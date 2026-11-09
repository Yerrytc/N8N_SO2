'use strict';
// Reglas de negocio deterministas: precios en céntimos, máquina de estados y catálogo.
const crypto = require('node:crypto');

const CATALOG = [
  { id: 'p1', sku: 'BURG-CLS', name: 'Hamburguesa clásica', price_cents: 1600, available: true, active: true },
  { id: 'p2', sku: 'GAS-15', name: 'Gaseosa 1.5 L', price_cents: 900, available: true, active: true },
  { id: 'p3', sku: 'PAP-FRI', name: 'Papas fritas', price_cents: 700, available: true, active: true },
  { id: 'p4', sku: 'INCA-GR', name: 'Inca Kola grande', price_cents: 1000, available: false, active: true },
];
const ZONES = { centro: 500, norte: 700 };

// Transiciones permitidas (figura 4 del informe)
const TRANSITIONS = {
  DRAFT: ['QUOTED', 'CANCELLED'],
  QUOTED: ['AWAITING_PAYMENT', 'CANCELLED'],
  AWAITING_PAYMENT: ['UNDER_REVIEW', 'CANCELLED'],
  UNDER_REVIEW: ['CONFIRMED', 'PAYMENT_ISSUE'],
  PAYMENT_ISSUE: ['UNDER_REVIEW'],
  CONFIRMED: ['PREPARING'],
  PREPARING: ['READY'],
  READY: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
};
const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

const ROLE_PERMS = {
  ADMIN: ['orders:read', 'orders:status', 'payments:verify', 'payments:override', 'evidence:view', 'audit:read'],
  CASHIER: ['orders:read', 'payments:verify', 'evidence:view'],
  OPERATOR: ['orders:read'],
  KITCHEN: ['kitchen:read', 'orders:status'],
  AUDITOR: ['orders:read', 'audit:read'],
};
const can = (role, perm) => (ROLE_PERMS[role] || []).includes(perm);

const fmt = (c) => 'S/ ' + (c / 100).toFixed(2);
const uuid = () => crypto.randomUUID();
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function sniffMime(buf) {
  if (buf.length >= 8 && buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image/png';
  if (buf.length >= 3 && buf.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  return null;
}

module.exports = { CATALOG, ZONES, TRANSITIONS, canTransition, can, fmt, uuid, sha256, sniffMime };
