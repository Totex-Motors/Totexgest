-- ============================================================================
-- VÍDEO DO CARRO (Marco, 2026-11-02): vídeo 9:16 gerado no navegador a partir das fotos da
-- página do carro (Ken Burns + preço/parcela/CTA + narração na voz do agente), salvo no bucket
-- público `vehicle-media` e publicado no TikTok/YouTube/Facebook pela Zernio (publish_media).
-- (aplicado em produção via pg_cron; aqui a versão idempotente)
-- ============================================================================
INSERT INTO storage.buckets (id, name, public) VALUES ('vehicle-media', 'vehicle-media', true) ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS vehicle_media_tenant_write ON storage.objects;
CREATE POLICY vehicle_media_tenant_write ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'vehicle-media' AND (storage.foldername(name))[1] = get_tenant_id()::text);
DROP POLICY IF EXISTS vehicle_media_tenant_update ON storage.objects;
CREATE POLICY vehicle_media_tenant_update ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'vehicle-media' AND (storage.foldername(name))[1] = get_tenant_id()::text);
DROP POLICY IF EXISTS vehicle_media_public_read ON storage.objects;
CREATE POLICY vehicle_media_public_read ON storage.objects FOR SELECT TO anon, authenticated USING (bucket_id = 'vehicle-media');

ALTER TABLE vehicle_pages ADD COLUMN IF NOT EXISTS videos jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Publicações da Zernio sem campanha (vídeo da página do carro)
ALTER TABLE social_publications ALTER COLUMN campaign_id DROP NOT NULL;
ALTER TABLE social_publications ADD COLUMN IF NOT EXISTS vehicle_page_id uuid;
ALTER TABLE social_publications ADD COLUMN IF NOT EXISTS origem text NOT NULL DEFAULT 'campanha';
