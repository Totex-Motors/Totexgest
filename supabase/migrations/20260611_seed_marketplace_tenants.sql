-- SEED: cria as 7 lojas do marketplace como tenants no CRM (idempotente).
-- NÃO reaponta o roteamento de leads (marketplace/credere continuam no tenant de
-- teste por ora). Credere = true só nas lojas clientes do módulo pago.
--
-- OBS: tenants.external_dealership_id é UUID (uso do OS). Os IDs do marketplace são
-- cuids (texto), então guardamos em metadata.marketplace_dealership_id.

WITH lojas(dealership_id, nome, slug, credere) AS (
  VALUES
    ('cmolwv3l105la143rmfkwzs4g', 'Cardoso Veículos',  'cardoso-veiculos',  true),
    ('cmolx19hg06w7143rbpsp2lkg', 'First Line',         'first-line',        false),
    ('cmpx4r4n5012nbfmo8al0ch10', 'Julio Multimarcas',  'julio-multimarcas', true),
    ('cmpmtgnmf0000yvpwo5tnt948', 'PG Motors',          'pg-motors',         true),
    ('cmolwysls06w6143rkm95h82a', 'Quest Multimarcas',  'quest-multimarcas', true),
    ('cmpx4o29n0000bfmo2v57pkrs', 'Soulcar Motors',     'soulcar-motors',    false),
    ('cmpznehrg1xdrbfmoqj76qqze', 'TOTEXMOTORS',        'totexmotors-loja',  true)
)
INSERT INTO public.tenants (name, slug, is_active, external_source, enabled_modules, metadata)
SELECT
  l.nome,
  l.slug || '-' || right(l.dealership_id, 5),
  true,
  'marketplace',
  jsonb_build_object('comercial', true, 'gestao', true, 'marketplace', true, 'credere', l.credere),
  jsonb_build_object('marketplace_dealership_id', l.dealership_id)
FROM lojas l
WHERE NOT EXISTS (
  SELECT 1 FROM public.tenants t
   WHERE t.metadata->>'marketplace_dealership_id' = l.dealership_id
);
