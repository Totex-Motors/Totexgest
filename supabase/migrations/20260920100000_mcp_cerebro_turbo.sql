-- ============================================================================
-- SEGUNDO CÉREBRO (MCP) — Fase 2: mais ferramentas (turbinar)
-- Ranking do time · Agenda de hoje · Buscar lead · Agendar follow-up.
-- Aditivo: só public.mcp_*. Escopado por tenant; guard bloqueia promotora/sdr.
-- ============================================================================

-- ─── Ranking do time (vendedores) ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mcp_ranking_time(p_period text DEFAULT 'month')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE t uuid; ps timestamptz;
BEGIN
  PERFORM public.mcp_guard_gestor();
  t := public.get_tenant_id();
  ps := CASE p_period WHEN 'week' THEN date_trunc('week', now()) WHEN 'all' THEN '2000-01-01'::timestamptz ELSE date_trunc('month', now()) END;
  RETURN jsonb_build_object(
    'periodo', p_period,
    'ranking', coalesce((SELECT jsonb_agg(x) FROM (
      SELECT coalesce(tm.name, 'Sem vendedor') AS vendedor,
             count(*) FILTER (WHERE d.won_at IS NOT NULL AND d.won_at >= ps) AS vendas_ganhas,
             coalesce(sum(coalesce(d.total_paid, d.negotiated_price, d.original_price)) FILTER (WHERE d.won_at IS NOT NULL AND d.won_at >= ps), 0) AS valor_ganho,
             count(*) FILTER (WHERE d.won_at IS NULL AND d.lost_at IS NULL) AS em_aberto,
             count(*) FILTER (WHERE d.lost_at IS NOT NULL AND d.lost_at >= ps) AS perdidas
      FROM deals d
      LEFT JOIN team_members tm ON tm.id = d.sales_rep_id
      WHERE d.tenant_id = t
      GROUP BY coalesce(tm.name, 'Sem vendedor')
      ORDER BY count(*) FILTER (WHERE d.won_at IS NOT NULL AND d.won_at >= ps) DESC,
               coalesce(sum(coalesce(d.total_paid, d.negotiated_price, d.original_price)) FILTER (WHERE d.won_at IS NOT NULL AND d.won_at >= ps), 0) DESC
      LIMIT 30) x), '[]'::jsonb)
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.mcp_ranking_time(text) TO authenticated;

-- ─── Agenda de hoje (reuniões/atividades agendadas) ──────────────────────────
CREATE OR REPLACE FUNCTION public.mcp_agenda_hoje()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE t uuid; hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  PERFORM public.mcp_guard_gestor();
  t := public.get_tenant_id();
  RETURN coalesce((SELECT jsonb_agg(x) FROM (
    SELECT id, name AS titulo, task_type AS tipo, assignee AS responsavel,
           to_char(coalesce(scheduled_at, due_datetime) AT TIME ZONE 'America/Sao_Paulo','HH24:MI') AS hora,
           completed AS concluida
    FROM company_activities
    WHERE tenant_id = t
      AND (coalesce(scheduled_at, due_datetime, (date::timestamptz)) AT TIME ZONE 'America/Sao_Paulo')::date = hoje
    ORDER BY coalesce(scheduled_at, due_datetime, date::timestamptz) ASC
    LIMIT 50) x), '[]'::jsonb);
END;
$$;
GRANT EXECUTE ON FUNCTION public.mcp_agenda_hoje() TO authenticated;

-- ─── Buscar lead (por nome ou telefone) ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mcp_buscar_lead(p_termo text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE t uuid; termo text := btrim(coalesce(p_termo,'')); digitos text;
BEGIN
  PERFORM public.mcp_guard_gestor();
  t := public.get_tenant_id();
  IF length(termo) < 2 THEN RAISE EXCEPTION 'Diga um nome ou telefone (mín. 2 caracteres)'; END IF;
  digitos := regexp_replace(termo, '\D', '', 'g');
  RETURN coalesce((SELECT jsonb_agg(x) FROM (
    SELECT l.id, l.name AS nome, l.phone AS telefone, l.sales_stage AS etapa,
           to_char(l.updated_at AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') AS ultima_atualizacao,
           (SELECT count(*) FROM deals d WHERE d.lead_id = l.id AND d.won_at IS NULL AND d.lost_at IS NULL) AS deals_abertos,
           (SELECT ca.name FROM company_activities ca WHERE ca.lead_id = l.id AND ca.completed IS NOT TRUE ORDER BY ca.due_datetime ASC NULLS LAST LIMIT 1) AS proxima_tarefa
    FROM leads l
    WHERE l.tenant_id = t
      AND (l.name ILIKE '%'||termo||'%' OR (length(digitos) >= 4 AND l.phone LIKE '%'||digitos||'%'))
    ORDER BY l.updated_at DESC
    LIMIT 15) x), '[]'::jsonb);
END;
$$;
GRANT EXECUTE ON FUNCTION public.mcp_buscar_lead(text) TO authenticated;

-- ─── Agendar follow-up (cria tarefa ligada ao lead) ──────────────────────────
CREATE OR REPLACE FUNCTION public.mcp_agendar_followup(p_lead uuid, p_quando timestamptz DEFAULT NULL, p_nota text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE t uuid; v_id uuid; v_nome text; v_titulo text;
BEGIN
  PERFORM public.mcp_guard_gestor();
  t := public.get_tenant_id();
  SELECT name INTO v_nome FROM leads WHERE id = p_lead AND tenant_id = t;
  IF v_nome IS NULL THEN RAISE EXCEPTION 'Lead não encontrado nesta empresa'; END IF;
  v_titulo := 'Follow-up: ' || coalesce(v_nome,'lead') || coalesce(' — ' || nullif(btrim(p_nota),''), '');
  INSERT INTO company_activities (name, status, priority, completed, due_datetime, lead_id)
  VALUES (v_titulo, 'not_started', 'medium', false, p_quando, p_lead)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'tarefa', v_titulo, 'lead', v_nome);
END;
$$;
GRANT EXECUTE ON FUNCTION public.mcp_agendar_followup(uuid, timestamptz, text) TO authenticated;
