-- ============================================================================
-- COMUNIDADE — "Janela de Oportunidades" (modelo soft) + captura de demanda
--
-- A IA abre uma janela por tempo limitado ("manda o carro que você procura"),
-- captura e qualifica a demanda que chega no período, e fecha com um resumo.
-- Não tranca o grupo (a Comunidade do WhatsApp não permite via API) — o senso
-- de escassez vem do ritual (hora marcada + tempo limitado + fecho com contagem).
--
--   community_engagement  — config: qual grupo, agenda das janelas, textos, tom
--   community_windows     — cada janela aberta (abre/fecha, contagem)
--   community_demand      — pedidos captados (carro que o membro procura) + match
-- ============================================================================

-- ─── Config ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.community_engagement (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL DEFAULT public.get_tenant_id(),
  instance_id        uuid NOT NULL REFERENCES public.whatsapp_instances(id) ON DELETE CASCADE,
  community_group_jid text NOT NULL,
  timezone           text NOT NULL DEFAULT 'America/Sao_Paulo',
  -- Agenda: array de { dow:0-6 (0=domingo), time:"HH:MM", duration_min:int }
  windows            jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Textos (placeholders: {DURACAO} na abertura, {QTD} no fechamento)
  open_template      text NOT NULL DEFAULT '🚗 *JANELA DE OPORTUNIDADES ABERTA!* ⏱️\n\nPelos próximos {DURACAO} minutos: me manda aqui o *carro que você está procurando* (modelo, ano e faixa de preço) que eu já saio caçando pra você. 👇',
  close_template     text NOT NULL DEFAULT '⛔ *Janela encerrada!* Recebi {QTD} pedido(s) e já vou atrás. Fica de olho que quando achar o seu, te chamo. 🚗💨',
  duration_default   int NOT NULL DEFAULT 30,
  ack_reaction       text NOT NULL DEFAULT '👍',  -- reação da IA em cada pedido (vazio = sem reação)
  model              text NOT NULL DEFAULT 'claude-sonnet-4-6',
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS community_engagement_instance_idx
  ON public.community_engagement (instance_id) WHERE active;
CREATE INDEX IF NOT EXISTS community_engagement_tenant_idx
  ON public.community_engagement (tenant_id);

-- ─── Janelas abertas ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.community_windows (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid,
  config_id    uuid NOT NULL REFERENCES public.community_engagement(id) ON DELETE CASCADE,
  -- chave do slot agendado (ex: "2026-09-15T19:00") ou "manual-<ts>" — evita abrir 2x
  slot_key     text NOT NULL,
  opened_at    timestamptz NOT NULL DEFAULT now(),
  closes_at    timestamptz NOT NULL,
  closed_at    timestamptz,
  status       text NOT NULL DEFAULT 'open',   -- open | closed
  opened_by    text NOT NULL DEFAULT 'schedule', -- schedule | manual
  demand_count int NOT NULL DEFAULT 0,
  CONSTRAINT community_windows_slot_uniq UNIQUE (config_id, slot_key)
);
CREATE INDEX IF NOT EXISTS community_windows_open_idx
  ON public.community_windows (config_id, status, closes_at);

-- ─── Demanda captada ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.community_demand (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid,
  config_id     uuid REFERENCES public.community_engagement(id) ON DELETE SET NULL,
  window_id     uuid REFERENCES public.community_windows(id) ON DELETE SET NULL,
  source_message_id text,
  member_phone  text,
  member_name   text,
  raw_text      text,
  modelo        text,
  ano           text,
  faixa_min     numeric,
  faixa_max     numeric,
  observacao    text,
  -- new | matched | contacted | descartado
  status        text NOT NULL DEFAULT 'new',
  matched_car   jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS community_demand_created_idx
  ON public.community_demand (created_at DESC);
CREATE INDEX IF NOT EXISTS community_demand_status_idx
  ON public.community_demand (tenant_id, status);
-- idempotência: não capta a mesma mensagem 2x
CREATE UNIQUE INDEX IF NOT EXISTS community_demand_msg_uniq
  ON public.community_demand (source_message_id) WHERE source_message_id IS NOT NULL;

-- ─── updated_at ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.touch_community_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;
DROP TRIGGER IF EXISTS trg_touch_community_engagement ON public.community_engagement;
CREATE TRIGGER trg_touch_community_engagement BEFORE UPDATE ON public.community_engagement
  FOR EACH ROW EXECUTE FUNCTION public.touch_community_updated_at();
DROP TRIGGER IF EXISTS trg_touch_community_demand ON public.community_demand;
CREATE TRIGGER trg_touch_community_demand BEFORE UPDATE ON public.community_demand
  FOR EACH ROW EXECUTE FUNCTION public.touch_community_updated_at();

-- ─── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.community_engagement ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_windows    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_demand      ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.community_engagement TO authenticated;
GRANT SELECT ON public.community_windows TO authenticated;
GRANT SELECT, UPDATE ON public.community_demand TO authenticated;
GRANT ALL ON public.community_engagement TO service_role;
GRANT ALL ON public.community_windows    TO service_role;
GRANT ALL ON public.community_demand      TO service_role;

DROP POLICY IF EXISTS community_engagement_all ON public.community_engagement;
CREATE POLICY community_engagement_all ON public.community_engagement
  FOR ALL TO authenticated
  USING ((tenant_id = public.get_tenant_id() AND public.is_admin()) OR public.is_superadmin())
  WITH CHECK ((tenant_id = public.get_tenant_id() AND public.is_admin()) OR public.is_superadmin());

DROP POLICY IF EXISTS community_windows_select ON public.community_windows;
CREATE POLICY community_windows_select ON public.community_windows
  FOR SELECT TO authenticated
  USING ((tenant_id = public.get_tenant_id() AND public.is_admin()) OR public.is_superadmin());

DROP POLICY IF EXISTS community_demand_rw ON public.community_demand;
CREATE POLICY community_demand_rw ON public.community_demand
  FOR ALL TO authenticated
  USING ((tenant_id = public.get_tenant_id() AND public.is_admin()) OR public.is_superadmin())
  WITH CHECK ((tenant_id = public.get_tenant_id() AND public.is_admin()) OR public.is_superadmin());

COMMENT ON TABLE public.community_engagement IS 'Janela de Oportunidades (soft): agenda de aberturas da IA na comunidade + captura de demanda.';
COMMENT ON TABLE public.community_demand IS 'Pedidos de carro captados nas janelas (demanda), com match contra os carros do repasse.';

-- ─── Cron: agendador das janelas (a cada 1 min) ──────────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
DO $$ BEGIN PERFORM cron.unschedule('community-window-tick-1min'); EXCEPTION WHEN OTHERS THEN NULL; END $$;
SELECT cron.schedule(
  'community-window-tick-1min',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://mztfyavuclqzivywkaeu.supabase.co/functions/v1/community-window-tick',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
  $$
);
