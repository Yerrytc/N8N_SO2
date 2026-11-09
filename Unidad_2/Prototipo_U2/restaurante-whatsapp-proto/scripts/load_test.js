'use strict';
// Ensayo local (NO es la prueba sobre la VPS): latencia del webhook y 50 pedidos simulados.
const { setup, H } = require('../apps/api/test/helpers');
const os = require('node:os');
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)]; };
(async () => {
  console.log(`Entorno: Node ${process.version}, ${os.cpus().length} CPU, ${Math.round(os.totalmem() / 2 ** 20)} MB RAM (entorno de desarrollo, no la VPS)`);
  // PT-16: 200 solicitudes firmadas, 10 en paralelo
  let t = await setup({ startN8n: false });
  const lat = []; let ok = 0; const N = 200, C = 10;
  const one = async (i) => { const s = performance.now(); const r = await t.sendWebhook([t.text('L' + i, '5190000' + String(i % 50).padStart(4, '0'), 'Hola ' + i)]); lat.push(performance.now() - s); if (r.code === 200) ok++; };
  for (let i = 0; i < N; i += C) await Promise.all(Array.from({ length: C }, (_, k) => one(i + k)));
  console.log(`PT-16 webhook: ${ok}/${N} respondidos 200 | p50 ${pct(lat, 50).toFixed(1)} ms | p95 ${pct(lat, 95).toFixed(1)} ms | p99 ${pct(lat, 99).toFixed(1)} ms | max ${Math.max(...lat).toFixed(1)} ms`);
  console.log(`      mensajes persistidos: ${t.store.d.messages.size} | eventos en outbox: ${t.store.d.outbox.length}`);
  t.close();
  // PT-18 (ensayo parcial): 50 pedidos de punta a punta con aprobación simulada
  t = await setup({ media: Object.fromEntries(Array.from({ length: 50 }, (_, i) => ['m' + i, { bytes: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('img' + i)]) }])) });
  const start = performance.now(); const times = [];
  for (let i = 0; i < 50; i++) {
    const wa = '5198000' + String(i).padStart(4, '0'); const s = performance.now();
    await t.sendWebhook([t.text('P' + i + 'a', wa, 'Quiero dos hamburguesas y una gaseosa para recojo')]); await t.pump();
    await t.sendWebhook([t.text('P' + i + 'b', wa, 'confirmo')]); await t.pump();
    await t.sendWebhook([t.image('P' + i + 'c', wa, 'm' + i)]); await t.pump();
    const pay = [...t.store.d.payments.values()].find((p) => t.store.d.orders.get(p.order_id).customer_id === t.store.d.customers.get(wa).id);
    await t.api('POST', `/api/payments/${pay.id}/verify`, { headers: H('tok-caja'), body: { observed_amount_cents: pay.expected_amount_cents } }); await t.pump();
    times.push(performance.now() - s);
  }
  const orders = [...t.store.d.orders.values()];
  const conf = orders.filter((o) => o.status === 'CONFIRMED').length;
  const codes = new Set(orders.map((o) => o.code));
  const withMsgs = [...t.store.d.customers.keys()].filter((wa) => t.out(wa).length >= 4).length;
  console.log(`PT-18 (ensayo parcial): ${orders.length} pedidos, ${conf} CONFIRMED, ${codes.size} códigos únicos, ${withMsgs}/50 clientes con las 4 respuestas | ciclo medio ${(times.reduce((a, b) => a + b, 0) / 50).toFixed(1)} ms | total ${(performance.now() - start).toFixed(0)} ms`);
  console.log(`      eventos sin entregar: ${t.store.d.outbox.filter((e) => !e.processed_at).length} | eventos en cola de error: ${t.store.d.outbox.filter((e) => e.dead).length} | duplicados de pago: ${t.store.d.payments.size - orders.length}`);
  t.close();
})();
