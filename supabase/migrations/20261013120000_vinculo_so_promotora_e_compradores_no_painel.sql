-- ============================================================================
-- (1) VINCULAR ATENDIMENTO: só PROMOTORA bloqueia — vendedor não (2026-10-13)
--
-- Bug: cliente que escaneou o QR do totem vira lead no HQ (source 'stand') e é
-- DISTRIBUÍDO pra loja, que ganha metadata.origin. capture_link_attendance tratava
-- QUALQUER origin como "já tem promotora" → a promotora não conseguia se vincular
-- e a tela dizia "Já havia uma promotora", quando quem estava no lead era só o
-- VENDEDOR (ex.: Glauter, responsável padrão da Cardoso).
--
-- Agora "já vinculado" = existe PROMOTORA de fato: store.metadata.repasse_promoter_id
-- ou o lead-mãe (HQ) com metadata.promoter_id. Vendedor (sales_rep_id) nunca bloqueia.
-- Lead do QR sem promotora: carimba a promotora no lead-mãe que já existe (sem
-- duplicar) → aparece em "Meus compradores" e o R$150 cai por capture_award_buyer_sale.
--
-- (2) PAINEL DA PROMOTORA: compradores entram na contagem (2026-10-13)
--
-- capture_home_stats só contava captação de VENDEDOR (captured_by_member_id). O
-- comprador (captar-comprador / vínculo) não seta esse campo de propósito (é pra
-- consignação) → a promotora cadastrava 10 compradores e o painel não mexia.
-- Novos campos compradores_hoje/semana/mes (mesma regra de list_my_buyer_leads).
-- A META (anel/voucher, lead_validated) continua só de vendedor — mudar isso é
-- decisão de premiação.
-- JÁ APLICADO EM PRODUÇÃO via MCP; este arquivo registra.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Quem é a promotora de um lead de loja (NULL = nenhuma). Vendedor não conta.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._store_lead_promoter(p_store_lead_id uuid)
RETURNS TABLE(promoter_id uuid, promoter_name text, master_lead_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH sl AS (SELECT * FROM leads WHERE id = p_store_lead_id),
  mother AS (
    SELECT m.* FROM leads m, sl
    WHERE m.id = nullif(sl.metadata->'origin'->>'origin_lead_id', '')::uuid
    UNION ALL
    SELECT m.* FROM leads m, sl
    WHERE nullif(m.metadata->'distributed_to'->>'lead_id', '')::uuid = sl.id
  )
  SELECT coalesce(nullif(sl.metadata->>'repasse_promoter_id', '')::uuid,
                  (SELECT nullif(mo.metadata->>'promoter_id', '')::uuid FROM mother mo
                   WHERE nullif(mo.metadata->>'promoter_id', '') IS NOT NULL LIMIT 1)) AS promoter_id,
         coalesce(CASE WHEN nullif(sl.metadata->>'repasse_promoter_id', '') IS NOT NULL
                       THEN nullif(btrim(coalesce(sl.metadata->>'promoter_name', '')), '') END,
                  (SELECT nullif(btrim(coalesce(mo.metadata->>'promoter_name', '')), '') FROM mother mo
                   WHERE nullif(mo.metadata->>'promoter_id', '') IS NOT NULL LIMIT 1)) AS promoter_name,
         (SELECT mo.id FROM mother mo LIMIT 1) AS master_lead_id
  FROM sl;
$$;
REVOKE ALL ON FUNCTION public._store_lead_promoter(uuid) FROM public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Busca por telefone: "já vinculado" só quando tem promotora.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.capture_find_attendance(p_tenant_id uuid, p_phone text)
RETURNS TABLE(lead_id uuid, name text, phone_tail text, created_at timestamp with time zone, veiculo text, already_linked boolean, linked_promoter text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_member team_members%ROWTYPE;
  v_phone  text;
  v_last8  text;
BEGIN
  SELECT * INTO v_member FROM team_members
  WHERE auth_user_id = auth.uid() AND is_active
  ORDER BY created_at LIMIT 1;
  IF v_member.id IS NULL THEN RAISE EXCEPTION 'Usuário não é membro ativo de nenhum tenant'; END IF;

  IF p_tenant_id IS NULL THEN RAISE EXCEPTION 'Escolha a loja'; END IF;
  IF NOT EXISTS (SELECT 1 FROM tenant_lead_destinations d WHERE d.tenant_id = p_tenant_id AND d.active) THEN
    RAISE EXCEPTION 'Loja inválida';
  END IF;

  v_phone := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_last8 := right(v_phone, 8);
  IF length(v_last8) < 8 THEN RAISE EXCEPTION 'Telefone incompleto — informe ao menos 8 dígitos'; END IF;

  RETURN QUERY
  SELECT l.id,
         l.name,
         right(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g'), 4) AS phone_tail,
         l.created_at,
         nullif(btrim(coalesce(
           l.metadata->'veiculo_interesse'->>'titulo',
           l.metadata->'vehicle'->>'title',
           l.metadata->'vehicle'->>'titulo', '')), '') AS veiculo,
         (p.promoter_id IS NOT NULL) AS already_linked,
         p.promoter_name AS linked_promoter
  FROM leads l
  LEFT JOIN LATERAL public._store_lead_promoter(l.id) p ON true
  WHERE l.tenant_id = p_tenant_id
    AND l.phone IS NOT NULL
    AND right(regexp_replace(l.phone, '\D', '', 'g'), 8) = v_last8
  ORDER BY l.created_at DESC
  LIMIT 10;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Vincular: bloqueia só se já tem PROMOTORA. Lead do QR (com lead-mãe no HQ e sem
-- promotora) → carimba a promotora no lead-mãe existente, sem duplicar.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.capture_link_attendance(p_store_lead_id uuid, p_observacao text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_member   team_members%ROWTYPE;
  sl         leads%ROWTYPE;
  ml         leads%ROWTYPE;
  v_store    text;
  v_master   uuid;
  v_prom_id  uuid;
  v_prom_nm  text;
  v_mother   uuid;
  v_obs      text := nullif(btrim(p_observacao), '');
  v_veiculo  jsonb;
  v_title    text;
BEGIN
  SELECT * INTO v_member FROM team_members
  WHERE auth_user_id = auth.uid() AND is_active
  ORDER BY created_at LIMIT 1;
  IF v_member.id IS NULL THEN RAISE EXCEPTION 'Usuário não é membro ativo de nenhum tenant'; END IF;

  SELECT * INTO sl FROM leads WHERE id = p_store_lead_id;
  IF sl.id IS NULL THEN RAISE EXCEPTION 'Atendimento não encontrado'; END IF;

  IF sl.tenant_id = v_member.tenant_id THEN
    RAISE EXCEPTION 'Esse atendimento não é de uma loja da rede';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenant_lead_destinations d WHERE d.tenant_id = sl.tenant_id AND d.active) THEN
    RAISE EXCEPTION 'Loja inválida';
  END IF;

  SELECT coalesce(nullif(btrim(t.name), ''), 'loja') INTO v_store FROM tenants t WHERE t.id = sl.tenant_id;

  -- Já tem PROMOTORA? (vendedor/responsável da loja não conta)
  SELECT p.promoter_id, p.promoter_name, p.master_lead_id INTO v_prom_id, v_prom_nm, v_mother
  FROM public._store_lead_promoter(sl.id) p;
  IF v_prom_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', true, 'already', true, 'store_name', v_store,
      'promoter_name', v_prom_nm, 'mine', v_prom_id = v_member.id,
      'master_lead_id', v_mother, 'store_lead_id', sl.id
    );
  END IF;

  v_veiculo := coalesce(sl.metadata->'veiculo_interesse', sl.metadata->'vehicle', '{}'::jsonb);
  v_title := nullif(btrim(coalesce(v_veiculo->>'titulo', v_veiculo->>'title', '')), '');

  -- Lead-mãe já existe no tenant da promotora (cliente do QR distribuído pelo HQ)?
  IF v_mother IS NOT NULL THEN
    SELECT * INTO ml FROM leads WHERE id = v_mother;
  END IF;

  IF ml.id IS NOT NULL AND ml.tenant_id = v_member.tenant_id THEN
    v_master := ml.id;
    UPDATE leads SET
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
        'comprador', true,
        'vinculo_atendimento', true,
        'vinculo_at', now(),
        'veiculo_interesse', CASE WHEN coalesce(metadata->'veiculo_interesse', '{}'::jsonb) = '{}'::jsonb
                                  THEN v_veiculo ELSE metadata->'veiculo_interesse' END,
        'owner_tenant_id', sl.tenant_id,
        'promoter_id', v_member.id,
        'promoter_code', v_member.repasse_code,
        'promoter_name', v_member.name,
        'observacao', coalesce(v_obs, metadata->>'observacao'),
        'distributed_to', coalesce(metadata->'distributed_to',
                                   jsonb_build_object('tenant_id', sl.tenant_id, 'lead_id', sl.id, 'at', now()))
      )),
      last_interaction_at = now()
    WHERE id = v_master;
  ELSE
    INSERT INTO leads (tenant_id, name, phone, email, source, utm_source, metadata)
    VALUES (
      v_member.tenant_id, sl.name, sl.phone, sl.email, 'stand-vinculo', 'stand-vinculo',
      jsonb_build_object(
        'comprador', true,
        'vinculo_atendimento', true,
        'vinculo_at', now(),
        'veiculo_interesse', v_veiculo,
        'owner_tenant_id', sl.tenant_id,
        'promoter_id', v_member.id,
        'promoter_code', v_member.repasse_code,
        'promoter_name', v_member.name,
        'observacao', v_obs,
        'distributed_to', jsonb_build_object('tenant_id', sl.tenant_id, 'lead_id', sl.id, 'at', now())
      )
    ) RETURNING id INTO v_master;
  END IF;

  -- Carimba a loja. `origin` só é criado se não existir (não sobrescreve o do HQ).
  UPDATE leads SET
    metadata = coalesce(metadata, '{}'::jsonb)
      || jsonb_build_object('comprador', true, 'repasse_promoter_id', v_member.id, 'promoter_name', v_member.name)
      || CASE WHEN metadata ? 'origin' THEN '{}'::jsonb ELSE jsonb_build_object(
           'origin', jsonb_build_object(
             'origin_tenant_id', v_member.tenant_id,
             'origin_lead_id', v_master,
             'distributed_at', now(),
             'motivo', 'Vínculo de atendimento (stand)')) END,
    last_interaction_at = now()
  WHERE id = sl.id;

  RETURN jsonb_build_object(
    'ok', true, 'already', false,
    'master_lead_id', v_master, 'store_lead_id', sl.id,
    'store_name', v_store, 'promoter_name', v_member.name, 'veiculo', v_title
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.capture_link_attendance(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.capture_link_attendance(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.capture_find_attendance(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.capture_find_attendance(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- (2) Painel: + compradores_hoje / compradores_semana / compradores_mes.
-- Comprador da promotora = lead no tenant dela com metadata.comprador e
-- metadata.promoter_id = ela (mesma regra de list_my_buyer_leads). Data = quando
-- ELA vinculou (metadata.vinculo_at) ou a criação do lead.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.capture_home_stats(p_member_id uuid DEFAULT NULL::uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_member_id uuid := public.current_member_id();
  v_target uuid; v_tenant uuid; v_profile text;
  v_today_start timestamptz := date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo';
  v_week_start  timestamptz := date_trunc('week', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo';
  v_month_start timestamptz := date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo';
  r jsonb; v_goal integer; v_goal_label text; v_daily integer; v_incentivos boolean; v_buyers jsonb;
BEGIN
  IF v_member_id IS NULL THEN RETURN '{}'::jsonb; END IF;
  v_target := CASE WHEN p_member_id IS NOT NULL AND (public.is_capture_manager()) THEN p_member_id ELSE v_member_id END;
  SELECT tenant_id, capture_profile INTO v_tenant, v_profile FROM team_members WHERE id = v_target;
  SELECT threshold, coalesce(voucher_label, name) INTO v_goal, v_goal_label FROM capture_reward_rules
  WHERE tenant_id = v_tenant AND active AND event_type = 'lead_validated' AND period_type = 'week'
    AND (include_folgista OR coalesce(v_profile, 'padrao') <> 'folgista')
  ORDER BY position LIMIT 1;
  SELECT daily_goal INTO v_daily FROM capture_handoff_config WHERE tenant_id = v_tenant;
  v_daily := coalesce(v_daily, greatest(1, ceil(coalesce(v_goal, 40) / 5.0)::int));
  v_incentivos := EXISTS (SELECT 1 FROM capture_reward_rules
                          WHERE tenant_id = v_tenant AND active AND (include_folgista OR coalesce(v_profile, 'padrao') <> 'folgista'));

  SELECT jsonb_build_object(
    'compradores_hoje',   count(*) FILTER (WHERE b.at >= v_today_start),
    'compradores_semana', count(*) FILTER (WHERE b.at >= v_week_start),
    'compradores_mes',    count(*) FILTER (WHERE b.at >= v_month_start)
  ) INTO v_buyers
  FROM (
    SELECT coalesce(nullif(l.metadata->>'vinculo_at', '')::timestamptz, l.created_at) AS at
    FROM leads l
    WHERE l.tenant_id = v_tenant
      AND coalesce((l.metadata->>'comprador')::boolean, false)
      AND l.metadata->>'promoter_id' = v_target::text
      AND NOT (l.metadata ? 'origin')
  ) b;

  SELECT jsonb_build_object(
    'perfil',         coalesce(v_profile, 'padrao'),
    'incentivos',     v_incentivos,
    'hoje',           count(*) FILTER (WHERE captured_at >= v_today_start),
    'semana',         count(*) FILTER (WHERE captured_at >= v_week_start),
    'mes',            count(*) FILTER (WHERE captured_at >= v_month_start),
    'validos_semana', count(*) FILTER (WHERE capture_valid AND capture_validated_at >= v_week_start),
    'validos_hoje',   count(*) FILTER (WHERE capture_valid AND capture_validated_at >= v_today_start),
    'invalidos_semana', count(*) FILTER (WHERE NOT capture_valid AND captured_at >= v_week_start),
    'invalidos_motivos', (SELECT coalesce(jsonb_object_agg(m, n), '{}'::jsonb) FROM (
        SELECT capture_invalid_reason AS m, count(*) AS n FROM leads
        WHERE captured_by_member_id = v_target AND NOT capture_valid AND captured_at >= v_week_start AND capture_invalid_reason IS NOT NULL
        GROUP BY 1) t),
    'meta_semanal',   coalesce(v_goal, 40),
    'meta_diaria',    v_daily,
    'meta_label',     v_goal_label,
    'quentes_semana', count(*) FILTER (WHERE captured_at >= v_week_start AND seller_qualification->>'temperatura' = 'quente'),
    'qualificados_hoje', count(*) FILTER (WHERE captured_at >= v_today_start AND coalesce(sales_score, 0) >= 45),
    'pendentes_complemento', count(*) FILTER (WHERE NOT capture_valid AND captured_at >= v_week_start),
    'handoff_pendente', count(*) FILTER (WHERE first_contact_at IS NULL
                                           AND handoff_status IN ('pending', 'notified', 'sla_breached', 'escalated', 'unassigned')
                                           AND seller_qualification->>'temperatura' IN ('quente', 'morno')
                                           AND captured_at >= v_month_start),
    'contatados_semana', count(*) FILTER (WHERE first_contact_at >= v_week_start),
    'em_atendimento', count(*) FILTER (WHERE sales_rep_id IS NOT NULL AND captured_at >= v_month_start),
    'captados_mes', (SELECT count(*) FROM seller_vehicles sv JOIN leads x ON x.id = sv.lead_id
                     WHERE x.captured_by_member_id = v_target AND sv.status IN ('captado', 'preparacao', 'anunciado', 'negociacao', 'vendido')
                       AND sv.captured_at >= v_month_start),
    'vendidos_mes', (SELECT count(*) FROM seller_vehicles sv JOIN leads x ON x.id = sv.lead_id
                     WHERE x.captured_by_member_id = v_target AND sv.status = 'vendido' AND sv.sold_at >= v_month_start),
    'retornos_nao_lidos', (SELECT count(*) FROM capture_lead_events e WHERE e.promotora_member_id = v_target AND e.read_at IS NULL),
    'wallet', (SELECT jsonb_build_object(
        'pending_cents',  coalesce(sum(amount_cents) FILTER (WHERE status = 'pending'  AND reward_type = 'cash'), 0),
        'earned_cents',   coalesce(sum(amount_cents) FILTER (WHERE status IN ('approved', 'paid') AND reward_type = 'cash'), 0),
        'vouchers_pending', count(*) FILTER (WHERE reward_type = 'voucher' AND status IN ('pending', 'approved')))
       FROM capture_reward_ledger WHERE promoter_id = v_target)
  ) INTO r
  FROM leads l
  WHERE l.captured_by_member_id = v_target;

  RETURN coalesce(r, '{}'::jsonb) || coalesce(v_buyers, '{}'::jsonb);
END;
$function$;
