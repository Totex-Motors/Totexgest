-- Colunas de tarefa recorrente + crucial que o front já usa mas nunca foram
-- criadas no banco (erro "Could not find the 'is_recurring' column ...").
ALTER TABLE public.company_activities
  ADD COLUMN IF NOT EXISTS is_recurring boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS recurrence_interval_days integer,
  ADD COLUMN IF NOT EXISTS recurrence_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS critical_last_reminded_at timestamptz;
