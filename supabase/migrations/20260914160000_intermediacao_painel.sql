-- ============================================================================
-- INTERMEDIAÇÃO — Painel de gestão (2026-09-14)
-- Um RPC agrega tudo pro gestor (admin/comercial/closer): KPIs, listas acionáveis
-- ("precisa de atenção"), ranking de promotoras e prêmios por status.
-- Promotora não acessa. Escopo por tenant. Só leitura.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.intermediation_dashboard(p_period text DEFAULT 'month')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant uuid := public.get_tenant_id();
  v_ps timestamptz;
  v_kpis jsonb; v_atencao jsonb; v_ranking jsonb; v_premios jsonb;
BEGIN
  IF public.is_promotora() OR v_tenant IS NULL THEN RAISE EXCEPTION 'Sem acesso'; END IF;
  v_ps := CASE p_period WHEN 'week' THEN date_trunc('week', now()) WHEN 'all' THEN '2000-01-01'::timestamptz
                        WHEN 'quarter' THEN date_trunc('quarter', now()) ELSE date_trunc('month', now()) END;

  -- KPIs (todas as intermediações vivas + números do período)
  SELECT jsonb_build_object(
    'ativas',              count(*) FILTER (WHERE status = 'active'),
    'vencendo',            count(*) FILTER (WHERE status = 'active' AND deadline_status <> 'ok'),
    'aguardando_contrato', count(*) FILTER (WHERE status IN ('lead','contracting','docs_pending') AND contract_status IN ('none','generated','sent','partial')),
    'aguardando_termo',    count(*) FILTER (WHERE status = 'active' AND sale_price IS NOT NULL AND sale_contract_status IN ('none','generated','sent','partial')),
    'aguardando_pagamento',count(*) FILTER (WHERE status = 'active' AND sale_contract_status IN ('signed','imported') AND coalesce(payment_status,'pending') <> 'satisfied'),
    'prontas_concluir',    count(*) FILTER (WHERE status = 'active' AND sale_contract_status IN ('signed','imported') AND payment_status = 'satisfied'),
    'vendidas_periodo',    count(*) FILTER (WHERE status = 'completed' AND completed_at >= v_ps),
    'encerradas_periodo',  count(*) FILTER (WHERE status IN ('cancelled_by_owner','refused_by_totex','lost','sold_outside') AND coalesce(closed_at, updated_at) >= v_ps),
    'valor_vendido_periodo', coalesce(sum(sale_price) FILTER (WHERE status = 'completed' AND completed_at >= v_ps), 0),
    'comissao_apurada',    coalesce(sum(commission_due) FILTER (WHERE status = 'completed'), 0),
    'comissao_paga',       coalesce(sum(commission_due) FILTER (WHERE commission_status = 'paid'), 0),
    'comissao_pendente',   coalesce(sum(commission_due) FILTER (WHERE status = 'completed' AND coalesce(commission_status,'pending') NOT IN ('paid','waived')), 0)
  ) INTO v_kpis
  FROM intermediations WHERE tenant_id = v_tenant;

  -- Listas acionáveis (cada uma no máx. 50, ordenada por urgência)
  WITH base AS (
    SELECT i.id, i.owner_lead_id, i.code, l.name AS lead_name, i.status, i.contract_status, i.sale_contract_status,
           i.payment_status, i.ends_at, i.deadline_status, i.sale_price, i.asking_price, i.updated_at
    FROM intermediations i JOIN leads l ON l.id = i.owner_lead_id
    WHERE i.tenant_id = v_tenant
  )
  SELECT jsonb_build_object(
    'prazos', coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (
        SELECT id AS intermediation_id, owner_lead_id, code, lead_name, ends_at, deadline_status
        FROM base WHERE status = 'active' AND deadline_status <> 'ok' ORDER BY ends_at NULLS LAST LIMIT 50) x), '[]'::jsonb),
    'contratos_pendentes', coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (
        SELECT id AS intermediation_id, owner_lead_id, code, lead_name, contract_status
        FROM base WHERE status IN ('lead','contracting','docs_pending') AND contract_status IN ('generated','sent','partial') ORDER BY updated_at DESC LIMIT 50) x), '[]'::jsonb),
    'termos_pendentes', coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (
        SELECT id AS intermediation_id, owner_lead_id, code, lead_name, sale_contract_status, sale_price
        FROM base WHERE status = 'active' AND sale_price IS NOT NULL AND sale_contract_status IN ('none','generated','sent','partial') ORDER BY updated_at DESC LIMIT 50) x), '[]'::jsonb),
    'pagamentos_pendentes', coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (
        SELECT id AS intermediation_id, owner_lead_id, code, lead_name, sale_price, payment_status
        FROM base WHERE status = 'active' AND sale_contract_status IN ('signed','imported') AND coalesce(payment_status,'pending') <> 'satisfied' ORDER BY updated_at DESC LIMIT 50) x), '[]'::jsonb),
    'prontas_concluir', coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (
        SELECT id AS intermediation_id, owner_lead_id, code, lead_name, sale_price
        FROM base WHERE status = 'active' AND sale_contract_status IN ('signed','imported') AND payment_status = 'satisfied' ORDER BY updated_at DESC LIMIT 50) x), '[]'::jsonb)
  ) INTO v_atencao;

  -- Ranking de promotoras no período (captações, vendas, prêmios ganhos)
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.premios_cents DESC, r.vendidas DESC), '[]'::jsonb) INTO v_ranking FROM (
    SELECT m.id AS member_id, m.name,
      count(DISTINCT i.id) FILTER (WHERE i.created_at >= v_ps) AS captadas,
      count(DISTINCT i.id) FILTER (WHERE i.status = 'completed' AND i.completed_at >= v_ps) AS vendidas,
      coalesce((SELECT sum(amount_cents) FROM capture_reward_ledger rl
                WHERE rl.tenant_id = v_tenant AND rl.promoter_id = m.id AND rl.earned_at >= v_ps AND rl.status <> 'cancelled'), 0) AS premios_cents
    FROM team_members m
    LEFT JOIN intermediations i ON i.tenant_id = v_tenant AND i.promoter_id = m.id
    WHERE m.tenant_id = v_tenant AND m.role = 'promotora' AND m.is_active
    GROUP BY m.id, m.name
    HAVING count(DISTINCT i.id) FILTER (WHERE i.created_at >= v_ps) > 0
        OR coalesce((SELECT sum(amount_cents) FROM capture_reward_ledger rl WHERE rl.tenant_id = v_tenant AND rl.promoter_id = m.id AND rl.earned_at >= v_ps AND rl.status <> 'cancelled'), 0) > 0
  ) r;

  -- Prêmios por status (ledger)
  SELECT jsonb_build_object(
    'pendente_cents', coalesce(sum(amount_cents) FILTER (WHERE status = 'pending'), 0),
    'aprovado_cents', coalesce(sum(amount_cents) FILTER (WHERE status = 'approved'), 0),
    'pago_cents',     coalesce(sum(amount_cents) FILTER (WHERE status = 'paid'), 0),
    'pendente_qtd',   count(*) FILTER (WHERE status = 'pending')
  ) INTO v_premios FROM capture_reward_ledger WHERE tenant_id = v_tenant AND status <> 'cancelled';

  RETURN jsonb_build_object(
    'period', p_period, 'period_start', v_ps, 'generated_at', now(),
    'kpis', v_kpis, 'atencao', v_atencao, 'ranking', v_ranking, 'premios', v_premios
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.intermediation_dashboard(text) TO authenticated;
