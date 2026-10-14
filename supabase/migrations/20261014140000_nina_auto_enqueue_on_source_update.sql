-- ============================================================================
-- Nina liga sozinha pro lead do TOTEM/STAND (2026-10-14)
--
-- O lead que chega pelo totem entra pelo whatsapp-cloud-webhook com source='whatsapp'
-- e só DEPOIS o agente V2 marca source='stand' (agent-platform.ts, cfg.lead_source).
-- O trigger era só AFTER INSERT → nenhum lead de totem entrava na fila da Nina
-- (Gabriel, Murilo, Mah, Claudio... nenhum tinha fila). Agora dispara também quando
-- o source MUDA pra uma das origens configuradas. Dedupe por telefone: o lead
-- distribuído pra loja (cópia no tenant da Cardoso) não vira 2ª ligação.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.trg_nina_auto_enqueue()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_on text; v_sources text; v_delay int; v_src text; v_old text; v_list text[]; v_phone text;
BEGIN
  SELECT value INTO v_on FROM config WHERE key = 'NINA_OUTBOUND_ENABLED';
  IF coalesce(v_on,'') <> 'true' THEN RETURN NEW; END IF;
  IF NEW.lead_kind NOT IN ('seller','buyer') THEN RETURN NEW; END IF;

  SELECT value INTO v_sources FROM config WHERE key = 'NINA_AUTO_CALL_SOURCES';
  v_sources := coalesce(nullif(v_sources,''), 'captacao,stand,stand_totex,totem-compra,marketplace');
  v_list := string_to_array(v_sources, ',');
  v_src := lower(coalesce(NEW.source, NEW.utm_source, ''));

  IF TG_OP = 'UPDATE' THEN
    -- só quando o source ENTRA na lista (ex.: whatsapp → stand); promotora já entrou no INSERT
    v_old := lower(coalesce(OLD.source, OLD.utm_source, ''));
    IF NOT (v_src = ANY (v_list)) OR (v_old = ANY (v_list)) THEN RETURN NEW; END IF;
  ELSE
    IF NEW.captured_by_member_id IS NULL AND NOT (v_src = ANY (v_list)) THEN RETURN NEW; END IF;
  END IF;

  -- dedupe por telefone (lead distribuído pra loja é outro id, mesmo cliente)
  v_phone := regexp_replace(coalesce(NEW.phone,''), '\D', '', 'g');
  IF length(v_phone) >= 10 AND EXISTS (
    SELECT 1 FROM nina_call_queue q
     WHERE q.phone = v_phone AND q.status IN ('queued','awaiting_permission','calling')
  ) THEN RETURN NEW; END IF;

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
CREATE TRIGGER trg_nina_auto_enqueue AFTER INSERT OR UPDATE OF source, utm_source ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.trg_nina_auto_enqueue();

-- Cron do discador: o pg_net cortava em 5 s (padrão) e a ligação de SAÍDA leva mais que
-- isso (sincroniza agente + permissão da Meta + ElevenLabs). Gabriel ficou "queued" sem
-- a Nina ligar (14/10 10h). 60 s.
SELECT cron.alter_job(jobid, command := $c$ SELECT net.http_post(
       url := (SELECT value FROM config WHERE key = 'SUPABASE_PROJECT_URL') || '/functions/v1/nina-dialer',
       headers := jsonb_build_object('Content-Type', 'application/json',
                                     'x-voice-token', coalesce((SELECT value FROM config WHERE key = 'VOICE_AGENT_TOKEN'), '')),
       body := '{"source":"cron"}'::jsonb,
       timeout_milliseconds := 60000
     ); $c$)
  FROM cron.job WHERE jobname = 'nina-dialer';
