'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const D = require('./domain');

const MAX_ATTEMPTS = 6;

function createApp({ store, config, mediaFetcher, clock = () => Date.now() }) {
  const pending = new Set();
  const track = (p) => { pending.add(p); p.finally(() => pending.delete(p)); return p; };
  const hmac = (secret, buf) => 'sha256=' + crypto.createHmac('sha256', secret).update(buf).digest('hex');
  const safeEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const audit = (d, actor, action, entity, before, after) => d.audit.push({ id: D.uuid(), at: clock(), actor, action, entity, before, after });
  const emit = (d, type, payload) => d.outbox.push({ id: D.uuid(), event_type: type, payload: { event_id: D.uuid(), event_type: type, occurred_at: new Date(clock()).toISOString(), ...payload }, processed_at: null, attempts: 0, next_attempt_at: 0, dead: false });

  function setStatus(d, order, to, actor, extra = {}) {
    if (!D.canTransition(order.status, to)) throw Object.assign(new Error('INVALID_TRANSITION'), { http: 409, detail: `${order.status} -> ${to}` });
    const before = order.status;
    order.status = to; order.version += 1; order.updated_at = clock();
    audit(d, actor, 'order.status', order.id, { status: before }, { status: to, ...extra });
  }
  const orderView = (d, o) => {
    const items = d.items.filter((i) => i.order_id === o.id);
    const subtotal = items.reduce((s, i) => s + i.line_total_cents, 0);
    return { id: o.id, code: o.code, status: o.status, version: o.version, mode: o.mode, zone: o.zone, address: o.address,
      items: items.map(({ product_name_snapshot, quantity, unit_price_cents, line_total_cents, sku }) => ({ sku, name: product_name_snapshot, quantity, unit_price_cents, line_total_cents })),
      subtotal_cents: subtotal, delivery_cents: o.delivery_cents, total_cents: subtotal + o.delivery_cents };
  };
  const fail = (http, error, detail) => Object.assign(new Error(error), { http, detail });

  // ---------------- webhook de Meta ----------------
  function webhookGet(q) {
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] && safeEq(q['hub.verify_token'], config.verifyToken)) return { code: 200, text: String(q['hub.challenge'] || '') };
    return { code: 403, json: { error: 'FORBIDDEN' } };
  }

  function webhookPost(raw, sig) {
    if (!sig) return { code: 401, json: { error: 'SIGNATURE_MISSING' } };
    if (!safeEq(sig, hmac(config.appSecret, raw))) return { code: 401, json: { error: 'SIGNATURE_INVALID' } };
    let body; try { body = JSON.parse(raw.toString('utf8')); } catch { return { code: 400, json: { error: 'BAD_JSON' } }; }
    let received = 0, duplicates = 0;
    for (const entry of body.entry || []) for (const ch of entry.changes || []) {
      const v = ch.value || {};
      for (const m of v.messages || []) {
        const res = store.tx((d) => {
          if (d.messages.has(m.id)) return 'dup'; // idempotencia por wamid
          let c = d.customers.get(m.from);
          if (!c) { c = { id: D.uuid(), wa_id: m.from, display_name: (v.contacts && v.contacts[0] && v.contacts[0].profile && v.contacts[0].profile.name) || null }; d.customers.set(m.from, c); }
          const msg = { id: D.uuid(), provider_message_id: m.id, customer_id: c.id, direction: 'IN', kind: m.type, payload: m, received_at: clock() };
          d.messages.set(m.id, msg);
          // mensaje + evento de outbox en la MISMA transacción
          emit(d, 'message.received', { message_id: msg.id, customer_id: c.id, kind: m.type, text: m.text ? m.text.body : null, media_id: m.image ? m.image.id : (m.document ? m.document.id : null) });
          return { msg, c };
        });
        if (res === 'dup') { duplicates++; continue; }
        received++;
        if (m.type === 'image' || m.type === 'document') track(processProof(res.msg, res.c, (m.image || m.document).id));
      }
    }
    return { code: 200, json: { received, duplicates } };
  }

  async function processProof(msg, customer, mediaId) {
    let media;
    try { media = await mediaFetcher(mediaId); } catch { media = null; }
    store.tx((d) => {
      const candidates = [...d.orders.values()].filter((o) => o.customer_id === customer.id && (o.status === 'AWAITING_PAYMENT' || o.status === 'PAYMENT_ISSUE'));
      if (candidates.length === 0) return emit(d, 'proof.unassociated', { customer_id: customer.id, reason: 'NO_PENDING_ORDER' });
      if (candidates.length > 1) return emit(d, 'proof.unassociated', { customer_id: customer.id, reason: 'AMBIGUOUS', order_codes: candidates.map((o) => o.code) });
      const order = candidates[0];
      const mime = media ? D.sniffMime(media.bytes) : null;
      if (!media || !mime || media.bytes.length > config.maxMediaBytes) return emit(d, 'proof.invalid', { customer_id: customer.id, order_code: order.code, reason: !media ? 'DOWNLOAD_FAILED' : (!mime ? 'BAD_TYPE' : 'TOO_LARGE') });
      const sha = D.sha256(media.bytes);
      const dup = d.attachments.get(sha);
      const att = dup || { id: D.uuid(), storage_key: `proofs/${sha}`, media_provider_id: mediaId, mime_type: mime, size_bytes: media.bytes.length, sha256: sha };
      d.attachments.set(sha, att);
      const payment = [...d.payments.values()].find((p) => p.order_id === order.id);
      d.evidence.push({ id: D.uuid(), payment_id: payment.id, attachment_id: att.id, received_at: clock(), review_status: dup ? 'DUPLICATE_HASH' : 'PENDING' });
      // El pago NO cambia de estado: solo el pedido pasa a revisión humana.
      setStatus(d, order, 'UNDER_REVIEW', 'system:gateway', { evidence: att.id });
      emit(d, 'payment.proof_received', { customer_id: order.customer_id, order_id: order.id, order_code: order.code, payment_id: payment.id, attachment_id: att.id, expected_amount_cents: payment.expected_amount_cents, review_status: dup ? 'DUPLICATE_HASH' : 'PENDING' });
    });
  }

  // ---------------- API interna (n8n) ----------------
  function internalAuth(h) { return h['x-internal-secret'] && safeEq(h['x-internal-secret'], config.internalSecret); }
  function idem(h, fn) {
    const key = h['idempotency-key'];
    if (key && store.d.idem.has(key)) return { ...store.d.idem.get(key), replay: true };
    const r = fn();
    if (key && r.code < 300) store.d.idem.set(key, r);
    return r;
  }

  function draftItems(b) {
    return store.tx((d) => {
      const customer = [...d.customers.values()].find((c) => c.id === b.customer_id);
      if (!customer) throw fail(404, 'CUSTOMER_NOT_FOUND');
      const unknown = [], unavailable = [], invalid = [];
      for (const it of b.items || []) {
        const p = d.products.find((x) => x.sku === it.sku && x.active);
        if (!p) { unknown.push(it.sku); continue; }
        if (!p.available) unavailable.push(it.sku);
        if (!Number.isInteger(it.quantity) || it.quantity < 1 || it.quantity > 20) invalid.push(it.sku);
      }
      if (unknown.length || unavailable.length || invalid.length) throw fail(422, 'ITEMS_REJECTED', { unknown, unavailable, invalid });
      let o = [...d.orders.values()].find((x) => x.customer_id === customer.id && (x.status === 'DRAFT' || x.status === 'QUOTED'));
      if (!o) { o = { id: D.uuid(), code: null, customer_id: customer.id, status: 'DRAFT', version: 1, mode: null, zone: null, address: null, delivery_cents: 0, created_at: clock(), updated_at: clock() }; d.orders.set(o.id, o); }
      for (const it of b.items) {
        const p = d.products.find((x) => x.sku === it.sku);
        const ex = d.items.find((i) => i.order_id === o.id && i.sku === it.sku);
        if (ex) { ex.quantity += it.quantity; ex.line_total_cents = ex.quantity * ex.unit_price_cents; }
        else d.items.push({ id: D.uuid(), order_id: o.id, sku: p.sku, product_id: p.id, product_name_snapshot: p.name, quantity: it.quantity, unit_price_cents: p.price_cents, line_total_cents: p.price_cents * it.quantity });
      }
      if (b.mode) o.mode = b.mode;
      if (b.zone) o.zone = b.zone;
      if (b.address) o.address = b.address;
      o.version += 1;
      if (o.status === 'QUOTED') recalcDelivery(o); // recálculo desde el servidor
      return { code: 200, json: orderView(d, o) };
    });
  }
  function recalcDelivery(o) {
    if (o.mode === 'DELIVERY') {
      if (!o.address) throw fail(422, 'MISSING_ADDRESS');
      if (!(o.zone in D.ZONES)) throw fail(422, 'UNKNOWN_ZONE');
      o.delivery_cents = D.ZONES[o.zone];
    } else o.delivery_cents = 0;
  }
  function quote(id, b) {
    return store.tx((d) => {
      const o = d.orders.get(id); if (!o) throw fail(404, 'ORDER_NOT_FOUND');
      if (b.expected_version !== undefined && b.expected_version !== o.version) throw fail(409, 'VERSION_CONFLICT');
      if (d.items.filter((i) => i.order_id === id).length === 0) throw fail(422, 'EMPTY_ORDER');
      if (b.mode) o.mode = b.mode; if (b.zone) o.zone = b.zone; if (b.address) o.address = b.address;
      recalcDelivery(o);
      if (o.status === 'DRAFT') setStatus(d, o, 'QUOTED', 'service:n8n'); else o.version += 1;
      return { code: 200, json: orderView(d, o) };
    });
  }
  function confirm(id, b) {
    return store.tx((d) => {
      const o = d.orders.get(id); if (!o) throw fail(404, 'ORDER_NOT_FOUND');
      if (b.expected_version !== undefined && b.expected_version !== o.version) throw fail(409, 'VERSION_CONFLICT');
      setStatus(d, o, 'AWAITING_PAYMENT', 'service:n8n');
      o.code = store.nextCode();
      const view = orderView(d, o);
      const pay = { id: D.uuid(), order_id: o.id, method: 'TRANSFER', expected_amount_cents: view.total_cents, status: 'PENDING', verified_by: null, verified_at: null };
      d.payments.set(pay.id, pay);
      return { code: 200, json: { ...orderView(d, o), payment_id: pay.id } };
    });
  }
  function postMessage(b) {
    return store.tx((d) => {
      const m = { id: D.uuid(), to: b.to, text: b.text, status: 'QUEUED', idempotency_key: b.idempotency_key || null };
      d.outbound.push(m); return { code: 202, json: { id: m.id, status: m.status } };
    });
  }
  function context(customerId) {
    const d = store.d;
    const orders = [...d.orders.values()].filter((o) => o.customer_id === customerId && !['COMPLETED', 'CANCELLED'].includes(o.status));
    const customer = [...d.customers.values()].find((c) => c.id === customerId);
    return { code: 200, json: { customer, active_orders: orders.map((o) => orderView(d, o)) } };
  }

  // ---------------- API del panel ----------------
  const authUser = (h) => { const t = (h.authorization || '').replace(/^Bearer /, ''); return config.users[t] || null; };
  function listOrders(user, q) {
    const d = store.d;
    if (!D.can(user.role, 'orders:read') && !D.can(user.role, 'kitchen:read')) throw fail(403, 'FORBIDDEN');
    let list = [...d.orders.values()];
    if (user.role === 'KITCHEN') list = list.filter((o) => ['CONFIRMED', 'PREPARING', 'READY'].includes(o.status));
    if (q.status) list = list.filter((o) => o.status === q.status);
    return { code: 200, json: list.map((o) => orderView(d, o)) };
  }
  function verify(user, paymentId, b) {
    if (!D.can(user.role, 'payments:verify')) throw fail(403, 'FORBIDDEN');
    return store.tx((d) => {
      const pay = d.payments.get(paymentId); if (!pay) throw fail(404, 'PAYMENT_NOT_FOUND');
      const o = d.orders.get(pay.order_id);
      if (b.expected_version !== undefined && b.expected_version !== o.version) throw fail(409, 'VERSION_CONFLICT');
      if (o.status !== 'UNDER_REVIEW') throw fail(409, 'INVALID_TRANSITION', `${o.status} -> CONFIRMED`);
      if (b.observed_amount_cents !== pay.expected_amount_cents) {
        if (!(b.override && b.reason && D.can(user.role, 'payments:override'))) throw fail(422, 'AMOUNT_MISMATCH', { expected: pay.expected_amount_cents, observed: b.observed_amount_cents });
      }
      pay.status = 'VERIFIED'; pay.verified_by = user.id; pay.verified_at = clock();
      d.evidence.filter((e) => e.payment_id === pay.id).forEach((e) => { e.review_status = 'APPROVED'; });
      setStatus(d, o, 'CONFIRMED', user.id, { payment: 'VERIFIED', reference: b.reference || null, override: !!b.override });
      emit(d, 'payment.verified', { customer_id: o.customer_id, order_id: o.id, order_code: o.code, payment_id: pay.id });
      return { code: 200, json: orderView(d, o) };
    });
  }
  function reject(user, paymentId, b) {
    if (!D.can(user.role, 'payments:verify')) throw fail(403, 'FORBIDDEN');
    if (!b.reason) throw fail(422, 'REASON_REQUIRED');
    return store.tx((d) => {
      const pay = d.payments.get(paymentId); if (!pay) throw fail(404, 'PAYMENT_NOT_FOUND');
      const o = d.orders.get(pay.order_id);
      pay.status = 'REJECTED';
      setStatus(d, o, 'PAYMENT_ISSUE', user.id, { reason: b.reason });
      emit(d, 'payment.rejected', { customer_id: o.customer_id, order_id: o.id, order_code: o.code, payment_id: pay.id, reason: b.reason });
      return { code: 200, json: orderView(d, o) };
    });
  }
  function kitchenStatus(user, id, b) {
    if (!D.can(user.role, 'orders:status')) throw fail(403, 'FORBIDDEN');
    return store.tx((d) => {
      const o = d.orders.get(id); if (!o) throw fail(404, 'ORDER_NOT_FOUND');
      if (b.expected_version !== undefined && b.expected_version !== o.version) throw fail(409, 'VERSION_CONFLICT');
      if (user.role === 'KITCHEN' && !['PREPARING', 'READY', 'COMPLETED'].includes(b.to)) throw fail(403, 'FORBIDDEN');
      setStatus(d, o, b.to, user.id);
      return { code: 200, json: orderView(d, o) };
    });
  }
  function viewAttachment(user, id) {
    if (!D.can(user.role, 'evidence:view')) throw fail(403, 'FORBIDDEN');
    const att = [...store.d.attachments.values()].find((a) => a.id === id);
    if (!att) throw fail(404, 'NOT_FOUND');
    audit(store.d, user.id, 'evidence.view', att.id, null, null);
    return { code: 200, json: { id: att.id, mime_type: att.mime_type, size_bytes: att.size_bytes, sha256: att.sha256, url: `/signed/${att.id}?exp=${clock() + 60000}` } };
  }

  // ---------------- despachador de outbox ----------------
  async function dispatchOnce(deliver, now = clock()) {
    let delivered = 0, failed = 0;
    for (const ev of store.d.outbox) {
      if (ev.processed_at || ev.dead || ev.next_attempt_at > now) continue;
      try { await deliver(ev); ev.processed_at = now; delivered++; }
      catch {
        ev.attempts += 1; failed++;
        if (ev.attempts >= MAX_ATTEMPTS) ev.dead = true; // cola de error revisable
        else ev.next_attempt_at = now + Math.pow(2, ev.attempts) * 1000; // backoff exponencial
      }
    }
    return { delivered, failed };
  }

  // ---------------- enrutador HTTP ----------------
  const wrap = (fn) => { try { return fn(); } catch (e) { if (e.http) return { code: e.http, json: { error: e.message, detail: e.detail } }; throw e; } };
  async function route(method, url, headers, raw) {
    const u = new URL(url, 'http://x'); const q = Object.fromEntries(u.searchParams); const p = u.pathname;
    const body = () => { try { return raw && raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { throw fail(400, 'BAD_JSON'); } };
    return wrap(() => {
      if (p === '/health') return { code: 200, json: { status: 'ok' } };
      if (p === '/webhooks/whatsapp' && method === 'GET') return webhookGet(q);
      if (p === '/webhooks/whatsapp' && method === 'POST') return webhookPost(raw, headers['x-hub-signature-256']);
      if (p.startsWith('/internal/')) {
        if (!internalAuth(headers)) return { code: 401, json: { error: 'UNAUTHORIZED' } };
        let m;
        if (p === '/internal/orders/draft/items' && method === 'POST') return idem(headers, () => draftItems(body()));
        if ((m = p.match(/^\/internal\/orders\/([\w-]+)\/quote$/)) && method === 'POST') return idem(headers, () => quote(m[1], body()));
        if ((m = p.match(/^\/internal\/orders\/([\w-]+)\/confirm$/)) && method === 'POST') return idem(headers, () => confirm(m[1], body()));
        if (p === '/internal/messages' && method === 'POST') return idem(headers, () => postMessage(body()));
        if ((m = p.match(/^\/internal\/conversations\/([\w-]+)\/context$/)) && method === 'GET') return context(m[1]);
        return { code: 404, json: { error: 'NOT_FOUND' } };
      }
      if (p.startsWith('/api/')) {
        const user = authUser(headers); if (!user) return { code: 401, json: { error: 'UNAUTHORIZED' } };
        let m;
        if (p === '/api/orders' && method === 'GET') return listOrders(user, q);
        if ((m = p.match(/^\/api\/payments\/([\w-]+)\/verify$/)) && method === 'POST') return verify(user, m[1], body());
        if ((m = p.match(/^\/api\/payments\/([\w-]+)\/reject$/)) && method === 'POST') return reject(user, m[1], body());
        if ((m = p.match(/^\/api\/orders\/([\w-]+)\/status$/)) && method === 'POST') return kitchenStatus(user, m[1], body());
        if ((m = p.match(/^\/api\/attachments\/([\w-]+)\/view$/)) && method === 'GET') return viewAttachment(user, m[1]);
        return { code: 404, json: { error: 'NOT_FOUND' } };
      }
      return { code: 404, json: { error: 'NOT_FOUND' } };
    });
  }
  const server = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks); // bytes originales para el HMAC
      try {
        const r = await route(req.method, req.url, req.headers, raw);
        if (r.text !== undefined) { res.writeHead(r.code, { 'content-type': 'text/plain' }); res.end(r.text); }
        else { res.writeHead(r.code, { 'content-type': 'application/json' }); res.end(JSON.stringify(r.json)); }
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: 'INTERNAL' })); }
    });
  });
  return { server, route, dispatchOnce, idle: () => Promise.all([...pending]), hmac, store };
}
module.exports = { createApp };
