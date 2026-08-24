-- Mais colunas que o frontend lê mas que faltavam em leads (drift de schema):
-- acao_de_hoje  → badge "Ação de hoje" no board (PipelineKanban) e na lista de leads.
-- instagram_profile_id → foto/perfil do Instagram no card e no calculate-lead-score.
-- Sem elas, o select do board precisava omitir os campos e os badges nunca renderizavam.
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS acao_de_hoje text;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS instagram_profile_id uuid;
NOTIFY pgrst, 'reload schema';
