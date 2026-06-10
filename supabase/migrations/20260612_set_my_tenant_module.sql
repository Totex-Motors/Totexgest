-- Permite que o admin de um tenant ligue/desligue os próprios módulos SELF-SERVICE.
-- Módulos pagos (credere, marketplace) NÃO entram aqui — só o super-admin controla
-- (via admin-tenants set_module). tenants não tem policy de UPDATE, por isso a RPC
-- SECURITY DEFINER faz a escrita controlada.

CREATE OR REPLACE FUNCTION public.set_my_tenant_module(p_module text, p_enabled boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_tid uuid := public.get_tenant_id();
  v_allowed text[] := ARRAY['comercial', 'gestao', 'telefonia', 'analytics'];
  v_modules jsonb;
BEGIN
  IF NOT public.is_tenant_admin() THEN
    RAISE EXCEPTION 'forbidden: tenant admin required';
  END IF;

  IF NOT (p_module = ANY (v_allowed)) THEN
    RAISE EXCEPTION 'module % is not self-serviceable', p_module;
  END IF;

  UPDATE public.tenants
     SET enabled_modules = COALESCE(enabled_modules, '{}'::jsonb)
                           || jsonb_build_object(p_module, p_enabled)
   WHERE id = v_tid
   RETURNING enabled_modules INTO v_modules;

  RETURN COALESCE(v_modules, '{}'::jsonb);
END;
$$;
