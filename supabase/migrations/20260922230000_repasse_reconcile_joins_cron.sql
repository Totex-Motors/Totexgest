-- Cron: reconcilia "entrou no grupo" de repasse a cada 30 min (belt-and-suspenders
-- do evento em tempo real, que falha com o formato LID do WhatsApp).
DO $$ BEGIN
  PERFORM cron.unschedule('repasse-reconcile-joins');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'repasse-reconcile-joins',
  '*/30 * * * *',
  $CRON$
  SELECT net.http_post(
    url := 'https://mztfyavuclqzivywkaeu.supabase.co/functions/v1/repasse-reconcile-joins',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im16dGZ5YXZ1Y2xxeml2eXdrYWV1Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODY3NTk3OCwiZXhwIjoyMDk0MjUxOTc4fQ.c7T3ctz0kJAnjOS-kiwHB9eptQogqzmGaZGT8ZM6O4g'
    ),
    body := '{}'::jsonb
  ) AS request_id
  $CRON$
);
