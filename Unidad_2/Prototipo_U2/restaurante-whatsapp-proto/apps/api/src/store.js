'use strict';
// Almacén en memoria con transacciones por instantánea. Hace el papel de PostgreSQL en la
// prueba de concepto; el esquema real se prueba aparte en tests/sql con PostgreSQL 16.
const { CATALOG } = require('./domain');

class Store {
  constructor() { this.reset(); }
  reset() {
    this.d = {
      products: CATALOG.map((p) => ({ ...p })),
      customers: new Map(), // wa_id -> customer
      messages: new Map(), // provider_message_id -> message
      orders: new Map(), // id -> order
      items: [], // order_items
      payments: new Map(),
      attachments: new Map(), // sha256 -> attachment
      evidence: [],
      outbox: [],
      audit: [],
      outbound: [],
      idem: new Map(),
      seq: 1000,
    };
  }
  // Atómico: si fn lanza una excepción, se restaura el estado anterior.
  tx(fn) {
    const snap = structuredClone(this.d);
    try { return fn(this.d); } catch (e) { this.d = snap; throw e; }
  }
  nextCode() { return 'PED-' + (++this.d.seq); }
}
module.exports = { Store };
