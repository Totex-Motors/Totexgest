-- Mapeamento Credere → tenant da PG Motors.
-- credere_store_id: 20132 | marketplace_dealership_id: cmpmtgnmf0000yvpwo5tnt948

INSERT INTO public.credere_store_mappings (credere_store_id, store_name, tenant_id)
SELECT
  '20132',
  'PG Motors',
  t.id
FROM public.tenants t
WHERE t.metadata->>'marketplace_dealership_id' = 'cmpmtgnmf0000yvpwo5tnt948'
ON CONFLICT (credere_store_id) DO UPDATE
  SET store_name = EXCLUDED.store_name,
      tenant_id  = EXCLUDED.tenant_id,
      active     = true;
