-- Segundo Cérebro (MCP) — telas dentro do Claude (MCP Apps)
-- RPCs de leitura usadas pelas ferramentas `ficha_lead` e `pipeline_do_dia` do servidor
-- MCP (mcp-server/). Só gestão (mcp_guard_gestor), só o tenant do usuário (RLS via
-- get_tenant_id), só leitura. Devolvem jsonb pronto pra renderizar.

-- ─── Ficha do lead ───────────────────────────────────────────────────────────
-- Aceita código (L000123 / 123), uuid, nome ou telefone. Se achar vários, devolve a
-- lista pra escolher; se achar um, devolve a ficha completa.
CREATE OR REPLACE FUNCTION public.mcp_ficha_lead(p_termo text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  t uuid;
  termo text := btrim(coalesce(p_termo,''));
  digitos text;
  cod text;
  l leads%ROWTYPE;
  n int;
  app_url text;
  hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  PERFORM public.mcp_guard_gestor();
  t := public.get_tenant_id();
  IF length(termo) < 2 THEN
    RAISE EXCEPTION 'Diga o código (ex.: L000123), o nome ou o telefone do lead';
  END IF;
  digitos := regexp_replace(termo, '\D', '', 'g');
  IF termo ~* '^L?\d{1,6}$' THEN
    cod := 'L' || lpad(digitos, 6, '0');
  END IF;

  IF termo ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT * INTO l FROM leads WHERE tenant_id = t AND id = termo::uuid;
  ELSIF cod IS NOT NULL THEN
    SELECT * INTO l FROM leads
     WHERE tenant_id = t AND (codigo = cod OR cod = ANY(coalesce(codigos_antigos, '{}'::text[])))
     ORDER BY (codigo = cod) DESC LIMIT 1;
  END IF;

  IF l.id IS NULL THEN
    SELECT count(*) INTO n FROM leads
     WHERE tenant_id = t
       AND (name ILIKE '%'||termo||'%'
            OR (length(digitos) >= 4 AND regexp_replace(coalesce(phone,''), '\D', '', 'g') LIKE '%'||digitos||'%'));
    IF n = 0 THEN
      RETURN jsonb_build_object('encontrado', false, 'termo', termo);
    END IF;
    IF n > 1 THEN
      RETURN jsonb_build_object('encontrado', true, 'multiplos', true, 'termo', termo, 'total', n,
        'opcoes', (SELECT jsonb_agg(x) FROM (
          SELECT id, codigo, name AS nome, phone AS telefone, sales_stage AS etapa,
                 (SELECT s.name FROM sales_pipeline_stages s WHERE s.id = ld.pipeline_stage_id) AS etapa_pipeline,
                 to_char(updated_at AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') AS atualizado_em
            FROM leads ld
           WHERE tenant_id = t
             AND (name ILIKE '%'||termo||'%'
                  OR (length(digitos) >= 4 AND regexp_replace(coalesce(phone,''), '\D', '', 'g') LIKE '%'||digitos||'%'))
           ORDER BY updated_at DESC LIMIT 12) x));
    END IF;
    SELECT * INTO l FROM leads
     WHERE tenant_id = t
       AND (name ILIKE '%'||termo||'%'
            OR (length(digitos) >= 4 AND regexp_replace(coalesce(phone,''), '\D', '', 'g') LIKE '%'||digitos||'%'))
     LIMIT 1;
  END IF;

  app_url := coalesce((SELECT value FROM config WHERE key IN ('app_url','APP_URL') AND value <> '' LIMIT 1), 'https://totexgest.vercel.app');

  RETURN jsonb_build_object(
    'encontrado', true,
    'lead', jsonb_build_object(
      'id', l.id, 'codigo', l.codigo, 'nome', l.name, 'telefone', l.phone, 'email', l.email,
      'cidade', l.city_name, 'estado', l.state,
      'etapa', l.sales_stage, 'etapa_funil', l.etapa_funil,
      'etapa_pipeline', (SELECT s.name FROM sales_pipeline_stages s WHERE s.id = l.pipeline_stage_id),
      'pipeline', (SELECT p.name FROM sales_pipeline_stages s JOIN sales_pipelines p ON p.id = s.pipeline_id WHERE s.id = l.pipeline_stage_id),
      'score', l.sales_score, 'motivo_score', l.sales_score_reason,
      'vendedor', (SELECT tm.name FROM team_members tm WHERE tm.id = l.sales_rep_id),
      'loja', (SELECT name FROM tenants WHERE id = t),
      'origem', coalesce(l.source, l.original_source, l.utm_source),
      'campanha', coalesce(l.utm_campaign, l.original_utm_campaign),
      'status', l.status,
      'criado_em', to_char(l.created_at AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY HH24:MI'),
      'dias_de_casa', (hoje - (l.created_at AT TIME ZONE 'America/Sao_Paulo')::date),
      'ultima_interacao', to_char(coalesce(l.last_interaction_at, l.last_message_received_at, l.last_message_sent_at) AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI'),
      'ultima_msg_recebida', to_char(l.last_message_received_at AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI'),
      'ultima_msg_enviada', to_char(l.last_message_sent_at AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI'),
      'total_mensagens', l.messages_count,
      'contexto', left(l.context, 600),
      'link', app_url || '/comercial/leads/' || l.id
    ),
    'playbook', jsonb_build_object(
      'acao_de_hoje', l.acao_de_hoje, 'dia', l.dia_do_playbook,
      'tentativas', l.tentativas_de_contato, 'resposta', l.status_de_resposta, 'ultima_acao', l.ultima_acao
    ),
    'negociacao', jsonb_build_object(
      'veiculo_interesse', CASE
          WHEN jsonb_typeof(l.metadata->'veiculo_interesse') = 'object' THEN
            coalesce(l.metadata#>>'{veiculo_interesse,modelo}', l.metadata#>>'{veiculo_interesse,title}', l.metadata#>>'{veiculo_interesse,model}', l.metadata#>>'{veiculo_interesse,nome}')
          ELSE coalesce(l.metadata->>'veiculo_interesse_texto', l.metadata->>'veiculo_interesse') END,
      'veiculo_meta', CASE WHEN jsonb_typeof(l.metadata->'vehicle') = 'object'
          THEN coalesce(l.metadata#>>'{vehicle,title}', l.metadata#>>'{vehicle,model}', l.metadata#>>'{vehicle,modelo}') END,
      'tem_troca', l.metadata->>'tem_veiculo_troca',
      'entrada', l.metadata->>'entrada_disponivel',
      'forma_pagamento', l.metadata->>'forma_pagamento',
      'precisa_financiar', l.metadata->>'precisa_financiar',
      'faixa_min', l.metadata->>'faixa_preco_min', 'faixa_max', l.metadata->>'faixa_preco_max',
      'observacao', left(l.metadata->>'observacao', 400),
      'ultima_tratativa', left(l.metadata->>'ultima_tratativa', 400),
      'trocas', coalesce((SELECT jsonb_agg(x) FROM (
          SELECT marca, modelo, versao, ano, km, placa, valor_pedido, valor_avaliado, modalidade
            FROM trade_in_vehicles WHERE lead_id = l.id ORDER BY created_at DESC LIMIT 5) x), '[]'::jsonb),
      'veiculos_captados', coalesce((SELECT jsonb_agg(x) FROM (
          SELECT brand AS marca, model AS modelo, version AS versao, year_model AS ano, km, status, expected_price AS valor_esperado, listing_price AS valor_anuncio
            FROM seller_vehicles WHERE lead_id = l.id ORDER BY created_at DESC LIMIT 5) x), '[]'::jsonb),
      'simulacoes', CASE WHEN jsonb_typeof(l.metadata->'simulacoes') = 'array' THEN jsonb_array_length(l.metadata->'simulacoes') ELSE 0 END
    ),
    'deals', coalesce((SELECT jsonb_agg(x) FROM (
        SELECT d.id, d.title AS titulo, d.status, d.negotiated_price AS valor,
               s.name AS etapa, p.name AS pipeline,
               to_char(d.created_at AT TIME ZONE 'America/Sao_Paulo','DD/MM/YY') AS criado_em,
               (hoje - coalesce(d.stage_changed_at, d.created_at)::date) AS dias_na_etapa,
               d.won_at IS NOT NULL AS ganho, d.lost_at IS NOT NULL AS perdido,
               d.metadata->>'temperatura' AS temperatura
          FROM deals d
          LEFT JOIN sales_pipeline_stages s ON s.id = d.pipeline_stage_id
          LEFT JOIN sales_pipelines p ON p.id = d.pipeline_id
         WHERE d.lead_id = l.id ORDER BY d.updated_at DESC LIMIT 8) x), '[]'::jsonb),
    'intermediacoes', coalesce((SELECT jsonb_agg(x) FROM (
        SELECT code AS codigo, status, asking_price AS preco_pedido, sale_price AS preco_venda,
               to_char(created_at AT TIME ZONE 'America/Sao_Paulo','DD/MM/YY') AS criado_em
          FROM intermediations WHERE owner_lead_id = l.id OR buyer_lead_id = l.id ORDER BY created_at DESC LIMIT 5) x), '[]'::jsonb),
    'tarefas', coalesce((SELECT jsonb_agg(x) FROM (
        SELECT id, name AS titulo, task_type AS tipo, assignee AS responsavel, is_critical AS critica,
               to_char(coalesce(scheduled_at, due_datetime) AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') AS quando,
               (coalesce(scheduled_at, due_datetime) < now()) AS atrasada
          FROM company_activities
         WHERE lead_id = l.id AND completed IS NOT TRUE
         ORDER BY coalesce(scheduled_at, due_datetime) ASC NULLS LAST LIMIT 10) x), '[]'::jsonb),
    'atividades', coalesce((SELECT jsonb_agg(x) FROM (
        SELECT name AS titulo, task_type AS tipo, completed AS concluida, outcome AS resultado,
               to_char(created_at AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') AS em
          FROM company_activities
         WHERE lead_id = l.id ORDER BY created_at DESC LIMIT 8) x), '[]'::jsonb),
    'mensagens', coalesce((SELECT jsonb_agg(x ORDER BY x.ts) FROM (
        SELECT m.is_from_me AS minha, m.message_type AS tipo,
               left(coalesce(nullif(m.content,''), '['||coalesce(m.message_type,'mídia')||']'), 280) AS texto,
               to_char(m.sent_at AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') AS em,
               m.sent_at AS ts, m.status
          FROM whatsapp_messages m
         WHERE m.lead_id = l.id AND m.is_deleted IS NOT TRUE
         ORDER BY m.sent_at DESC LIMIT 12) x), '[]'::jsonb),
    'agente', coalesce((SELECT jsonb_agg(x) FROM (
        SELECT event_type AS evento, left(reason, 160) AS motivo,
               to_char(created_at AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') AS em
          FROM ai_agent_chat_events WHERE lead_id = l.id ORDER BY created_at DESC LIMIT 6) x), '[]'::jsonb),
    'historico', jsonb_build_object(
      'codigos_antigos', to_jsonb(coalesce(l.codigos_antigos, '{}'::text[])),
      'mesclado_de', coalesce(l.metadata->'mesclado_de', '[]'::jsonb),
      'email_reativacao', CASE WHEN jsonb_typeof(l.metadata->'email_reativacao') = 'object' THEN jsonb_build_object(
          'tipo', l.metadata#>>'{email_reativacao,tipo}', 'loja', l.metadata#>>'{email_reativacao,loja}',
          'campanha', l.metadata#>>'{email_reativacao,campanha}', 'modelo', l.metadata#>>'{email_reativacao,modelo}',
          'carro_interesse', l.metadata#>>'{email_reativacao,carro_interesse}', 'em', l.metadata#>>'{email_reativacao,em}') END,
      'reaquecimento', CASE WHEN jsonb_typeof(l.metadata->'reaquecimento') = 'object' THEN l.metadata->'reaquecimento' END,
      'transferido_de', l.transferred_from_tenant,
      'captado_por', coalesce(l.metadata->>'captured_by_name', (SELECT tm.name FROM team_members tm WHERE tm.id = l.captured_by_member_id)),
      'promotora', l.metadata->>'promoter_name'
    )
  );
END;
$function$;

-- ─── Pipeline do dia ─────────────────────────────────────────────────────────
-- Panorama de hoje do tenant: resumo, kanban (etapas + cards), fila do playbook,
-- agenda de hoje, atrasadas e novos leads.
CREATE OR REPLACE FUNCTION public.mcp_pipeline_do_dia()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  t uuid;
  hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  ini timestamptz;
  fim timestamptz;
  app_url text;
BEGIN
  PERFORM public.mcp_guard_gestor();
  t := public.get_tenant_id();
  ini := (hoje::timestamp) AT TIME ZONE 'America/Sao_Paulo';
  fim := ini + interval '1 day';
  app_url := coalesce((SELECT value FROM config WHERE key IN ('app_url','APP_URL') AND value <> '' LIMIT 1), 'https://totexgest.vercel.app');

  RETURN jsonb_build_object(
    'data', to_char(hoje, 'DD/MM/YYYY'),
    'dia_semana', trim(to_char(hoje, 'TMDay')),
    'loja', (SELECT name FROM tenants WHERE id = t),
    'app_url', app_url,
    'resumo', jsonb_build_object(
      'novos_leads', (SELECT count(*) FROM leads WHERE tenant_id = t AND created_at >= ini AND created_at < fim),
      'responderam', (SELECT count(*) FROM leads WHERE tenant_id = t AND last_message_received_at >= ini AND last_message_received_at < fim),
      'movidos', (SELECT count(*) FROM deals WHERE tenant_id = t AND stage_changed_at >= ini AND stage_changed_at < fim),
      'ganhos', (SELECT count(*) FROM deals WHERE tenant_id = t AND won_at >= ini AND won_at < fim),
      'em_aberto', (SELECT count(*) FROM deals d WHERE d.tenant_id = t AND d.won_at IS NULL AND d.lost_at IS NULL
                      AND coalesce(lower(d.status),'') NOT IN ('won','ganho','lost','perdido','closed')),
      'tarefas_hoje', (SELECT count(*) FROM company_activities WHERE tenant_id = t AND completed IS NOT TRUE
                         AND coalesce(scheduled_at, due_datetime, date::timestamptz) >= ini AND coalesce(scheduled_at, due_datetime, date::timestamptz) < fim),
      'tarefas_atrasadas', (SELECT count(*) FROM company_activities WHERE tenant_id = t AND completed IS NOT TRUE
                              AND coalesce(scheduled_at, due_datetime) < ini),
      'fila', (SELECT count(*) FROM leads WHERE tenant_id = t AND acao_de_hoje IS NOT NULL AND acao_de_hoje NOT IN ('AGUARDAR','ENCERRAR'))
    ),
    'pipelines', coalesce((SELECT jsonb_agg(pp ORDER BY pp.padrao DESC, pp.posicao) FROM (
      SELECT p.id, p.name AS nome, p.position AS posicao, coalesce(p.is_default, false) AS padrao,
        coalesce((SELECT jsonb_agg(ss ORDER BY ss.posicao) FROM (
          SELECT s.id, s.name AS nome, s.position AS posicao, s.color AS cor, coalesce(s.is_won,false) AS ganho,
            (SELECT count(*) FROM deals d WHERE d.pipeline_stage_id = s.id
               AND CASE WHEN s.is_won THEN d.won_at >= ini - interval '30 days'
                        ELSE d.won_at IS NULL AND d.lost_at IS NULL AND coalesce(lower(d.status),'') NOT IN ('won','ganho','lost','perdido','closed') END) AS total,
            coalesce((SELECT jsonb_agg(x) FROM (
              SELECT d.id, d.title AS titulo, l.codigo, l.name AS lead, l.id AS lead_id, l.phone AS telefone,
                     d.negotiated_price AS valor,
                     (hoje - coalesce(d.stage_changed_at, d.created_at)::date) AS dias_na_etapa,
                     (coalesce(d.stage_changed_at, d.created_at) >= ini) AS movido_hoje,
                     (l.last_message_received_at >= ini) AS respondeu_hoje,
                     tm.name AS vendedor, d.metadata->>'temperatura' AS temperatura,
                     l.acao_de_hoje AS acao
                FROM deals d
                LEFT JOIN leads l ON l.id = d.lead_id
                LEFT JOIN team_members tm ON tm.id = d.sales_rep_id
               WHERE d.pipeline_stage_id = s.id
                 AND CASE WHEN s.is_won THEN d.won_at >= ini - interval '30 days'
                          ELSE d.won_at IS NULL AND d.lost_at IS NULL AND coalesce(lower(d.status),'') NOT IN ('won','ganho','lost','perdido','closed') END
               ORDER BY coalesce(d.stage_changed_at, d.updated_at) DESC LIMIT 8) x), '[]'::jsonb) AS cards
            FROM sales_pipeline_stages s
           WHERE s.pipeline_id = p.id AND s.tenant_id = t AND s.is_lost IS NOT TRUE) ss), '[]'::jsonb) AS etapas
        FROM sales_pipelines p
       WHERE p.tenant_id = t AND p.is_active IS NOT FALSE) pp), '[]'::jsonb),
    'fila', coalesce((SELECT jsonb_agg(x) FROM (
        SELECT id, codigo, name AS nome, phone AS telefone, acao_de_hoje AS acao, dia_do_playbook AS dia,
               status_de_resposta AS resposta, etapa_funil AS etapa, tentativas_de_contato AS tentativas,
               (SELECT tm.name FROM team_members tm WHERE tm.id = ld.sales_rep_id) AS vendedor
          FROM leads ld
         WHERE tenant_id = t AND acao_de_hoje IS NOT NULL AND acao_de_hoje NOT IN ('AGUARDAR','ENCERRAR')
         ORDER BY dia_do_playbook DESC NULLS LAST, updated_at ASC LIMIT 25) x), '[]'::jsonb),
    'agenda', coalesce((SELECT jsonb_agg(x) FROM (
        SELECT a.id, a.name AS titulo, a.task_type AS tipo, a.assignee AS responsavel, a.completed AS concluida,
               to_char(coalesce(a.scheduled_at, a.due_datetime) AT TIME ZONE 'America/Sao_Paulo','HH24:MI') AS hora,
               l.name AS lead, l.codigo
          FROM company_activities a LEFT JOIN leads l ON l.id = a.lead_id
         WHERE a.tenant_id = t
           AND coalesce(a.scheduled_at, a.due_datetime, a.date::timestamptz) >= ini
           AND coalesce(a.scheduled_at, a.due_datetime, a.date::timestamptz) < fim
         ORDER BY coalesce(a.scheduled_at, a.due_datetime, a.date::timestamptz) ASC LIMIT 30) x), '[]'::jsonb),
    'atrasadas', coalesce((SELECT jsonb_agg(x) FROM (
        SELECT a.id, a.name AS titulo, a.task_type AS tipo, a.assignee AS responsavel, a.is_critical AS critica,
               to_char(coalesce(a.scheduled_at, a.due_datetime) AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') AS vencia_em,
               (hoje - coalesce(a.scheduled_at, a.due_datetime)::date) AS dias,
               l.name AS lead, l.codigo
          FROM company_activities a LEFT JOIN leads l ON l.id = a.lead_id
         WHERE a.tenant_id = t AND a.completed IS NOT TRUE AND coalesce(a.scheduled_at, a.due_datetime) < ini
         ORDER BY coalesce(a.scheduled_at, a.due_datetime) ASC LIMIT 10) x), '[]'::jsonb),
    'novos_leads', coalesce((SELECT jsonb_agg(x) FROM (
        SELECT id, codigo, name AS nome, phone AS telefone, coalesce(source, utm_source) AS origem,
               to_char(created_at AT TIME ZONE 'America/Sao_Paulo','HH24:MI') AS hora,
               (last_message_received_at IS NOT NULL) AS respondeu
          FROM leads WHERE tenant_id = t AND created_at >= ini AND created_at < fim
         ORDER BY created_at DESC LIMIT 12) x), '[]'::jsonb)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.mcp_ficha_lead(text) FROM public, anon;
REVOKE ALL ON FUNCTION public.mcp_pipeline_do_dia() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.mcp_ficha_lead(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_pipeline_do_dia() TO authenticated;
