-- ============================================================================
-- Captação — "Resumo da Captação" no grupo da operação (WhatsApp).
--   capture_handoff_config: summary_enabled, summary_hours (BRT), last_summary_at
--   capture_daily_summary(tenant): dados prontos pra edge function formatar
--   cron capture-summary (de hora em hora; a função só posta nas horas configuradas)
-- ============================================================================

ALTER TABLE public.capture_handoff_config
  ADD COLUMN IF NOT EXISTS summary_enabled  boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS summary_hours    integer[] NOT NULL DEFAULT '{13,19}',
  ADD COLUMN IF NOT EXISTS last_summary_at  timestamptz;

-- Dados do resumo (hoje / semana / handoff / prêmios) de um tenant.
-- SECURITY DEFINER: chamada pela edge function com service role.
CREATE OR REPLACE FUNCTION public.capture_daily_summary(p_tenant uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today timestamptz := date_trunc('day',  now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo';
  v_week  timestamptz := date_trunc('week', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo';
  v_month timestamptz := date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo';
  r jsonb;
BEGIN
  SELECT jsonb_build_object(
    'hoje', (SELECT jsonb_build_object(
        'total',   count(*),
        'quentes', count(*) FILTER (WHERE seller_qualification->>'temperatura' = 'quente'),
        'mornos',  count(*) FILTER (WHERE seller_qualification->>'temperatura' = 'morno'),
        'frios',   count(*) FILTER (WHERE seller_qualification->>'temperatura' = 'frio'),
        'contatados', count(*) FILTER (WHERE first_contact_at IS NOT NULL))
      FROM leads WHERE tenant_id = p_tenant AND captured_by_member_id IS NOT NULL AND captured_at >= v_today),
    -- por promotora (hoje + semana), só quem tem lead na semana
    'promotoras', (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'member_id', p.member_id, 'name', p.name,
        'hoje', p.hoje, 'hoje_quentes', p.hoje_quentes,
        'semana', p.semana, 'semana_quentes', p.semana_quentes,
        'pontos_semana', p.semana * 10 + p.semana_quentes * 20
      ) ORDER BY p.semana DESC, p.name), '[]'::jsonb)
      FROM (
        SELECT tm.id AS member_id, tm.name,
               count(l.id) FILTER (WHERE l.captured_at >= v_today) AS hoje,
               count(l.id) FILTER (WHERE l.captured_at >= v_today AND l.seller_qualification->>'temperatura' = 'quente') AS hoje_quentes,
               count(l.id) AS semana,
               count(l.id) FILTER (WHERE l.seller_qualification->>'temperatura' = 'quente') AS semana_quentes
        FROM team_members tm
        JOIN leads l ON l.captured_by_member_id = tm.id AND l.captured_at >= v_week
        WHERE tm.tenant_id = p_tenant
        GROUP BY tm.id, tm.name
      ) p),
    -- handoff: quente/morno sem 1º contato
    'aguardando', (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'lead', l.name, 'temperatura', l.seller_qualification->>'temperatura',
        'especialista', split_part(coalesce(tm.name, '—'), ' ', 1),
        'minutos', floor(extract(epoch FROM (now() - l.handoff_at)) / 60)::int,
        'status', l.handoff_status
      ) ORDER BY l.handoff_at), '[]'::jsonb)
      FROM leads l LEFT JOIN team_members tm ON tm.id = l.handoff_member_id
      WHERE l.tenant_id = p_tenant AND l.captured_by_member_id IS NOT NULL
        AND l.first_contact_at IS NULL AND l.handoff_at >= v_week
        AND l.seller_qualification->>'temperatura' IN ('quente', 'morno')
        AND l.handoff_status IN ('pending', 'notified', 'sla_breached', 'escalated', 'unassigned')),
    'captados_mes', (SELECT count(*) FROM leads l JOIN sales_pipeline_stages s ON s.id = l.pipeline_stage_id
                     WHERE l.tenant_id = p_tenant AND l.captured_by_member_id IS NOT NULL AND s.is_won AND l.captured_at >= v_month),
    -- prêmios ativos (meta semanal/mensal) pra montar "faltam X pro Voucher"
    'premios', (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'name', name, 'goal_type', goal_type, 'goal_value', goal_value, 'stock', stock) ORDER BY position, goal_value), '[]'::jsonb)
      FROM capture_rewards WHERE tenant_id = p_tenant AND is_active),
    'week_start', (v_week AT TIME ZONE 'America/Sao_Paulo')::date
  ) INTO r;
  RETURN r;
END;
$$;
GRANT EXECUTE ON FUNCTION public.capture_daily_summary(uuid) TO authenticated, service_role;

-- Crons: SLA (10 min) + resumo (de hora em hora, minuto 5)
CREATE OR REPLACE FUNCTION public.capture_handoff_setup_crons()
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url text; v_job record; v_cmd text;
  v_jobs constant text[][] := ARRAY[
    ARRAY['capture-sla',     '*/10 * * * *', '{"mode":"sla"}'],
    ARRAY['capture-summary', '5 * * * *',    '{"mode":"summary"}']
  ];
BEGIN
  SELECT value INTO v_url FROM public.config WHERE key = 'SUPABASE_PROJECT_URL';
  v_url := rtrim(coalesce(v_url, ''), '/');
  IF v_url = '' OR v_url NOT LIKE 'http%' THEN
    RAISE WARNING 'SUPABASE_PROJECT_URL ausente — crons de captação NAO agendados.';
    RETURN 'skipped: SUPABASE_PROJECT_URL ausente';
  END IF;
  FOR i IN 1 .. array_length(v_jobs, 1) LOOP
    FOR v_job IN SELECT jobname FROM cron.job WHERE jobname = v_jobs[i][1] LOOP
      PERFORM cron.unschedule(v_job.jobname);
    END LOOP;
    v_cmd := format(
      $f$SELECT net.http_post(url := %L, headers := '{"Content-Type":"application/json"}'::jsonb, body := %L::jsonb)$f$,
      v_url || '/functions/v1/capture-handoff', v_jobs[i][3]);
    PERFORM cron.schedule(v_jobs[i][1], v_jobs[i][2], v_cmd);
  END LOOP;
  RETURN format('%s crons de captação agendados para %s', array_length(v_jobs, 1), v_url);
END $$;

SELECT public.capture_handoff_setup_crons();
