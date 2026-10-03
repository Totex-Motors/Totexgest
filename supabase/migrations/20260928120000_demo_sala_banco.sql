-- ============================================================================
-- SALA DE DEMO — Fase 1: banco (2026-09-28)
-- Base do módulo de demo personalizada: o lead recebe /demo/:token, assiste a
-- apresentação gravada (câmera+tela) com saudação por voz, e o CRM registra
-- os eventos. Aqui só o BANCO: 2 tabelas (multi-tenant, RLS por loja) + bucket
-- privado do áudio. Etapas de funil e edge functions vêm nas fases seguintes.
--
-- Acesso público (o visitante sem login) é servido pelas edge functions por
-- TOKEN (service_role) — NÃO por RLS anônima. As policies abaixo dão acesso só
-- ao gestor/admin da própria loja (para o CRM listar/gerenciar as demos dela).
-- ============================================================================

-- ─── 1) Salas de demo ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.demo_rooms (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  -- token forte (256 bits, hex) — a edge fn pode sobrescrever; default é rede de segurança.
  token                text NOT NULL UNIQUE
                         DEFAULT replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-',''),
  lead_id              uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  deal_id              uuid,                              -- oportunidade vinculada (opcional)
  -- vídeos (chaves no storage do projeto / bucket de vídeos) + tempos reais
  video_camera_key     text,
  video_screen_key     text,
  camera_duration_s    integer,
  screen_share_start_s integer,
  booking_slide_at_s   integer,
  -- saudação por voz (ElevenLabs) — caminho no bucket privado demo-greetings
  greeting_text        text,
  greeting_audio_path  text,
  -- call-to-action (agenda)
  cta_url              text,
  cta_label            text,
  status               text NOT NULL DEFAULT 'created'
                         CHECK (status IN ('created','sent','opened','watching','completed','ended')),
  run_version          integer NOT NULL DEFAULT 1,        -- reset administrativo incrementa (dedupe de eventos por execução)
  started_at           timestamptz,
  ended_at             timestamptz,
  expires_at           timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  created_by           uuid,                              -- team_member que criou
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS demo_rooms_tenant_lead_idx ON public.demo_rooms(tenant_id, lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS demo_rooms_expires_idx ON public.demo_rooms(expires_at);

ALTER TABLE public.demo_rooms ENABLE ROW LEVEL SECURITY;
-- Gestor/admin da loja vê as demos do próprio tenant; superadmin vê todas.
-- (o visitante público NÃO passa por aqui — vem por token via edge fn/service_role)
DROP POLICY IF EXISTS demo_rooms_select ON public.demo_rooms;
CREATE POLICY demo_rooms_select ON public.demo_rooms FOR SELECT TO authenticated
  USING (public.is_superadmin() OR tenant_id = public.get_tenant_id());
GRANT SELECT ON public.demo_rooms TO authenticated;
GRANT ALL ON public.demo_rooms TO service_role;

-- ─── 2) Eventos da sala (marcos + interações) ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.demo_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  room_id         uuid NOT NULL REFERENCES public.demo_rooms(id) ON DELETE CASCADE,
  run_version     integer NOT NULL DEFAULT 1,
  event_type      text NOT NULL CHECK (event_type IN (
                    'session_opened','joined','progress',
                    'milestone_25','milestone_50','milestone_75','completed','ended',
                    'cta_click','exit_attempted','exit_confirmed','exit_cancelled',
                    'booking_slide_shown','booking_slide_reopened','booking_abandoned','booking_confirmed')),
  watched_seconds integer,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS demo_events_room_idx ON public.demo_events(room_id, created_at DESC);
-- idempotência dos MARCOS: um marco só conta uma vez por execução da sala.
CREATE UNIQUE INDEX IF NOT EXISTS demo_events_milestone_unique
  ON public.demo_events(room_id, run_version, event_type)
  WHERE event_type IN ('milestone_25','milestone_50','milestone_75','completed');

ALTER TABLE public.demo_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS demo_events_select ON public.demo_events;
CREATE POLICY demo_events_select ON public.demo_events FOR SELECT TO authenticated
  USING (public.is_superadmin() OR tenant_id = public.get_tenant_id());
GRANT SELECT ON public.demo_events TO authenticated;
GRANT ALL ON public.demo_events TO service_role;

-- ─── 3) Bucket privado do áudio da saudação ──────────────────────────────────
-- Privado; servido só por URL assinada/proxy por token (edge fn). Path por loja:
-- demo-greetings/<tenant_id>/<room_id>.mp3
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('demo-greetings','demo-greetings', false, 10485760, -- 10 MB
        ARRAY['audio/mpeg','audio/mp4','audio/ogg','audio/wav'])
ON CONFLICT (id) DO UPDATE SET
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Acesso autenticado restrito à PASTA DA PRÓPRIA LOJA (primeira pasta = tenant_id).
-- A geração/serviço do áudio roda via service_role (bypassa RLS); esta policy é
-- só a rede de segurança pra acesso direto autenticado.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='storage' AND tablename='objects' AND policyname='demo_greetings_tenant_all'
  ) THEN
    CREATE POLICY demo_greetings_tenant_all
      ON storage.objects FOR ALL TO authenticated
      USING (bucket_id='demo-greetings'
             AND (public.is_superadmin() OR (storage.foldername(name))[1] = public.get_tenant_id()::text))
      WITH CHECK (bucket_id='demo-greetings'
             AND (public.is_superadmin() OR (storage.foldername(name))[1] = public.get_tenant_id()::text));
  END IF;
END $$;

-- NOTA (fase seguinte): as 2 etapas de funil "Demo enviada"/"Demo assistida" NÃO
-- entram aqui — dependem dos UUIDs reais de pipeline/etapa por tenant. Migration
-- separada, escrita após ler public.sales_pipeline_stages do banco (ver docs/SALA-DEMO-ADAPTACAO.md §6).
