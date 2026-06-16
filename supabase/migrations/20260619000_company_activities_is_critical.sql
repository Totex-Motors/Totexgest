-- Adiciona coluna is_critical em company_activities.
-- O frontend (DailyActivityBanner, TaskReminderOverlay, useTasks, CreateTaskModal)
-- e a edge function process-task-reminders ja referenciam essa coluna, mas ela
-- nunca foi criada no schema base -> erro 42703 "column company_activities.is_critical does not exist".

ALTER TABLE public.company_activities
  ADD COLUMN IF NOT EXISTS is_critical boolean NOT NULL DEFAULT false;

-- Index parcial pra acelerar os filtros .eq("is_critical", true) usados nos lembretes.
CREATE INDEX IF NOT EXISTS idx_company_activities_is_critical
  ON public.company_activities (is_critical)
  WHERE is_critical = true;
