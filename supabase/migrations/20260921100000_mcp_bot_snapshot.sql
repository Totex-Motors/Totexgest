-- ============================================================================
-- SEGUNDO CÉREBRO — Bot no WhatsApp: config + foto da operação (service role)
-- O webhook (service role, sem JWT) chama mcp_bot_snapshot(p_tenant) para montar
-- a resposta do bot no grupo. Escopado pelo tenant recebido. Só service_role.
-- ============================================================================

INSERT INTO public.config (key, value)
SELECT 'MCP_BOT_GROUP_JID', '120363432553422256@g.us'
WHERE NOT EXISTS (SELECT 1 FROM config WHERE key = 'MCP_BOT_GROUP_JID');
INSERT INTO public.config (key, value)
SELECT 'MCP_BOT_TRIGGER', 'cerebro'
WHERE NOT EXISTS (SELECT 1 FROM config WHERE key = 'MCP_BOT_TRIGGER');

CREATE OR REPLACE FUNCTION public.mcp_bot_snapshot(p_tenant uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date; mes timestamptz := date_trunc('month', now());
BEGIN
  IF p_tenant IS NULL THEN RAISE EXCEPTION 'tenant obrigatório'; END IF;
  RETURN jsonb_build_object(
    'gerado_em', to_char(now() AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI'),
    'resumo', jsonb_build_object(
      'leads_hoje', (SELECT count(*) FROM leads WHERE tenant_id=p_tenant AND (created_at AT TIME ZONE 'America/Sao_Paulo')::date = hoje),
      'leads_7d', (SELECT count(*) FROM leads WHERE tenant_id=p_tenant AND created_at >= now()-interval '7 days'),
      'deals_abertos', (SELECT count(*) FROM deals WHERE tenant_id=p_tenant AND won_at IS NULL AND lost_at IS NULL),
      'tarefas_atrasadas', (SELECT count(*) FROM company_activities WHERE tenant_id=p_tenant AND completed IS NOT TRUE AND due_datetime IS NOT NULL AND due_datetime < now()),
      'tarefas_criticas', (SELECT count(*) FROM company_activities WHERE tenant_id=p_tenant AND completed IS NOT TRUE AND is_critical),
      'aprovacoes_pendentes', (SELECT count(*) FROM approval_requests WHERE tenant_id=p_tenant AND lower(status) IN ('pending','open','aguardando','requested'))
    ),
    'intermediacoes_por_status', coalesce((SELECT jsonb_object_agg(status, n) FROM (SELECT status, count(*) n FROM intermediations WHERE tenant_id=p_tenant GROUP BY status) s), '{}'::jsonb),
    'repasse', jsonb_build_object(
      'indicacoes', (SELECT count(*) FROM repasse_referrals WHERE tenant_id=p_tenant),
      'convertidos', (SELECT count(*) FROM repasse_referrals WHERE tenant_id=p_tenant AND status='converted')
    ),
    'atrasos_top', coalesce((SELECT jsonb_agg(x) FROM (
      SELECT name AS tarefa, (now()::date - due_datetime::date) AS dias_atraso, is_critical AS critica
      FROM company_activities WHERE tenant_id=p_tenant AND completed IS NOT TRUE AND due_datetime IS NOT NULL AND due_datetime < now()
      ORDER BY due_datetime ASC LIMIT 8) x), '[]'::jsonb),
    'aprovacoes', coalesce((SELECT jsonb_agg(x) FROM (
      SELECT kind AS tipo, title AS titulo, amount AS valor, (now()::date - created_at::date) AS dias_esperando
      FROM approval_requests WHERE tenant_id=p_tenant AND lower(status) IN ('pending','open','aguardando','requested')
      ORDER BY created_at ASC LIMIT 10) x), '[]'::jsonb),
    'ranking_top', coalesce((SELECT jsonb_agg(x) FROM (
      SELECT coalesce(tm.name,'Sem vendedor') AS vendedor,
             count(*) FILTER (WHERE d.won_at IS NOT NULL AND d.won_at >= mes) AS vendas_mes,
             coalesce(sum(coalesce(d.total_paid,d.negotiated_price,d.original_price)) FILTER (WHERE d.won_at IS NOT NULL AND d.won_at >= mes),0) AS valor_mes
      FROM deals d LEFT JOIN team_members tm ON tm.id=d.sales_rep_id
      WHERE d.tenant_id=p_tenant
      GROUP BY coalesce(tm.name,'Sem vendedor')
      ORDER BY count(*) FILTER (WHERE d.won_at IS NOT NULL AND d.won_at >= mes) DESC LIMIT 5) x), '[]'::jsonb)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.mcp_bot_snapshot(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_bot_snapshot(uuid) TO service_role;
