-- ============================================================================
-- COMISSÃO DE VENDA DO COMPRADOR (R$ 150) — fluxo "Comprar" da captação.
--
-- A promotora capta um comprador no totem; o lead é distribuído pro tenant da
-- LOJA. Quando a loja FECHA a venda (deal em etapa is_won no tenant dela), a
-- promotora ganha R$ 150 — que EMPILHA com o crédito de indicação (repasse).
--
-- Cross-tenant: a venda acontece no tenant da loja; a recompensa entra no ledger
-- do tenant da PROMOTORA, PENDENTE (o gestor aprova/paga, igual aos R$25/R$50).
-- Idempotente por lead master (nunca paga 2× o mesmo comprador).
--
-- Gatilhos: (1) automático no deal is_won da loja; (2) manual pelo gestor
-- (capture_mark_buyer_sold) — backup pra quando a loja não fecha no CRM.
-- ============================================================================

-- 1) event_type novo nos CHECKs (rules + events) — preserva os valores já
--    adicionados por migrations posteriores (intermediação, repasse) e só soma 'buyer_sold'.
ALTER TABLE public.capture_reward_rules DROP CONSTRAINT IF EXISTS capture_reward_rules_event_type_check;
ALTER TABLE public.capture_reward_rules ADD CONSTRAINT capture_reward_rules_event_type_check
  CHECK (event_type IN ('lead_validated','vehicle_captured','vehicle_sold','monthly_champion',
                        'intermediation_formalized','intermediation_completed','repasse_converted','buyer_sold'));

ALTER TABLE public.capture_events DROP CONSTRAINT IF EXISTS capture_events_event_type_check;
ALTER TABLE public.capture_events ADD CONSTRAINT capture_events_event_type_check
  CHECK (event_type IN ('lead_submitted','lead_validated','lead_invalidated','vehicle_captured',
                        'vehicle_sold','monthly_champion','reward_approved','reward_paid','reward_cancelled',
                        'intermediation_formalized','intermediation_completed','repasse_converted','buyer_sold'));

-- 2) Award idempotente. Insere ledger PENDENTE no tenant da promotora + feed dela.
CREATE OR REPLACE FUNCTION public.capture_award_buyer_sale(p_master_lead_id uuid, p_store_lead_id uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  ml leads%ROWTYPE; v_promoter uuid; v_ptenant uuid; v_amount int; v_rule uuid;
  v_desc text; v_key text; v_id uuid; ev record;
BEGIN
  SELECT * INTO ml FROM leads WHERE id = p_master_lead_id;
  IF ml.id IS NULL THEN RETURN NULL; END IF;
  IF coalesce((ml.metadata->>'comprador')::boolean, false) IS NOT TRUE THEN RETURN NULL; END IF;
  v_promoter := nullif(ml.metadata->>'promoter_id', '')::uuid;
  IF v_promoter IS NULL THEN RETURN NULL; END IF;
  SELECT tenant_id INTO v_ptenant FROM team_members WHERE id = v_promoter;
  IF v_ptenant IS NULL THEN RETURN NULL; END IF;

  v_key := 'buyer_sold:' || p_master_lead_id;
  IF EXISTS (SELECT 1 FROM capture_reward_ledger WHERE idempotency_key = v_key) THEN RETURN NULL; END IF;

  SELECT id, amount_cents INTO v_rule, v_amount FROM capture_reward_rules
   WHERE tenant_id = v_ptenant AND active AND event_type = 'buyer_sold' ORDER BY position LIMIT 1;
  v_amount := coalesce(v_amount, 15000);
  v_desc := coalesce(nullif(btrim(ml.metadata->'veiculo_interesse'->>'titulo', ''), ''), 'carro');

  SELECT * INTO ev FROM capture_emit_event(v_ptenant, v_promoter, 'buyer_sold', v_key, p_master_lead_id, NULL, NULL,
    jsonb_build_object('store_lead_id', p_store_lead_id, 'amount_cents', v_amount));

  INSERT INTO capture_reward_ledger (tenant_id, promoter_id, rule_id, event_id, lead_id, reward_type,
                                     amount_cents, title, status, period_start, idempotency_key)
  VALUES (v_ptenant, v_promoter, v_rule, ev.event_id, p_master_lead_id, 'cash',
          v_amount, 'Comprador vendido — ' || v_desc, 'pending', capture_period_start('month'), v_key)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_id;

  -- feed da promotora (capture_add_event ignora leads sem captured_by → insere direto)
  IF v_id IS NOT NULL THEN
    INSERT INTO capture_lead_events (tenant_id, lead_id, promotora_member_id, event_type, title, body)
    VALUES (v_ptenant, p_master_lead_id, v_promoter, 'sold', '🎉 VENDEU! ' || v_desc,
            'O comprador que você mandou fechou. +R$ ' || to_char(v_amount/100.0, 'FM999G990D00') || ' pendentes de aprovação.');
  END IF;
  RETURN v_id;
END;
$$;

-- 3) Manual: gestor marca o comprador como vendido (backup do automático).
CREATE OR REPLACE FUNCTION public.capture_mark_buyer_sold(p_lead_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid;
BEGIN
  IF NOT (public.is_admin() OR public.is_superadmin()) THEN RAISE EXCEPTION 'Apenas gestor'; END IF;
  SELECT tenant_id INTO v_tenant FROM leads WHERE id = p_lead_id;
  IF v_tenant IS NULL OR (v_tenant <> public.get_tenant_id() AND NOT public.is_superadmin()) THEN
    RAISE EXCEPTION 'Lead não encontrado';
  END IF;
  RETURN public.capture_award_buyer_sale(p_lead_id, NULL);
END;
$$;
GRANT EXECUTE ON FUNCTION public.capture_mark_buyer_sold(uuid) TO authenticated;

-- 4) Automático: deal da loja chegou em etapa is_won → paga a promotora do comprador.
CREATE OR REPLACE FUNCTION public.trg_buyer_sale_on_deal_won() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s_won boolean; lmeta jsonb; ml uuid;
BEGIN
  SELECT is_won INTO s_won FROM sales_pipeline_stages WHERE id = NEW.pipeline_stage_id;
  IF NOT coalesce(s_won, false) THEN RETURN NEW; END IF;
  SELECT metadata INTO lmeta FROM leads WHERE id = NEW.lead_id;
  IF lmeta IS NULL OR coalesce((lmeta->>'comprador')::boolean, false) IS NOT TRUE THEN RETURN NEW; END IF;
  -- o deal está no tenant da loja: o lead master é origin.origin_lead_id
  ml := nullif(lmeta->'origin'->>'origin_lead_id', '')::uuid;
  IF ml IS NULL THEN ml := NEW.lead_id; END IF;  -- fallback: o próprio lead é o master
  PERFORM public.capture_award_buyer_sale(ml, NEW.lead_id);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_buyer_sale_on_deal_won_ins ON public.deals;
CREATE TRIGGER trg_buyer_sale_on_deal_won_ins AFTER INSERT ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.trg_buyer_sale_on_deal_won();
DROP TRIGGER IF EXISTS trg_buyer_sale_on_deal_won_upd ON public.deals;
CREATE TRIGGER trg_buyer_sale_on_deal_won_upd AFTER UPDATE OF pipeline_stage_id ON public.deals
  FOR EACH ROW WHEN (OLD.pipeline_stage_id IS DISTINCT FROM NEW.pipeline_stage_id)
  EXECUTE FUNCTION public.trg_buyer_sale_on_deal_won();

-- 5) Regra R$150 (editável) por tenant que tem promotora. Sem ela o award usa 15000.
INSERT INTO public.capture_reward_rules (tenant_id, name, event_type, reward_type, amount_cents, cap_per_period, position, active)
SELECT DISTINCT tm.tenant_id, 'Comprador vendido', 'buyer_sold', 'cash', 15000, 999, 5, true
FROM public.team_members tm
WHERE tm.role = 'promotora'
  AND NOT EXISTS (SELECT 1 FROM public.capture_reward_rules r WHERE r.tenant_id = tm.tenant_id AND r.event_type = 'buyer_sold');

-- 6) Painel: list_my_buyer_leads ganha status de venda/comissão + visão do gestor.
DROP FUNCTION IF EXISTS public.list_my_buyer_leads(uuid);
CREATE OR REPLACE FUNCTION public.list_my_buyer_leads(p_member_id uuid DEFAULT NULL)
RETURNS TABLE (
  lead_id uuid, name text, phone text, created_at timestamptz,
  veiculo text, loja text, distribuido boolean, observacao text,
  promoter_name text, vendido boolean, comissao_cents integer, comissao_status text
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_member uuid := public.current_member_id();
  v_admin boolean := (public.is_admin() OR public.is_superadmin());
  v_target uuid;
BEGIN
  IF v_member IS NULL THEN RETURN; END IF;
  -- promotora: só os dela. gestor sem filtro: todos do tenant. gestor com p_member_id: daquela promotora.
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
         cs.status AS comissao_status
  FROM leads l
  LEFT JOIN tenants t ON t.id = nullif(l.metadata->>'owner_tenant_id', '')::uuid
  LEFT JOIN LATERAL (SELECT amount_cents, status FROM capture_reward_ledger
                     WHERE idempotency_key = 'buyer_sold:' || l.id LIMIT 1) cs ON true
  WHERE coalesce((l.metadata->>'comprador')::boolean, false) = true
    AND (l.metadata->>'promoter_id') IS NOT NULL
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
