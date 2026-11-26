-- CÓDIGO SEQUENCIAL DO LEAD (L000001…) por loja. Foi criado direto no banco (fora do repositório)
-- entre 17 e 26/11/2026; este arquivo documenta o que existe e traz a correção de 26/11:
-- "Novo Lead" no CRM dava "new row violates row-level security policy for table lead_counters",
-- porque next_lead_codigo rodava com a permissão do usuário logado e lead_counters tem RLS ligado
-- sem política (só o service_role conseguia gravar). Agora a função roda como dona (SECURITY
-- DEFINER) e só usuário autenticado/service_role pode chamá-la.

ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS codigo text;

CREATE TABLE IF NOT EXISTS public.lead_counters (
  tenant_id  uuid PRIMARY KEY,
  last_value integer NOT NULL DEFAULT 0
);
ALTER TABLE public.lead_counters ENABLE ROW LEVEL SECURITY; -- sem política: ninguém lê/grava direto

CREATE OR REPLACE FUNCTION public.next_lead_codigo(p_tenant uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE v int;
BEGIN
  INSERT INTO lead_counters (tenant_id, last_value) VALUES (p_tenant, 1)
    ON CONFLICT (tenant_id) DO UPDATE SET last_value = lead_counters.last_value + 1
    RETURNING last_value INTO v;
  RETURN 'L' || lpad(v::text, 6, '0');
END $function$;
REVOKE EXECUTE ON FUNCTION public.next_lead_codigo(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.next_lead_codigo(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trg_assign_lead_codigo()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.codigo IS NULL AND NEW.tenant_id IS NOT NULL THEN NEW.codigo := next_lead_codigo(NEW.tenant_id); END IF;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS trg_assign_lead_codigo ON public.leads;
CREATE TRIGGER trg_assign_lead_codigo BEFORE INSERT ON public.leads
  FOR EACH ROW EXECUTE FUNCTION trg_assign_lead_codigo();
