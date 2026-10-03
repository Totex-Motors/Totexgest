-- ============================================================================
-- VINCULAR ATENDIMENTO POR TELEFONE (2026-10-03)
--
-- Cenário (Marco): a promotora atende um cliente no stand; o cliente escaneia o
-- QR da loja e cai no "cérebro" (agente WhatsApp), que cria o lead JÁ no tenant
-- da LOJA. A promotora quer o crédito da indicação SEM recadastrar o cliente —
-- recadastrar duplicaria o lead na loja.
--
-- Solução: a promotora escolhe a loja + informa o telefone, o sistema ACHA o
-- atendimento que já existe na loja e VINCULA a promotora a ele (sem criar lead
-- novo na loja). O vínculo reaproveita exatamente o mecanismo do fluxo "Comprar":
--   • cria o lead "master" de atribuição no tenant da promotora (HQ), marcado
--     comprador=true + promoter_id + distributed_to → lead da loja;
--   • carimba o lead da loja com origin → master + comprador=true (pro gatilho de
--     venda) + promoter_name (pra aparecer "trazido por <promotora>").
--
-- Com isso o R$ 150 cai pelo caminho PROVADO buyer_sold (capture_award_buyer_sale),
-- que lança no ledger do tenant da PRÓPRIA promotora — SEM o descasamento de
-- tenant do caminho de repasse (repasse_convert_for_buyer olha o tenant da loja).
-- O pagamento dispara: (a) automático quando o deal da loja chega em is_won
-- (trg_buyer_sale_on_deal_won lê comprador=true + origin.origin_lead_id) ou
-- (b) manual pelo gestor em "Meus leads" (capture_mark_buyer_sold).
--
-- Guarda anti-duplicidade: se o lead da loja JÁ tem origin (já veio de um master,
-- ex.: distribuído pelo "Comprar"), o vínculo é recusado como "já vinculado" —
-- isso também evita pagar 2× o mesmo comprador.
-- ============================================================================

-- ─── 1) Buscar o atendimento da loja por telefone ────────────────────────────
-- Promotora escolhe a loja (precisa ser loja roteável — mesma fronteira do
-- "Comprar") e informa o telefone; devolve os leads candidatos (mínimo de dados).
CREATE OR REPLACE FUNCTION public.capture_find_attendance(p_tenant_id uuid, p_phone text)
RETURNS TABLE (
  lead_id        uuid,
  name           text,
  phone_tail     text,
  created_at     timestamptz,
  veiculo        text,
  already_linked boolean,
  linked_promoter text
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
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
         ((l.metadata ? 'origin') OR (l.metadata ? 'repasse_promoter_id')) AS already_linked,
         nullif(btrim(coalesce(l.metadata->>'promoter_name', '')), '') AS linked_promoter
  FROM leads l
  WHERE l.tenant_id = p_tenant_id
    AND l.phone IS NOT NULL
    AND right(regexp_replace(l.phone, '\D', '', 'g'), 8) = v_last8
  ORDER BY l.created_at DESC
  LIMIT 10;
END;
$$;
REVOKE ALL ON FUNCTION public.capture_find_attendance(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.capture_find_attendance(uuid, text) TO authenticated;

-- ─── 2) Vincular a promotora ao atendimento existente ────────────────────────
CREATE OR REPLACE FUNCTION public.capture_link_attendance(p_store_lead_id uuid, p_observacao text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_member   team_members%ROWTYPE;
  sl         leads%ROWTYPE;
  v_store    text;
  v_master   uuid;
  v_existing uuid;
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

  -- só lojas roteáveis da rede; e nunca um lead do próprio tenant da promotora
  IF sl.tenant_id = v_member.tenant_id THEN
    RAISE EXCEPTION 'Esse atendimento não é de uma loja da rede';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenant_lead_destinations d WHERE d.tenant_id = sl.tenant_id AND d.active) THEN
    RAISE EXCEPTION 'Loja inválida';
  END IF;

  SELECT coalesce(nullif(btrim(t.name), ''), 'loja') INTO v_store FROM tenants t WHERE t.id = sl.tenant_id;

  -- Já vinculado? (primeira promotora vence) — evita master duplicado e pagamento 2×.
  IF sl.metadata ? 'origin' OR sl.metadata ? 'repasse_promoter_id' THEN
    RETURN jsonb_build_object(
      'ok', true, 'already', true, 'store_name', v_store,
      'promoter_name', nullif(btrim(coalesce(sl.metadata->>'promoter_name', '')), ''),
      'store_lead_id', sl.id
    );
  END IF;

  -- Já existe master apontando pra esse lead da loja? (idempotência do vínculo)
  SELECT id INTO v_existing FROM leads
  WHERE tenant_id = v_member.tenant_id
    AND nullif(metadata->'distributed_to'->>'lead_id', '')::uuid = sl.id
  LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'store_name', v_store,
                              'promoter_name', v_member.name, 'master_lead_id', v_existing, 'store_lead_id', sl.id);
  END IF;

  v_veiculo := coalesce(sl.metadata->'veiculo_interesse', sl.metadata->'vehicle', '{}'::jsonb);
  v_title := nullif(btrim(coalesce(v_veiculo->>'titulo', v_veiculo->>'title', '')), '');

  -- 1) Cria o lead master de atribuição no tenant da promotora (HQ).
  INSERT INTO leads (tenant_id, name, phone, email, source, utm_source, metadata)
  VALUES (
    v_member.tenant_id, sl.name, sl.phone, sl.email, 'stand-vinculo', 'stand-vinculo',
    jsonb_build_object(
      'comprador', true,
      'vinculo_atendimento', true,
      'veiculo_interesse', v_veiculo,
      'owner_tenant_id', sl.tenant_id,
      'promoter_id', v_member.id,
      'promoter_code', v_member.repasse_code,
      'promoter_name', v_member.name,
      'observacao', v_obs,
      'distributed_to', jsonb_build_object('tenant_id', sl.tenant_id, 'lead_id', sl.id, 'at', now())
    )
  ) RETURNING id INTO v_master;

  -- 2) Carimba o lead da loja: origin → master, comprador=true (gatilho de venda),
  --    e atribuição da promotora (pra UI mostrar "trazido por <promotora>").
  UPDATE leads SET
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'comprador', true,
      'origin', jsonb_build_object(
        'origin_tenant_id', v_member.tenant_id,
        'origin_lead_id', v_master,
        'distributed_at', now(),
        'motivo', 'Vínculo de atendimento (stand)'
      ),
      'repasse_promoter_id', v_member.id,
      'promoter_name', v_member.name
    ),
    last_interaction_at = now()
  WHERE id = sl.id;

  RETURN jsonb_build_object(
    'ok', true, 'already', false,
    'master_lead_id', v_master, 'store_lead_id', sl.id,
    'store_name', v_store, 'promoter_name', v_member.name, 'veiculo', v_title
  );
END;
$$;
REVOKE ALL ON FUNCTION public.capture_link_attendance(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.capture_link_attendance(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.capture_link_attendance(uuid, text) IS
  'Vincula a promotora a um atendimento que já existe no tenant da loja (sem duplicar): cria o master de atribuição e carimba o lead da loja. R$150 cai pelo caminho buyer_sold.';
