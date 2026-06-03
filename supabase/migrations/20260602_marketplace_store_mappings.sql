-- Mapeamento entre IDs de loja do marketplace Totex e tenant_ids do CRM
CREATE TABLE IF NOT EXISTS marketplace_store_mappings (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  marketplace_store_id TEXT        NOT NULL,
  store_name           TEXT        NOT NULL,
  tenant_id            UUID        NOT NULL REFERENCES tenants(id),
  active               BOOLEAN     NOT NULL DEFAULT true,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_marketplace_store_mappings_store_id
  ON marketplace_store_mappings(marketplace_store_id);

ALTER TABLE marketplace_store_mappings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "marketplace_mappings_authenticated_all" ON marketplace_store_mappings
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION update_marketplace_store_mappings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_marketplace_mappings_updated_at ON marketplace_store_mappings;
CREATE TRIGGER trg_marketplace_mappings_updated_at
  BEFORE UPDATE ON marketplace_store_mappings
  FOR EACH ROW EXECUTE FUNCTION update_marketplace_store_mappings_updated_at();

COMMENT ON TABLE marketplace_store_mappings IS
  'Mapeia loja.id do marketplace totexmotors.com para tenant_id do CRM. Gerenciado via /comercial/marketplace.';
