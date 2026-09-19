-- Rodízio de captação: o fallback (quando NENHUM especialista é marcado) só pegava
-- role IN ('comercial','closer'), deixando de fora quem tem role 'geral' (Vendedor).
-- Inclui 'geral' pra que vendedores como o Glauter também entrem no rodízio.
CREATE OR REPLACE FUNCTION public.capture_pick_specialist(p_tenant uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cfg capture_handoff_config%ROWTYPE;
  v_candidates uuid[];
  v_idx integer;
  v_next uuid;
BEGIN
  SELECT * INTO v_cfg FROM capture_handoff_config WHERE tenant_id = p_tenant;

  -- lista configurada (mantém a ordem do array, só ativos)
  IF v_cfg.tenant_id IS NOT NULL AND coalesce(array_length(v_cfg.specialist_member_ids, 1), 0) > 0 THEN
    SELECT array_agg(m.id ORDER BY o.ord) INTO v_candidates
    FROM unnest(v_cfg.specialist_member_ids) WITH ORDINALITY AS o(id, ord)
    JOIN team_members m ON m.id = o.id AND m.is_active AND m.tenant_id = p_tenant;
  END IF;

  -- fallback: todo vendedor ativo do tenant (inclui 'geral' = Vendedor)
  IF coalesce(array_length(v_candidates, 1), 0) = 0 THEN
    SELECT array_agg(id ORDER BY name) INTO v_candidates
    FROM team_members
    WHERE tenant_id = p_tenant AND is_active AND role IN ('comercial', 'closer', 'geral');
  END IF;

  IF coalesce(array_length(v_candidates, 1), 0) = 0 THEN RETURN NULL; END IF;

  v_idx := coalesce(array_position(v_candidates, v_cfg.last_assigned_member_id), 0);
  v_next := v_candidates[(v_idx % array_length(v_candidates, 1)) + 1];

  INSERT INTO capture_handoff_config (tenant_id, last_assigned_member_id)
  VALUES (p_tenant, v_next)
  ON CONFLICT (tenant_id) DO UPDATE SET last_assigned_member_id = EXCLUDED.last_assigned_member_id;

  RETURN v_next;
END;
$$;
