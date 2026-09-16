-- SEGUNDO CÉREBRO — briefing matinal: config da instância + agendamento (8h BRT).
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Qual instância UAZAPI envia o briefing (a que está no grupo do cérebro).
INSERT INTO public.config (key, value)
SELECT 'MCP_BOT_INSTANCE_ID', 'eb8199e5-3bc6-416f-9953-038ef04175cd'
WHERE NOT EXISTS (SELECT 1 FROM config WHERE key = 'MCP_BOT_INSTANCE_ID');

CREATE OR REPLACE FUNCTION public.brain_briefing_setup_cron()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_url text; v_cmd text; v_job record;
BEGIN
  SELECT value INTO v_url FROM public.config WHERE key = 'SUPABASE_PROJECT_URL';
  v_url := rtrim(coalesce(v_url,''), '/');
  IF v_url = '' OR v_url NOT LIKE 'http%' THEN
    RAISE WARNING 'SUPABASE_PROJECT_URL ausente — briefing NAO agendado.';
    RETURN 'skipped: SUPABASE_PROJECT_URL ausente';
  END IF;
  FOR v_job IN SELECT jobname FROM cron.job WHERE jobname = 'brain-daily-briefing' LOOP
    PERFORM cron.unschedule(v_job.jobname);
  END LOOP;
  -- 8h BRT = 11:00 UTC
  v_cmd := format($f$SELECT net.http_post(url := %L, headers := '{"Content-Type":"application/json"}'::jsonb, body := '{}'::jsonb)$f$,
                  v_url || '/functions/v1/daily-brain-briefing');
  PERFORM cron.schedule('brain-daily-briefing', '0 11 * * *', v_cmd);
  RETURN 'agendado 08:00 BRT para ' || v_url;
END $$;

SELECT public.brain_briefing_setup_cron();
