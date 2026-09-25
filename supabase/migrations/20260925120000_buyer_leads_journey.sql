-- Jornada do comprador (fluxo "Comprar"): enriquece list_my_buyer_leads com o
-- ESTADO DA COPIA na loja. O lead da central (master) só rastreia quem trouxe;
-- a ficha realmente trabalhada vive no tenant da loja e é apontada por
-- metadata.distributed_to.lead_id. Seguimos esse vínculo pra trazer o
-- especialista que atende, a etapa atual e o primeiro contato — assim o painel
-- "Compradores (totem)" mostra a jornada inteira (quem trouxe → loja →
-- especialista → etapa), sem o gestor pular de tela em tela.
-- SECURITY DEFINER: a função lê a cópia da loja (outro tenant) de propósito.
DROP FUNCTION IF EXISTS public.list_my_buyer_leads(uuid);

CREATE OR REPLACE FUNCTION public.list_my_buyer_leads(p_member_id uuid DEFAULT NULL)
RETURNS TABLE (
  lead_id uuid, name text, phone text, created_at timestamptz,
  veiculo text, loja text, distribuido boolean, observacao text,
  promoter_name text, vendido boolean, comissao_cents integer, comissao_status text,
  especialista text, etapa text, etapa_ganho boolean, etapa_perdido boolean,
  primeiro_contato_at timestamptz, store_lead_id uuid, store_tenant_id uuid
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_member uuid := public.current_member_id();
  v_admin boolean := (public.is_admin() OR public.is_superadmin());
  v_target uuid;
BEGIN
  IF v_member IS NULL THEN RETURN; END IF;
  v_target := CASE
    WHEN p_member_id IS NOT NULL AND v_admin THEN p_member_id
    WHEN v_admin THEN NULL
    ELSE v_member END;
  RETURN QUERY
  SELECT l.id, l.name, l.phone, l.created_at,
         nullif(btrim(coalesce(l.metadata->'veiculo_interesse'->>'titulo', '')), '') AS veiculo,
         t.name AS loja,
         (l.metadata ? 'distributed_to') AS distribuido,
         nullif(btrim(coalesce(l.metadata->>'observacao', '')), '') AS observacao,
         nullif(btrim(coalesce(l.metadata->>'promoter_name', '')), '') AS promoter_name,
         (cs.status IS NOT NULL) AS vendido,
         cs.amount_cents AS comissao_cents,
         cs.status AS comissao_status,
         esp.name AS especialista,
         stg.name AS etapa,
         coalesce(stg.is_won, false) AS etapa_ganho,
         coalesce(stg.is_lost, false) AS etapa_perdido,
         sl.first_contact_at AS primeiro_contato_at,
         sl.id AS store_lead_id,
         sl.tenant_id AS store_tenant_id
  FROM leads l
  LEFT JOIN tenants t ON t.id = nullif(l.metadata->>'owner_tenant_id', '')::uuid
  LEFT JOIN LATERAL (
    SELECT amount_cents, status FROM capture_reward_ledger
    WHERE idempotency_key = 'buyer_sold:' || l.id LIMIT 1
  ) cs ON true
  LEFT JOIN LATERAL (
    SELECT sl0.id, sl0.tenant_id, sl0.sales_rep_id, sl0.pipeline_stage_id, sl0.first_contact_at
    FROM leads sl0
    WHERE sl0.id = nullif(l.metadata->'distributed_to'->>'lead_id', '')::uuid
    LIMIT 1
  ) sl ON true
  LEFT JOIN team_members esp ON esp.id = sl.sales_rep_id
  LEFT JOIN sales_pipeline_stages stg ON stg.id = sl.pipeline_stage_id
  WHERE coalesce((l.metadata->>'comprador')::boolean, false) = true
    AND (l.metadata->>'promoter_id') IS NOT NULL
    -- Só a ficha-mãe (central). A cópia criada na loja pelo distribuir-lead herda
    -- todo o metadata (comprador/promoter_id) e ganha 'origin'; excluímos ela pra
    -- não duplicar o comprador na visão da promotora.
    AND NOT (l.metadata ? 'origin')
    AND (
      (v_target IS NOT NULL AND (l.metadata->>'promoter_id') = v_target::text)
      OR (v_target IS NULL AND v_admin AND l.tenant_id = public.get_tenant_id())
    )
  ORDER BY l.created_at DESC
  LIMIT 200;
END;
$$;
REVOKE ALL ON FUNCTION public.list_my_buyer_leads(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.list_my_buyer_leads(uuid) TO authenticated;
