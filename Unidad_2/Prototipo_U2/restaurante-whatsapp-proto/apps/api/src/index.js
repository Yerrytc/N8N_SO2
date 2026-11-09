'use strict';
// Punto de entrada del contenedor "api" (prueba de concepto: almacén en memoria; en producción, PostgreSQL/Supabase).
const { Store } = require('./store');
const { createApp } = require('./app');
const config = {
  appSecret: process.env.META_APP_SECRET, verifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN,
  internalSecret: process.env.INTERNAL_API_SECRET, maxMediaBytes: 5 * 1024 * 1024, users: {},
};
for (const k of ['appSecret', 'verifyToken', 'internalSecret']) if (!config[k]) { console.error('Falta configuración: ' + k); process.exit(1); }
const mediaFetcher = async () => { throw new Error('Descarga de medios no implementada en la prueba de concepto'); };
const app = createApp({ store: new Store(), config, mediaFetcher });
app.server.listen(3000, '0.0.0.0', () => console.log('api escuchando en :3000'));
