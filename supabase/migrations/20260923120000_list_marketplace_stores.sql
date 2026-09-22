-- Lista as lojas roteáveis (que têm destino de lead configurado) pra promotora
-- escolher no fluxo "Comprar". Nome (do tenant) + tenant_id, pra casar com o
-- estoque do marketplace (consultar-estoque casa por nome) e rotear via distribuir-lead.
CREATE OR REPLACE FUNCTION public.list_marketplace_stores()
RETURNS TABLE(tenant_id uuid, name text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT d.tenant_id, coalesce(nullif(btrim(t.name), ''), d.label) AS name
  FROM tenant_lead_destinations d
  JOIN tenants t ON t.id = d.tenant_id
  WHERE d.active
  ORDER BY name;
$$;
REVOKE ALL ON FUNCTION public.list_marketplace_stores() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.list_marketplace_stores() TO authenticated;
