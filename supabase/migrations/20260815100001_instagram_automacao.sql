-- ============================================================================
-- AUTOMAÇÃO INSTAGRAM (API oficial Meta) — inbox + agente + campanhas
-- Merge do pack instagram-automacao no schema existente, tenant-aware (padrão B1).
-- Idempotente: roda limpa em banco virgem e em banco existente.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────
-- 1. COLUNAS NOVAS nas tabelas existentes
-- ─────────────────────────────────────────────────────────────

-- Conta conectada: tokens do flavor "Instagram API with Instagram Login"
-- page_access_token é o que manda DM (NÃO o access_token comum).
ALTER TABLE public.instagram_business_accounts
  ADD COLUMN IF NOT EXISTS page_access_token text,
  ADD COLUMN IF NOT EXISTS ig_login_token text,
  ADD COLUMN IF NOT EXISTS ig_login_id text,
  -- Token do IG Login dura 60 DIAS. instagram-refresh-token (cron semanal)
  -- renova e grava a nova validade aqui. Sem isso a automação para em silêncio.
  ADD COLUMN IF NOT EXISTS ig_login_token_expires_at timestamptz;

-- Conversas: sessão por PESSOA (regra central), pause, qualificação
ALTER TABLE public.instagram_conversations
  ADD COLUMN IF NOT EXISTS last_message_type text,
  ADD COLUMN IF NOT EXISTS is_ignored boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS agent_paused boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS agent_session_id uuid,
  ADD COLUMN IF NOT EXISTS has_dm boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS qualification_tier text,
  ADD COLUMN IF NOT EXISTS qualification_reason text,
  ADD COLUMN IF NOT EXISTS qualification_at timestamptz,
  ADD COLUMN IF NOT EXISTS ig_web_thread_id text;

CREATE INDEX IF NOT EXISTS idx_ig_conv_user
  ON public.instagram_conversations (lower(participant_username));
CREATE INDEX IF NOT EXISTS idx_ig_conv_last
  ON public.instagram_conversations (last_message_at DESC);

-- Mensagens: metadata + dedup por mid da Meta
ALTER TABLE public.instagram_messages
  ADD COLUMN IF NOT EXISTS metadata jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ig_msg_dedup
  ON public.instagram_messages (instagram_message_id)
  WHERE instagram_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ig_msg_conv
  ON public.instagram_messages (conversation_id, sent_at DESC);

-- ─────────────────────────────────────────────────────────────
-- 2. CAMPANHAS COMENTÁRIO → DM
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.instagram_comment_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT public.get_tenant_id(),
  name text NOT NULL,
  post_id text NOT NULL,                 -- ID da Graph API (NUNCA URL/shortcode)
  post_permalink text,
  post_caption text,
  post_thumbnail_url text,
  keyword_mode text NOT NULL DEFAULT 'contains',   -- all|contains|min_words
  keywords text[] DEFAULT '{}',
  min_words int DEFAULT 1,
  reply_mode text NOT NULL DEFAULT 'agent',        -- agent|template
  dm_template text,                                -- fallback do modo agente
  agent_slug text,
  delay_min_seconds int NOT NULL DEFAULT 15,       -- parecer humano
  delay_max_seconds int NOT NULL DEFAULT 45,
  once_per_user boolean NOT NULL DEFAULT true,
  process_existing boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active',           -- active|paused|ended
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ig_camp_tenant ON public.instagram_comment_campaigns (tenant_id);

CREATE TABLE IF NOT EXISTS public.instagram_comment_campaign_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT public.get_tenant_id(),
  campaign_id uuid NOT NULL REFERENCES public.instagram_comment_campaigns(id) ON DELETE CASCADE,
  comment_id text NOT NULL,
  commenter_username text,
  commenter_ig_id text,
  comment_text text,
  comment_at timestamptz,
  dm_status text NOT NULL DEFAULT 'pending',  -- pending|processing|sent|failed|skipped_*
  dm_message text,
  dm_sent_at timestamptz,
  dm_error text,
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  recipient_psid text,
  agent_session_id uuid,
  replied_at timestamptz,
  lead_id uuid,
  public_replied_at timestamptz,
  retry_count int NOT NULL DEFAULT 0,
  nudge_count int NOT NULL DEFAULT 0,         -- cutucão: 0→1→2 e para
  last_nudged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, comment_id)            -- private reply 1x por comentário
);
CREATE INDEX IF NOT EXISTS idx_recip_due
  ON public.instagram_comment_campaign_recipients (dm_status, scheduled_at)
  WHERE dm_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_recip_tenant ON public.instagram_comment_campaign_recipients (tenant_id);

-- ─────────────────────────────────────────────────────────────
-- 3. FILA DE DMs RECEBIDAS (trailing debounce)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ig_agent_message_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT public.get_tenant_id(),
  username text NOT NULL,
  content text,
  scheduled_for timestamptz NOT NULL,    -- now() + ~15s
  status text DEFAULT 'pending',         -- pending|processing|done|failed|cancelled
  attempts int DEFAULT 0,
  error_message text,
  created_at timestamptz DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_ig_queue_due
  ON public.ig_agent_message_queue (status, scheduled_for)
  WHERE status = 'pending';

-- ─────────────────────────────────────────────────────────────
-- 3b. DEDUP ATÔMICO de eventos Meta (retry re-entrega o mesmo mid)
-- Sem tenant_id de propósito: mid é globalmente único (vem da Meta) e a
-- tabela também serve de lock efêmero (chaves agentlock_{tenant}_{user}).
-- Só service_role toca nela (RLS ligada sem policy = ninguém autenticado lê).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.instagram_processed_mids (
  mid text PRIMARY KEY,
  seen_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.instagram_processed_mids ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────
-- 4. OBSERVABILIDADE — toda falha de envio vai pra tabela
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.instagram_send_failures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT public.get_tenant_id(),
  created_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL,                  -- campaign_private_reply|bot_detected|...
  username text,
  comment_id text,
  recipient_psid text,
  attempt int NOT NULL DEFAULT 1,
  error_raw text,                        -- erro CRU da Meta
  message_text text
);

-- ─────────────────────────────────────────────────────────────
-- 5. OPCIONAIS — gatilho keyword, ICP, outbound
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ig_dm_keyword_triggers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT public.get_tenant_id(),
  label text NOT NULL,
  keyword text NOT NULL,                 -- sempre minúsculo
  material_link text NOT NULL,
  utm_campaign text NOT NULL,
  utm_medium text NOT NULL DEFAULT 'story',
  agent_slug text NOT NULL DEFAULT 'ig-primeiro-contato',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ig_icp_scores (
  tenant_id uuid NOT NULL DEFAULT public.get_tenant_id(),
  username text NOT NULL,
  score int NOT NULL DEFAULT 0,
  segmento text,
  motivo text,
  gancho text,          -- abertura pessoal
  ponte text,
  descartar boolean DEFAULT false,
  scored_at timestamptz DEFAULT now(),
  PRIMARY KEY (tenant_id, username)
);
CREATE INDEX IF NOT EXISTS idx_icp_score ON public.ig_icp_scores (score DESC) WHERE NOT descartar;

CREATE TABLE IF NOT EXISTS public.ig_outbound_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT public.get_tenant_id(),
  username text NOT NULL,
  message text NOT NULL,
  mission text,                          -- o que o agente faz quando responderem
  priority int DEFAULT 100,
  status text NOT NULL DEFAULT 'pending',
  send_after timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  error text,
  created_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_outq_user_pending
  ON public.ig_outbound_queue (tenant_id, lower(username))
  WHERE status = 'pending';

-- ─────────────────────────────────────────────────────────────
-- 6. RLS — padrão B1: escopo por tenant
-- ─────────────────────────────────────────────────────────────
DO $$ DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['instagram_comment_campaigns','instagram_comment_campaign_recipients',
    'ig_agent_message_queue','instagram_send_failures','ig_dm_keyword_triggers',
    'ig_icp_scores','ig_outbound_queue']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_read ON public.%I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_tenant_read ON public.%I FOR SELECT TO authenticated USING (tenant_id = public.get_tenant_id())',
      t, t);
    -- escrita: admin do tenant (edges usam service_role, que bypassa RLS)
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_write ON public.%I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_tenant_write ON public.%I FOR ALL TO authenticated USING (public.is_admin() AND tenant_id = public.get_tenant_id()) WITH CHECK (public.is_admin() AND tenant_id = public.get_tenant_id())',
      t, t);
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────
-- 7. RPC — criar campanha sem abrir INSERT na tabela
-- p_tenant_id: chamadas service_role (sem JWT) passam o tenant explícito;
-- chamadas autenticadas deixam null e cai no tenant do JWT.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.criar_campanha_comentario(
  p_post_id text, p_palavra text, p_material_link text, p_nome text,
  p_permalink text DEFAULT NULL, p_caption text DEFAULT NULL,
  p_dm_template text DEFAULT NULL, p_tenant_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_tenant uuid;
BEGIN
  v_tenant := COALESCE(p_tenant_id, public.get_tenant_id());
  IF p_post_id !~ '^\d+$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'post_id tem que ser o ID numérico da Graph API, não URL');
  END IF;
  IF p_material_link !~ '^https?://' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'material_link precisa começar com http');
  END IF;
  IF EXISTS (SELECT 1 FROM instagram_comment_campaigns
             WHERE post_id = p_post_id AND tenant_id = v_tenant) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'já existe campanha para esse post');
  END IF;

  INSERT INTO instagram_comment_campaigns (
    tenant_id, name, post_id, post_permalink, post_caption, keyword_mode, keywords,
    reply_mode, agent_slug, dm_template, delay_min_seconds, delay_max_seconds,
    once_per_user, process_existing, status
  ) VALUES (
    v_tenant, p_nome, p_post_id, p_permalink, p_caption,
    CASE WHEN COALESCE(p_palavra,'') = '' THEN 'all' ELSE 'contains' END,
    CASE WHEN COALESCE(p_palavra,'') = '' THEN '{}' ELSE ARRAY[lower(trim(p_palavra))] END,
    'agent', 'ig-primeiro-contato',
    COALESCE(p_dm_template, format('Material: %s%s%s', p_nome, chr(10), p_material_link)),
    15, 45, true, true, 'active'
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'campaign_id', v_id);
END $$;

-- ─────────────────────────────────────────────────────────────
-- 8. RPC — selo A/B/C (classifica TODAS as conversas, joins escopados por tenant)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.recompute_ig_qualification()
RETURNS TABLE(tier text, qtd bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  WITH msg AS (
    SELECT conversation_id,
           count(*) FILTER (WHERE is_from_me = false AND length(COALESCE(content,'')) > 3) deles
    FROM instagram_messages GROUP BY conversation_id
  ),
  camp AS (
    SELECT tenant_id t, lower(commenter_username) u, count(*) n
    FROM instagram_comment_campaign_recipients
    WHERE commenter_username IS NOT NULL GROUP BY 1, 2
  ),
  calc AS (
    SELECT c.id,
      CASE
        WHEN c.is_ignored THEN 'fora'
        WHEN (c.metadata->'ai_analysis'->>'whatsapp') IS NOT NULL
          OR (c.agent_session_id IS NOT NULL AND COALESCE(m.deles,0) >= 2)
          OR (c.metadata->'ai_analysis'->>'interesse') = 'alto' THEN 'A'
        WHEN COALESCE(m.deles,0) >= 2
          OR (c.metadata->'ai_analysis'->>'interesse') = 'medio'
          OR COALESCE(cp.n,0) >= 2 THEN 'B'
        ELSE 'C'
      END new_tier,
      CASE
        WHEN c.is_ignored THEN 'ignorado'
        WHEN (c.metadata->'ai_analysis'->>'whatsapp') IS NOT NULL THEN 'passou o WhatsApp'
        WHEN c.agent_session_id IS NOT NULL AND COALESCE(m.deles,0) >= 2 THEN 'conversou com o agente'
        WHEN (c.metadata->'ai_analysis'->>'interesse') = 'alto' THEN 'interesse alto'
        WHEN COALESCE(m.deles,0) >= 2 THEN 'trocou mensagens'
        WHEN COALESCE(cp.n,0) >= 2 THEN 'pediu 2+ conteúdos'
        WHEN COALESCE(cp.n,0) = 1 THEN 'pediu conteúdo'
        ELSE 'só interagiu uma vez'
      END new_reason
    FROM instagram_conversations c
    LEFT JOIN msg m ON m.conversation_id = c.id
    LEFT JOIN camp cp ON cp.u = lower(c.participant_username) AND cp.t = c.tenant_id
    WHERE c.participant_username IS NOT NULL
  )
  UPDATE instagram_conversations c
  SET qualification_tier = calc.new_tier, qualification_reason = calc.new_reason,
      qualification_at = now()
  FROM calc WHERE calc.id = c.id;

  RETURN QUERY SELECT c.qualification_tier, count(*) FROM instagram_conversations c
    WHERE c.qualification_tier IS NOT NULL GROUP BY 1 ORDER BY 1;
END $$;

GRANT EXECUTE ON FUNCTION public.criar_campanha_comentario(text,text,text,text,text,text,text,uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.recompute_ig_qualification() TO authenticated, service_role;

-- Crons (pg_cron + pg_net) são configurados no ambiente, não na migration:
--   ig-dispatch      * * * * *          → instagram-comments-dispatch
--   ig-agent-queue   * * * * * (ou 30s) → instagram-agent-queue
--   ig-nudge         */30 11-23 * * *   → instagram-comment-nudge

-- ─────────────────────────────────────────────────────────────
-- 9. (Adaptação Totexgest) instagram_profiles — cache de perfis
-- O pack assume essa tabela no baseline (fetchCommenterProfile, icp-score),
-- mas este banco não a tinha. Colunas = exatamente o que o código usa.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.instagram_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT public.get_tenant_id(),
  username text NOT NULL,
  full_name text,
  biography text,
  follower_count int,
  external_url text,
  latest_posts jsonb,
  last_scraped_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, username)
);
ALTER TABLE public.instagram_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instagram_profiles_tenant_read ON public.instagram_profiles;
CREATE POLICY instagram_profiles_tenant_read ON public.instagram_profiles
  FOR SELECT TO authenticated USING (tenant_id = public.get_tenant_id());
