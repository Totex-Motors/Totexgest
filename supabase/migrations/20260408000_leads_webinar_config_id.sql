DO $$ BEGIN
  ALTER TABLE leads
    ADD COLUMN IF NOT EXISTS webinar_config_id UUID;

  CREATE INDEX IF NOT EXISTS idx_leads_webinar_config
    ON leads(webinar_config_id)
    WHERE webinar_config_id IS NOT NULL;
EXCEPTION WHEN OTHERS THEN NULL; END $$;
