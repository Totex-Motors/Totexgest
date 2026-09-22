-- Painel da promotora: leads de COMPRA que ela captou no totem (fluxo "Comprar").
-- Esses leads vivem no tenant dela (master), sem captured_by_member_id (não entram
-- na meta de captação de consignação); a atribuição é via metadata.promoter_id.
-- SECURITY DEFINER: a promotora não tem SELECT direto (RLS), a função filtra pelo
-- próprio member id. Admin pode consultar de outra promotora passando p_member_id.
CREATE OR REPLACE FUNCTION public.list_my_buyer_leads(p_member_id uuid DEFAULT NULL)
RETURNS TABLE (
  lead_id uuid, name text, phone text, created_at timestamptz,
  veiculo text, loja text, distribuido boolean, observacao text
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_member uuid := public.current_member_id(); v_target uuid;
BEGIN
  IF v_member IS NULL THEN RETURN; END IF;
  v_target := CASE WHEN p_member_id IS NOT NULL AND (public.is_admin() OR public.is_superadmin())
                   THEN p_member_id ELSE v_member END;
  RETURN QUERY
  SELECT l.id, l.name, l.phone, l.created_at,
         nullif(btrim(coalesce(l.metadata->'veiculo_interesse'->>'titulo', '')), '') AS veiculo,
         t.name AS loja,
         (l.metadata ? 'distributed_to') AS distribuido,
         nullif(btrim(coalesce(l.metadata->>'observacao', '')), '') AS observacao
  FROM leads l
  LEFT JOIN tenants t ON t.id = nullif(l.metadata->>'owner_tenant_id', '')::uuid
  WHERE (l.metadata->>'promoter_id') = v_target::text
    AND coalesce((l.metadata->>'comprador')::boolean, false) = true
  ORDER BY l.created_at DESC
  LIMIT 200;
END;
$$;
REVOKE ALL ON FUNCTION public.list_my_buyer_leads(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.list_my_buyer_leads(uuid) TO authenticated;
