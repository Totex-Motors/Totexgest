-- ============================================================================
-- Segurança (portado do template v3, adaptado ao multi-tenant Totex):
--
-- 1) is_admin(): admin ativo do próprio tenant (team_members.role='admin').
-- 2) config (GLOBAL — chaves centrais da Totex): leitura de secrets e QUALQUER
--    escrita só super-admin; demais usuários leem apenas a allowlist pública.
--    Antes: policy "tenant_isolation" USING (true) — qualquer logado lia/escrevia
--    todas as API keys centrais.
-- 3) agents_provider_credentials (tokens de provider dos agentes): leitura e
--    escrita restritas a admin do tenant OU dono da credencial (antes: qualquer
--    membro do tenant lia os tokens).
--
-- Edge functions (service_role) não são afetadas.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM team_members
    WHERE auth_user_id = auth.uid() AND role = 'admin' AND is_active
  );
$$;

-- ─── config global ───
DROP POLICY IF EXISTS "tenant_isolation" ON public.config;
DROP POLICY IF EXISTS config_read_public_or_superadmin ON public.config;
DROP POLICY IF EXISTS config_insert_superadmin ON public.config;
DROP POLICY IF EXISTS config_update_superadmin ON public.config;
DROP POLICY IF EXISTS config_delete_superadmin ON public.config;

CREATE POLICY config_read_public_or_superadmin ON public.config
FOR SELECT TO authenticated
USING (
  public.is_superadmin()
  OR key IN (
    'enabled_modules',
    'agent_platform_v2_enabled',
    'SUPABASE_PROJECT_URL',
    'UAZAPI_ADMIN_URL',
    'GOOGLE_CLIENT_ID',
    'COMPANY_NAME',
    'COMPANY_DOMAIN',
    'TOTEX_MARKETPLACE_API_URL'
  )
);

CREATE POLICY config_insert_superadmin ON public.config
FOR INSERT TO authenticated WITH CHECK (public.is_superadmin());

CREATE POLICY config_update_superadmin ON public.config
FOR UPDATE TO authenticated
USING (public.is_superadmin()) WITH CHECK (public.is_superadmin());

CREATE POLICY config_delete_superadmin ON public.config
FOR DELETE TO authenticated USING (public.is_superadmin());

-- ─── agents_provider_credentials ───
DO $$
BEGIN
  IF to_regclass('public.agents_provider_credentials') IS NULL THEN
    RETURN;
  END IF;

  EXECUTE 'DROP POLICY IF EXISTS ap_tenant_read ON agents_provider_credentials';
  EXECUTE 'DROP POLICY IF EXISTS ap_tenant_write ON agents_provider_credentials';
  EXECUTE 'DROP POLICY IF EXISTS apc_read_admin_or_owner ON agents_provider_credentials';
  EXECUTE 'DROP POLICY IF EXISTS apc_write_admin_or_owner ON agents_provider_credentials';

  EXECUTE 'CREATE POLICY apc_read_admin_or_owner ON agents_provider_credentials FOR SELECT TO authenticated
    USING (tenant_id = public.get_tenant_id() AND (public.is_admin() OR owner_user_id = auth.uid()))';

  EXECUTE 'CREATE POLICY apc_write_admin_or_owner ON agents_provider_credentials FOR ALL TO authenticated
    USING (tenant_id = public.get_tenant_id() AND (public.is_admin() OR owner_user_id = auth.uid()))
    WITH CHECK (tenant_id = public.get_tenant_id() AND (public.is_admin() OR owner_user_id = auth.uid()))';
END $$;
