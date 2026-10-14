-- ============================================================================
-- APRENDIZADO DA NINA + INTELIGÊNCIA IA AUTOMÁTICA (2026-10-14, pedido do Marco)
--
-- nina_learnings: lições propostas pelo "treinador" depois de cada ligação
-- (voice-agent-postcall → _shared/nina-learnings.ts). Status pendente → a equipe aprova
-- na tela Nina — Ligações › "O que a Nina aprendeu" → aprovada entra no prompt do agente
-- (syncNinaAgent). Humano no circuito de propósito.
--
-- Inteligência IA: generate-lead-intelligence agora SALVA em
-- leads.ai_conversation_insights.full_intelligence (+ ai_last_analysis_at) e roda sozinha:
-- depois de cada ligação da Nina e, de hora em hora, pros leads com interação nova.
--
-- Aplicar no SQL Editor (CREATE TABLE trava pelo MCP) — ou pelo cron temporário.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.nina_learnings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid,
  regra text NOT NULL,                       -- a regra curta que entra no prompt
  categoria text,                            -- interrupcao|descoberta|estoque|agendamento|encerramento|tom|dados
  chave text UNIQUE,                         -- regra normalizada (dedupe)
  evidencia text,                            -- trecho da 1ª ligação que motivou
  ultima_evidencia text,
  origem_ligacao_id uuid,                    -- call_history.id
  ultima_ligacao_id uuid,
  vezes integer NOT NULL DEFAULT 1,          -- quantas ligações sugeriram a mesma lição
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','aprovada','rejeitada')),
  aprovada_por uuid,
  aprovada_em timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nina_learnings_status_idx ON public.nina_learnings (status, aprovada_em DESC);

ALTER TABLE public.nina_learnings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS nina_learnings_admin ON public.nina_learnings;
-- A Nina é da operação central (HQ): quem vê/aprova é o admin da HQ ou superadmin.
CREATE POLICY nina_learnings_admin ON public.nina_learnings
  FOR ALL USING (public.is_platform_superadmin() OR public.get_tenant_id() = 'c13681e3-5db9-48d1-9c5c-856e6041d77f'::uuid)
  WITH CHECK (public.is_platform_superadmin() OR public.get_tenant_id() = 'c13681e3-5db9-48d1-9c5c-856e6041d77f'::uuid);

-- Aprovar/rejeitar pela tela (carimba quem e quando)
CREATE OR REPLACE FUNCTION public.nina_learning_set_status(p_id uuid, p_status text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_status NOT IN ('pendente','aprovada','rejeitada') THEN RAISE EXCEPTION 'status inválido'; END IF;
  IF NOT (public.is_platform_superadmin() OR public.get_tenant_id() = 'c13681e3-5db9-48d1-9c5c-856e6041d77f'::uuid) THEN
    RAISE EXCEPTION 'sem permissão';
  END IF;
  UPDATE nina_learnings SET status = p_status,
    aprovada_por = CASE WHEN p_status = 'aprovada' THEN auth.uid() ELSE aprovada_por END,
    aprovada_em = CASE WHEN p_status = 'aprovada' THEN now() ELSE aprovada_em END,
    updated_at = now()
  WHERE id = p_id;
  -- o sync do agente (nina-dialer, a cada 2 min) percebe pelo hash e regrava o prompt
END $$;
GRANT EXECUTE ON FUNCTION public.nina_learning_set_status(uuid, text) TO authenticated;

-- Inteligência IA de hora em hora pros leads com interação nova (lote pequeno; a função
-- generate-lead-intelligence com {batch:true} escolhe os leads e salva no card).
SELECT cron.unschedule('lead-intelligence-batch') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'lead-intelligence-batch');
SELECT cron.schedule('lead-intelligence-batch', '17 * * * *', $c$ SELECT net.http_post(
       url := (SELECT value FROM config WHERE key = 'SUPABASE_PROJECT_URL') || '/functions/v1/generate-lead-intelligence',
       headers := jsonb_build_object('Content-Type', 'application/json',
                                     'Authorization', 'Bearer ' || (SELECT value FROM config WHERE key = 'SUPABASE_ANON_KEY'),
                                     'x-voice-token', coalesce((SELECT value FROM config WHERE key = 'VOICE_AGENT_TOKEN'), '')),
       body := '{"batch":true,"limite":15}'::jsonb,
       timeout_milliseconds := 120000
     ); $c$);
