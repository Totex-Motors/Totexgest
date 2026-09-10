-- Captação — aviso PRIVADO do especialista passa a ser SÓ pela API oficial
-- (Cloud API) com template aprovado. A UAZAPI nunca mais fala no privado.
ALTER TABLE public.capture_handoff_config
  ADD COLUMN IF NOT EXISTS specialist_template_name text NOT NULL DEFAULT 'captacao_lead_especialista';

COMMENT ON COLUMN public.capture_handoff_config.notify_specialist IS
  'true = além do grupo (@menção), manda template pelo número OFICIAL (Cloud API) pro especialista. Só envia se o template estiver APPROVED em whatsapp_cloud_templates.';

UPDATE public.capture_handoff_config SET notify_specialist = true;
ALTER TABLE public.capture_handoff_config ALTER COLUMN notify_specialist SET DEFAULT true;
