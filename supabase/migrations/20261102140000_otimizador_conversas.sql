-- ============================================================================
-- OTIMIZADOR DE CONVERSAS (Marco, 2026-11-02): medir cada ponto de contato (template /
-- primeira mensagem / pedido de permissão), rodar variantes (A/B com amostragem de Thompson)
-- e um agente diário (edge fn message-optimizer) que diagnostica, propõe novas variantes
-- (templates da Meta) e pausa as que perdem. Humano aprova propostas; rotação é automática.
--
-- Achado da auditoria (30 dias, número oficial): 20 primeiras mensagens da Nina pra leads do
-- totem FALHARAM na Meta ("Re-engagement message": texto livre fora da janela de 24 h) e
-- 21 de 35 pedidos de permissão de ligação também. Correção: primeiro contato por TEMPLATE
-- com botões (nina_primeiro_contato / _b); o pedido de permissão só sai com a janela aberta.
-- ============================================================================

-- Variantes por ponto de contato (touchpoint): template da Meta ou texto (janela aberta)
CREATE TABLE IF NOT EXISTS message_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  touchpoint text NOT NULL,              -- nina_primeiro_contato | nina_curiosidade | reaquecimento_trocar | ...
  name text NOT NULL,                    -- nome do template (Meta) ou rótulo
  kind text NOT NULL DEFAULT 'template', -- template | text
  body text,                             -- texto com {{1}}.. (referência; a Meta tem a cópia oficial)
  buttons jsonb NOT NULL DEFAULT '[]'::jsonb,
  params_hint text,                      -- o que vai em cada {{n}}
  status text NOT NULL DEFAULT 'proposed', -- proposed | submitted | active | paused | rejected
  weight numeric NOT NULL DEFAULT 1,
  origem text NOT NULL DEFAULT 'manual', -- manual | otimizador
  rationale text,
  meta_template_id text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, touchpoint, name)
);
ALTER TABLE message_variants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS message_variants_read ON message_variants;
CREATE POLICY message_variants_read ON message_variants FOR SELECT USING (tenant_id = get_tenant_id());

-- Cada envio atribuído a uma variante (a resposta é medida depois, pela whatsapp_messages)
CREATE TABLE IF NOT EXISTS message_variant_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  variant_id uuid NOT NULL REFERENCES message_variants(id) ON DELETE CASCADE,
  touchpoint text NOT NULL,
  lead_id uuid,
  phone text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  delivered boolean,
  replied_at timestamptz,
  outcome text,                          -- replied | permitted | scheduled | silent | failed
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS message_variant_sends_variant_idx ON message_variant_sends (variant_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS message_variant_sends_phone_idx ON message_variant_sends (phone, sent_at DESC);
ALTER TABLE message_variant_sends ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS message_variant_sends_read ON message_variant_sends;
CREATE POLICY message_variant_sends_read ON message_variant_sends FOR SELECT USING (tenant_id = get_tenant_id());

-- Relatórios do agente otimizador
CREATE TABLE IF NOT EXISTS message_optimizer_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  run_at timestamptz NOT NULL DEFAULT now(),
  period_days integer NOT NULL DEFAULT 7,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  report jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {diagnostico, hipoteses[], acoes[], propostas[], prompt_sugestoes[]}
  actions_taken jsonb NOT NULL DEFAULT '[]'::jsonb,
  model text
);
ALTER TABLE message_optimizer_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS message_optimizer_runs_read ON message_optimizer_runs;
CREATE POLICY message_optimizer_runs_read ON message_optimizer_runs FOR SELECT USING (tenant_id = get_tenant_id());

-- Estatística por ponto de contato (número oficial), lida pela tela e pelo otimizador
CREATE OR REPLACE FUNCTION whatsapp_touchpoint_stats(p_tenant uuid, p_days integer DEFAULT 30)
RETURNS TABLE (tipo text, enviadas bigint, contatos bigint, entregues bigint, lidas bigint, falhas bigint, erro_principal text, respondidas_48h bigint, taxa_resposta numeric)
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  WITH o AS (
    SELECT m.id, m.remote_jid, m.sent_at, m.status, m.metadata,
           COALESCE(m.metadata->>'template_name', m.message_type) AS tipo
      FROM whatsapp_messages m
      JOIN whatsapp_instances i ON i.id = m.instance_id AND i.provider = 'meta_cloud'
     WHERE m.is_from_me AND m.tenant_id = p_tenant
       AND m.sent_at > now() - (p_days || ' days')::interval
       AND m.remote_jid NOT LIKE '%@g.us'
  )
  SELECT tipo,
         count(*) AS enviadas,
         count(DISTINCT remote_jid) AS contatos,
         count(*) FILTER (WHERE status IN ('delivered','read')) AS entregues,
         count(*) FILTER (WHERE status = 'read') AS lidas,
         count(*) FILTER (WHERE status = 'failed') AS falhas,
         (SELECT x.metadata->'delivery_errors'->0->>'title' FROM o x WHERE x.tipo = o.tipo AND x.status = 'failed' AND x.metadata ? 'delivery_errors' LIMIT 1) AS erro_principal,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM whatsapp_messages r WHERE r.remote_jid = o.remote_jid AND NOT r.is_from_me AND r.sent_at > o.sent_at AND r.sent_at < o.sent_at + interval '48 hours')) AS respondidas_48h,
         round(100.0 * count(*) FILTER (WHERE EXISTS (SELECT 1 FROM whatsapp_messages r WHERE r.remote_jid = o.remote_jid AND NOT r.is_from_me AND r.sent_at > o.sent_at AND r.sent_at < o.sent_at + interval '48 hours')) / GREATEST(count(*),1), 1) AS taxa_resposta
    FROM o GROUP BY tipo ORDER BY enviadas DESC;
$$;

-- Funil de conversas (número oficial)
CREATE OR REPLACE FUNCTION whatsapp_conversation_funnel(p_tenant uuid, p_days integer DEFAULT 30)
RETURNS TABLE (contatos bigint, abordados bigint, abordados_responderam bigint, iniciados_pelo_cliente bigint, conversas_3mais bigint, continuidade_pct numeric)
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  WITH c AS (
    SELECT m.remote_jid,
           count(*) FILTER (WHERE NOT m.is_from_me) AS in_n,
           min(m.sent_at) FILTER (WHERE NOT m.is_from_me) AS primeira_in,
           min(m.sent_at) FILTER (WHERE m.is_from_me) AS primeira_out
      FROM whatsapp_messages m JOIN whatsapp_instances i ON i.id = m.instance_id AND i.provider = 'meta_cloud'
     WHERE m.tenant_id = p_tenant AND m.sent_at > now() - (p_days || ' days')::interval AND m.remote_jid NOT LIKE '%@g.us'
     GROUP BY m.remote_jid
  ), a AS (
    SELECT m.id, m.remote_jid, m.sent_at FROM whatsapp_messages m JOIN whatsapp_instances i ON i.id = m.instance_id AND i.provider = 'meta_cloud'
     WHERE m.is_from_me AND m.tenant_id = p_tenant AND m.sent_at > now() - (p_days || ' days')::interval AND m.remote_jid NOT LIKE '%@g.us'
       AND m.message_type = 'Conversation' AND m.metadata->>'template_name' IS NULL
       AND EXISTS (SELECT 1 FROM whatsapp_messages p WHERE p.remote_jid = m.remote_jid AND NOT p.is_from_me AND p.sent_at < m.sent_at AND p.sent_at > m.sent_at - interval '24 hours')
  )
  SELECT (SELECT count(*) FROM c),
         (SELECT count(*) FROM c WHERE primeira_out < COALESCE(primeira_in, 'infinity')),
         (SELECT count(*) FROM c WHERE primeira_out < COALESCE(primeira_in, 'infinity') AND in_n > 0),
         (SELECT count(*) FROM c WHERE primeira_in < COALESCE(primeira_out, 'infinity')),
         (SELECT count(*) FROM c WHERE in_n >= 3),
         (SELECT round(100.0 * count(*) FILTER (WHERE EXISTS (SELECT 1 FROM whatsapp_messages r WHERE r.remote_jid = a.remote_jid AND NOT r.is_from_me AND r.sent_at > a.sent_at AND r.sent_at < a.sent_at + interval '24 hours')) / GREATEST(count(*),1), 1) FROM a);
$$;

-- Métricas por variante (resposta em 48 h / permissão / agendamento)
CREATE OR REPLACE FUNCTION message_variant_stats(p_tenant uuid, p_days integer DEFAULT 30)
RETURNS TABLE (variant_id uuid, touchpoint text, name text, status text, enviadas bigint, respondidas bigint, permitiram bigint, taxa numeric)
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT v.id, v.touchpoint, v.name, v.status,
         count(s.id) AS enviadas,
         count(s.id) FILTER (WHERE s.replied_at IS NOT NULL OR EXISTS (SELECT 1 FROM whatsapp_messages r WHERE NOT r.is_from_me AND r.sender_phone LIKE '%' || right(s.phone, 8) AND r.sent_at > s.sent_at AND r.sent_at < s.sent_at + interval '48 hours')) AS respondidas,
         count(s.id) FILTER (WHERE s.outcome IN ('permitted','scheduled')) AS permitiram,
         round(100.0 * count(s.id) FILTER (WHERE s.replied_at IS NOT NULL OR EXISTS (SELECT 1 FROM whatsapp_messages r WHERE NOT r.is_from_me AND r.sender_phone LIKE '%' || right(s.phone, 8) AND r.sent_at > s.sent_at AND r.sent_at < s.sent_at + interval '48 hours')) / GREATEST(count(s.id),1), 1) AS taxa
    FROM message_variants v
    LEFT JOIN message_variant_sends s ON s.variant_id = v.id AND s.sent_at > now() - (p_days || ' days')::interval
   WHERE v.tenant_id = p_tenant
   GROUP BY v.id, v.touchpoint, v.name, v.status ORDER BY v.touchpoint, v.name;
$$;

-- 03/11: status novos da fila da Nina (awaiting_window = template de primeiro contato enviado,
-- esperando resposta; paused = segurada pela equipe). Sem isso a gravação falhava em silêncio e o
-- discador repetia o envio a cada minuto (incidente: 500 envios pro mesmo lead).
ALTER TABLE nina_call_queue DROP CONSTRAINT IF EXISTS nina_call_queue_status_check;
ALTER TABLE nina_call_queue ADD CONSTRAINT nina_call_queue_status_check
  CHECK (status = ANY (ARRAY['queued','awaiting_permission','awaiting_window','calling','done','no_answer','failed','cancelled','expired','paused']));

-- 03/11: o que vai em cada {{n}} da variante (vocabulário: nome, assinatura, carro, assunto, motivo, parcela)
ALTER TABLE message_variants ADD COLUMN IF NOT EXISTS params_spec jsonb NOT NULL DEFAULT '[]'::jsonb;
-- Templates atuais entram como variantes "controle" do A/B (reaquecimento_* e retomada_conversa);
-- nina_primeiro_contato / _b = ["nome","motivo"]. Seeds aplicados em produção via SQL.
