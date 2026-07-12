-- ============================================================
-- DRIFT: WhatsApp Cloud API multi-número + auditoria de config
-- ------------------------------------------------------------
-- Versiona mudanças que foram aplicadas direto em produção
-- (Onda 5 — WhatsApp multi-número + coexistência + janela CTWA).
-- Idempotente: seguro rodar em banco existente (no-op) ou novo.
-- ============================================================

-- ---------- whatsapp_instances: suporte multi-provider ----------
-- provider: 'uazapi' (QR code, não-oficial) | 'meta_cloud' (API oficial Meta)
ALTER TABLE whatsapp_instances
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'uazapi',
  ADD COLUMN IF NOT EXISTS phone_number_id text,
  ADD COLUMN IF NOT EXISTS business_account_id text,
  ADD COLUMN IF NOT EXISTS verify_token text,
  ADD COLUMN IF NOT EXISTS pipeline_ids uuid[],
  ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'inbox';

-- ---------- whatsapp_messages: janela CTWA (72h, Click-to-WhatsApp Ads) ----------
ALTER TABLE whatsapp_messages
  ADD COLUMN IF NOT EXISTS ctwa_referral jsonb;

-- ---------- whatsapp_cloud_templates: colunas usadas pelo front + sync ----------
ALTER TABLE whatsapp_cloud_templates
  ADD COLUMN IF NOT EXISTS variables_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS internal_tags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS last_synced_at timestamptz;

-- Índice único exigido pelo upsert do sync (onConflict tenant_id,name,language)
CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_cloud_templates_tenant_name_lang
  ON whatsapp_cloud_templates (tenant_id, name, language);

-- ---------- config_audit_log: alvo do trigger fn_config_audit ----------
CREATE TABLE IF NOT EXISTS config_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name text,
  record_id text,
  action text,
  changed_by_user_id uuid,
  changed_by_name text,
  old_data jsonb,
  new_data jsonb,
  changed_fields text[],
  tenant_id uuid,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE config_audit_log ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  DROP POLICY IF EXISTS config_audit_authenticated_read ON config_audit_log;
  CREATE POLICY config_audit_authenticated_read ON config_audit_log
    FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- team_member_whatsapp_cloud_access: grants de instância Cloud ----------
CREATE TABLE IF NOT EXISTS team_member_whatsapp_cloud_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_member_id uuid,
  instance_id uuid,
  tenant_id uuid DEFAULT get_tenant_id(),
  created_at timestamptz DEFAULT now()
);
ALTER TABLE team_member_whatsapp_cloud_access ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  DROP POLICY IF EXISTS tm_cloud_access_tenant ON team_member_whatsapp_cloud_access;
  CREATE POLICY tm_cloud_access_tenant ON team_member_whatsapp_cloud_access
    FOR ALL TO authenticated
    USING (tenant_id = get_tenant_id())
    WITH CHECK (tenant_id = get_tenant_id());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
