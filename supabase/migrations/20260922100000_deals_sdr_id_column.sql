-- Fix: deals.sdr_id column was missing.
--
-- The column deals.sdr_id is referenced across the whole app (cockpit, focus queue,
-- pipeline, SDR/closer transfers, useSalesDeals PostgREST embeds via deals_sdr_id_fkey,
-- and the commission calculation). The base schema never created it on `deals` (only on
-- `sdr_closer_transfers`), and 001_post_baseline_fixes tried to add ONLY the FK wrapped in
-- `EXCEPTION WHEN OTHERS THEN NULL`, so it failed silently. As a result every query that
-- embedded `sdr:team_members!deals_sdr_id_fkey(...)` returned HTTP 400, which made
-- useContactDeals() throw — so the "Lucro & Comissao" card never rendered on any lead and
-- lead stats showed "0 Vendas" even when a deal existed.

ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS sdr_id uuid;

DO $$ BEGIN
  ALTER TABLE public.deals
    ADD CONSTRAINT deals_sdr_id_fkey
    FOREIGN KEY (sdr_id) REFERENCES public.team_members(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_deals_sdr_id ON public.deals(sdr_id);

NOTIFY pgrst, 'reload schema';
