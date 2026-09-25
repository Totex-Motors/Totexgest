-- Blinda as funções sensíveis (segredos e cross-tenant) contra o mesmo vazamento:
-- is_superadmin() é true pra qualquer membro do tenant HQ, então promotora/comercial
-- passavam em get_my_tenant_integration_keys (LÊ API KEYS/segredos) e em
-- intermediation_set_buyer (edição cross-tenant).
--
-- Novo verificador is_platform_superadmin() = superadmin DE VERDADE: flag pessoal
-- is_superadmin OU admin (role='admin') de um tenant HQ. Exclui promotora e comercial;
-- preserva o dono (admin do HQ). Trocado só nessas 2 funções.
CREATE OR REPLACE FUNCTION public.is_platform_superadmin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM team_members tm
    LEFT JOIN tenants t ON t.id = tm.tenant_id
    WHERE tm.auth_user_id = auth.uid() AND tm.is_active
      AND (tm.is_superadmin = true OR (t.is_super_admin = true AND tm.role = 'admin'))
  );
$$;
REVOKE ALL ON FUNCTION public.is_platform_superadmin() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.is_platform_superadmin() TO authenticated;

DO $mig$
DECLARE
  p_oid oid;
  def text;
BEGIN
  FOR p_oid IN
    SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f'
      AND p.proname IN ('get_my_tenant_integration_keys','intermediation_set_buyer')
  LOOP
    def := pg_get_functiondef(p_oid);
    def := replace(def, 'public.is_superadmin()', 'public.is_platform_superadmin()');
    EXECUTE def;
  END LOOP;
END $mig$;
