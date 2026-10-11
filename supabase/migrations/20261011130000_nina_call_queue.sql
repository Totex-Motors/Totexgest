-- ============================================================================
-- NINA (voz) — Fase B: a Nina LIGA pro cliente (2026-10-11) — docs/NINA-VOZ.md §2d
--
-- Fila de ligações de saída + permissão de ligação da Meta + auto-enfileirar quando
-- o lead entra (promotora no stand, QR Code, totem). Quem disca é a edge fn
-- `nina-dialer` (cron a cada 2 min, horário comercial do SLA). Resultado volta pelo
-- `voice-agent-postcall` (ElevenLabs) e, se não atendeu, o agente de WhatsApp manda
-- "tentei te ligar, qual horário?".
--
-- APLICAR VIA SQL EDITOR (CREATE TABLE / TRIGGER travam no MCP). Idempotente.
-- Ligação de saída fica DESLIGADA até config NINA_OUTBOUND_ENABLED = 'true'.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.nina_call_queue (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  lead_id         uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  phone           text NOT NULL,
  playbook        text,                       -- vender | trocar | comprar | descobrir (dossiê na hora da ligação)
  reason          text,                       -- por que ligar: lead_novo_captacao | lead_novo_qr | manual | retorno
  status          text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','awaiting_permission','calling','done','no_answer','failed','cancelled','expired')),
  scheduled_for   timestamptz NOT NULL DEFAULT now(),
  attempts        int  NOT NULL DEFAULT 0,
  max_attempts    int  NOT NULL DEFAULT 3,
  permission_requested_at timestamptz,
  last_attempt_at timestamptz,
  conversation_id text,                       -- ElevenLabs conversation_id da última tentativa
  outcome         text,                       -- agendou | qualificou | conversou | nao_atendeu
  last_error      text,
  requested_by    uuid,                       -- team_member que pediu (manual) ou null (automático)
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nina_call_queue_due_idx ON public.nina_call_queue (status, scheduled_for);
CREATE INDEX IF NOT EXISTS nina_call_queue_lead_idx ON public.nina_call_queue (lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS nina_call_queue_conv_idx ON public.nina_call_queue (conversation_id);

ALTER TABLE public.nina_call_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nina_call_queue_tenant_select ON public.nina_call_queue;
CREATE POLICY nina_call_queue_tenant_select ON public.nina_call_queue
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_tenant_id() OR public.is_platform_superadmin());
-- escrita só por RPC (SECURITY DEFINER) e service role

DROP TRIGGER IF EXISTS trg_nina_call_queue_updated ON public.nina_call_queue;
CREATE TRIGGER trg_nina_call_queue_updated BEFORE UPDATE ON public.nina_call_queue
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ─── Horário da NINA (separado do SLA das lojas): todo dia 10h–22h = shopping ─────────
CREATE OR REPLACE FUNCTION public.nina_business_time(p_ts timestamptz)
RETURNS timestamptz LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  v_ini   int   := coalesce((SELECT value::int FROM public.config WHERE key = 'NINA_HORARIO_INICIO'),
                            (SELECT value::int FROM public.config WHERE key = 'SLA_HORARIO_INICIO'), 10);
  v_fim   int   := coalesce((SELECT value::int FROM public.config WHERE key = 'NINA_HORARIO_FIM'),
                            (SELECT value::int FROM public.config WHERE key = 'SLA_HORARIO_FIM'), 22);
  v_dias  int[] := coalesce((SELECT string_to_array(value, ',')::int[] FROM public.config WHERE key = 'NINA_DIAS_SEMANA'),
                            (SELECT string_to_array(value, ',')::int[] FROM public.config WHERE key = 'SLA_DIAS_SEMANA'),
                            ARRAY[0,1,2,3,4,5,6]);
  v_local timestamp := (p_ts AT TIME ZONE 'America/Sao_Paulo');
  v_day   date := v_local::date;
  v_hour  numeric := extract(hour from v_local) + extract(minute from v_local) / 60.0;
  i       int := 0;
BEGIN
  IF extract(dow from v_day)::int = ANY(v_dias) AND v_hour >= v_ini AND v_hour < v_fim THEN RETURN p_ts; END IF;
  IF NOT (extract(dow from v_day)::int = ANY(v_dias) AND v_hour < v_ini) THEN v_day := v_day + 1; END IF;
  WHILE NOT (extract(dow from v_day)::int = ANY(v_dias)) AND i < 8 LOOP v_day := v_day + 1; i := i + 1; END LOOP;
  RETURN (v_day + make_interval(hours => v_ini)) AT TIME ZONE 'America/Sao_Paulo';
END;
$$;
INSERT INTO public.config (key, value) VALUES ('NINA_HORARIO_INICIO','10'), ('NINA_HORARIO_FIM','22'), ('NINA_DIAS_SEMANA','0,1,2,3,4,5,6')
ON CONFLICT (key) DO NOTHING;

-- ─── Enfileirar (interna, sem auth) ──────────────────────────────────────────
-- Dedupe: 1 ligação aberta por lead. Horário: joga pra dentro do expediente do SLA.
CREATE OR REPLACE FUNCTION public._nina_enqueue_call(p_lead_id uuid, p_reason text, p_delay_minutes int DEFAULT 5, p_requested_by uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_lead leads%ROWTYPE; v_id uuid; v_phone text; v_playbook text; v_when timestamptz;
BEGIN
  SELECT * INTO v_lead FROM leads WHERE id = p_lead_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Lead não encontrado'; END IF;
  v_phone := regexp_replace(coalesce(v_lead.phone,''), '\D', '', 'g');
  IF length(v_phone) < 10 OR v_phone LIKE 'pending%' THEN RAISE EXCEPTION 'Lead sem telefone válido'; END IF;
  IF v_lead.lead_kind IN ('contact','franchise') THEN RAISE EXCEPTION 'A Nina não liga pra contato/franqueado'; END IF;

  SELECT id INTO v_id FROM nina_call_queue
   WHERE lead_id = p_lead_id AND status IN ('queued','awaiting_permission','calling') LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  v_playbook := CASE
    WHEN lower(coalesce(v_lead.seller_qualification->>'intent','')) LIKE 'troc%' OR v_lead.lead_intent = 'trade_in' THEN 'trocar'
    WHEN v_lead.lead_kind = 'seller' THEN 'vender'
    WHEN v_lead.lead_kind = 'buyer' AND (v_lead.source LIKE 'stand%' OR v_lead.source LIKE 'totem%' OR v_lead.source = 'marketplace' OR v_lead.metadata ? 'vehicle') THEN 'comprar'
    ELSE 'descobrir' END;

  -- Pedido MANUAL (botão) = agora. Automático = horário da Nina (nina_business_time).
  v_when := now() + make_interval(mins => greatest(p_delay_minutes, 0));
  IF coalesce(p_reason,'') <> 'manual' THEN v_when := nina_business_time(v_when); END IF;

  INSERT INTO nina_call_queue (tenant_id, lead_id, phone, playbook, reason, scheduled_for, requested_by)
  VALUES (v_lead.tenant_id, p_lead_id, v_phone, v_playbook, p_reason, v_when, p_requested_by)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public._nina_enqueue_call(uuid, text, int, uuid) FROM PUBLIC, anon, authenticated;

-- ─── Enfileirar (pública: botão "Pedir pra Nina ligar") ───────────────────────
CREATE OR REPLACE FUNCTION public.nina_enqueue_call(p_lead_id uuid, p_reason text DEFAULT 'manual', p_delay_minutes int DEFAULT 0)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid; v_member uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Não autenticado'; END IF;
  IF public.is_promotora() THEN RAISE EXCEPTION 'Sem permissão'; END IF;
  SELECT tenant_id INTO v_tenant FROM leads WHERE id = p_lead_id;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Lead não encontrado'; END IF;
  IF v_tenant <> public.get_tenant_id() AND NOT public.is_platform_superadmin() THEN RAISE EXCEPTION 'Lead de outra loja'; END IF;
  v_member := public.current_member_id();
  RETURN public._nina_enqueue_call(p_lead_id, coalesce(p_reason,'manual'), coalesce(p_delay_minutes,0), v_member);
END $$;
REVOKE ALL ON FUNCTION public.nina_enqueue_call(uuid, text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.nina_enqueue_call(uuid, text, int) TO authenticated;

-- Cancelar (botão)
CREATE OR REPLACE FUNCTION public.nina_cancel_call(p_queue_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Não autenticado'; END IF;
  SELECT tenant_id INTO v_tenant FROM nina_call_queue WHERE id = p_queue_id;
  IF v_tenant IS NULL THEN RETURN false; END IF;
  IF v_tenant <> public.get_tenant_id() AND NOT public.is_platform_superadmin() THEN RAISE EXCEPTION 'Sem permissão'; END IF;
  UPDATE nina_call_queue SET status = 'cancelled' WHERE id = p_queue_id AND status IN ('queued','awaiting_permission');
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.nina_cancel_call(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.nina_cancel_call(uuid) TO authenticated;

-- ─── Auto-enfileirar quando o lead ENTRA ───────────────────────────────────────
-- Só se config NINA_OUTBOUND_ENABLED = 'true'. Fontes em config NINA_AUTO_CALL_SOURCES
-- (padrão: captacao,stand,stand_totex,totem-compra,marketplace). Delay NINA_AUTO_CALL_DELAY_MIN
-- (padrão 10 min — dá tempo da mensagem/template de boas-vindas chegar antes da ligação).
CREATE OR REPLACE FUNCTION public.trg_nina_auto_enqueue()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_on text; v_sources text; v_delay int; v_src text;
BEGIN
  SELECT value INTO v_on FROM config WHERE key = 'NINA_OUTBOUND_ENABLED';
  IF coalesce(v_on,'') <> 'true' THEN RETURN NEW; END IF;
  IF NEW.lead_kind NOT IN ('seller','buyer') THEN RETURN NEW; END IF;
  SELECT value INTO v_sources FROM config WHERE key = 'NINA_AUTO_CALL_SOURCES';
  v_sources := coalesce(nullif(v_sources,''), 'captacao,stand,stand_totex,totem-compra,marketplace');
  v_src := lower(coalesce(NEW.source, NEW.utm_source, ''));
  IF NEW.captured_by_member_id IS NULL AND NOT (v_src = ANY (string_to_array(v_sources, ','))) THEN RETURN NEW; END IF;
  SELECT value::int INTO v_delay FROM config WHERE key = 'NINA_AUTO_CALL_DELAY_MIN';
  BEGIN
    PERFORM public._nina_enqueue_call(NEW.id,
      CASE WHEN NEW.captured_by_member_id IS NOT NULL THEN 'lead_novo_captacao' ELSE 'lead_novo_' || v_src END,
      coalesce(v_delay, 10), NULL);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[nina] auto-enqueue lead %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_nina_auto_enqueue ON public.leads;
CREATE TRIGGER trg_nina_auto_enqueue AFTER INSERT ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.trg_nina_auto_enqueue();

-- ─── Cron: discador a cada 2 min (edge fn nina-dialer, autenticada pelo token das tools) ──
SELECT cron.unschedule('nina-dialer') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'nina-dialer');
SELECT cron.schedule(
  'nina-dialer', '*/2 * * * *',
  $$ SELECT net.http_post(
       url := (SELECT value FROM config WHERE key = 'SUPABASE_PROJECT_URL') || '/functions/v1/nina-dialer',
       headers := jsonb_build_object('Content-Type', 'application/json',
                                     'x-voice-token', coalesce((SELECT value FROM config WHERE key = 'VOICE_AGENT_TOKEN'), '')),
       body := '{"source":"cron"}'::jsonb
     ); $$
);

COMMENT ON TABLE public.nina_call_queue IS 'Fila de ligações de saída da Nina (voz). Discada por nina-dialer; resultado via voice-agent-postcall.';
