\set ON_ERROR_STOP off
\pset format unaligned
\pset tuples_only on
-- Datos base
INSERT INTO customers(id,wa_id) VALUES ('00000000-0000-0000-0000-0000000000c1','51999000111');
INSERT INTO products(id,sku,name,price_cents) VALUES ('00000000-0000-0000-0000-0000000000a1','BURG-CLS','Hamburguesa clásica',1600);
INSERT INTO orders(id,code,customer_id,status,total_cents) VALUES ('00000000-0000-0000-0000-0000000000b1','PED-1001','00000000-0000-0000-0000-0000000000c1','AWAITING_PAYMENT',3200);

\echo S1 idempotencia: el mismo wamid dos veces (esperado: segundo INSERT rechazado por UNIQUE)
INSERT INTO messages(id,provider_message_id,customer_id,direction,kind) VALUES (gen_random_uuid(),'wamid.A','00000000-0000-0000-0000-0000000000c1','IN','text');
INSERT INTO messages(id,provider_message_id,customer_id,direction,kind) VALUES (gen_random_uuid(),'wamid.A','00000000-0000-0000-0000-0000000000c1','IN','text');
SELECT 'S1 filas con wamid.A = ' || count(*) FROM messages WHERE provider_message_id='wamid.A';

\echo S2 precio negativo (esperado: rechazo por CHECK)
INSERT INTO products(id,sku,name,price_cents) VALUES (gen_random_uuid(),'X-NEG','Negativo',-5);

\echo S3 estado inválido de pedido (esperado: rechazo por CHECK)
UPDATE orders SET status='PAGADO' WHERE code='PED-1001';

\echo S4 línea de pedido con total incoherente (esperado: rechazo por CHECK)
INSERT INTO order_items VALUES (gen_random_uuid(),'00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000a1','Hamburguesa clásica',2,1600,9999);
INSERT INTO order_items VALUES (gen_random_uuid(),'00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000a1','Hamburguesa clásica',2,1600,3200);

\echo S5 pago VERIFIED sin responsable (esperado: rechazo por CHECK)
INSERT INTO payments(id,order_id,method,expected_amount_cents,status) VALUES ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000b1','TRANSFER',3200,'PENDING');
UPDATE payments SET status='VERIFIED' WHERE id='00000000-0000-0000-0000-0000000000d1';
UPDATE payments SET status='VERIFIED', verified_by='00000000-0000-0000-0000-0000000000e1', verified_at=NOW() WHERE id='00000000-0000-0000-0000-0000000000d1';
SELECT 'S5 estado final del pago = ' || status FROM payments WHERE id='00000000-0000-0000-0000-0000000000d1';

\echo S6 clave foránea: línea para un pedido inexistente (esperado: rechazo)
INSERT INTO order_items VALUES (gen_random_uuid(),gen_random_uuid(),'00000000-0000-0000-0000-0000000000a1','x',1,100,100);

\echo S7 hash de comprobante mal formado (esperado: rechazo por CHECK)
INSERT INTO attachments(id,storage_key,mime_type,size_bytes,sha256) VALUES (gen_random_uuid(),'proofs/mal','image/png',10,'abc');

\echo S8 atomicidad mensaje + outbox: ROLLBACK no deja filas a medias
BEGIN;
INSERT INTO messages(id,provider_message_id,customer_id,direction,kind) VALUES (gen_random_uuid(),'wamid.B','00000000-0000-0000-0000-0000000000c1','IN','text');
INSERT INTO event_outbox(id,event_type,payload) VALUES (gen_random_uuid(),'message.received','{}');
ROLLBACK;
SELECT 'S8 mensajes wamid.B = ' || count(*) || ', eventos outbox = ' || (SELECT count(*) FROM event_outbox) FROM messages WHERE provider_message_id='wamid.B';
BEGIN;
INSERT INTO messages(id,provider_message_id,customer_id,direction,kind) VALUES (gen_random_uuid(),'wamid.C','00000000-0000-0000-0000-0000000000c1','IN','text');
INSERT INTO event_outbox(id,event_type,payload) VALUES (gen_random_uuid(),'message.received','{"wamid":"wamid.C"}');
COMMIT;
SELECT 'S8 tras COMMIT: mensajes wamid.C = ' || count(*) || ', eventos outbox = ' || (SELECT count(*) FROM event_outbox) FROM messages WHERE provider_message_id='wamid.C';

\echo S9 consulta de reclamo del outbox con FOR UPDATE SKIP LOCKED (sintaxis y ejecución; la concurrencia real se prueba en la III Unidad)
INSERT INTO event_outbox(id,event_type,payload) VALUES (gen_random_uuid(),'payment.proof_received','{}');
SELECT 'S9 pendientes = ' || count(*) FROM event_outbox WHERE processed_at IS NULL;
BEGIN;
SELECT 'S9 consumidor A reclama ' || count(*) FROM (SELECT id FROM event_outbox WHERE processed_at IS NULL AND next_attempt_at <= NOW() ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) a;
COMMIT;

\echo S10 auditoría de solo inserción (esperado: UPDATE y DELETE rechazados)
INSERT INTO audit_log(id,actor,action,entity_id,after) VALUES ('00000000-0000-0000-0000-0000000000f1','u-caja','payment.verify','00000000-0000-0000-0000-0000000000d1','{"status":"VERIFIED"}');
UPDATE audit_log SET actor='otro' WHERE id='00000000-0000-0000-0000-0000000000f1';
DELETE FROM audit_log WHERE id='00000000-0000-0000-0000-0000000000f1';
SELECT 'S10 filas de auditoría = ' || count(*) || ', actor = ' || max(actor) FROM audit_log;
