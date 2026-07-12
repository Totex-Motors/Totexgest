-- Análise do Claude nos cards de melhoria (rotina 3x/dia).
-- A rotina lê os cards em "Eu peguei" (em_andamento) ainda não analisados,
-- investiga no código, grava a análise aqui e manda pro Marco autorizar.
-- ai_analyzed_at marca o card como processado (evita re-análise).

ALTER TABLE melhoria_reports ADD COLUMN IF NOT EXISTS ai_analysis TEXT;
ALTER TABLE melhoria_reports ADD COLUMN IF NOT EXISTS ai_analyzed_at TIMESTAMPTZ;
