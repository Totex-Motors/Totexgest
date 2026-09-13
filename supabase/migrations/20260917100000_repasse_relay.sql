-- ============================================================================
-- REPASSE RELAY — "TOTEX Abaixo da Tabela"
--
-- Captura carros postados num grupo de repasse (onde a loja participa), reescreve
-- no tom da TOTEX com a margem embutida e reposta no grupo da comunidade.
--
-- Vale a REGRA INVIOLÁVEL da UAZAPI: só posta em grupo/canal (o alvo é sempre
-- um @g.us), então este fluxo é 100% compatível com group_only.
--
--   repasse_relay_config  — o que monitorar, pra onde postar, margem e tom
--   repasse_relay_posts   — log/auditoria + idempotência (não reposta 2x)
-- ============================================================================

-- ─── Config ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.repasse_relay_config (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL DEFAULT public.get_tenant_id(),
  instance_id        uuid NOT NULL REFERENCES public.whatsapp_instances(id) ON DELETE CASCADE,
  -- Grupo de origem (repasse) que a loja participa. JID completo (…@g.us).
  source_group_jid   text NOT NULL,
  -- Grupo da comunidade onde o post final é publicado. JID completo (…@g.us).
  target_group_jid   text NOT NULL,
  -- Margem embutida, em reais (some ao preço pedido no anúncio).
  margin             numeric NOT NULL DEFAULT 5000,
  -- Tom do post: equilibrado | vendedor | consultor | descolado
  voice              text NOT NULL DEFAULT 'equilibrado',
  -- Assinatura/rodapé do post.
  signature          text NOT NULL DEFAULT 'TOTEX Motors',
  -- Modelo Claude usado na transformação (alias do repo).
  model              text NOT NULL DEFAULT 'claude-sonnet-4-6',
  -- Filtros opcionais de preço do anúncio de origem (null = sem filtro).
  min_source_price   numeric,
  max_source_price   numeric,
  -- Se o anúncio não tiver preço claro: false = pula (não posta), true = posta com "(consultar)".
  post_without_price boolean NOT NULL DEFAULT false,
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT repasse_relay_target_is_group
    CHECK (public.wa_is_group_or_channel(target_group_jid))
);

CREATE INDEX IF NOT EXISTS repasse_relay_config_lookup_idx
  ON public.repasse_relay_config (instance_id, source_group_jid) WHERE active;
CREATE INDEX IF NOT EXISTS repasse_relay_config_tenant_idx
  ON public.repasse_relay_config (tenant_id);

-- ─── Log / idempotência ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.repasse_relay_posts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid,
  config_id          uuid REFERENCES public.repasse_relay_config(id) ON DELETE CASCADE,
  instance_id        uuid,
  source_message_id  text NOT NULL,
  source_text        text,
  modelo             text,
  preco_original     numeric,
  margem             numeric,
  preco_final        numeric,
  post_text          text,
  target_group_jid   text,
  -- posted | skipped | error
  status             text NOT NULL DEFAULT 'posted',
  skip_reason        text,
  error              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- Não reposta a mesma mensagem de origem duas vezes.
  CONSTRAINT repasse_relay_posts_uniq UNIQUE (config_id, source_message_id)
);

CREATE INDEX IF NOT EXISTS repasse_relay_posts_created_idx
  ON public.repasse_relay_posts (created_at DESC);
CREATE INDEX IF NOT EXISTS repasse_relay_posts_config_idx
  ON public.repasse_relay_posts (config_id, created_at DESC);

-- ─── updated_at ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.touch_repasse_relay_config() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;
DROP TRIGGER IF EXISTS trg_touch_repasse_relay_config ON public.repasse_relay_config;
CREATE TRIGGER trg_touch_repasse_relay_config BEFORE UPDATE ON public.repasse_relay_config
  FOR EACH ROW EXECUTE FUNCTION public.touch_repasse_relay_config();

-- ─── RLS (mesmo padrão de whatsapp_send_blocks) ──────────────────────────────
ALTER TABLE public.repasse_relay_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.repasse_relay_posts  ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.repasse_relay_config TO authenticated;
GRANT SELECT ON public.repasse_relay_posts TO authenticated;
GRANT ALL ON public.repasse_relay_config TO service_role;
GRANT ALL ON public.repasse_relay_posts  TO service_role;

-- Config: admin do tenant gerencia; superadmin vê tudo.
DROP POLICY IF EXISTS repasse_relay_config_all ON public.repasse_relay_config;
CREATE POLICY repasse_relay_config_all ON public.repasse_relay_config
  FOR ALL TO authenticated
  USING ((tenant_id = public.get_tenant_id() AND public.is_admin()) OR public.is_superadmin())
  WITH CHECK ((tenant_id = public.get_tenant_id() AND public.is_admin()) OR public.is_superadmin());

-- Log: leitura pra admin do tenant / superadmin (escrita é do service role).
DROP POLICY IF EXISTS repasse_relay_posts_select ON public.repasse_relay_posts;
CREATE POLICY repasse_relay_posts_select ON public.repasse_relay_posts
  FOR SELECT TO authenticated
  USING ((tenant_id = public.get_tenant_id() AND public.is_admin()) OR public.is_superadmin());

COMMENT ON TABLE public.repasse_relay_config IS
  'Repasse Relay: monitora um grupo de repasse e reposta os carros no grupo da comunidade (TOTEX Abaixo da Tabela), com margem embutida e no tom da loja.';
COMMENT ON TABLE public.repasse_relay_posts IS
  'Log/auditoria e idempotência do Repasse Relay (uma linha por mensagem de origem processada).';
