'use strict';
// Despachador de outbox (contenedor "outbox-worker"): entrega eventos firmados a n8n con reintentos exponenciales.
// En la prueba de concepto la cola vive en el proceso de la API; en producción se lee de event_outbox con SKIP LOCKED.
console.log('outbox-worker: ver createApp().dispatchOnce() en app.js; la lectura de event_outbox se implementa en la III Unidad');
setInterval(() => {}, 60_000);
