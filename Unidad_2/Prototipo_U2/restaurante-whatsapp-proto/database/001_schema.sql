-- Esquema orientativo del documento de arquitectura (sec. 5.3), con las restricciones que
-- el propio documento indicaba como pendientes: estados válidos, unicidad y claves foráneas.
CREATE TABLE customers (
  id UUID PRIMARY KEY,
  wa_id TEXT NOT NULL UNIQUE,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE products (
  id UUID PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  price_cents BIGINT NOT NULL CHECK (price_cents >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'PEN',
  available BOOLEAN NOT NULL DEFAULT TRUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE orders (
  id UUID PRIMARY KEY,
  code TEXT UNIQUE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  status TEXT NOT NULL CHECK (status IN ('DRAFT','QUOTED','AWAITING_PAYMENT','UNDER_REVIEW','PAYMENT_ISSUE','CONFIRMED','PREPARING','READY','COMPLETED','CANCELLED')),
  total_cents BIGINT NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE order_items (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES orders(id),
  product_id UUID NOT NULL REFERENCES products(id),
  product_name_snapshot TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents BIGINT NOT NULL CHECK (unit_price_cents >= 0),
  line_total_cents BIGINT NOT NULL CHECK (line_total_cents >= 0),
  CHECK (line_total_cents = quantity * unit_price_cents)
);
CREATE TABLE messages (
  id UUID PRIMARY KEY,
  provider_message_id TEXT UNIQUE,
  customer_id UUID REFERENCES customers(id),
  direction TEXT NOT NULL CHECK (direction IN ('IN', 'OUT')),
  kind TEXT NOT NULL,
  delivery_status TEXT,
  payload JSONB,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE payments (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES orders(id),
  method TEXT NOT NULL,
  expected_amount_cents BIGINT NOT NULL CHECK (expected_amount_cents >= 0),
  status TEXT NOT NULL CHECK (status IN ('PENDING','VERIFIED','REJECTED')),
  verified_by UUID,
  verified_at TIMESTAMPTZ,
  -- un pago verificado exige actor y fecha (nunca "verificado" sin responsable)
  CHECK (status <> 'VERIFIED' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL))
);
CREATE TABLE attachments (
  id UUID PRIMARY KEY,
  storage_key TEXT NOT NULL UNIQUE,
  media_provider_id TEXT,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE payment_evidence (
  id UUID PRIMARY KEY,
  payment_id UUID NOT NULL REFERENCES payments(id),
  attachment_id UUID NOT NULL REFERENCES attachments(id),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  review_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (review_status IN ('PENDING','APPROVED','REJECTED','DUPLICATE_HASH'))
);
CREATE TABLE event_outbox (
  id UUID PRIMARY KEY,
  event_type TEXT NOT NULL,
  aggregate_id UUID,
  payload JSONB NOT NULL,
  processed_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE audit_log (
  id UUID PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_id UUID,
  before JSONB,
  after JSONB,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Impide dos pedidos activos de pago simultáneo con la misma evidencia reutilizada en el mismo pago
CREATE UNIQUE INDEX uq_evidence_payment_attachment ON payment_evidence(payment_id, attachment_id);
CREATE INDEX idx_outbox_pending ON event_outbox(next_attempt_at) WHERE processed_at IS NULL;
CREATE INDEX idx_orders_status ON orders(status);
-- Auditoría de solo inserción: se impide UPDATE y DELETE ("inmutable en lo lógico", sec. 12.1)
CREATE FUNCTION audit_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'audit_log es de solo inserción'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_audit_immutable BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_immutable();
