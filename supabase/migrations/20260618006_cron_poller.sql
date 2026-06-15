-- ============================================================
-- 0006 — Cron do Poller (RODAR POR ÚLTIMO, com placeholders trocados!)
--
-- O agent-jobs-poller é o "coração" da proatividade: a cada 1 minuto
-- ele verifica jobs assíncronos e lembretes/rotinas vencidos e acorda
-- os agentes pra trabalhar sozinhos.
--
-- ⚠️ ANTES DE RODAR, substitua os 2 placeholders:
--   https://mztfyavuclqzivywkaeu.supabase.co  → ex: https://abcdefgh.supabase.co  (SEM barra no final)
--   eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im16dGZ5YXZ1Y2xxeml2eXdrYWV1Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODY3NTk3OCwiZXhwIjoyMDk0MjUxOTc4fQ.c7T3ctz0kJAnjOS-kiwHB9eptQogqzmGaZGT8ZM6O4g      → a service_role key do projeto (Dashboard → Settings → API)
-- ============================================================

-- extensões necessárias (já existem em projetos Supabase, garante)
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- remove agendamento anterior se reinstalando
DO $$ BEGIN
  PERFORM cron.unschedule('agent-jobs-poller');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'agent-jobs-poller',
  '* * * * *',
  $CRON$
  SELECT net.http_post(
    url := 'https://mztfyavuclqzivywkaeu.supabase.co/functions/v1/agent-jobs-poller',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im16dGZ5YXZ1Y2xxeml2eXdrYWV1Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODY3NTk3OCwiZXhwIjoyMDk0MjUxOTc4fQ.c7T3ctz0kJAnjOS-kiwHB9eptQogqzmGaZGT8ZM6O4g'
    ),
    body := '{}'::jsonb
  ) AS request_id
  $CRON$
);

-- confirma
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'agent-jobs-poller';
