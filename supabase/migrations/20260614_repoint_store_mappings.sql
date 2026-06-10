-- Reaponta o roteamento de leads das lojas para os tenants per-loja recém-criados.
-- (Seguro porque o super-admin agora lê cross-tenant — migration 20260613.)
-- Afeta apenas o ROTEAMENTO FUTURO; leads já existentes não são movidos.

-- Marketplace: marketplace_store_id (cuid) casa com metadata.marketplace_dealership_id do tenant.
UPDATE public.marketplace_store_mappings m
   SET tenant_id = t.id,
       store_name = t.name
  FROM public.tenants t
 WHERE t.metadata->>'marketplace_dealership_id' = m.marketplace_store_id;

-- Credere: casa pelo nome da loja (credere_store_mappings.store_name = tenants.name).
-- Lojas sem correspondência permanecem inalteradas.
UPDATE public.credere_store_mappings cm
   SET tenant_id = t.id
  FROM public.tenants t
 WHERE t.external_source = 'marketplace'
   AND lower(t.name) = lower(cm.store_name);
