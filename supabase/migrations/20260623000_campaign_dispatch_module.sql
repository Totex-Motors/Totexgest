-- ============================================================================
-- 20260623_campaign_dispatch_module.sql
-- Módulo de disparo de campanhas (Email via Resend + WhatsApp) + Automações
--
-- Porta do repo crm-aifirst-totex, adaptado ao padrão multi-tenant do totexgest:
--   - tenant_id uuid NOT NULL em todas as tabelas
--   - RLS por public.get_tenant_id() (mesmo padrão de email_campaigns)
--   - Edge functions usam service_role (bypassam RLS) e passam tenant_id explícito
--
-- As tabelas de campanha "core" (campaigns, email_campaigns, campaign_leads,
-- email_campaign_leads, email_templates, email_unsubscribes, etc.) JÁ existem no
-- 000_base_schema.sql. Esta migration adiciona só o que faltava + colunas novas.
--
-- NOTA DE COLISÃO: o remote usa `email_automation_runs` pro motor visual de
-- fluxos. O totexgest JÁ tem `email_automation_runs` (20260410) com outro schema
-- (idempotência do action send_email das sales_automation_rules). Pra não quebrar
-- aquela feature, o motor de fluxos aqui usa `email_flow_runs`.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) tenant_email_config — config Resend por loja (1 row por tenant)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tenant_email_config (
  tenant_id             uuid PRIMARY KEY,
  resend_api_key        text,
  resend_webhook_secret text,
  from_email            text,
  from_name             text,
  reply_to              text,
  company_address       text,
  company_name          text,
  app_url               text,
  is_active             boolean NOT NULL DEFAULT false,
  domain_verified       boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.tenant_email_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_email_config_tenant ON public.tenant_email_config;
CREATE POLICY tenant_email_config_tenant ON public.tenant_email_config
  USING (tenant_id = public.get_tenant_id())
  WITH CHECK (tenant_id = public.get_tenant_id());

DROP TRIGGER IF EXISTS trg_tenant_email_config_updated_at ON public.tenant_email_config;
CREATE TRIGGER trg_tenant_email_config_updated_at
  BEFORE UPDATE ON public.tenant_email_config
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 2) email_lists — listas/segmentos salvos (critério de audiência)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.email_lists (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  name        text NOT NULL,
  description text,
  criteria    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_lists_tenant ON public.email_lists(tenant_id);

ALTER TABLE public.email_lists ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS email_lists_tenant ON public.email_lists;
CREATE POLICY email_lists_tenant ON public.email_lists
  USING (tenant_id = public.get_tenant_id())
  WITH CHECK (tenant_id = public.get_tenant_id());

DROP TRIGGER IF EXISTS trg_email_lists_updated_at ON public.email_lists;
CREATE TRIGGER trg_email_lists_updated_at
  BEFORE UPDATE ON public.email_lists
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 3) email_subscribers — status de consentimento por email (opt-out/bounce)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.email_subscribers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  email             text NOT NULL,
  lead_id           uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  status            text NOT NULL DEFAULT 'subscribed'
                      CHECK (status IN ('subscribed','unsubscribed','bounced','complained')),
  unsubscribe_token uuid NOT NULL DEFAULT gen_random_uuid(),
  bounce_reason     text,
  consent_source    text,
  consent_at        timestamptz,
  unsubscribed_at   timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_subscribers_tenant_email_uniq UNIQUE (tenant_id, email)
);

CREATE INDEX IF NOT EXISTS idx_email_subscribers_tenant ON public.email_subscribers(tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_subscribers_token ON public.email_subscribers(unsubscribe_token);

ALTER TABLE public.email_subscribers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS email_subscribers_tenant ON public.email_subscribers;
CREATE POLICY email_subscribers_tenant ON public.email_subscribers
  USING (tenant_id = public.get_tenant_id())
  WITH CHECK (tenant_id = public.get_tenant_id());

DROP TRIGGER IF EXISTS trg_email_subscribers_updated_at ON public.email_subscribers;
CREATE TRIGGER trg_email_subscribers_updated_at
  BEFORE UPDATE ON public.email_subscribers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 4) email_sends — 1 row por email enviado (tracking individual via Resend)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.email_sends (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  campaign_id   uuid REFERENCES public.email_campaigns(id) ON DELETE CASCADE,
  lead_id       uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  email         text NOT NULL,
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','sent','delivered','opened','clicked','bounced','complained','failed')),
  html          text,
  resend_id     text,
  sent_at       timestamptz,
  delivered_at  timestamptz,
  opened_at     timestamptz,
  clicked_at    timestamptz,
  bounced_at    timestamptz,
  open_count    integer NOT NULL DEFAULT 0,
  click_count   integer NOT NULL DEFAULT 0,
  clicked_url   text,
  bounce_reason text,
  error_message text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_sends_tenant ON public.email_sends(tenant_id);
CREATE INDEX IF NOT EXISTS idx_email_sends_campaign ON public.email_sends(campaign_id);
CREATE INDEX IF NOT EXISTS idx_email_sends_resend ON public.email_sends(resend_id);
CREATE INDEX IF NOT EXISTS idx_email_sends_lead ON public.email_sends(lead_id);

ALTER TABLE public.email_sends ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS email_sends_tenant ON public.email_sends;
CREATE POLICY email_sends_tenant ON public.email_sends
  USING (tenant_id = public.get_tenant_id())
  WITH CHECK (tenant_id = public.get_tenant_id());

-- ----------------------------------------------------------------------------
-- 5) email_events — eventos brutos do webhook Resend (auditoria)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.email_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL,
  send_id    uuid REFERENCES public.email_sends(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  payload    jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_events_tenant ON public.email_events(tenant_id);
CREATE INDEX IF NOT EXISTS idx_email_events_send ON public.email_events(send_id);

ALTER TABLE public.email_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS email_events_tenant ON public.email_events;
CREATE POLICY email_events_tenant ON public.email_events
  USING (tenant_id = public.get_tenant_id())
  WITH CHECK (tenant_id = public.get_tenant_id());

-- ----------------------------------------------------------------------------
-- 6) email_automations — motor visual de fluxos (gatilho -> flow JSON)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.email_automations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  name           text NOT NULL,
  description    text,
  trigger_event  text NOT NULL,
  trigger_filter jsonb NOT NULL DEFAULT '{}'::jsonb,
  flow_json      jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_automations_tenant ON public.email_automations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_email_automations_trigger
  ON public.email_automations(tenant_id, trigger_event) WHERE is_active;

ALTER TABLE public.email_automations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS email_automations_tenant ON public.email_automations;
CREATE POLICY email_automations_tenant ON public.email_automations
  USING (tenant_id = public.get_tenant_id())
  WITH CHECK (tenant_id = public.get_tenant_id());

DROP TRIGGER IF EXISTS trg_email_automations_updated_at ON public.email_automations;
CREATE TRIGGER trg_email_automations_updated_at
  BEFORE UPDATE ON public.email_automations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 7) email_flow_runs — execuções do motor de fluxos (node-walking)
--    (renomeada de email_automation_runs do remote pra evitar colisão)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.email_flow_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  automation_id     uuid NOT NULL REFERENCES public.email_automations(id) ON DELETE CASCADE,
  lead_id           uuid REFERENCES public.leads(id) ON DELETE CASCADE,
  current_node_id   text,
  scheduled_next_at timestamptz,
  status            text NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','completed','cancelled','failed')),
  context           jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_flow_runs_tenant ON public.email_flow_runs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_email_flow_runs_due
  ON public.email_flow_runs(scheduled_next_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_email_flow_runs_automation ON public.email_flow_runs(automation_id);

ALTER TABLE public.email_flow_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS email_flow_runs_tenant ON public.email_flow_runs;
CREATE POLICY email_flow_runs_tenant ON public.email_flow_runs
  USING (tenant_id = public.get_tenant_id())
  WITH CHECK (tenant_id = public.get_tenant_id());

-- ----------------------------------------------------------------------------
-- 8) whatsapp_cloud_templates — templates Meta WhatsApp Cloud por tenant
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.whatsapp_cloud_templates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  meta_template_id text,
  meta_waba_id     text,
  name             text NOT NULL,
  language         text NOT NULL DEFAULT 'pt_BR',
  category         text,
  status           text NOT NULL DEFAULT 'PENDING',
  components       jsonb,
  variables_count  integer NOT NULL DEFAULT 0,
  quality_score    text,
  rejected_reason  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_cloud_templates_tenant_name_lang_uniq UNIQUE (tenant_id, name, language)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_cloud_templates_tenant ON public.whatsapp_cloud_templates(tenant_id);

ALTER TABLE public.whatsapp_cloud_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS whatsapp_cloud_templates_tenant ON public.whatsapp_cloud_templates;
CREATE POLICY whatsapp_cloud_templates_tenant ON public.whatsapp_cloud_templates
  USING (tenant_id = public.get_tenant_id())
  WITH CHECK (tenant_id = public.get_tenant_id());

DROP TRIGGER IF EXISTS trg_whatsapp_cloud_templates_updated_at ON public.whatsapp_cloud_templates;
CREATE TRIGGER trg_whatsapp_cloud_templates_updated_at
  BEFORE UPDATE ON public.whatsapp_cloud_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 9) Colunas novas em email_campaigns usadas pelo módulo (idempotente)
-- ----------------------------------------------------------------------------
ALTER TABLE public.email_campaigns
  ADD COLUMN IF NOT EXISTS settings      jsonb,
  ADD COLUMN IF NOT EXISTS list_id       uuid REFERENCES public.email_lists(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_type   text NOT NULL DEFAULT 'campaign',
  ADD COLUMN IF NOT EXISTS automation_id uuid REFERENCES public.email_automations(id) ON DELETE SET NULL;
