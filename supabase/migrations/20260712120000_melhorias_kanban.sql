-- ════════════════════════════════════════════════════════════════════
-- Melhorias do sistema — report com botão flutuante + kanban interno
-- (feature do template v3 do Frank, portada pro Totexgest)
--
-- Fluxo: qualquer membro do time clica no botão flutuante em qualquer
-- tela → painel "Reportar melhoria" captura contexto (rota, URL, tela,
-- browser) + prints → card nasce na coluna NOVO do kanban em
-- /gestao/melhorias. Time arrasta: NOVO → EU PEGUEI → RESOLVIDO
-- (ou NÃO VAI ROLAR).
--
-- Idempotente: pode rodar mais de uma vez sem erro.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS melhoria_reports (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL,
  reported_by      UUID REFERENCES team_members(id) ON DELETE SET NULL,
  assigned_to      UUID REFERENCES team_members(id) ON DELETE SET NULL,

  description      TEXT NOT NULL,
  category         TEXT NOT NULL DEFAULT 'outro'
                     CHECK (category IN ('agente_ia','ux_ui','bug','nova_feature','reuniao_call','performance','outro')),
  severity         TEXT NOT NULL DEFAULT 'media'
                     CHECK (severity IN ('baixa','media','alta','critica')),
  status           TEXT NOT NULL DEFAULT 'novo'
                     CHECK (status IN ('novo','em_andamento','resolvido','descartado')),

  route            TEXT,                          -- rota do CRM onde o report nasceu (ex: /comercial/pipeline)
  context          JSONB NOT NULL DEFAULT '{}',   -- { url, screen, window, browser, extra }
  prints           JSONB NOT NULL DEFAULT '[]',   -- [{ path, width, height }] no bucket melhorias-prints

  resolution_notes TEXT,                          -- "o que você fez? que arquivo mudou? como ficou?"
  resolved_at      TIMESTAMPTZ,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_melhoria_reports_tenant  ON melhoria_reports (tenant_id);
CREATE INDEX IF NOT EXISTS idx_melhoria_reports_status  ON melhoria_reports (tenant_id, status);

-- updated_at automático (função set_updated_at já existe no schema base)
DO $$ BEGIN
  CREATE TRIGGER trg_melhoria_reports_updated_at
    BEFORE UPDATE ON melhoria_reports
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- RLS: todo o time do tenant vê e opera (report é colaborativo — qualquer
-- um reporta, qualquer um pode pegar/arrastar/resolver).
ALTER TABLE melhoria_reports ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  DROP POLICY IF EXISTS melhoria_reports_tenant ON melhoria_reports;
  CREATE POLICY melhoria_reports_tenant ON melhoria_reports
    FOR ALL TO authenticated
    USING (tenant_id = get_tenant_id())
    WITH CHECK (tenant_id = get_tenant_id());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ────────────────────────────────────────────────────────────────────
-- Bucket dos prints — PRIVADO (prints da tela do CRM contêm dados de
-- clientes; acesso via signed URLs geradas pelo client, igual call-recordings)
-- ────────────────────────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'melhorias-prints',
  'melhorias-prints',
  false,
  10485760, -- 10 MB por print
  ARRAY['image/png', 'image/jpeg', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Path convencionado pelo app: <tenant_id>/<uuid>.png — policy segmenta por tenant.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'melhorias_prints_tenant_all'
  ) THEN
    CREATE POLICY melhorias_prints_tenant_all
      ON storage.objects
      FOR ALL
      TO authenticated
      USING (bucket_id = 'melhorias-prints' AND (storage.foldername(name))[1] = get_tenant_id()::text)
      WITH CHECK (bucket_id = 'melhorias-prints' AND (storage.foldername(name))[1] = get_tenant_id()::text);
  END IF;
END $$;
