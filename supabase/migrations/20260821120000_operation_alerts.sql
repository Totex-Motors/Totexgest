-- Fase 2 da Torre de Controle: alertas da operação de leads pro time
-- (Telegram como canal principal + WhatsApp/UAZAPI opcional).
-- Config por tenant + log anti-spam pra não repetir o mesmo alerta.

-- 1. Config dos alertas (uma linha por tenant)
CREATE TABLE IF NOT EXISTS public.operation_alert_config (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,          -- chave-geral
  realtime_enabled boolean NOT NULL DEFAULT true,  -- 2A: SLA estourado + reconversão sem resposta
  summary_enabled boolean NOT NULL DEFAULT true,   -- 2B: resumo 2x/dia
  include_ai_plan boolean NOT NULL DEFAULT true,   -- resumo inclui plano do copiloto IA
  sla_alert_minutes integer NOT NULL DEFAULT 60,   -- dispara alerta de lead sem contato após N min
  summary_hours jsonb NOT NULL DEFAULT '[9,14]'::jsonb, -- horas (BRT) do resumo
  -- Telegram
  telegram_enabled boolean NOT NULL DEFAULT false,
  telegram_bot_token text,
  telegram_chat_id text,
  -- WhatsApp (UAZAPI) — opcional
  whatsapp_enabled boolean NOT NULL DEFAULT false,
  whatsapp_instance_id uuid REFERENCES public.whatsapp_instances(id) ON DELETE SET NULL,
  whatsapp_group_jid text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.operation_alert_config ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='operation_alert_config' AND policyname='oac_tenant_rw') THEN
    CREATE POLICY oac_tenant_rw ON public.operation_alert_config
      FOR ALL TO authenticated
      USING (tenant_id = get_tenant_id())
      WITH CHECK (tenant_id = get_tenant_id());
  END IF;
END $$;

-- 2. Log anti-spam: um alerta por (tenant, lead, tipo). Serve de dedup.
CREATE TABLE IF NOT EXISTS public.operation_alert_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  lead_id uuid,
  alert_type text NOT NULL,          -- ex: 'sla_breach', 'reconversion_unattended'
  channel text,                      -- 'telegram' | 'whatsapp'
  sent_at timestamptz NOT NULL DEFAULT now()
);

-- Dedup: mesmo lead + mesmo tipo não repete (guarda dispara 1x)
CREATE UNIQUE INDEX IF NOT EXISTS operation_alert_log_dedup
  ON public.operation_alert_log (tenant_id, lead_id, alert_type)
  WHERE lead_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS operation_alert_log_sent_at ON public.operation_alert_log (sent_at);

ALTER TABLE public.operation_alert_log ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='operation_alert_log' AND policyname='oal_tenant_read') THEN
    CREATE POLICY oal_tenant_read ON public.operation_alert_log
      FOR SELECT TO authenticated
      USING (tenant_id = get_tenant_id());
  END IF;
END $$;
