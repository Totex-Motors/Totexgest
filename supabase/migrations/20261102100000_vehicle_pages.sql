-- ============================================================================
-- PÁGINAS DE CARRO COM IA ("autoconsultor") — Marco, 2026-11-02
-- Uma landing page por carro do estoque (marketplace totexmotors.com), com conteúdo gerado
-- por IA (pontos fortes, pra quem é, equipamentos típicos, consumo, custo mensal, concorrentes,
-- FAQ, objeções), FIPE (via fipe-lookup) e parcela (simulador-cardoso, quando a loja tem).
-- Edge function `vehicle-page`: gera/publica (CRM) e serve o HTML público (/c/<slug> via
-- rewrite da Vercel). O botão de WhatsApp da página cria o lead "clique" com ref, igual ao
-- site (absorbMarketplaceClick casa com a mensagem que chega).
-- ============================================================================
CREATE TABLE IF NOT EXISTS vehicle_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  marketplace_vehicle_id text NOT NULL,
  slug text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'draft',          -- draft | published | archived
  vehicle jsonb NOT NULL DEFAULT '{}'::jsonb,     -- snapshot do marketplace (título, preço, fotos, loja…)
  content jsonb NOT NULL DEFAULT '{}'::jsonb,     -- conteúdo da IA
  fipe jsonb,                                     -- {valor_centavos, mes_referencia, codigo_fipe, diferenca_pct}
  simulacao jsonb,                                -- {prazo, parcela, entrada, outros_prazos, antecipacao}
  model text,                                     -- modelo de IA usado
  generated_at timestamptz,
  published_at timestamptz,
  views integer NOT NULL DEFAULT 0,
  clicks integer NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, marketplace_vehicle_id)
);
CREATE INDEX IF NOT EXISTS vehicle_pages_tenant_idx ON vehicle_pages (tenant_id, updated_at DESC);
ALTER TABLE vehicle_pages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vehicle_pages_read ON vehicle_pages;
CREATE POLICY vehicle_pages_read ON vehicle_pages FOR SELECT USING (tenant_id = get_tenant_id());
COMMENT ON TABLE vehicle_pages IS 'Landing page por carro do estoque com conteúdo de IA. Escrita só pela edge function vehicle-page (service role).';

-- Contadores sem RLS (a página pública incrementa via service role)
CREATE OR REPLACE FUNCTION vehicle_page_hit(p_slug text, p_kind text)
RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE vehicle_pages
     SET views = views + (CASE WHEN p_kind = 'view' THEN 1 ELSE 0 END),
         clicks = clicks + (CASE WHEN p_kind = 'click' THEN 1 ELSE 0 END)
   WHERE slug = p_slug;
$$;
REVOKE ALL ON FUNCTION vehicle_page_hit(text, text) FROM public, anon, authenticated;
