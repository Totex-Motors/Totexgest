-- Mapeamento entre IDs de loja da Credere e tenant_ids do CRM
CREATE TABLE IF NOT EXISTS credere_store_mappings (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  credere_store_id TEXT   NOT NULL,
  store_name  TEXT        NOT NULL,
  tenant_id   UUID        NOT NULL,
  active      BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_credere_store_mappings_store_id
  ON credere_store_mappings(credere_store_id);

ALTER TABLE credere_store_mappings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "credere_mappings_authenticated_all" ON credere_store_mappings
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION update_credere_store_mappings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_credere_mappings_updated_at ON credere_store_mappings;
CREATE TRIGGER trg_credere_mappings_updated_at
  BEFORE UPDATE ON credere_store_mappings
  FOR EACH ROW EXECUTE FUNCTION update_credere_store_mappings_updated_at();

COMMENT ON TABLE credere_store_mappings IS 'Mapeia store.id da Credere para tenant_id do CRM. Gerenciado via /comercial/credere.';
