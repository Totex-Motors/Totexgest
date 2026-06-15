-- ============================================================
-- 0006 — Cron do Poller (RODAR POR ÚLTIMO, com placeholders trocados!)
--
-- O agent-jobs-poller é o "coração" da proatividade: a cada 1 minuto
-- ele verifica jobs assíncronos e lembretes/rotinas vencidos e acorda
-- os agentes pra trabalhar sozinhos.
--
-- ⚠️ ANTES DE RODAR, substitua os 2 placeholders:
--   __SUPABASE_PROJECT_URL__  → ex: https://abcdefgh.supabase.co  (SEM barra no final)
--   __SERVICE_ROLE_KEY__      → a service_role key do projeto (Dashboard → Settings → API)
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
    url := '__SUPABASE_PROJECT_URL__/functions/v1/agent-jobs-poller',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer __SERVICE_ROLE_KEY__'
    ),
    body := '{}'::jsonb
  ) AS request_id
  $CRON$
);

-- confirma
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'agent-jobs-poller';
