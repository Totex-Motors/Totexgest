-- AUTOCONF → TOTEX (09/11/2026): app "Totex Motors" no marketplace de apps do Autoconf (ERP das lojas).
-- O Autoconf manda um webhook quando a loja ativa o app (dados da loja, link do feed de estoque,
-- contato de quem ativou). Edge fn `autoconf-webhook` valida o segredo (config
-- AUTOCONF_WEBHOOK_SECRET), registra o evento, cria/atualiza a loja e provisiona o tenant.
-- Especificação: docs/INTEGRACAO-AUTOCONF.md

CREATE TABLE IF NOT EXISTS public.autoconf_stores (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id       text NOT NULL UNIQUE,               -- id da loja no Autoconf
  tenant_id      uuid,                               -- tenant provisionado no Totexgest
  name           text NOT NULL,
  legal_name     text, cnpj text, phone text, whatsapp text, email text, website text, logo_url text,
  address        jsonb,
  feed_url       text, feed_format text,
  activated_by   jsonb,
  status         text NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo','inativo')),
  activated_at   timestamptz, deactivated_at timestamptz,
  raw            jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.autoconf_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      text UNIQUE,                        -- idempotência (reenvio não duplica)
  event         text NOT NULL,
  store_id      text,
  payload       jsonb NOT NULL,
  normalized    jsonb,
  result        jsonb,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz
);
CREATE INDEX IF NOT EXISTS autoconf_events_store_idx ON public.autoconf_events(store_id, received_at DESC);

ALTER TABLE public.autoconf_stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.autoconf_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS autoconf_stores_admin ON public.autoconf_stores;
CREATE POLICY autoconf_stores_admin ON public.autoconf_stores FOR SELECT TO authenticated USING (public.is_superadmin() OR public.is_admin());
DROP POLICY IF EXISTS autoconf_events_admin ON public.autoconf_events;
CREATE POLICY autoconf_events_admin ON public.autoconf_events FOR SELECT TO authenticated USING (public.is_superadmin() OR public.is_admin());
GRANT SELECT ON public.autoconf_stores, public.autoconf_events TO authenticated;
GRANT ALL ON public.autoconf_stores, public.autoconf_events TO service_role;

-- Segredo compartilhado com o Autoconf (gerado uma vez; trocar aqui se vazar).
INSERT INTO public.config (key, value)
SELECT 'AUTOCONF_WEBHOOK_SECRET', encode(sha256((gen_random_uuid()::text || clock_timestamp()::text)::bytea), 'hex')
WHERE NOT EXISTS (SELECT 1 FROM config WHERE key = 'AUTOCONF_WEBHOOK_SECRET');

-- Repasse ao marketplace totexmotors.com (loja + integração AUTOCONF + sync) e retorno de leads.
ALTER TABLE public.autoconf_stores ADD COLUMN IF NOT EXISTS marketplace_dealership_id text;
ALTER TABLE public.autoconf_stores ADD COLUMN IF NOT EXISTS marketplace_integration_id text;
ALTER TABLE public.autoconf_stores ADD COLUMN IF NOT EXISTS marketplace_result jsonb;
ALTER TABLE public.autoconf_stores ADD COLUMN IF NOT EXISTS lead_webhook_url text;

-- Correção de rumo (Marco, 09/11): lojista Autoconf NÃO ganha tenant no Totexgest — trabalha no CRM do
-- Autoconf e os leads vão pra lá. autoconf_stores.tenant_id fica nulo (coluna mantida). Cada entrega de
-- lead (site → marketplace usa Dealership.leadWebhookUrl; stand → stand-handoff/_shared/autoconf-leads.ts)
-- fica registrada aqui. Destino: autoconf_stores.lead_webhook_url ou config AUTOCONF_LEADS_URL (?store_id=),
-- token opcional em config AUTOCONF_LEADS_TOKEN.
CREATE TABLE IF NOT EXISTS public.autoconf_lead_deliveries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id     text NOT NULL,
  lead_id      uuid,
  origem       text,
  url          text,
  status       text NOT NULL CHECK (status IN ('entregue','falhou','sem_destino')),
  http_status  integer,
  erro         text,
  payload      jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS autoconf_lead_deliveries_store_idx ON public.autoconf_lead_deliveries(store_id, created_at DESC);
ALTER TABLE public.autoconf_lead_deliveries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS autoconf_lead_deliveries_admin ON public.autoconf_lead_deliveries;
CREATE POLICY autoconf_lead_deliveries_admin ON public.autoconf_lead_deliveries FOR SELECT TO authenticated USING (public.is_superadmin() OR public.is_admin());
GRANT SELECT ON public.autoconf_lead_deliveries TO authenticated;
GRANT ALL ON public.autoconf_lead_deliveries TO service_role;
