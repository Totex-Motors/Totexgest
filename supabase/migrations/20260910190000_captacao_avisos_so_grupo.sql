-- Captação — política anti-banimento: a instância NÃO oficial (UAZAPI) só
-- manda mensagem em GRUPO. O especialista é marcado com @menção no grupo da
-- operação em vez de receber no privado. (Validado pelo Marco: a Meta não bane
-- quando a não oficial fala só em grupos que nós determinamos.)
ALTER TABLE public.capture_handoff_config ALTER COLUMN notify_specialist SET DEFAULT false;
UPDATE public.capture_handoff_config SET notify_specialist = false WHERE notify_specialist;
