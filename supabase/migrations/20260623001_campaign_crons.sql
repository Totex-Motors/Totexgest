-- =============================================================================
-- 20260623001_campaign_crons.sql
-- Crons do módulo de disparo de campanhas. Rodam a cada 1 minuto.
--
-- IMPORTANTE: depende de config.SUPABASE_PROJECT_URL com a URL REAL do projeto
-- (mesmo requisito do 002_ai_agent_crons.sql). Se estiver no placeholder
-- __REPLACE_WITH_PROJECT_URL__, atualize antes:
--
--   UPDATE config SET value = 'https://SEU_PROJECT_REF.supabase.co'
--   WHERE key = 'SUPABASE_PROJECT_URL';
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Cron 1: processa campanhas (WhatsApp em massa) que estão em status 'sending'.
-- A função varre todos os tenants; cada campanha carrega seu próprio tenant_id.
SELECT cron.unschedule('process-campaigns') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='process-campaigns');
SELECT cron.schedule(
  'process-campaigns', '* * * * *',
  $$ SELECT net.http_post(
       url := (SELECT value FROM config WHERE key='SUPABASE_PROJECT_URL') || '/functions/v1/campaign-processor',
       headers := jsonb_build_object('Content-Type','application/json'),
       body := '{}'::jsonb
     ); $$
);

-- Cron 2: avança os runs ativos do motor de automações de email (node-walking).
SELECT cron.unschedule('email-automation-tick') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='email-automation-tick');
SELECT cron.schedule(
  'email-automation-tick', '* * * * *',
  $$ SELECT net.http_post(
       url := (SELECT value FROM config WHERE key='SUPABASE_PROJECT_URL') || '/functions/v1/email-automation-tick',
       headers := jsonb_build_object('Content-Type','application/json'),
       body := '{}'::jsonb
     ); $$
);
