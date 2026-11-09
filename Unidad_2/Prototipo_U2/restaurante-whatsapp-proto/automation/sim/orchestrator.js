'use strict';
// Simulador del orquestador n8n (WF-01 a WF-06) para la prueba de concepto.
// Recibe eventos firmados del despachador, decide la ruta y llama a la API interna.
// NO es n8n: sirve para ejercitar el contrato de eventos y la API sin levantar n8n.
const http = require('node:http');
const crypto = require('node:crypto');

const NUMS = { un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5 };
const ALIASES = [
  ['hamburguesa clasica', 'BURG-CLS'], ['hamburguesas clasicas', 'BURG-CLS'], ['hamburguesa', 'BURG-CLS'], ['hamburguesas', 'BURG-CLS'],
  ['inca kola grande', 'INCA-GR'], ['gaseosa', 'GAS-15'], ['papas fritas', 'PAP-FRI'], ['papas', 'PAP-FRI'],
];
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// F1.4 interpretación determinista (reglas/alias) antes de usar IA
function parseOrder(text) {
  const t = norm(text);
  const wantsHuman = /\b(asesor|persona|humano)\b/.test(t);
  const mode = /recojo|recoger|paso a buscar/.test(t) ? 'PICKUP' : (/delivery|mandas|envi|al centro|reparto/.test(t) ? 'DELIVERY' : null);
  const zone = /\bcentro\b/.test(t) ? 'centro' : (/\bnorte\b/.test(t) ? 'norte' : null);
  const am = text.match(/direcci[oó]n:\s*(.+)$/i); const address = am ? am[1].trim() : null;
  const items = []; const unknown = [];
  for (const seg of t.split(/,|\by\b|\+|\bagrega\b|\bademas\b/)) {
    const s = seg.trim(); if (!s) continue;
    const qm = s.match(/\b(\d+|un|uno|una|dos|tres|cuatro|cinco)\b/);
    const isRequest = !!qm || /\b(quiero|dame|pon|agrega)\b/.test(s);
    const hit = ALIASES.find(([a]) => s.includes(a));
    if (hit) { const q = qm ? (NUMS[qm[1]] || parseInt(qm[1], 10)) : 1; items.push({ sku: hit[1], quantity: q }); }
    else if (isRequest && !/\b(asesor|persona|humano|confirmo|si)\b/.test(s) && !/^hola/.test(s) && /\b(quiero|dame|pon|un|una|dos|tres)\b/.test(s) && !/direccion|centro|norte|recojo|delivery/.test(s)) unknown.push(s);
  }
  return { items, unknown, mode, zone, address, wantsHuman, confirms: /\b(confirmo|confirmamos|si confirmo|dale)\b/.test(t) };
}

function startOrchestrator({ apiBase, internalSecret, sharedSecret, port = 0 }) {
  const processed = new Set(); const log = []; const effects = { messages: 0, drafts: 0, confirms: 0 };
  const call = async (method, path, body, key) => {
    const r = await fetch(apiBase + path, { method, headers: { 'content-type': 'application/json', 'x-internal-secret': internalSecret, ...(key ? { 'idempotency-key': key } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { code: r.status, json: await r.json().catch(() => ({})) };
  };
  const say = async (to, text, key) => { effects.messages++; return call('POST', '/internal/messages', { to, text, idempotency_key: key }, key); };
  const money = (c) => 'S/ ' + (c / 100).toFixed(2);

  async function handle(ev) {
    log.push(ev.event_type);
    if (ev.event_type === 'message.received') {
      if (ev.kind !== 'text') return; // el comprobante lo procesa la pasarela; WF-05 responde con otro evento
      const ctx = (await call('GET', `/internal/conversations/${ev.customer_id}/context`)).json;
      const to = ctx.customer.wa_id; const p = parseOrder(ev.text || '');
      if (p.wantsHuman) return void (await say(to, 'Te paso con una persona del local.', 'h-' + ev.event_id)); // WF-07
      const active = ctx.active_orders[0];
      if (p.confirms && active && active.status === 'QUOTED') { // WF-04
        const r = await call('POST', `/internal/orders/${active.id}/confirm`, { expected_version: active.version }, 'confirm-' + active.id);
        if (r.code === 200 && !r.replay) effects.confirms++;
        if (r.code === 200) await say(to, `Pedido ${r.json.code} confirmado. Total ${money(r.json.total_cents)}. Transfiere ese monto, indica el código ${r.json.code} y envía la imagen del comprobante.`, 'pay-' + active.id);
        return;
      }
      if (p.unknown.length) return void (await say(to, `No tengo "${p.unknown[0]}" en la carta. Tenemos hamburguesa clásica, papas fritas y gaseosa 1.5 L.`, 'u-' + ev.event_id));
      if (p.items.length) { // WF-02 + WF-03
        effects.drafts++;
        const r = await call('POST', '/internal/orders/draft/items', { customer_id: ev.customer_id, items: p.items, mode: p.mode, zone: p.zone, address: p.address }, 'draft-' + ev.event_id);
        if (r.code === 422 && r.json.error === 'ITEMS_REJECTED') return void (await say(to, `No puedo ofrecer: ${[...r.json.detail.unavailable, ...r.json.detail.unknown].join(', ')} (agotado o inexistente). ¿Quieres otra presentación?`, 'r-' + ev.event_id));
        if (r.code !== 200) return;
        return void (await quoteAndAsk(to, r.json, ev));
      }
      if (active && (p.mode || p.address || p.zone)) { // completar datos faltantes
        const r = await call('POST', `/internal/orders/${active.id}/quote`, { mode: p.mode, zone: p.zone, address: p.address }, 'q-' + ev.event_id);
        if (r.code === 422) return void (await say(to, 'Necesito tu dirección para calcular el delivery. Escribe: Dirección: ...', 'a-' + ev.event_id));
        if (r.code === 200) return void (await say(to, `Total ${money(r.json.total_cents)} (delivery ${money(r.json.delivery_cents)}). ¿Confirmamos el pedido?`, 'q2-' + ev.event_id));
      }
      return;
    }
    if (ev.event_type === 'payment.proof_received') return void (await say(ev.customer_wa || (await waOf(ev)), `Recibimos tu comprobante del pedido ${ev.order_code}. Estamos verificando el pago; te confirmaremos cuando finalice la revisión.`, 'proof-' + ev.event_id)); // WF-05 (nunca "pagado")
    if (ev.event_type === 'payment.verified') return void (await say(await waOf(ev), `Pago verificado. Tu pedido ${ev.order_code} está confirmado y pasa a cocina.`, 'ok-' + ev.event_id)); // WF-06
    if (ev.event_type === 'payment.rejected') return void (await say(await waOf(ev), `Necesitamos aclarar el pago del pedido ${ev.order_code}. Un asesor te escribirá.`, 'no-' + ev.event_id));
    if (ev.event_type === 'proof.unassociated') return void (await say(await waOf(ev), '¿A qué pedido corresponde el comprobante? Indica el código (ej. PED-1001).', 'ref-' + ev.event_id));
  }
  // el evento no trae el teléfono: se consulta el contexto por order_id/customer_id
  const customers = new Map();
  async function waOf(ev) {
    const cid = ev.customer_id || customers.get(ev.order_id); if (!cid) return null;
    return (await call('GET', `/internal/conversations/${cid}/context`)).json.customer.wa_id;
  }
  async function handleWrapped(ev) {
    if (ev.order_id && ev.customer_id) customers.set(ev.order_id, ev.customer_id);
    return handle(ev);
  }

  async function quoteAndAsk(to, order, ev) {
    if (order.mode === 'DELIVERY' && !order.address) return say(to, `Tu pedido: ${order.items.map((i) => `${i.quantity} x ${i.name}`).join(', ')}. Subtotal ${money(order.subtotal_cents)}. Para el delivery necesito tu dirección. Escribe: Dirección: ...`, 'ask-' + ev.event_id);
    const q = await call('POST', `/internal/orders/${order.id}/quote`, { mode: order.mode, zone: order.zone, address: order.address }, 'quote-' + ev.event_id);
    if (q.code !== 200) return say(to, 'Necesito más datos para cotizar.', 'more-' + ev.event_id);
    const o = q.json;
    return say(to, `Tu pedido: ${o.items.map((i) => `${i.quantity} x ${i.name} (${money(i.line_total_cents)})`).join(' + ')}. Subtotal ${money(o.subtotal_cents)}. Delivery ${money(o.delivery_cents)}. Total ${money(o.total_cents)}. ¿Confirmamos el pedido?`, 'ask-' + ev.event_id);
  }

  const server = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      const sig = req.headers['x-signature'] || '';
      const exp = 'sha256=' + crypto.createHmac('sha256', sharedSecret).update(raw).digest('hex');
      if (sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) { res.writeHead(401); return res.end('{}'); }
      const ev = JSON.parse(raw.toString('utf8'));
      if (processed.has(ev.event_id)) { res.writeHead(200); return res.end('{"duplicate":true}'); } // dedup de entrega al menos una vez
      try { await handleWrapped(ev); processed.add(ev.event_id); res.writeHead(200); res.end('{}'); }
      catch (e) { res.writeHead(500); res.end('{}'); }
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, log, effects, processed })));
}
module.exports = { startOrchestrator, parseOrder };
