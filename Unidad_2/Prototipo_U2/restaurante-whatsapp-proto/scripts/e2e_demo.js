'use strict';
// "Primera prueba técnica de extremo a extremo" del documento de arquitectura (sec. 18):
// "Hola, quiero dos hamburguesas" -> cotización -> confirmación -> instrucciones de pago ->
// imagen -> UNDER_REVIEW -> aprobación manual -> confirmación al cliente.
const { setup, H } = require('../apps/api/test/helpers');
const WA = '51999000111';
(async () => {
  const t = await setup();
  const say = (who, s) => console.log(`${who.padEnd(10)}| ${s}`);
  const step = async (title, fn) => { console.log(`\n== ${title}`); await fn(); await t.pump(); };
  let last = 0; const newBot = () => { const all = t.out(WA); const n = all.slice(last); last = all.length; n.forEach((x) => say('BOT', x)); };
  await step('1. Cliente escribe', async () => { say('CLIENTE', 'Hola, quiero dos hamburguesas para recojo'); await t.sendWebhook([t.text('e2e-1', WA, 'Hola, quiero dos hamburguesas para recojo')]); }); newBot();
  const order = () => [...t.store.d.orders.values()][0];
  console.log('estado pedido:', order().status);
  await step('2. Cliente confirma', async () => { say('CLIENTE', 'Sí, confirmo el pedido'); await t.sendWebhook([t.text('e2e-2', WA, 'Sí, confirmo el pedido')]); }); newBot();
  console.log('estado pedido:', order().status, '| código:', order().code);
  await step('3. Cliente envía la imagen del comprobante', async () => { say('CLIENTE', '[imagen del comprobante]'); await t.sendWebhook([t.image('e2e-3', WA)]); }); newBot();
  const pay = [...t.store.d.payments.values()][0];
  console.log('estado pedido:', order().status, '| estado del pago:', pay.status, '(la imagen NO verifica el pago)');
  const alerts = (await t.api('GET', '/api/orders?status=UNDER_REVIEW', { headers: H('tok-caja') })).json;
  console.log('alerta en el panel (GET /api/orders?status=UNDER_REVIEW):', alerts.map((o) => `${o.code} ${o.status} total ${o.total_cents / 100}`));
  const r = await t.api('POST', `/api/payments/${pay.id}/verify`, { headers: H('tok-caja'), body: { observed_amount_cents: alerts[0].total_cents, reference: 'OP-7788' } });
  console.log('\n== 4. Cajero verifica el abono y aprueba -> HTTP', r.code);
  await t.pump(); newBot();
  console.log('estado pedido:', order().status, '| estado del pago:', pay.status === 'VERIFIED' ? 'VERIFIED' : t.store.d.payments.get(pay.id).status);
  console.log('\n== Auditoría');
  t.store.d.audit.forEach((a) => console.log(`${a.actor.padEnd(14)} ${a.action.padEnd(14)} ${JSON.stringify(a.before)} -> ${JSON.stringify(a.after)}`));
  t.close();
})();
