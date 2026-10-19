-- ============================================================================
-- PREMISSA DE GANHOS (Marco, 2026-10-19): calculadora "quanto o vendedor leva no mês"
-- = fixo + comissão por faixa do plano. O fixo e as premissas (carros/mês, lucro médio,
-- % consignado, meta) ficam no próprio plano de comissão.
-- UI: botão "Premissa de ganhos" em /comercial/comissoes e no card Lucro & Comissão.
-- ============================================================================
ALTER TABLE commission_plans ADD COLUMN IF NOT EXISTS fixed_salary numeric NOT NULL DEFAULT 0;
ALTER TABLE commission_plans ADD COLUMN IF NOT EXISTS premissas jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN commission_plans.fixed_salary IS 'Salário fixo mensal do vendedor (R$), usado na premissa de ganhos.';
COMMENT ON COLUMN commission_plans.premissas IS 'Premissas salvas da calculadora: {carros, lucro_medio, pct_consignado, meta}.';

-- Glauter: fixo de R$ 2.800 (combinado com o Marco)
UPDATE commission_plans SET fixed_salary = 2800
WHERE id = '475167fe-45e9-4916-bec9-c6b00d77983b' AND fixed_salary = 0;
