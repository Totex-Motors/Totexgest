-- =============================================================================
-- API KEYS POR-TENANT (#5)
-- Cada loja (tenant) paga as próprias chaves de integração (IA, WhatsApp, etc).
-- A tabela `config` global continua existindo como FALLBACK central da Totex
-- (e guarda infra como SUPABASE_PROJECT_URL). Esta migração é ADITIVA: nenhuma
-- edge function quebra — getIntegrationKey() sem tenantId continua lendo o global.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.tenant_integration_keys (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    key text NOT NULL,
    value text,
    updated_at timestamp with time zone DEFAULT now(),
    UNIQUE (tenant_id, key)
);

CREATE INDEX IF NOT EXISTS idx_tenant_integration_keys_tenant
  ON public.tenant_integration_keys (tenant_id);

ALTER TABLE public.tenant_integration_keys ENABLE ROW LEVEL SECURITY;

-- Leitura: admin do tenant vê só as chaves do próprio tenant; super-admin vê tudo.
-- (Edge functions usam service_role e ignoram RLS.)
DO $$ BEGIN
  CREATE POLICY "tenant_admin_read_own_keys" ON public.tenant_integration_keys
    FOR SELECT
    USING (
      public.is_superadmin()
      OR (tenant_id = public.get_tenant_id() AND public.is_tenant_admin())
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Super-admin pode gerenciar diretamente (oversight). Tenants normais escrevem
-- via RPC SECURITY DEFINER abaixo (não há policy de INSERT/UPDATE pra eles).
DO $$ BEGIN
  CREATE POLICY "superadmin_manage_keys" ON public.tenant_integration_keys
    FOR ALL
    USING (public.is_superadmin())
    WITH CHECK (public.is_superadmin());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =============================================================================
-- RPC: admin do tenant grava a própria chave (SECURITY DEFINER).
-- value vazio/NULL → remove a linha (volta a usar o fallback global da Totex).
-- Só permite chaves que fazem sentido por-loja; infra central (ex: webhook
-- secret do marketplace, SUPABASE_PROJECT_URL) NÃO é override-ável aqui.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.set_my_tenant_integration_key(
  p_key text,
  p_value text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_tid uuid := public.get_tenant_id();
  -- Chaves que as edge functions leem por-tenant via getIntegrationKey(..., tenantId).
  -- NÃO inclui Google OAuth (app central da Totex) nem o webhook secret do
  -- marketplace (segredo compartilhado Totex<->marketplace) — esses são globais.
  v_allowed text[] := ARRAY[
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY',
    'UAZAPI_ADMIN_URL', 'UAZAPI_ADMIN_TOKEN',
    'WHATSAPP_CLOUD_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID',
    'SONIOX_API_KEY', 'WAVOIP_API_KEY',
    'ASAAS_API_KEY', 'RESEND_API_KEY'
  ];
  v_clean text := NULLIF(btrim(COALESCE(p_value, '')), '');
BEGIN
  IF NOT public.is_tenant_admin() THEN
    RAISE EXCEPTION 'forbidden: tenant admin required';
  END IF;

  IF v_tid IS NULL THEN
    RAISE EXCEPTION 'tenant context missing';
  END IF;

  IF NOT (p_key = ANY (v_allowed)) THEN
    RAISE EXCEPTION 'key % is not configurable per-tenant', p_key;
  END IF;

  IF v_clean IS NULL THEN
    DELETE FROM public.tenant_integration_keys
     WHERE tenant_id = v_tid AND key = p_key;
    RETURN;
  END IF;

  INSERT INTO public.tenant_integration_keys (tenant_id, key, value, updated_at)
  VALUES (v_tid, p_key, v_clean, now())
  ON CONFLICT (tenant_id, key)
  DO UPDATE SET value = EXCLUDED.value, updated_at = now();
END;
$$;

-- =============================================================================
-- RPC: lista as chaves do próprio tenant (pra UI mostrar configurado/pendente).
-- Retorna só do tenant do caller; super-admin pode passar p_tenant_id.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.get_my_tenant_integration_keys(
  p_tenant_id uuid DEFAULT NULL
)
RETURNS TABLE (key text, value text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_tid uuid;
BEGIN
  IF p_tenant_id IS NOT NULL THEN
    IF NOT public.is_superadmin() THEN
      RAISE EXCEPTION 'forbidden: super admin required to read other tenants';
    END IF;
    v_tid := p_tenant_id;
  ELSE
    IF NOT (public.is_tenant_admin() OR public.is_superadmin()) THEN
      RAISE EXCEPTION 'forbidden: tenant admin required';
    END IF;
    v_tid := public.get_tenant_id();
  END IF;

  RETURN QUERY
    SELECT tik.key, tik.value
      FROM public.tenant_integration_keys tik
     WHERE tik.tenant_id = v_tid;
END;
$$;

NOTIFY pgrst, 'reload schema';
