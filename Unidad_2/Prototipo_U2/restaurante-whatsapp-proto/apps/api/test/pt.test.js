'use strict';
// Pruebas de la capa de negocio. Los identificadores PT-xx corresponden al plan de pruebas del informe (Tabla 29).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setup, H, PNG, PNG2 } = require('./helpers');
const WA = '51999000111';

test('PT-11 verificación del webhook: reto GET y firma HMAC', async () => {
  const t = await setup();
  try {
    const ok = await t.api('GET', '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-token-de-prueba&hub.challenge=12345');
    assert.equal(ok.code, 200); assert.equal(ok.json, 12345);
    const bad = await t.api('GET', '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=1');
    assert.equal(bad.code, 403);
    assert.equal((await t.sendWebhook([t.text('w1', WA, 'Hola')])).code, 200);          // firma válida
    assert.equal((await t.sendWebhook([t.text('w2', WA, 'Hola')], { secret: 'otra' })).code, 401); // firma inválida
    assert.equal((await t.sendWebhook([t.text('w3', WA, 'Hola')], { sign: false })).code, 401);    // sin firma
    assert.equal(t.store.d.messages.size, 1, 'solo el mensaje firmado se persiste');
    // la firma se calcula sobre los bytes originales: un body alterado invalida la firma
    const raw = JSON.stringify(t.sendWebhook ? { x: 1 } : {});
    const sig = 'sha256=' + crypto.createHmac('sha256', t.config.appSecret).update(raw).digest('hex');
    const tampered = await t.api('POST', '/webhooks/whatsapp', { headers: { 'x-hub-signature-256': sig }, raw: raw + ' ' });
    assert.equal(tampered.code, 401);
  } finally { t.close(); }
});

test('PT-12 idempotencia: mismo wamid dos veces', async () => {
  const t = await setup();
  try {
    const m = t.text('wamid.A', WA, 'Quiero dos hamburguesas');
    assert.equal((await t.sendWebhook([m])).json.received, 1);
    const r2 = await t.sendWebhook([m]);
    assert.equal(r2.code, 200); assert.equal(r2.json.duplicates, 1);
    await t.pump();
    assert.equal(t.store.d.messages.size, 1);
    assert.equal(t.store.d.orders.size, 1, 'un solo pedido');
    assert.equal(t.store.d.outbox.filter((e) => e.event_type === 'message.received').length, 1, 'un solo evento');
  } finally { t.close(); }
});

test('Flujo de negocio: cotización con total calculado en el servidor (T01, T03)', async () => {
  const t = await setup();
  try {
    await t.sendWebhook([t.text('a1', WA, 'Hola, quiero dos hamburguesas clásicas y una gaseosa para recojo')]);
    await t.pump();
    const o = [...t.store.d.orders.values()][0];
    assert.equal(o.status, 'QUOTED');
    const ctx = (await t.internal('GET', `/internal/conversations/${o.customer_id}/context`)).json.active_orders[0];
    assert.equal(ctx.subtotal_cents, 2 * 1600 + 900); assert.equal(ctx.total_cents, 4100);
    assert.match(t.out(WA).at(-1), /Total S\/ 41\.00/);
    // T03: cambio de cantidad -> recalcula desde el servidor
    await t.sendWebhook([t.text('a2', WA, 'agrega una hamburguesa')]);
    await t.pump();
    const ctx2 = (await t.internal('GET', `/internal/conversations/${o.customer_id}/context`)).json.active_orders[0];
    assert.equal(ctx2.total_cents, 3 * 1600 + 900);
    assert.equal(ctx2.items.every((i) => Number.isInteger(i.unit_price_cents)), true, 'precios en céntimos enteros');
  } finally { t.close(); }
});

test('T02/T15: producto inexistente o agotado no se inventa ni se acepta', async () => {
  const t = await setup();
  try {
    await t.sendWebhook([t.text('b1', WA, 'Quiero una pizza hawaiana')]); await t.pump();
    assert.equal(t.store.d.orders.size, 0);
    assert.match(t.out(WA).at(-1), /No tengo "?.*pizza/i);
    await t.sendWebhook([t.text('b2', WA, 'Quiero una inca kola grande')]); await t.pump();
    assert.equal(t.store.d.items.length, 0, 'el producto agotado no entra al carrito');
    assert.match(t.out(WA).at(-1), /agotado o inexistente/);
  } finally { t.close(); }
});

test('T04: delivery sin dirección pide la dirección y no inventa tarifa', async () => {
  const t = await setup();
  try {
    await t.sendWebhook([t.text('c1', WA, 'Quiero una hamburguesa, me lo mandas al centro')]); await t.pump();
    const o = [...t.store.d.orders.values()][0];
    assert.equal(o.status, 'DRAFT'); assert.equal(o.delivery_cents, 0);
    assert.match(t.out(WA).at(-1), /necesito tu direcci[oó]n/i);
    await t.sendWebhook([t.text('c2', WA, 'Dirección: Av. Bolognesi 123')]); await t.pump();
    assert.equal(o.status, 'QUOTED'); assert.equal(o.delivery_cents, 500);
  } finally { t.close(); }
});

async function reachAwaitingPayment(t, tag = 'x') {
  await t.sendWebhook([t.text(`${tag}1`, WA, 'Quiero dos hamburguesas para recojo')]); await t.pump();
  await t.sendWebhook([t.text(`${tag}2`, WA, 'Sí, confirmo el pedido')]); await t.pump();
  return [...t.store.d.orders.values()].at(-1);
}

test('T05: la confirmación crea una sola orden aunque llegue dos veces', async () => {
  const t = await setup();
  try {
    const o = await reachAwaitingPayment(t);
    assert.equal(o.status, 'AWAITING_PAYMENT'); assert.match(o.code, /^PED-\d+$/);
    // un segundo "confirmo" con otro wamid no genera otro pedido ni otro pago
    await t.sendWebhook([t.text('x3', WA, 'confirmo')]); await t.pump();
    assert.equal(t.store.d.orders.size, 1); assert.equal(t.store.d.payments.size, 1);
    assert.equal(t.orch.effects.confirms, 1);
    // reintento de la misma llamada interna con la misma clave: respuesta repetida, sin duplicar
    const again = await t.internal('POST', `/internal/orders/${o.id}/confirm`, { expected_version: o.version }, 'confirm-' + o.id);
    assert.equal(again.code, 200); assert.equal(t.store.d.payments.size, 1);
    // transición inválida sin clave de idempotencia
    const dup = await t.internal('POST', `/internal/orders/${o.id}/confirm`, {}, 'otra-clave');
    assert.equal(dup.code, 409); assert.equal(dup.json.error, 'INVALID_TRANSITION');
  } finally { t.close(); }
});

test('PT-15 regla de pago: comprobante recibido ≠ pago confirmado; roles y auditoría', async () => {
  const t = await setup();
  try {
    const o = await reachAwaitingPayment(t);
    const pay0 = [...t.store.d.payments.values()][0]; const pay = { id: pay0.id }; const O = () => t.store.d.orders.get(o.id); const P = () => t.store.d.payments.get(pay.id); // tras un rollback el estado se restaura: se relee
    await t.sendWebhook([t.image('img1', WA)]); await t.pump();
    assert.equal(O().status, 'UNDER_REVIEW');
    assert.equal(P().status, 'PENDING', 'el pago NO pasa a verificado por recibir una imagen');
    assert.equal(t.store.d.outbox.some((e) => e.event_type === 'payment.verified'), false);
    assert.match(t.out(WA).at(-1), /Estamos verificando el pago/);
    assert.doesNotMatch(t.out(WA).join(' '), /Pago verificado|pago aprobado/i);
    const att = [...t.store.d.attachments.values()][0];
    assert.equal(att.sha256.length, 64); assert.match(att.storage_key, /^proofs\//);
    // COCINA no ve comprobantes ni aprueba (403, sin cambios)
    assert.equal((await t.api('GET', `/api/attachments/${att.id}/view`, { headers: H('tok-cocina') })).code, 403);
    assert.equal((await t.api('POST', `/api/payments/${pay.id}/verify`, { headers: H('tok-cocina'), body: { observed_amount_cents: 3200 } })).code, 403);
    assert.equal((await t.api('POST', `/api/payments/${pay.id}/verify`, { headers: H('tok-oper'), body: { observed_amount_cents: 3200 } })).code, 403);
    assert.equal(O().status, 'UNDER_REVIEW');
    assert.equal((await t.api('GET', '/api/orders?status=UNDER_REVIEW')).code, 401, 'sin sesión');
    // el cajero ve la evidencia y aprueba con el monto observado
    assert.equal((await t.api('GET', `/api/attachments/${att.id}/view`, { headers: H('tok-caja') })).code, 200);
    // T19: importe distinto no se aprueba
    const mism = await t.api('POST', `/api/payments/${pay.id}/verify`, { headers: H('tok-caja'), body: { observed_amount_cents: 3000 } });
    assert.equal(mism.code, 422); assert.equal(mism.json.error, 'AMOUNT_MISMATCH'); assert.equal(O().status, 'UNDER_REVIEW');
    const ok = await t.api('POST', `/api/payments/${pay.id}/verify`, { headers: H('tok-caja'), body: { observed_amount_cents: 3200, reference: 'OP-123' } });
    assert.equal(ok.code, 200); assert.equal(O().status, 'CONFIRMED'); assert.equal(P().status, 'VERIFIED'); assert.equal(P().verified_by, 'u-caja');
    await t.pump();
    assert.match(t.out(WA).at(-1), /Pago verificado/);
    const log = t.store.d.audit.filter((a) => a.action === 'order.status').map((a) => a.after.status);
    assert.deepEqual(log, ['QUOTED', 'AWAITING_PAYMENT', 'UNDER_REVIEW', 'CONFIRMED']);
    assert.equal(t.store.d.audit.some((a) => a.actor === 'u-caja' && a.after && a.after.payment === 'VERIFIED'), true, 'auditoría con actor');
    // cocina solo ve pedidos confirmados y puede avanzar la preparación
    assert.equal((await t.api('GET', '/api/orders', { headers: H('tok-cocina') })).json.length, 1);
    assert.equal((await t.api('POST', `/api/orders/${o.id}/status`, { headers: H('tok-cocina'), body: { to: 'PREPARING', expected_version: O().version } })).code, 200);
    // versión desfasada: conflicto, sin cambios
    assert.equal((await t.api('POST', `/api/orders/${o.id}/status`, { headers: H('tok-cocina'), body: { to: 'READY', expected_version: 1 } })).json.error, 'VERSION_CONFLICT');
  } finally { t.close(); }
});

test('T07/T08/T09: comprobante repetido, sin pedido y reutilizado', async () => {
  const t = await setup({ media: { 'media-1': { bytes: PNG }, 'media-2': { bytes: PNG }, 'media-3': { bytes: Buffer.from('no-es-imagen') } } });
  try {
    // T08: imagen sin pedido identificable -> se pide referencia y no se asocia
    await t.sendWebhook([t.image('i0', WA)]); await t.pump();
    assert.match(t.out(WA).at(-1), /¿A qué pedido corresponde/);
    assert.equal(t.store.d.evidence.length, 0);
    const o = await reachAwaitingPayment(t); const O = () => t.store.d.orders.get(o.id);
    // tipo de archivo inválido: se rechaza antes de asociar
    await t.sendWebhook([t.image('i1', WA, 'media-3')]); await t.pump();
    assert.equal(O().status, 'AWAITING_PAYMENT'); assert.equal(t.store.d.evidence.length, 0);
    // T07: el mismo webhook de imagen repetido -> un solo archivo lógico
    await t.sendWebhook([t.image('i2', WA)]); await t.sendWebhook([t.image('i2', WA)]); await t.pump();
    assert.equal(t.store.d.evidence.length, 1); assert.equal(t.store.d.attachments.size, 1);
    // T09: se rechaza el pago; luego se reenvía la MISMA imagen -> hash igual queda marcado
    const pay = { id: [...t.store.d.payments.values()][0].id };
    await t.api('POST', `/api/payments/${pay.id}/reject`, { headers: H('tok-caja'), body: { reason: 'Monto no coincide' } });
    assert.equal(O().status, 'PAYMENT_ISSUE'); await t.pump();
    assert.match(t.out(WA).at(-1), /aclarar el pago/);
    await t.sendWebhook([t.image('i3', WA, 'media-2')]); await t.pump();
    assert.equal(O().status, 'UNDER_REVIEW');
    assert.equal(t.store.d.evidence.at(-1).review_status, 'DUPLICATE_HASH', 'hash igual detecta reutilización');
    assert.equal((await t.api('POST', `/api/payments/${pay.id}/reject`, { headers: H('tok-caja'), body: {} })).json.error, 'REASON_REQUIRED');
  } finally { t.close(); }
});

test('T12: solicitud de atención humana', async () => {
  const t = await setup();
  try {
    await t.sendWebhook([t.text('h1', WA, 'quiero hablar con una persona')]); await t.pump();
    assert.match(t.out(WA).at(-1), /una persona del local/);
    assert.equal(t.store.d.orders.size, 0);
  } finally { t.close(); }
});

test('PT-23 resiliencia del outbox: n8n caído y recuperación con backoff', async () => {
  const t = await setup();
  try {
    t.setN8n(false);
    await t.sendWebhook([t.text('o1', WA, 'Quiero dos hamburguesas para recojo')]);
    // el webhook ya respondió 200 y el evento quedó persistido aunque n8n no atiende
    let r = await t.app.dispatchOnce(t.deliver, t.now());
    assert.equal(r.delivered, 0); assert.equal(r.failed, 1);
    const ev = t.store.d.outbox[0];
    assert.equal(ev.processed_at, null); assert.equal(ev.attempts, 1); assert.equal(ev.next_attempt_at, t.now() + 2000, 'backoff exponencial');
    r = await t.app.dispatchOnce(t.deliver, t.now()); assert.equal(r.failed, 0, 'no reintenta antes de tiempo');
    t.setN8n(true); t.advance(2500);
    await t.pump();
    assert.notEqual(ev.processed_at, null);
    assert.equal(t.store.d.orders.size, 1, 'el pedido se procesó al volver n8n');
    assert.equal(t.orch.effects.drafts, 1, 'un solo efecto, sin duplicados');
    // entrega duplicada del mismo evento: n8n la descarta por event_id
    const before = t.orch.effects.drafts;
    await t.deliver(ev); await t.deliver(ev);
    assert.equal(t.orch.effects.drafts, before);
    // un evento que falla siempre termina en la cola de error
    t.setN8n(false); await t.sendWebhook([t.text('o2', WA, 'hola')]);
    for (let i = 0; i < 8; i++) { await t.app.dispatchOnce(t.deliver, t.now()); t.advance(200_000); }
    assert.equal(t.store.d.outbox.filter((e) => e.dead).length, 1, 'cola de error revisable');
  } finally { t.close(); }
});

test('Atomicidad: si falla la transacción no queda mensaje ni evento a medias', async () => {
  const t = await setup({ startN8n: false });
  try {
    const before = { m: t.store.d.messages.size, o: t.store.d.outbox.length };
    assert.throws(() => t.store.tx((d) => { d.messages.set('x', { id: 'x' }); d.outbox.push({ id: 'y' }); throw new Error('fallo simulado'); }));
    assert.equal(t.store.d.messages.size, before.m); assert.equal(t.store.d.outbox.length, before.o);
  } finally { t.close(); }
});

test('Seguridad de la API interna: sin secreto compartido no hay acceso', async () => {
  const t = await setup({ startN8n: false });
  try {
    assert.equal((await t.api('POST', '/internal/orders/draft/items', { body: {} })).code, 401);
    assert.equal((await t.api('POST', '/internal/messages', { headers: { 'x-internal-secret': 'mal' }, body: {} })).code, 401);
    assert.equal((await t.api('GET', '/health')).code, 200);
  } finally { t.close(); }
});

test('Máquina de estados: transiciones no permitidas se rechazan', async () => {
  const D = require('../src/domain');
  assert.equal(D.canTransition('QUOTED', 'CONFIRMED'), false);       // no se confirma sin pago verificado
  assert.equal(D.canTransition('AWAITING_PAYMENT', 'CONFIRMED'), false);
  assert.equal(D.canTransition('UNDER_REVIEW', 'CONFIRMED'), true);
  assert.equal(D.canTransition('COMPLETED', 'DRAFT'), false);
  assert.equal(D.fmt(4600), 'S/ 46.00');
});
