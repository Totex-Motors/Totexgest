-- =============================================================================
-- Fix dos RPCs do dashboard comercial (NaN no Semaforo do Time / Atividades Hoje)
-- =============================================================================
-- As versoes anteriores destas funcoes (em 001_post_baseline_fixes.sql) retornavam
-- colunas que NAO batiam com o que o frontend espera:
--   * get_sales_performance  -> retornava (deals_count, total_revenue, won_count...)
--     mas o front le sales_rep_id, deals_won, deals_won_value, calls_connected,
--     completion_rate, etc. -> tudo virava undefined -> NaN
--   * get_daily_activity_summary -> retornava uma unica linha global
--     (calls_count, messages_sent...) mas o front le uma linha POR vendedor com
--     calls_made, followups_done, meetings_done, leads_contacted -> NaN
--     (so messages_sent existia, por isso aparecia "0" e o resto "NaN")
--
-- Aqui redefinimos as duas funcoes com a assinatura/colunas corretas, agregando
-- por membro do time (team_members).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- get_sales_performance: uma linha por vendedor no periodo [p_date_from, p_date_to]
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_sales_performance(date, date);

CREATE OR REPLACE FUNCTION public.get_sales_performance(
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL
)
RETURNS TABLE(
  sales_rep_id uuid,
  sales_rep_name text,
  total_tasks bigint,
  completed_tasks bigint,
  overdue_tasks bigint,
  completion_rate numeric,
  meetings_total bigint,
  meetings_done bigint,
  meetings_noshow bigint,
  noshow_rate numeric,
  followups_total bigint,
  followups_done bigint,
  calls_total bigint,
  calls_connected bigint,
  calls_duration_min numeric,
  deals_moved bigint,
  deals_won bigint,
  deals_won_value numeric,
  new_contacts bigint,
  streak_days integer
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH bounds AS (
    SELECT COALESCE(p_date_from, '1900-01-01'::date) AS df,
           COALESCE(p_date_to,   '2999-12-31'::date) AS dt
  )
  SELECT
    tm.id,
    tm.name,
    COALESCE(t.total_tasks, 0),
    COALESCE(t.completed_tasks, 0),
    COALESCE(t.overdue_tasks, 0),
    CASE WHEN COALESCE(t.total_tasks, 0) > 0
      THEN ROUND(t.completed_tasks::numeric / t.total_tasks * 100, 0)
      ELSE 0 END,
    COALESCE(t.meetings_total, 0),
    COALESCE(t.meetings_done, 0),
    COALESCE(t.meetings_noshow, 0),
    CASE WHEN COALESCE(t.meetings_total, 0) > 0
      THEN ROUND(t.meetings_noshow::numeric / t.meetings_total * 100, 0)
      ELSE 0 END,
    COALESCE(t.followups_total, 0),
    COALESCE(t.followups_done, 0),
    COALESCE(c.calls_total, 0),
    COALESCE(c.calls_connected, 0),
    ROUND(COALESCE(c.calls_duration_sec, 0)::numeric / 60, 0),
    COALESCE(dl.deals_moved, 0),
    COALESCE(dl.deals_won, 0),
    COALESCE(dl.deals_won_value, 0),
    COALESCE(ld.new_contacts, 0),
    0
  FROM team_members tm
  CROSS JOIN bounds b
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*)::bigint AS total_tasks,
      COUNT(*) FILTER (WHERE ca.completed)::bigint AS completed_tasks,
      COUNT(*) FILTER (WHERE NOT ca.completed AND ca.due_datetime IS NOT NULL AND ca.due_datetime < now())::bigint AS overdue_tasks,
      COUNT(*) FILTER (WHERE ca.task_type = 'meeting')::bigint AS meetings_total,
      COUNT(*) FILTER (WHERE ca.task_type = 'meeting' AND ca.status = 'completed')::bigint AS meetings_done,
      COUNT(*) FILTER (WHERE ca.task_type = 'meeting' AND ca.status = 'no_show')::bigint AS meetings_noshow,
      COUNT(*) FILTER (WHERE ca.task_type = 'follow_up')::bigint AS followups_total,
      COUNT(*) FILTER (WHERE ca.task_type = 'follow_up' AND ca.completed)::bigint AS followups_done
    FROM company_activities ca
    WHERE ca.responsavel_id = tm.id
      AND COALESCE(ca.due_datetime, ca.created_at)::date BETWEEN b.df AND b.dt
  ) t ON true
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*)::bigint AS calls_total,
      COUNT(*) FILTER (WHERE ch.duration_seconds > 0)::bigint AS calls_connected,
      COALESCE(SUM(ch.duration_seconds), 0) AS calls_duration_sec
    FROM call_history ch
    WHERE ch.team_member_id = tm.id
      AND ch.started_at::date BETWEEN b.df AND b.dt
  ) c ON true
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*) FILTER (WHERE d.stage_changed_at::date BETWEEN b.df AND b.dt)::bigint AS deals_moved,
      COUNT(*) FILTER (WHERE d.status = 'won' AND d.won_at::date BETWEEN b.df AND b.dt)::bigint AS deals_won,
      COALESCE(SUM(d.negotiated_price) FILTER (WHERE d.status = 'won' AND d.won_at::date BETWEEN b.df AND b.dt), 0) AS deals_won_value
    FROM deals d
    WHERE d.sales_rep_id = tm.id
  ) dl ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::bigint AS new_contacts
    FROM leads l
    WHERE l.sales_rep_id = tm.id
      AND l.created_at::date BETWEEN b.df AND b.dt
  ) ld ON true
  ORDER BY COALESCE(dl.deals_won_value, 0) DESC, tm.name;
$$;

-- ---------------------------------------------------------------------------
-- get_daily_activity_summary: uma linha por vendedor para o dia p_date
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_daily_activity_summary(date, uuid);

CREATE OR REPLACE FUNCTION public.get_daily_activity_summary(
  p_date date DEFAULT CURRENT_DATE,
  p_team_member_id uuid DEFAULT NULL
)
RETURNS TABLE(
  team_member_id uuid,
  team_member_name text,
  calls_made bigint,
  calls_connected bigint,
  calls_avg_duration_sec numeric,
  followups_done bigint,
  meetings_scheduled bigint,
  meetings_done bigint,
  proposals_sent bigint,
  messages_sent bigint,
  leads_contacted bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT
    tm.id,
    tm.name,
    COALESCE(c.calls_made, 0),
    COALESCE(c.calls_connected, 0),
    COALESCE(c.calls_avg_duration_sec, 0),
    COALESCE(t.followups_done, 0),
    COALESCE(t.meetings_scheduled, 0),
    COALESCE(t.meetings_done, 0),
    COALESCE(dl.proposals_sent, 0),
    COALESCE(m.messages_sent, 0),
    COALESCE(m.leads_contacted, 0)
  FROM team_members tm
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*)::bigint AS calls_made,
      COUNT(*) FILTER (WHERE ch.duration_seconds > 0)::bigint AS calls_connected,
      COALESCE(ROUND(AVG(ch.duration_seconds) FILTER (WHERE ch.duration_seconds > 0), 0), 0) AS calls_avg_duration_sec
    FROM call_history ch
    WHERE ch.team_member_id = tm.id
      AND ch.started_at::date = p_date
  ) c ON true
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*) FILTER (WHERE ca.task_type = 'follow_up' AND ca.completed
        AND COALESCE(ca.completed_at, ca.updated_at)::date = p_date)::bigint AS followups_done,
      COUNT(*) FILTER (WHERE ca.task_type = 'meeting'
        AND ca.scheduled_at::date = p_date)::bigint AS meetings_scheduled,
      COUNT(*) FILTER (WHERE ca.task_type = 'meeting' AND ca.status = 'completed'
        AND COALESCE(ca.completed_at, ca.updated_at)::date = p_date)::bigint AS meetings_done
    FROM company_activities ca
    WHERE ca.responsavel_id = tm.id
  ) t ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::bigint AS proposals_sent
    FROM deals d
    WHERE d.sales_rep_id = tm.id
      AND d.proposal_sent_at::date = p_date
  ) dl ON true
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*)::bigint AS messages_sent,
      COUNT(DISTINCT wm.lead_id)::bigint AS leads_contacted
    FROM whatsapp_messages wm
    JOIN leads l ON l.id = wm.lead_id
    WHERE l.sales_rep_id = tm.id
      AND wm.is_from_me = true
      AND wm.sent_at::date = p_date
  ) m ON true
  WHERE (p_team_member_id IS NULL OR tm.id = p_team_member_id)
  ORDER BY tm.name;
$$;
