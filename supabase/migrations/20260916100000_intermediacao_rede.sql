-- ============================================================================
-- INTERMEDIAÇÃO — Fase 6: Rede de franquias (2026-09-16)
-- Franquia = tenant (o sistema já é multi-tenant: entidade jurídica, templates
-- globais × locais, procurações, alçadas e credenciais já são por tenant). O que
-- faltava é a VISÃO DE REDE do superadmin Totex central: métricas de intermediação
-- agregadas por franquia. RPC superadmin-only, uma chamada.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.intermediation_network_dashboard(p_period text DEFAULT 'month')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ps timestamptz; v_rows jsonb; v_total jsonb;
BEGIN
  IF NOT public.is_superadmin() THEN RAISE EXCEPTION 'Só superadmin vê a rede'; END IF;
  v_ps := CASE p_period WHEN 'week' THEN date_trunc('week', now()) WHEN 'all' THEN '2000-01-01'::timestamptz
                        WHEN 'quarter' THEN date_trunc('quarter', now()) ELSE date_trunc('month', now()) END;

  WITH per AS (
    SELECT t.id AS tenant_id, t.name AS tenant_name, t.slug, t.is_active,
      count(i.id) FILTER (WHERE i.status = 'active') AS ativas,
      count(i.id) FILTER (WHERE i.status = 'active' AND i.deadline_status <> 'ok') AS vencendo,
      count(i.id) FILTER (WHERE i.created_at >= v_ps) AS captadas_periodo,
      count(i.id) FILTER (WHERE i.status = 'completed' AND i.completed_at >= v_ps) AS vendidas_periodo,
      coalesce(sum(i.sale_price) FILTER (WHERE i.status = 'completed' AND i.completed_at >= v_ps), 0) AS valor_vendido_periodo,
      coalesce(sum(i.commission_due) FILTER (WHERE i.status = 'completed'), 0) AS comissao_apurada,
      coalesce(sum(i.commission_due) FILTER (WHERE i.commission_status = 'paid'), 0) AS comissao_paga,
      (SELECT count(*) FROM team_members m WHERE m.tenant_id = t.id AND m.role = 'promotora' AND m.is_active) AS promotoras,
      (SELECT count(*) FROM approval_requests a WHERE a.tenant_id = t.id AND a.status = 'pending') AS aprovacoes_pendentes
    FROM tenants t
    LEFT JOIN intermediations i ON i.tenant_id = t.id
    WHERE t.is_active AND NOT coalesce(t.is_super_admin, false)
    GROUP BY t.id, t.name, t.slug, t.is_active
    HAVING count(i.id) > 0 OR (SELECT count(*) FROM team_members m WHERE m.tenant_id = t.id AND m.role = 'promotora') > 0
  )
  SELECT coalesce(jsonb_agg(to_jsonb(per) ORDER BY per.vendidas_periodo DESC, per.ativas DESC), '[]'::jsonb),
         jsonb_build_object(
           'franquias', count(*),
           'ativas', coalesce(sum(ativas), 0),
           'vencendo', coalesce(sum(vencendo), 0),
           'vendidas_periodo', coalesce(sum(vendidas_periodo), 0),
           'valor_vendido_periodo', coalesce(sum(valor_vendido_periodo), 0),
           'comissao_apurada', coalesce(sum(comissao_apurada), 0),
           'comissao_paga', coalesce(sum(comissao_paga), 0),
           'promotoras', coalesce(sum(promotoras), 0),
           'aprovacoes_pendentes', coalesce(sum(aprovacoes_pendentes), 0)
         )
  INTO v_rows, v_total FROM per;

  RETURN jsonb_build_object(
    'period', p_period, 'period_start', v_ps, 'generated_at', now(),
    'total', v_total, 'franquias', v_rows,
    'templates_globais', (SELECT count(*) FROM contract_templates WHERE tenant_id IS NULL AND status = 'published')
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.intermediation_network_dashboard(text) TO authenticated;
