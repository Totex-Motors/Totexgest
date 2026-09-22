-- Cron: importa os leads do Totexcar Co-pilot (loja=totexmotors) a cada 15 min,
-- atribuindo à promotora pelo repasse_code (via a função import-copilot-leads).
-- Idempotente; no-op enquanto COPILOT_SUPABASE_KEY não estiver configurada.
DO $$ BEGIN
  PERFORM cron.unschedule('import-copilot-leads');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'import-copilot-leads',
  '*/15 * * * *',
  $CRON$
  SELECT net.http_post(
    url := 'https://mztfyavuclqzivywkaeu.supabase.co/functions/v1/import-copilot-leads',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im16dGZ5YXZ1Y2xxeml2eXdrYWV1Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODY3NTk3OCwiZXhwIjoyMDk0MjUxOTc4fQ.c7T3ctz0kJAnjOS-kiwHB9eptQogqzmGaZGT8ZM6O4g'
    ),
    body := '{}'::jsonb
  ) AS request_id
  $CRON$
);
