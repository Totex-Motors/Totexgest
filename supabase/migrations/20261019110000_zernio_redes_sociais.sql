-- ============================================================================
-- ZERNIO — publicação do Studio em OUTRAS redes (Facebook, TikTok, YouTube…)
-- Decisão do Marco (2026-10-19): Instagram continua direto na Meta (instagram-publish).
-- A Zernio entra só pra espelhar o carrossel do Studio nas outras redes (plano grátis
-- cobre 2 contas conectadas). DMs/comentários do Instagram NÃO passam pela Zernio.
--
-- Chaves (globais, config): ZERNIO_API_KEY, ZERNIO_WEBHOOK_SECRET.
-- Edge functions: zernio-publish (tela) e zernio-webhook (eventos post.*/account.*).
-- ============================================================================

-- Um "profile" na Zernio por loja (externalId = tenant_id). Criado sob demanda.
CREATE TABLE IF NOT EXISTS zernio_profiles (
  tenant_id uuid PRIMARY KEY,
  profile_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE zernio_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS zernio_profiles_read ON zernio_profiles;
CREATE POLICY zernio_profiles_read ON zernio_profiles FOR SELECT USING (tenant_id = get_tenant_id());

-- Cada envio do Studio pra Zernio (um post, N redes).
CREATE TABLE IF NOT EXISTS social_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  campaign_id uuid NOT NULL,            -- instagram_comment_campaigns.id (campanha do Studio)
  zernio_post_id text UNIQUE,
  status text NOT NULL DEFAULT 'publishing',  -- draft|scheduled|publishing|published|partial|failed|cancelled
  caption text,
  media_count integer NOT NULL DEFAULT 0,
  scheduled_for timestamptz,
  -- [{platform, account_id, username, status, url, error}]
  platforms jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS social_publications_campaign_idx ON social_publications (tenant_id, campaign_id, created_at DESC);
ALTER TABLE social_publications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS social_publications_read ON social_publications;
CREATE POLICY social_publications_read ON social_publications FOR SELECT USING (tenant_id = get_tenant_id());

COMMENT ON TABLE social_publications IS 'Posts enviados pela Zernio (Facebook/TikTok/YouTube…) a partir do carrossel do Studio. Escrita só pelas edge functions (service role).';
