-- Segundo Cérebro (MCP) — telas 2: Inbox (WhatsApp + Instagram), Agenda da semana, Ranking.
-- Só gestão (mcp_guard_gestor), só o tenant do usuário. Leitura, exceto mcp_responder, que
-- enfileira o envio pelas edge functions OFICIAIS (send-whatsapp-cloud / instagram-send-dm)
-- via pg_net com o token interno — nunca pela UAZAPI (regra inviolável: 1:1 só pelo oficial).

-- ─── Inbox ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mcp_inbox(p_canal text DEFAULT 'todos', p_filtro text DEFAULT 'todas', p_busca text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  t uuid; m uuid;
  busca text := nullif(btrim(coalesce(p_busca,'')), '');
  digitos text;
  wa jsonb := '[]'::jsonb; ig jsonb := '[]'::jsonb;
  oficial boolean; ig_conectado boolean; pode_escrever boolean;
BEGIN
  m := public.mcp_guard_gestor();
  t := public.get_tenant_id();
  digitos := regexp_replace(coalesce(busca,''), '\D', '', 'g');
  oficial := EXISTS (SELECT 1 FROM whatsapp_instances WHERE tenant_id = t AND provider = 'meta_cloud' AND status = 'connected');
  ig_conectado := EXISTS (SELECT 1 FROM instagram_business_accounts WHERE tenant_id = t AND status = 'connected');
  pode_escrever := (SELECT lower(coalesce(role,'')) NOT IN ('promotora','sdr') FROM team_members WHERE id = m);

  IF coalesce(p_canal,'todos') IN ('todos','whatsapp') THEN
    wa := coalesce((SELECT jsonb_agg(x) FROM (
      WITH ult AS (
        SELECT DISTINCT ON (mm.lead_id) mm.lead_id, mm.content, mm.message_type, mm.is_from_me, mm.sent_at, mm.instance_id, mm.metadata
          FROM whatsapp_messages mm
         WHERE mm.tenant_id = t AND mm.lead_id IS NOT NULL AND mm.group_id IS NULL
           AND mm.is_deleted IS NOT TRUE AND mm.sent_at > now() - interval '60 days'
         ORDER BY mm.lead_id, mm.sent_at DESC)
      SELECT u.lead_id AS id, l.codigo, l.name AS nome, l.phone AS telefone,
             left(coalesce(nullif(u.content,''), '['||coalesce(u.message_type,'mídia')||']'), 140) AS ultima,
             to_char(u.sent_at AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') AS ultima_em,
             u.is_from_me AS ultima_minha, (u.is_from_me IS NOT TRUE) AS aguardando,
             (l.last_message_received_at > now() - interval '24 hours') AS janela_aberta,
             coalesce(u.metadata->>'sent_by_name', CASE WHEN u.metadata->>'sent_by' = 'ai_agent' THEN 'Nina' END) AS enviada_por,
             (SELECT tm.name FROM team_members tm WHERE tm.id = l.sales_rep_id) AS vendedor,
             (SELECT s.name FROM sales_pipeline_stages s WHERE s.id = l.pipeline_stage_id) AS etapa,
             wi.name AS instancia, wi.provider,
             -- lead de outra loja falando no MEU número oficial (ex.: base Cardoso respondendo o e-mail)
             CASE WHEN l.tenant_id <> t THEN (SELECT name FROM tenants WHERE id = l.tenant_id) END AS outra_loja,
             (SELECT e.event_type FROM ai_agent_chat_events e WHERE e.lead_id = l.id AND e.created_at > now() - interval '24 hours' ORDER BY e.created_at DESC LIMIT 1) AS nina,
             (SELECT count(*) FROM whatsapp_messages m2 WHERE m2.lead_id = l.id AND m2.group_id IS NULL AND m2.is_from_me IS NOT TRUE
                 AND m2.sent_at > coalesce(l.last_message_sent_at, '2000-01-01'::timestamptz)) AS sem_resposta
        FROM ult u
        JOIN leads l ON l.id = u.lead_id
        LEFT JOIN whatsapp_instances wi ON wi.id = u.instance_id
       WHERE (busca IS NULL OR l.name ILIKE '%'||busca||'%' OR l.codigo ILIKE busca
              OR (length(digitos) >= 4 AND regexp_replace(coalesce(l.phone,''), '\D', '', 'g') LIKE '%'||digitos||'%'))
         AND (coalesce(p_filtro,'todas') <> 'pendentes' OR u.is_from_me IS NOT TRUE)
       ORDER BY u.sent_at DESC LIMIT 40) x), '[]'::jsonb);
  END IF;

  IF coalesce(p_canal,'todos') IN ('todos','instagram') THEN
    ig := coalesce((SELECT jsonb_agg(x) FROM (
      SELECT c.id, c.participant_username AS usuario, coalesce(c.participant_name, l.name) AS nome, c.lead_id, l.codigo,
             left(coalesce(nullif(c.last_message,''), '['||coalesce(c.last_message_type,'mídia')||']'), 140) AS ultima,
             to_char(c.last_message_at AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') AS ultima_em,
             (c.last_client_message_at IS NOT NULL AND (c.last_agent_message_at IS NULL OR c.last_client_message_at > c.last_agent_message_at)) AS aguardando,
             (c.last_client_message_at > now() - interval '24 hours') AS janela_aberta,
             (coalesce(c.participant_instagram_id,'') ~ '^\d+$') AS tem_psid,
             c.unread_count AS nao_lidas, c.status, c.qualification_tier AS qualificacao, c.last_message_type AS tipo_ultima,
             (SELECT tm.name FROM team_members tm WHERE tm.id = c.assigned_to) AS responsavel
        FROM instagram_conversations c
        LEFT JOIN leads l ON l.id = c.lead_id
       WHERE c.tenant_id = t AND c.is_ignored IS NOT TRUE AND coalesce(c.status,'open') <> 'closed'
         AND c.last_message_at > now() - interval '90 days'
         AND (busca IS NULL OR c.participant_username ILIKE '%'||busca||'%' OR c.participant_name ILIKE '%'||busca||'%' OR l.name ILIKE '%'||busca||'%')
         AND (coalesce(p_filtro,'todas') <> 'pendentes'
              OR (c.last_client_message_at IS NOT NULL AND (c.last_agent_message_at IS NULL OR c.last_client_message_at > c.last_agent_message_at)))
       ORDER BY c.last_message_at DESC NULLS LAST LIMIT 40) x), '[]'::jsonb);
  END IF;

  RETURN jsonb_build_object(
    'tipo', 'inbox', 'canal', coalesce(p_canal,'todos'), 'filtro', coalesce(p_filtro,'todas'), 'busca', busca,
    'loja', (SELECT name FROM tenants WHERE id = t),
    'oficial_conectado', oficial, 'instagram_conectado', ig_conectado, 'pode_escrever', coalesce(pode_escrever, false),
    'whatsapp', wa, 'instagram', ig,
    'resumo', jsonb_build_object(
      'wa_total', jsonb_array_length(wa),
      'wa_aguardando', (SELECT count(*) FROM jsonb_array_elements(wa) e WHERE (e->>'aguardando')::boolean),
      'ig_total', jsonb_array_length(ig),
      'ig_aguardando', (SELECT count(*) FROM jsonb_array_elements(ig) e WHERE (e->>'aguardando')::boolean))
  );
END;
$function$;

-- ─── Conversa (thread) ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mcp_conversa(p_canal text, p_id uuid, p_limite integer DEFAULT 40)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  t uuid; m uuid; lim int := least(greatest(coalesce(p_limite,40), 5), 120);
  l leads%ROWTYPE; c instagram_conversations%ROWTYPE;
  oficial boolean; pode_escrever boolean; app_url text;
BEGIN
  m := public.mcp_guard_gestor();
  t := public.get_tenant_id();
  pode_escrever := (SELECT lower(coalesce(role,'')) NOT IN ('promotora','sdr') FROM team_members WHERE id = m);
  app_url := coalesce((SELECT value FROM config WHERE key IN ('app_url','APP_URL') AND value <> '' LIMIT 1), 'https://totexgest.vercel.app');

  IF p_canal = 'whatsapp' THEN
    -- lead da minha loja OU lead de outra loja cuja conversa está no MEU número
    SELECT * INTO l FROM leads WHERE id = p_id
       AND (tenant_id = t OR EXISTS (SELECT 1 FROM whatsapp_messages mm WHERE mm.lead_id = p_id AND mm.tenant_id = t));
    IF l.id IS NULL THEN RAISE EXCEPTION 'Lead não encontrado na sua loja'; END IF;
    oficial := EXISTS (SELECT 1 FROM whatsapp_instances WHERE tenant_id = t AND provider = 'meta_cloud' AND status = 'connected');
    RETURN jsonb_build_object(
      'tipo', 'conversa', 'canal', 'whatsapp', 'id', l.id,
      'cabecalho', jsonb_build_object(
        'nome', l.name, 'codigo', l.codigo, 'telefone', l.phone,
        'outra_loja', CASE WHEN l.tenant_id <> t THEN (SELECT name FROM tenants WHERE id = l.tenant_id) END,
        'etapa', (SELECT s.name FROM sales_pipeline_stages s WHERE s.id = l.pipeline_stage_id),
        'vendedor', (SELECT tm.name FROM team_members tm WHERE tm.id = l.sales_rep_id),
        'janela_aberta', (l.last_message_received_at > now() - interval '24 hours'),
        'ultima_do_cliente', to_char(l.last_message_received_at AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI'),
        'pode_responder', coalesce(pode_escrever,false) AND oficial AND (l.last_message_received_at > now() - interval '24 hours'),
        'motivo_bloqueio', CASE WHEN NOT coalesce(pode_escrever,false) THEN 'Seu perfil só lê'
                                WHEN NOT oficial THEN 'Número oficial (Cloud API) não conectado'
                                WHEN l.last_message_received_at IS NULL OR l.last_message_received_at < now() - interval '24 hours' THEN 'Janela de 24h fechada: só com template, pelo CRM' END,
        'link', app_url || '/comercial/leads/' || l.id,
        'nina', coalesce((SELECT jsonb_agg(x) FROM (SELECT event_type AS evento, left(reason,120) AS motivo, to_char(created_at AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') AS em
                  FROM ai_agent_chat_events WHERE lead_id = l.id ORDER BY created_at DESC LIMIT 3) x), '[]'::jsonb)),
      'mensagens', coalesce((SELECT jsonb_agg(x ORDER BY x.ts) FROM (
        SELECT mm.id, mm.is_from_me AS minha, mm.message_type AS tipo,
               left(coalesce(nullif(mm.content,''), '['||coalesce(mm.message_type,'mídia')||']'), 1200) AS texto,
               mm.media_url IS NOT NULL AS tem_midia,
               to_char(mm.sent_at AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') AS em, mm.sent_at AS ts, mm.status,
               coalesce(mm.metadata->>'sent_by_name', CASE WHEN mm.metadata->>'sent_by' = 'ai_agent' THEN 'Nina' END) AS por
          FROM whatsapp_messages mm
         WHERE mm.lead_id = l.id AND mm.group_id IS NULL AND mm.is_deleted IS NOT TRUE AND mm.tenant_id = t
         ORDER BY mm.sent_at DESC LIMIT lim) x), '[]'::jsonb));
  ELSIF p_canal = 'instagram' THEN
    SELECT * INTO c FROM instagram_conversations WHERE id = p_id AND tenant_id = t;
    IF c.id IS NULL THEN RAISE EXCEPTION 'Conversa não encontrada na sua loja'; END IF;
    oficial := EXISTS (SELECT 1 FROM instagram_business_accounts WHERE tenant_id = t AND status = 'connected');
    RETURN jsonb_build_object(
      'tipo', 'conversa', 'canal', 'instagram', 'id', c.id,
      'cabecalho', jsonb_build_object(
        'nome', coalesce(c.participant_name, (SELECT name FROM leads WHERE id = c.lead_id)), 'usuario', c.participant_username,
        'codigo', (SELECT codigo FROM leads WHERE id = c.lead_id), 'lead_id', c.lead_id,
        'responsavel', (SELECT tm.name FROM team_members tm WHERE tm.id = c.assigned_to),
        'janela_aberta', (c.last_client_message_at > now() - interval '24 hours'),
        'ultima_do_cliente', to_char(c.last_client_message_at AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI'),
        'pode_responder', coalesce(pode_escrever,false) AND oficial AND (coalesce(c.participant_instagram_id,'') ~ '^\d+$') AND (c.last_client_message_at > now() - interval '24 hours'),
        'motivo_bloqueio', CASE WHEN NOT coalesce(pode_escrever,false) THEN 'Seu perfil só lê'
                                WHEN NOT oficial THEN 'Conta do Instagram não conectada'
                                WHEN coalesce(c.participant_instagram_id,'') !~ '^\d+$' THEN 'Conversa antiga sem identificador da Meta: a pessoa precisa mandar uma nova DM'
                                WHEN c.last_client_message_at IS NULL OR c.last_client_message_at < now() - interval '24 hours' THEN 'Janela de 24h fechada (regra da Meta)' END,
        'link', CASE WHEN c.lead_id IS NOT NULL THEN app_url || '/comercial/leads/' || c.lead_id ELSE app_url || '/comercial/inbox' END),
      'mensagens', coalesce((SELECT jsonb_agg(x ORDER BY x.ts) FROM (
        SELECT im.id, im.is_from_me AS minha, im.message_type AS tipo,
               left(coalesce(nullif(im.content,''), '['||coalesce(im.message_type,'mídia')||']'), 1200) AS texto,
               im.media_url IS NOT NULL OR im.reference_url IS NOT NULL AS tem_midia,
               to_char(im.sent_at AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') AS em, im.sent_at AS ts, im.status,
               im.error_message AS erro
          FROM instagram_messages im
         WHERE im.conversation_id = c.id
         ORDER BY im.sent_at DESC LIMIT lim) x), '[]'::jsonb));
  END IF;
  RAISE EXCEPTION 'Canal inválido (whatsapp ou instagram)';
END;
$function$;

-- ─── Responder (enfileira pelo canal OFICIAL) ────────────────────────────────
CREATE OR REPLACE FUNCTION public.mcp_responder(p_canal text, p_id uuid, p_texto text)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  t uuid; m uuid; mnome text; mrole text; base text; tok text; rid bigint;
  l leads%ROWTYPE; c instagram_conversations%ROWTYPE;
  txt text := btrim(coalesce(p_texto,''));
BEGIN
  m := public.mcp_guard_gestor();
  t := public.get_tenant_id();
  SELECT name, role INTO mnome, mrole FROM team_members WHERE id = m;
  IF lower(coalesce(mrole,'')) IN ('promotora','sdr') THEN RAISE EXCEPTION 'Seu perfil não envia mensagens por aqui'; END IF;
  IF length(txt) < 1 THEN RAISE EXCEPTION 'Escreva a mensagem'; END IF;
  IF length(txt) > 1500 THEN RAISE EXCEPTION 'Mensagem longa demais (máx. 1500 caracteres)'; END IF;
  base := (SELECT value FROM config WHERE key = 'SUPABASE_PROJECT_URL');
  tok := (SELECT value FROM config WHERE key = 'INTERNAL_CRON_TOKEN');
  IF base IS NULL OR base LIKE '%REPLACE%' OR tok IS NULL THEN RAISE EXCEPTION 'Envio não configurado (SUPABASE_PROJECT_URL / INTERNAL_CRON_TOKEN)'; END IF;

  IF p_canal = 'whatsapp' THEN
    SELECT * INTO l FROM leads WHERE id = p_id
       AND (tenant_id = t OR EXISTS (SELECT 1 FROM whatsapp_messages mm WHERE mm.lead_id = p_id AND mm.tenant_id = t));
    IF l.id IS NULL THEN RAISE EXCEPTION 'Lead não encontrado na sua loja'; END IF;
    IF nullif(regexp_replace(coalesce(l.phone,''), '\D', '', 'g'),'') IS NULL THEN RAISE EXCEPTION 'Lead sem telefone'; END IF;
    IF NOT EXISTS (SELECT 1 FROM whatsapp_instances WHERE tenant_id = t AND provider = 'meta_cloud' AND status = 'connected') THEN
      RAISE EXCEPTION 'Sua loja não tem o número oficial (Cloud API) conectado. Conversa com cliente só sai pelo oficial.';
    END IF;
    IF l.last_message_received_at IS NULL OR l.last_message_received_at < now() - interval '24 hours' THEN
      RAISE EXCEPTION 'Janela de 24h fechada: o cliente não escreveu nas últimas 24h. Pelo oficial só dá com template, pelo CRM.';
    END IF;
    rid := net.http_post(
      url := base || '/functions/v1/send-whatsapp-cloud',
      headers := jsonb_build_object('Content-Type','application/json','x-internal-token', tok),
      body := jsonb_build_object('action','send_text','phone', l.phone, 'lead_id', l.id, 'tenant_id', t, 'text', txt, 'sent_by', m, 'sent_by_name', mnome));
  ELSIF p_canal = 'instagram' THEN
    SELECT * INTO c FROM instagram_conversations WHERE id = p_id AND tenant_id = t;
    IF c.id IS NULL THEN RAISE EXCEPTION 'Conversa não encontrada na sua loja'; END IF;
    IF NOT EXISTS (SELECT 1 FROM instagram_business_accounts WHERE tenant_id = t AND status = 'connected') THEN
      RAISE EXCEPTION 'Conta do Instagram não conectada.';
    END IF;
    IF c.last_client_message_at IS NULL OR c.last_client_message_at < now() - interval '24 hours' THEN
      RAISE EXCEPTION 'Janela de 24h fechada (regra da Meta): só dá pra responder até 24h depois da última DM da pessoa.';
    END IF;
    rid := net.http_post(
      url := base || '/functions/v1/instagram-send-dm',
      headers := jsonb_build_object('Content-Type','application/json','x-internal-token', tok),
      body := jsonb_build_object('conversation_id', c.id, 'lead_id', c.lead_id, 'tenant_id', t, 'message', txt, 'message_type', 'text'));
  ELSE
    RAISE EXCEPTION 'Canal inválido (whatsapp ou instagram)';
  END IF;
  RETURN jsonb_build_object('enfileirado', true, 'request_id', rid, 'canal', p_canal, 'id', p_id, 'por', mnome);
END;
$function$;

-- Status do envio (resposta da edge function, via pg_net). Só resumo: ok / erro.
CREATE OR REPLACE FUNCTION public.mcp_envio_status(p_request_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE sc int; body text; err text; j jsonb; ok boolean; msg text;
BEGIN
  PERFORM public.mcp_guard_gestor();
  SELECT status_code, content, error_msg INTO sc, body, err FROM net._http_response WHERE id = p_request_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('pronto', false); END IF;
  BEGIN j := body::jsonb; EXCEPTION WHEN others THEN j := NULL; END;
  ok := coalesce(sc BETWEEN 200 AND 299, false) AND coalesce((j->>'success')::boolean, true) AND (j->>'error') IS NULL AND err IS NULL;
  msg := coalesce(j->>'error', err, CASE WHEN sc IS NOT NULL AND sc NOT BETWEEN 200 AND 299 THEN 'HTTP '||sc END);
  RETURN jsonb_build_object('pronto', true, 'ok', ok, 'erro', CASE WHEN ok THEN NULL ELSE left(coalesce(msg,'Falhou'), 300) END, 'message_id', j->>'message_id');
END;
$function$;

-- ─── Agenda da semana ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mcp_agenda_semana(p_inicio date DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE t uuid; hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date; ini date; app_url text;
BEGIN
  PERFORM public.mcp_guard_gestor();
  t := public.get_tenant_id();
  ini := coalesce(p_inicio, hoje - (extract(isodow FROM hoje)::int - 1));
  app_url := coalesce((SELECT value FROM config WHERE key IN ('app_url','APP_URL') AND value <> '' LIMIT 1), 'https://totexgest.vercel.app');
  RETURN jsonb_build_object(
    'tipo', 'agenda_semana', 'loja', (SELECT name FROM tenants WHERE id = t), 'app_url', app_url,
    'inicio', to_char(ini,'DD/MM'), 'fim', to_char(ini+6,'DD/MM'), 'inicio_iso', ini, 'anterior', ini-7, 'proxima', ini+7, 'hoje', hoje,
    'dias', (SELECT jsonb_agg(d ORDER BY d.dia) FROM (
      SELECT (ini + i) AS dia, to_char(ini + i,'DD/MM') AS data, trim(to_char(ini + i,'TMDy')) AS semana, ((ini + i) = hoje) AS eh_hoje,
        coalesce((SELECT jsonb_agg(x) FROM (
          SELECT a.id, a.name AS titulo, a.task_type AS tipo, a.assignee AS responsavel, coalesce(a.completed,false) AS concluida,
                 coalesce(a.is_critical,false) AS critica, coalesce(a.is_all_day,false) AS dia_inteiro, a.confirmed_by_client AS confirmada,
                 to_char(coalesce(a.scheduled_at, a.due_datetime) AT TIME ZONE 'America/Sao_Paulo','HH24:MI') AS hora,
                 l.name AS lead, l.codigo, l.id AS lead_id
            FROM company_activities a LEFT JOIN leads l ON l.id = a.lead_id
           WHERE a.tenant_id = t
             AND coalesce((coalesce(a.scheduled_at, a.due_datetime) AT TIME ZONE 'America/Sao_Paulo')::date, a.date) = ini + i
           ORDER BY coalesce(a.scheduled_at, a.due_datetime) ASC NULLS FIRST LIMIT 40) x), '[]'::jsonb) AS itens
      FROM generate_series(0, 6) AS i) d),
    'resumo', (SELECT jsonb_build_object('total', count(*), 'concluidas', count(*) FILTER (WHERE completed), 'reunioes', count(*) FILTER (WHERE task_type = 'meeting'), 'ligacoes', count(*) FILTER (WHERE task_type = 'call'))
                 FROM company_activities a WHERE a.tenant_id = t
                  AND coalesce((coalesce(a.scheduled_at, a.due_datetime) AT TIME ZONE 'America/Sao_Paulo')::date, a.date) BETWEEN ini AND ini + 6)
  );
END;
$function$;

-- ─── Ranking do time (mesma assinatura, mais colunas) ────────────────────────
CREATE OR REPLACE FUNCTION public.mcp_ranking_time(p_period text DEFAULT 'month'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE t uuid; ps timestamptz;
BEGIN
  PERFORM public.mcp_guard_gestor();
  t := public.get_tenant_id();
  ps := CASE p_period WHEN 'week' THEN date_trunc('week', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'
                      WHEN 'all' THEN '2000-01-01'::timestamptz
                      ELSE date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo' END;
  RETURN jsonb_build_object(
    'tipo', 'ranking', 'periodo', p_period, 'desde', to_char(ps AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY'),
    'loja', (SELECT name FROM tenants WHERE id = t),
    'ranking', coalesce((SELECT jsonb_agg(x) FROM (
      SELECT tm.name AS vendedor, tm.id AS membro_id, tm.role AS papel,
             (SELECT count(*) FROM deals d WHERE d.tenant_id = t AND d.sales_rep_id = tm.id AND d.won_at >= ps) AS vendas_ganhas,
             (SELECT coalesce(sum(coalesce(d.total_paid, d.negotiated_price, d.original_price)),0) FROM deals d WHERE d.tenant_id = t AND d.sales_rep_id = tm.id AND d.won_at >= ps) AS valor_ganho,
             (SELECT count(*) FROM deals d WHERE d.tenant_id = t AND d.sales_rep_id = tm.id AND d.won_at IS NULL AND d.lost_at IS NULL
                 AND coalesce(lower(d.status),'') NOT IN ('won','ganho','lost','perdido','closed')) AS em_aberto,
             (SELECT count(*) FROM deals d WHERE d.tenant_id = t AND d.sales_rep_id = tm.id AND d.lost_at >= ps) AS perdidas,
             (SELECT count(*) FROM leads l WHERE l.tenant_id = t AND l.sales_rep_id = tm.id AND l.created_at >= ps) AS leads_novos,
             (SELECT count(*) FROM leads l WHERE l.tenant_id = t AND l.sales_rep_id = tm.id AND l.last_message_received_at >= ps) AS leads_que_responderam,
             (SELECT count(*) FROM company_activities a WHERE a.tenant_id = t AND a.responsavel_id = tm.id AND a.completed AND a.completed_at >= ps) AS tarefas_feitas,
             (SELECT count(*) FROM company_activities a WHERE a.tenant_id = t AND a.responsavel_id = tm.id AND a.completed IS NOT TRUE
                 AND coalesce(a.scheduled_at, a.due_datetime) < now()) AS tarefas_atrasadas
        FROM team_members tm
       WHERE tm.tenant_id = t AND tm.is_active
         AND lower(coalesce(tm.role,'')) IN ('admin','comercial','closer','sdr','vendedor','gestor')
       ORDER BY 4 DESC, 5 DESC, 6 DESC LIMIT 30) x), '[]'::jsonb),
    'sem_vendedor', jsonb_build_object(
      'em_aberto', (SELECT count(*) FROM deals d WHERE d.tenant_id = t AND d.sales_rep_id IS NULL AND d.won_at IS NULL AND d.lost_at IS NULL
                      AND coalesce(lower(d.status),'') NOT IN ('won','ganho','lost','perdido','closed')),
      'ganhas', (SELECT count(*) FROM deals d WHERE d.tenant_id = t AND d.sales_rep_id IS NULL AND d.won_at >= ps))
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.mcp_inbox(text,text,text), public.mcp_conversa(text,uuid,integer), public.mcp_responder(text,uuid,text),
  public.mcp_envio_status(bigint), public.mcp_agenda_semana(date), public.mcp_ranking_time(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.mcp_inbox(text,text,text), public.mcp_conversa(text,uuid,integer), public.mcp_responder(text,uuid,text),
  public.mcp_envio_status(bigint), public.mcp_agenda_semana(date), public.mcp_ranking_time(text) TO authenticated;
