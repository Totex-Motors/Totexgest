-- ============================================================
-- 0003 — Crons do Instagram (SEM eles nada roda sozinho)
--
-- | cron             | frequência        | o que faz                          |
-- |------------------|-------------------|------------------------------------|
-- | ig-dispatch      | 1/min             | puxa comentários + dispara as DMs  |
-- | ig-agent-queue   | 1/min             | agente responde DMs (com debounce) |
-- | ig-nudge         | 30min (11h-23h UTC)| cutuca quem recebeu DM e sumiu    |
-- | ig-refresh-token | semanal (dom 6h)  | renova o token que MORRE em 60 dias|
--
-- ⚠️ O ig-refresh-token não é opcional: o token do Instagram Login expira em
-- 60 dias e, sem renovação, TODA a automação para em silêncio no dia 61.
--
-- A função lê SUPABASE_PROJECT_URL da tabela config. Se ainda não existir,
-- grave antes:  INSERT INTO config (key, value)
--               VALUES ('SUPABASE_PROJECT_URL','https://SEU-REF.supabase.co')
--               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
-- e rode:       SELECT public.ig_setup_crons();
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.ig_setup_crons()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url text;
  v_job record;
  v_cmd text;
  v_jobs constant text[][] := ARRAY[
    ARRAY['ig-dispatch',      '* * * * *',        'instagram-crons', '{"action":"dispatch"}'],
    ARRAY['ig-agent-queue',   '* * * * *',        'instagram-crons', '{"action":"agent_queue"}'],
    ARRAY['ig-nudge',         '*/30 11-23 * * *', 'instagram-crons', '{"action":"nudge"}'],
    ARRAY['ig-refresh-token', '0 6 * * 0',        'instagram-crons', '{"action":"refresh_token"}']
  ];
BEGIN
  SELECT value INTO v_url FROM public.config WHERE key = 'SUPABASE_PROJECT_URL';
  v_url := rtrim(coalesce(v_url, ''), '/');
  IF v_url = '' OR v_url NOT LIKE 'http%' THEN
    RAISE WARNING 'SUPABASE_PROJECT_URL ausente na config — crons NAO agendados. Grave a URL e rode: SELECT public.ig_setup_crons();';
    RETURN 'skipped: SUPABASE_PROJECT_URL ausente';
  END IF;

  FOR i IN 1 .. array_length(v_jobs, 1) LOOP
    FOR v_job IN SELECT jobname FROM cron.job WHERE jobname = v_jobs[i][1] LOOP
      PERFORM cron.unschedule(v_job.jobname);
    END LOOP;
    v_cmd := format(
      $f$SELECT net.http_post(url := %L, headers := '{"Content-Type":"application/json"}'::jsonb, body := %L::jsonb)$f$,
      v_url || '/functions/v1/' || v_jobs[i][3], v_jobs[i][4]);
    PERFORM cron.schedule(v_jobs[i][1], v_jobs[i][2], v_cmd);
  END LOOP;

  RETURN format('%s crons do Instagram agendados para %s', array_length(v_jobs, 1), v_url);
END $$;

REVOKE EXECUTE ON FUNCTION public.ig_setup_crons() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ig_setup_crons() TO service_role;

-- Tenta agendar já (no-op com aviso se a URL ainda não foi gravada)
DO $$ BEGIN PERFORM public.ig_setup_crons(); END $$;
