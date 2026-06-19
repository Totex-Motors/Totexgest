-- ============================================================================
-- 20260620003_stand_cloud_instance.sql
-- Instância "oficial" da WhatsApp Cloud API para o Agente do Stand.
--
-- O whatsapp-cloud-webhook resolve a instância (e dela o tenant_id) de dois jeitos:
--   1. metadata->>'phone_number_id' == phone_number_id do payload da Meta  (preferido)
--   2. fallback por name = 'IAP - OFICIAL'                                  (rede de segurança)
--
-- Como hoje só existe UM número Cloud (tenant Totex Motors super-admin), o fallback
-- por nome já resolve o roteamento. Quando o Phone Number ID real estiver disponível,
-- basta atualizar o metadata (ver bloco UPDATE comentado no fim).
-- ============================================================================

INSERT INTO public.whatsapp_instances (id, name, status, purpose, tenant_id, metadata)
VALUES (
  gen_random_uuid(),
  'IAP - OFICIAL',
  'connected',
  'inbox',
  'c13681e3-5db9-48d1-9c5c-856e6041d77f',  -- Totex Motors (super-admin)
  jsonb_build_object(
    'provider', 'whatsapp_cloud',
    'phone_number_id', '__REPLACE_WITH_PHONE_NUMBER_ID__'
  )
)
ON CONFLICT DO NOTHING;

-- Garante o tenant correto e a flag de provider mesmo se a linha 'IAP - OFICIAL' já existir.
UPDATE public.whatsapp_instances
SET tenant_id = 'c13681e3-5db9-48d1-9c5c-856e6041d77f',
    purpose   = 'inbox',
    metadata  = metadata || jsonb_build_object('provider', 'whatsapp_cloud')
WHERE name = 'IAP - OFICIAL';

-- ============================================================================
-- DEPOIS de ter o Phone Number ID real (painel Meta), rode:
--
-- UPDATE public.whatsapp_instances
-- SET metadata = metadata || jsonb_build_object('phone_number_id', '<PN_ID_REAL>')
-- WHERE name = 'IAP - OFICIAL';
-- ============================================================================
