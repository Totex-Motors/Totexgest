-- ============================================================================
-- Captação — PERFIL da promotora: 'padrao' (com incentivos) | 'folgista'
-- (esporádica: capta e treina normalmente, mas NÃO participa dos valores em
-- pecúnia / vouchers, salvo regra marcada como "vale pra folgista").
--
--   team_members.capture_profile          — padrao | folgista
--   capture_reward_rules.include_folgista — regra também vale pra folgista?
--   capture_award()                        — ponto único: pula folgista quando a regra não inclui
--   capture_close_month()                  — folgista fora da disputa (salvo regra incluir)
--   capture_home_stats()                   — devolve 'perfil' e 'incentivos' (front escolhe o layout)
-- ============================================================================

ALTER TABLE public.team_members
  ADD COLUMN IF NOT EXISTS capture_profile text NOT NULL DEFAULT 'padrao';
DO $$ BEGIN
  ALTER TABLE public.team_members ADD CONSTRAINT team_members_capture_profile_check
    CHECK (capture_profile IN ('padrao', 'folgista'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
COMMENT ON COLUMN public.team_members.capture_profile IS
  'Captação: padrao = participa de metas/incentivos; folgista = esporádica, sem valores em pecúnia (salvo regra com include_folgista).';

ALTER TABLE public.capture_reward_rules
  ADD COLUMN IF NOT EXISTS include_folgista boolean NOT NULL DEFAULT false;

-- Trava: role e capture_profile só mudam por admin (a policy de auto-edição de
-- team_members deixaria a própria pessoa se promover). Service role (edge fns) passa.
CREATE OR REPLACE FUNCTION public.protect_team_member_privileges() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF (NEW.role IS DISTINCT FROM OLD.role OR NEW.capture_profile IS DISTINCT FROM OLD.capture_profile)
     AND NOT (public.is_admin() OR public.is_superadmin()) THEN
    RAISE EXCEPTION 'Só admin altera cargo/perfil de captação';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_protect_team_member_privileges ON public.team_members;
CREATE TRIGGER trg_protect_team_member_privileges BEFORE UPDATE ON public.team_members
  FOR EACH ROW EXECUTE FUNCTION public.protect_team_member_privileges();

-- Admin do tenant pode trocar o perfil de captação de um membro
CREATE OR REPLACE FUNCTION public.set_capture_profile(p_member_id uuid, p_profile text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (public.is_admin() OR public.is_superadmin()) THEN RAISE EXCEPTION 'Apenas admin'; END IF;
  IF p_profile NOT IN ('padrao', 'folgista') THEN RAISE EXCEPTION 'Perfil inválido'; END IF;
  UPDATE team_members SET capture_profile = p_profile
  WHERE id = p_member_id AND (tenant_id = public.get_tenant_id() OR public.is_superadmin());
END;
$$;
GRANT EXECUTE ON FUNCTION public.set_capture_profile(uuid, text) TO authenticated;

-- A regra vale pra esse membro?
CREATE OR REPLACE FUNCTION public.capture_rule_applies(p_rule capture_reward_rules, p_member uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_rule.include_folgista OR coalesce((SELECT capture_profile FROM team_members WHERE id = p_member), 'padrao') <> 'folgista';
$$;

-- capture_award: ponto único de lançamento — folgista só recebe se a regra incluir
CREATE OR REPLACE FUNCTION public.capture_award(
  p_rule capture_reward_rules, p_promoter uuid, p_event uuid, p_lead uuid, p_period_start date, p_key text, p_title text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_img text; v_promo_name text;
BEGIN
  IF NOT public.capture_rule_applies(p_rule, p_promoter) THEN RETURN NULL; END IF;
  IF p_rule.reward_id IS NOT NULL THEN SELECT image_url INTO v_img FROM capture_rewards WHERE id = p_rule.reward_id; END IF;
  INSERT INTO capture_reward_ledger (tenant_id, promoter_id, rule_id, event_id, lead_id, reward_type, amount_cents,
                                     voucher_label, reward_image_url, title, period_start, idempotency_key)
  VALUES (p_rule.tenant_id, p_promoter, p_rule.id, p_event, p_lead, p_rule.reward_type, coalesce(p_rule.amount_cents, 0),
          p_rule.voucher_label, v_img, p_title, p_period_start, p_key)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    IF p_rule.reward_id IS NOT NULL THEN
      UPDATE capture_rewards SET stock = stock - 1 WHERE id = p_rule.reward_id AND stock IS NOT NULL AND stock > 0;
    END IF;
    IF p_lead IS NOT NULL THEN
      PERFORM capture_add_event(p_lead, 'reward', '🎁 ' || p_title,
        CASE WHEN p_rule.reward_type = 'cash' THEN '+R$ ' || to_char(coalesce(p_rule.amount_cents, 0) / 100.0, 'FM999G990D00') || ' pendentes de aprovação.'
             ELSE coalesce(p_rule.voucher_label, 'Prêmio') || ' — o gestor vai entregar.' END);
    ELSE
      SELECT name INTO v_promo_name FROM team_members WHERE id = p_promoter;
      INSERT INTO capture_lead_events (tenant_id, lead_id, promotora_member_id, event_type, title, body)
      SELECT p_rule.tenant_id, l.id, p_promoter, 'reward', '🎁 ' || p_title,
             CASE WHEN p_rule.reward_type = 'cash' THEN '+R$ ' || to_char(coalesce(p_rule.amount_cents, 0) / 100.0, 'FM999G990D00') || ' pendentes de aprovação.'
                  ELSE coalesce(p_rule.voucher_label, 'Prêmio') || ' — o gestor vai entregar.' END
      FROM leads l WHERE l.captured_by_member_id = p_promoter ORDER BY l.captured_at DESC NULLS LAST LIMIT 1;
    END IF;
  END IF;
  RETURN v_id;
END;
$$;

-- Campeã do mês: folgista fora da disputa (salvo a regra incluir)
CREATE OR REPLACE FUNCTION public.capture_close_month(p_month date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid := public.get_tenant_id(); v_ps date; r capture_reward_rules%ROWTYPE; w record; ev record; v_id uuid;
BEGIN
  IF NOT (public.is_admin() OR public.is_superadmin()) THEN RAISE EXCEPTION 'Apenas admin'; END IF;
  v_ps := coalesce(date_trunc('month', p_month)::date, capture_period_start('month', now() - interval '1 month'));
  SELECT * INTO r FROM capture_reward_rules WHERE tenant_id = v_tenant AND active AND event_type = 'monthly_champion' ORDER BY position LIMIT 1;
  IF r.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'sem regra de campeã do mês'); END IF;

  SELECT tm.id AS member_id, tm.name,
         count(l.id) FILTER (WHERE l.capture_valid) AS valid,
         count(l.id) FILTER (WHERE v.status IN ('captado', 'preparacao', 'anunciado', 'negociacao', 'vendido')) AS captured
  INTO w
  FROM team_members tm
  JOIN leads l ON l.captured_by_member_id = tm.id AND capture_period_start('month', l.captured_at) = v_ps
  LEFT JOIN LATERAL (SELECT status FROM seller_vehicles sv WHERE sv.lead_id = l.id ORDER BY sv.created_at DESC LIMIT 1) v ON true
  WHERE tm.tenant_id = v_tenant AND (r.include_folgista OR tm.capture_profile <> 'folgista')
  GROUP BY tm.id, tm.name
  HAVING count(l.id) FILTER (WHERE l.capture_valid) >= coalesce(r.min_valid_leads, 1)
  ORDER BY (count(l.id) FILTER (WHERE v.status IN ('captado', 'preparacao', 'anunciado', 'negociacao', 'vendido')))::numeric
           / greatest(count(l.id) FILTER (WHERE l.capture_valid), 1) DESC,
           count(l.id) FILTER (WHERE v.status IN ('captado', 'preparacao', 'anunciado', 'negociacao', 'vendido')) DESC,
           count(l.id) FILTER (WHERE l.capture_valid) DESC
  LIMIT 1;
  IF w.member_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'ninguém elegível', 'month', v_ps); END IF;

  SELECT * INTO ev FROM capture_emit_event(v_tenant, w.member_id, 'monthly_champion', 'monthly_champion:' || v_tenant || ':' || v_ps,
                                           NULL, NULL, NULL, jsonb_build_object('valid', w.valid, 'captured', w.captured), public.current_member_id());
  v_id := capture_award(r, w.member_id, ev.event_id, NULL, v_ps, 'rule:' || r.id || ':' || v_ps,
                        r.name || ' — ' || to_char(v_ps, 'MM/YYYY'));
  RETURN jsonb_build_object('ok', true, 'month', v_ps, 'champion', w.name, 'member_id', w.member_id,
                            'valid', w.valid, 'captured', w.captured, 'ledger_id', v_id, 'already', v_id IS NULL);
END;
$$;

-- Home stats: perfil + se existe algum incentivo válido pra essa pessoa
CREATE OR REPLACE FUNCTION public.capture_home_stats(p_member_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member_id uuid := public.current_member_id();
  v_target uuid; v_tenant uuid; v_profile text;
  v_today_start timestamptz := date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo';
  v_week_start  timestamptz := date_trunc('week', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo';
  v_month_start timestamptz := date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo';
  r jsonb; v_goal integer; v_goal_label text; v_daily integer; v_incentivos boolean;
BEGIN
  IF v_member_id IS NULL THEN RETURN '{}'::jsonb; END IF;
  v_target := CASE WHEN p_member_id IS NOT NULL AND (public.is_admin() OR public.is_superadmin()) THEN p_member_id ELSE v_member_id END;
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

  RETURN coalesce(r, '{}'::jsonb);
END;
$$;
