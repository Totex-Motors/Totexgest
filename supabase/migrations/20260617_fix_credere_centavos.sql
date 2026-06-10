-- =============================================================================
-- FIX: valores monetários da Credere estavam sendo armazenados em centavos.
-- Divide por 100 todos os campos monetários dos leads com source='credere'.
-- Seguro rodar novamente: só afeta registros onde o valor já está em centavos
-- (heurística: assets_value > 100000, ou seja, > R$ 100.000 em reais — qualquer
-- valor acima disso em "reais" seria um carro de luxo extremo; na prática todos
-- os leads Credere atuais têm o valor em centavos e precisam da correção).
-- =============================================================================

UPDATE public.leads
SET metadata = jsonb_set(
    metadata,
    '{vehicle,assets_value}',
    to_jsonb(round(((metadata -> 'vehicle' ->> 'assets_value')::numeric / 100), 2))
)
WHERE source = 'credere'
  AND metadata -> 'vehicle' ->> 'assets_value' IS NOT NULL
  AND (metadata -> 'vehicle' ->> 'assets_value')::numeric > 100000;

UPDATE public.leads
SET metadata = jsonb_set(
    jsonb_set(
        metadata,
        '{financing,down_payment}',
        to_jsonb(round(((metadata -> 'financing' ->> 'down_payment')::numeric / 100), 2))
    ),
    '{financing,financed_amount}',
    to_jsonb(round(((metadata -> 'financing' ->> 'financed_amount')::numeric / 100), 2))
)
WHERE source = 'credere'
  AND metadata -> 'financing' IS NOT NULL
  AND metadata -> 'financing' != 'null'::jsonb
  AND (metadata -> 'financing' ->> 'financed_amount')::numeric > 100000;
