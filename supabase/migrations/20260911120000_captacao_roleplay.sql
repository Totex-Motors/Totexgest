-- ============================================================================
-- Captação — Treino: ROLEPLAY com IA + progresso de treinamento (PRD F8).
--
--   capture_roleplay_scenarios — cenários (globais tenant_id NULL + do tenant)
--   capture_roleplay_sessions  — conversa promotora × "cliente" IA + avaliação
--   capture_training_progress  — aulas concluídas (sai do localStorage)
--   RPCs: capture_training_mark_lesson, capture_training_summary
-- A conversa e a avaliação rodam na edge function `capture-roleplay`.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.capture_roleplay_scenarios (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid,                                   -- NULL = cenário padrão pra todos
  key           text NOT NULL,
  title         text NOT NULL,
  emoji         text NOT NULL DEFAULT '🧑',
  difficulty    text NOT NULL DEFAULT 'medio' CHECK (difficulty IN ('facil', 'medio', 'dificil')),
  summary       text NOT NULL,                          -- o que a promotora vê antes de começar
  objective     text NOT NULL,                          -- o que precisa conseguir
  persona       text NOT NULL,                          -- instruções do "cliente" (system prompt)
  opening_line  text NOT NULL,                          -- primeira fala do cliente
  hidden_facts  jsonb NOT NULL DEFAULT '{}'::jsonb,     -- carro, prazo, motivo… que o cliente só revela se perguntado
  max_turns     integer NOT NULL DEFAULT 8,
  is_active     boolean NOT NULL DEFAULT true,
  position      integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);
GRANT SELECT ON public.capture_roleplay_scenarios TO authenticated;
GRANT ALL ON public.capture_roleplay_scenarios TO service_role;
ALTER TABLE public.capture_roleplay_scenarios ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS capture_roleplay_scenarios_select ON public.capture_roleplay_scenarios;
CREATE POLICY capture_roleplay_scenarios_select ON public.capture_roleplay_scenarios
  FOR SELECT TO authenticated
  USING (is_active AND (tenant_id IS NULL OR tenant_id = public.get_tenant_id() OR public.is_superadmin()));
DROP POLICY IF EXISTS capture_roleplay_scenarios_write ON public.capture_roleplay_scenarios;
CREATE POLICY capture_roleplay_scenarios_write ON public.capture_roleplay_scenarios
  FOR ALL TO authenticated
  USING (tenant_id = public.get_tenant_id() AND public.is_admin())
  WITH CHECK (tenant_id = public.get_tenant_id() AND public.is_admin());

CREATE TABLE IF NOT EXISTS public.capture_roleplay_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  member_id     uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  scenario_id   uuid REFERENCES public.capture_roleplay_scenarios(id) ON DELETE SET NULL,
  scenario_key  text,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended', 'evaluated', 'abandoned')),
  messages      jsonb NOT NULL DEFAULT '[]'::jsonb,     -- [{role:'cliente'|'promotora', text, at}]
  turns         integer NOT NULL DEFAULT 0,
  score         integer CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  evaluation    jsonb,                                  -- {criteria:[…], strengths:[…], improvements:[…], best_line, next_drill}
  started_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS capture_roleplay_sessions_member_idx ON public.capture_roleplay_sessions(member_id, started_at DESC);
GRANT SELECT ON public.capture_roleplay_sessions TO authenticated;
GRANT ALL ON public.capture_roleplay_sessions TO service_role;
ALTER TABLE public.capture_roleplay_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS capture_roleplay_sessions_select ON public.capture_roleplay_sessions;
CREATE POLICY capture_roleplay_sessions_select ON public.capture_roleplay_sessions
  FOR SELECT TO authenticated
  USING ((tenant_id = public.get_tenant_id() OR public.is_superadmin())
         AND (NOT public.is_promotora() OR member_id = public.current_member_id()));
-- escrita só pela edge function (service role)

CREATE TABLE IF NOT EXISTS public.capture_training_progress (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  member_id     uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  lesson_id     text NOT NULL,
  score         integer,
  completed_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, lesson_id)
);
GRANT SELECT ON public.capture_training_progress TO authenticated;
GRANT ALL ON public.capture_training_progress TO service_role;
ALTER TABLE public.capture_training_progress ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS capture_training_progress_select ON public.capture_training_progress;
CREATE POLICY capture_training_progress_select ON public.capture_training_progress
  FOR SELECT TO authenticated
  USING ((tenant_id = public.get_tenant_id() OR public.is_superadmin())
         AND (NOT public.is_promotora() OR member_id = public.current_member_id()));

-- Promotora marca/desmarca uma aula (só o próprio progresso)
CREATE OR REPLACE FUNCTION public.capture_training_mark_lesson(p_lesson_id text, p_done boolean DEFAULT true, p_score integer DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_member uuid := public.current_member_id(); v_tenant uuid;
BEGIN
  IF v_member IS NULL THEN RAISE EXCEPTION 'Sem membro ativo'; END IF;
  SELECT tenant_id INTO v_tenant FROM team_members WHERE id = v_member;
  IF p_done THEN
    INSERT INTO capture_training_progress (tenant_id, member_id, lesson_id, score)
    VALUES (v_tenant, v_member, p_lesson_id, p_score)
    ON CONFLICT (member_id, lesson_id) DO UPDATE SET score = coalesce(EXCLUDED.score, capture_training_progress.score), completed_at = now();
  ELSE
    DELETE FROM capture_training_progress WHERE member_id = v_member AND lesson_id = p_lesson_id;
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION public.capture_training_mark_lesson(text, boolean, integer) TO authenticated;

-- Resumo do treino (Perfil / gestor)
CREATE OR REPLACE FUNCTION public.capture_training_summary(p_member_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_member uuid := public.current_member_id(); v_target uuid;
BEGIN
  IF v_member IS NULL THEN RETURN '{}'::jsonb; END IF;
  v_target := CASE WHEN p_member_id IS NOT NULL AND (public.is_admin() OR public.is_superadmin()) THEN p_member_id ELSE v_member END;
  RETURN jsonb_build_object(
    'lessons_done', (SELECT coalesce(jsonb_agg(lesson_id), '[]'::jsonb) FROM capture_training_progress WHERE member_id = v_target),
    'roleplays', (SELECT count(*) FROM capture_roleplay_sessions WHERE member_id = v_target AND status = 'evaluated'),
    'avg_score', (SELECT round(avg(score)) FROM capture_roleplay_sessions WHERE member_id = v_target AND status = 'evaluated'),
    'best_score', (SELECT max(score) FROM capture_roleplay_sessions WHERE member_id = v_target AND status = 'evaluated'),
    'last_sessions', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'scenario_key', s.scenario_key, 'score', s.score, 'ended_at', s.ended_at,
                        'title', sc.title, 'emoji', sc.emoji) ORDER BY s.started_at DESC), '[]'::jsonb)
                      FROM (SELECT * FROM capture_roleplay_sessions WHERE member_id = v_target AND status = 'evaluated' ORDER BY started_at DESC LIMIT 10) s
                      LEFT JOIN capture_roleplay_scenarios sc ON sc.id = s.scenario_id)
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.capture_training_summary(uuid) TO authenticated;

-- ─── Cenários padrão (captação de proprietário no shopping) ────────────────
INSERT INTO public.capture_roleplay_scenarios (tenant_id, key, title, emoji, difficulty, summary, objective, persona, opening_line, hidden_facts, max_turns, position) VALUES
(NULL, 'apressado', 'Cliente com pressa', '🏃', 'facil',
 'Ele está passando no corredor, com pressa, e dá 30 segundos de atenção.',
 'Descobrir o carro e o prazo, pegar o WhatsApp e a autorização de contato em poucas frases.',
 'Você é Rodrigo, 38 anos, saindo apressado do shopping com sacolas. Responde curto e impaciente ("fala rápido", "tô atrasado"). Se a promotora for direta, simpática e prometer que leva 30 segundos, você colabora. Se ela enrolar ou fizer discurso longo, você diz que precisa ir. Você TEM um carro que pensa em trocar, mas só conta se perguntarem.',
 'Oi… tô meio atrasado, o que é?',
 '{"carro":"Honda HR-V EXL 2019","km":"58 mil","prazo":"uns 2 meses, quero trocar por um SUV maior","proprietario":true,"telefone":"11 9 8877-6655"}', 6, 1),
(NULL, 'desconfiado', 'Cliente desconfiado', '🤨', 'medio',
 'Já ouviu história de golpe e acha que loja sempre paga pouco.',
 'Gerar confiança (Totex, avaliação gratuita, sem compromisso) e conseguir contato + consentimento.',
 'Você é Marcia, 52 anos, desconfiada. Diz coisas como "loja sempre quer pagar mixaria", "conheço gente que caiu em golpe". Você só amolece se a promotora explicar que a avaliação é gratuita, sem compromisso, que a Totex é loja física ali no shopping e que quem decide é você. Nunca dê o telefone antes de sentir segurança. Fale de forma natural, 1–2 frases por vez.',
 'Hum… vocês são de loja? Porque loja só quer pagar mixaria no carro da gente, né.',
 '{"carro":"Toyota Corolla XEi 2020","km":"41 mil","prazo":"sem pressa, mas se o valor for bom vendo","proprietario":true,"motivo":"filho vai pra faculdade, quer diminuir o gasto"}', 8, 2),
(NULL, 'quer_preco', 'Quer o preço na hora', '💰', 'medio',
 'Só quer saber "quanto vocês pagam" e insiste num número ali mesmo.',
 'Não chutar valor: explicar que a avaliação é feita pelo especialista e conduzir pro contato.',
 'Você é Fábio, 45 anos, objetivo. Sua única pergunta é "quanto vocês dão no meu carro?" e você repete isso de formas diferentes. Se a promotora chutar um número, você reclama que é pouco e vai embora. Se ela explicar com segurança que quem avalia é o especialista, que é gratuito e rápido pelo WhatsApp, você aceita passar o contato. Respostas curtas.',
 'Beleza, mas quanto vocês pagam num Jeep Compass 2021? Me fala um número.',
 '{"carro":"Jeep Compass Limited 2021","km":"33 mil","prazo":"agora, já tá anunciado na OLX","proprietario":true,"expectativa":"R$ 135 mil"}', 7, 3),
(NULL, 'nao_agora', '"Não quero vender agora"', '🙅', 'facil',
 'Simpático, mas diz que não está pensando em vender.',
 'Plantar a semente: registrar o contato pra quando fizer sentido, sem pressão.',
 'Você é Juliana, 31 anos, educada. Sua primeira reação é "não tô pensando em vender agora". Se a promotora respeitar e oferecer só deixar registrado pra saber quanto vale / avisar de oportunidade, você acha simpático e aceita passar o WhatsApp. Se ela insistir demais, você se fecha. Você pensa em trocar no fim do ano, mas só conta se perguntarem sobre prazo.',
 'Ah, obrigada, mas não tô pensando em vender agora não.',
 '{"carro":"Hyundai HB20 1.0 2018","km":"70 mil","prazo":"talvez no fim do ano","proprietario":true}', 6, 4),
(NULL, 'por_conta', '"Vou vender por conta própria"', '📱', 'dificil',
 'Acha que anunciar sozinho rende mais e não vê valor no serviço.',
 'Mostrar o valor da intermediação (anúncio, curiosos, test drive, documentação) e conseguir a avaliação.',
 'Você é Carlos, 40 anos, confiante. Já vendeu carro sozinho antes e acha que loja "come" o lucro. Você rebate com "eu mesmo anuncio", "não preciso de intermediário". Só muda de ideia se a promotora mostrar de forma concreta o trabalho que a Totex tira das costas dele (curiosos, test drive com estranhos, golpe, transferência) e propuser algo sem risco: avaliação gratuita pra comparar com a proposta que ele tem. Fale como gente, 1–3 frases.',
 'Valeu, mas eu mesmo anuncio. Vender por loja é perder dinheiro.',
 '{"carro":"Chevrolet Onix Plus Premier 2022","km":"25 mil","prazo":"esse mês","proprietario":true,"expectativa":"R$ 92 mil, já tem uma proposta de 85"}', 8, 5)
ON CONFLICT (tenant_id, key) DO NOTHING;
