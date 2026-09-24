-- Vídeos de treinamento comercial privados, associados a membros do próprio tenant.
-- Upload e atribuição são feitos por um admin em /comercial/treinamento.

CREATE TABLE IF NOT EXISTS public.training_video_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT public.get_tenant_id(),
  member_id uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 120),
  description text,
  storage_path text NOT NULL UNIQUE,
  is_published boolean NOT NULL DEFAULT true,
  created_by uuid DEFAULT public.current_member_id() REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT training_video_path_matches_assignment CHECK (
    split_part(storage_path, '/', 1) = tenant_id::text
    AND split_part(storage_path, '/', 2) = member_id::text
  )
);

CREATE INDEX IF NOT EXISTS training_video_assignments_member_idx
  ON public.training_video_assignments (tenant_id, member_id, created_at DESC)
  WHERE is_published;

ALTER TABLE public.training_video_assignments ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.training_video_assignments TO authenticated;
REVOKE ALL ON public.training_video_assignments FROM anon;

DROP POLICY IF EXISTS training_video_assignments_read ON public.training_video_assignments;
CREATE POLICY training_video_assignments_read ON public.training_video_assignments
  FOR SELECT TO authenticated
  USING (
    tenant_id = public.get_tenant_id()
    AND ((member_id = public.current_member_id() AND is_published) OR public.is_admin())
  );

DROP POLICY IF EXISTS training_video_assignments_admin_insert ON public.training_video_assignments;
CREATE POLICY training_video_assignments_admin_insert ON public.training_video_assignments
  FOR INSERT TO authenticated
  WITH CHECK (
    tenant_id = public.get_tenant_id()
    AND public.is_admin()
    AND EXISTS (
      SELECT 1 FROM public.team_members tm
      WHERE tm.id = member_id AND tm.tenant_id = training_video_assignments.tenant_id AND tm.is_active
    )
  );

DROP POLICY IF EXISTS training_video_assignments_admin_update ON public.training_video_assignments;
CREATE POLICY training_video_assignments_admin_update ON public.training_video_assignments
  FOR UPDATE TO authenticated
  USING (tenant_id = public.get_tenant_id() AND public.is_admin())
  WITH CHECK (
    tenant_id = public.get_tenant_id()
    AND public.is_admin()
    AND EXISTS (
      SELECT 1 FROM public.team_members tm
      WHERE tm.id = member_id AND tm.tenant_id = training_video_assignments.tenant_id AND tm.is_active
    )
  );

DROP POLICY IF EXISTS training_video_assignments_admin_delete ON public.training_video_assignments;
CREATE POLICY training_video_assignments_admin_delete ON public.training_video_assignments
  FOR DELETE TO authenticated
  USING (tenant_id = public.get_tenant_id() AND public.is_admin());

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'commercial-training',
  'commercial-training',
  false,
  104857600,
  ARRAY['video/mp4']
)
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS commercial_training_read_assigned ON storage.objects;
CREATE POLICY commercial_training_read_assigned ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'commercial-training'
    AND (storage.foldername(name))[1] = public.get_tenant_id()::text
    AND (
      public.is_admin()
      OR (
        (storage.foldername(name))[2] = public.current_member_id()::text
        AND EXISTS (
          SELECT 1 FROM public.training_video_assignments assignment
          WHERE assignment.tenant_id = public.get_tenant_id()
            AND assignment.member_id = public.current_member_id()
            AND assignment.storage_path = storage.objects.name
            AND assignment.is_published
        )
      )
    )
  );

DROP POLICY IF EXISTS commercial_training_admin_upload ON storage.objects;
CREATE POLICY commercial_training_admin_upload ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'commercial-training'
    AND public.is_admin()
    AND (storage.foldername(name))[1] = public.get_tenant_id()::text
  );

DROP POLICY IF EXISTS commercial_training_admin_update ON storage.objects;
CREATE POLICY commercial_training_admin_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'commercial-training'
    AND public.is_admin()
    AND (storage.foldername(name))[1] = public.get_tenant_id()::text
  )
  WITH CHECK (
    bucket_id = 'commercial-training'
    AND public.is_admin()
    AND (storage.foldername(name))[1] = public.get_tenant_id()::text
  );

DROP POLICY IF EXISTS commercial_training_admin_delete ON storage.objects;
CREATE POLICY commercial_training_admin_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'commercial-training'
    AND public.is_admin()
    AND (storage.foldername(name))[1] = public.get_tenant_id()::text
  );
