-- Bucket `email-assets` para imagens do editor de email marketing (MailyEditor)
-- e anexos (EmailAttachmentUploader). Publico: as URLs vao dentro dos emails
-- e precisam abrir no cliente de email do destinatario.
-- Idempotente: pode rodar varias vezes sem erro.

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES (
  'email-assets',
  'email-assets',
  true,
  26214400 -- 25 MB
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit;

-- Upload/gestao: qualquer usuario autenticado. Leitura publica ja vem do
-- bucket ser public (URLs publicas nao passam por policy).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'email_assets_authenticated_all'
  ) THEN
    CREATE POLICY email_assets_authenticated_all
      ON storage.objects
      FOR ALL
      TO authenticated
      USING (bucket_id = 'email-assets')
      WITH CHECK (bucket_id = 'email-assets');
  END IF;
END $$;
