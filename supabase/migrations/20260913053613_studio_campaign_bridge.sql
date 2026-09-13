ALTER TABLE public.instagram_comment_campaigns
  ADD COLUMN IF NOT EXISTS studio_payload jsonb;
-- Separate from stats, which the Instagram dispatcher periodically replaces.
-- Existing tenant RLS and grants also cover this nullable column.
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='instagram_studio_activation' AND conrelid='public.instagram_comment_campaigns'::regclass) THEN
  ALTER TABLE public.instagram_comment_campaigns ADD CONSTRAINT instagram_studio_activation CHECK (
   studio_payload IS NULL OR status <> 'active' OR (
    post_id ~ '^[0-9]+$' AND coalesce(studio_payload #>> '{studio,state}', '') = 'ready'
    AND (reply_mode <> 'agent' OR coalesce(agent_slug,'') <> '')
   )
  );
 END IF;
END $$;
