'use strict';
const crypto = require('node:crypto');
const { Store } = require('../src/store');
const { createApp } = require('../src/app');
const { startOrchestrator } = require('../../../automation/sim/orchestrator');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('comprobante-demo-1')]);
const PNG2 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('comprobante-demo-2')]);
const config = {
  appSecret: 'app-secret-de-prueba', verifyToken: 'verify-token-de-prueba', internalSecret: 'interno-de-prueba', sharedSecret: 'compartido-de-prueba',
  maxMediaBytes: 5 * 1024 * 1024,
  users: { 'tok-admin': { id: 'u-admin', role: 'ADMIN' }, 'tok-caja': { id: 'u-caja', role: 'CASHIER' }, 'tok-cocina': { id: 'u-cocina', role: 'KITCHEN' }, 'tok-oper': { id: 'u-oper', role: 'OPERATOR' }, 'tok-audit': { id: 'u-audit', role: 'AUDITOR' } },
};
const H = (t) => ({ authorization: 'Bearer ' + t });

async function setup({ media = { 'media-1': { bytes: PNG } }, startN8n = true } = {}) {
  const store = new Store();
  let nowMs = 1_000_000; const clock = () => nowMs;
  const app = createApp({ store, config, clock, mediaFetcher: async (id) => { if (!media[id]) throw new Error('no media'); return media[id]; } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const orch = startN8n ? await startOrchestrator({ apiBase: base, internalSecret: config.internalSecret, sharedSecret: config.sharedSecret }) : null;
  let n8nUp = true;
  const deliver = async (ev) => {
    if (!n8nUp || !orch) throw new Error('n8n caído');
    const raw = Buffer.from(JSON.stringify(ev.payload));
    const r = await fetch(`http://127.0.0.1:${orch.port}/webhook/events`, { method: 'POST', headers: { 'x-signature': 'sha256=' + crypto.createHmac('sha256', config.sharedSecret).update(raw).digest('hex') }, body: raw });
    if (!r.ok) throw new Error('n8n ' + r.status);
  };
  const api = async (method, path, { headers = {}, body, raw } = {}) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: raw !== undefined ? raw : (body ? JSON.stringify(body) : undefined) });
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
    return { code: r.status, json: j };
  };
  const internal = (method, path, body, key) => api(method, path, { headers: { 'x-internal-secret': config.internalSecret, ...(key ? { 'idempotency-key': key } : {}) }, body });
  const payload = (msgs) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { contacts: [{ profile: { name: 'Cliente Demo' }, wa_id: msgs[0].from }], messages: msgs } }] }] });
  const sendWebhook = async (msgs, { sign = true, secret = config.appSecret } = {}) => {
    const raw = Buffer.from(JSON.stringify(payload(msgs)));
    const headers = sign ? { 'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex') } : {};
    return api('POST', '/webhooks/whatsapp', { headers, raw: raw.toString('utf8') });
  };
  const text = (id, from, body) => ({ from, id, timestamp: '1', type: 'text', text: { body } });
  const image = (id, from, mediaId = 'media-1') => ({ from, id, timestamp: '1', type: 'image', image: { id: mediaId, mime_type: 'image/png' } });
  // Procesa todo el outbox hasta que no haya más eventos entregables (equivale al despachador + n8n)
  const pump = async () => { for (let i = 0; i < 20; i++) { await app.idle(); const r = await app.dispatchOnce(deliver, nowMs); await app.idle(); if (r.delivered === 0) break; } };
  const out = (wa) => store.d.outbound.filter((m) => m.to === wa).map((m) => m.text);
  const close = () => { app.server.close(); if (orch) orch.server.close(); };
  return { app, store, base, orch, api, internal, sendWebhook, text, image, pump, out, close, config, H, setN8n: (v) => { n8nUp = v; }, advance: (ms) => { nowMs += ms; }, now: () => nowMs, deliver, PNG, PNG2 };
}
module.exports = { setup, config, H, PNG, PNG2 };
