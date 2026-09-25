-- Verificador de "gestor da captação" por PAPEL REAL da pessoa — não pela flag do
-- tenant. Usado pelas funções da captação pra distinguir gestor (vê/faz tudo) de
-- promotora (só o dela). Substitui is_superadmin() nesse contexto, que vazava
-- porque toda promotora vive no tenant HQ (is_super_admin=true).
-- Precisa existir ANTES da migration capture_manager_gate (que passa a usá-lo).
CREATE OR REPLACE FUNCTION public.is_capture_manager()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM team_members tm
    WHERE tm.auth_user_id = auth.uid() AND tm.is_active
      AND (tm.role = 'admin' OR tm.is_superadmin = true)
  );
$$;
REVOKE ALL ON FUNCTION public.is_capture_manager() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.is_capture_manager() TO authenticated;
