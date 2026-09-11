-- Captação — meta DIÁRIA de leads válidos (anel "Hoje" ao lado do "Semana").
-- Configurável por tenant; sem valor, deriva da meta semanal (÷ 5 dias úteis).
ALTER TABLE public.capture_handoff_config
  ADD COLUMN IF NOT EXISTS daily_goal integer CHECK (daily_goal IS NULL OR daily_goal > 0);

CREATE OR REPLACE FUNCTION public.capture_home_stats(p_member_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member_id uuid := public.current_member_id();
  v_target uuid; v_tenant uuid;
  v_today_start timestamptz := date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo';
  v_week_start  timestamptz := date_trunc('week', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo';
  v_month_start timestamptz := date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo';
  r jsonb; v_goal integer; v_goal_label text; v_daily integer;
BEGIN
  IF v_member_id IS NULL THEN RETURN '{}'::jsonb; END IF;
  v_target := CASE WHEN p_member_id IS NOT NULL AND (public.is_admin() OR public.is_superadmin()) THEN p_member_id ELSE v_member_id END;
  SELECT tenant_id INTO v_tenant FROM team_members WHERE id = v_target;
  SELECT threshold, coalesce(voucher_label, name) INTO v_goal, v_goal_label FROM capture_reward_rules
  WHERE tenant_id = v_tenant AND active AND event_type = 'lead_validated' AND period_type = 'week' ORDER BY position LIMIT 1;
  SELECT daily_goal INTO v_daily FROM capture_handoff_config WHERE tenant_id = v_tenant;
  v_daily := coalesce(v_daily, greatest(1, ceil(coalesce(v_goal, 40) / 5.0)::int));

  SELECT jsonb_build_object(
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

  RETURN coalesce(r, '{}'::jsonb);
END;
$$;
