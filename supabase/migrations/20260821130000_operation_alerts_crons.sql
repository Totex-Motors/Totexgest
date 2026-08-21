-- Crons da Fase 2 (alertas da operação). Leem SUPABASE_PROJECT_URL da config.
--  op-alerts-realtime : a cada 10min — SLA estourado + reconversão sem resposta
--  op-alerts-summary  : de hora em hora — a função só envia se a hora (BRT)
--                       estiver em operation_alert_config.summary_hours
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.operation_alerts_setup_crons()
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
    ARRAY['op-alerts-realtime', '*/10 * * * *', '{"mode":"realtime"}'],
    ARRAY['op-alerts-summary',  '0 * * * *',    '{"mode":"summary"}']
  ];
BEGIN
  SELECT value INTO v_url FROM public.config WHERE key = 'SUPABASE_PROJECT_URL';
  v_url := rtrim(coalesce(v_url, ''), '/');
  IF v_url = '' OR v_url NOT LIKE 'http%' THEN
    RAISE WARNING 'SUPABASE_PROJECT_URL ausente — crons de alertas NAO agendados.';
    RETURN 'skipped: SUPABASE_PROJECT_URL ausente';
  END IF;

  FOR i IN 1 .. array_length(v_jobs, 1) LOOP
    FOR v_job IN SELECT jobname FROM cron.job WHERE jobname = v_jobs[i][1] LOOP
      PERFORM cron.unschedule(v_job.jobname);
    END LOOP;
    v_cmd := format(
      $f$SELECT net.http_post(url := %L, headers := '{"Content-Type":"application/json"}'::jsonb, body := %L::jsonb)$f$,
      v_url || '/functions/v1/operation-alerts', v_jobs[i][3]);
    PERFORM cron.schedule(v_jobs[i][1], v_jobs[i][2], v_cmd);
  END LOOP;

  RETURN format('%s crons de alertas agendados para %s', array_length(v_jobs, 1), v_url);
END $$;

SELECT public.operation_alerts_setup_crons();
