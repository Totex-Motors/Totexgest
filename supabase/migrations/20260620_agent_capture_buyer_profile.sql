-- ============================================================================
-- Plataforma de Agentes v2 — Skill automotiva "Capturar perfil de compra"
--
-- A qualificação da v2 (agent_qualify_lead) é B2B: grava faturamento e faz
-- bant_budget = (faturamento >= 100k). Para revenda de veículos isso não serve.
--
-- Esta migration ADICIONA (não altera a função B2B) uma skill dedicada que o
-- agente usa para gravar o PERFIL DE COMPRA do lead em leads.metadata — os
-- mesmos campos que a BuyerProfileCard lê na tela. Mapeia os sinais pro BANT
-- interno pra qualificação seguir alimentando score/funil.
--
-- Ativação (feita pela equipe): atribuir a skill "Capturar perfil de compra"
-- ao agente (Configurações > Agentes > Habilidades) e citar no prompt do agente.
-- ============================================================================

-- 1) Função SQL: merge dos campos automotivos em leads.metadata + BANT
CREATE OR REPLACE FUNCTION public.agent_capture_buyer_profile(
  p_lead_id uuid,
  p_agent_id uuid DEFAULT NULL::uuid,
  p_veiculo_interesse text DEFAULT NULL::text,
  p_faixa_preco_min numeric DEFAULT NULL::numeric,
  p_faixa_preco_max numeric DEFAULT NULL::numeric,
  p_precisa_financiar boolean DEFAULT NULL::boolean,
  p_entrada_disponivel numeric DEFAULT NULL::numeric,
  p_tem_veiculo_troca boolean DEFAULT NULL::boolean,
  p_forma_pagamento text DEFAULT NULL::text,
  p_urgencia text DEFAULT NULL::text,
  p_session_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_patch jsonb;
  v_budget boolean;
  v_need boolean;
  v_timeline boolean;
  v_score int;
  v_bant int;
BEGIN
  -- Só as chaves informadas (strip_nulls remove o que veio NULL) → merge preserva o resto
  v_patch := jsonb_strip_nulls(jsonb_build_object(
    'veiculo_interesse_texto', p_veiculo_interesse,
    'faixa_preco_min',         p_faixa_preco_min,
    'faixa_preco_max',         p_faixa_preco_max,
    'precisa_financiar',       p_precisa_financiar,
    'entrada_disponivel',      p_entrada_disponivel,
    'tem_veiculo_troca',       p_tem_veiculo_troca,
    'forma_pagamento',         p_forma_pagamento,
    'urgencia',                p_urgencia
  ));

  -- Sinais automotivos → BANT (acumulativo: nunca "desliga" o que já era true)
  v_budget   := (p_faixa_preco_min IS NOT NULL OR p_faixa_preco_max IS NOT NULL
                 OR p_entrada_disponivel IS NOT NULL OR p_forma_pagamento IS NOT NULL);
  v_need     := (p_veiculo_interesse IS NOT NULL);
  v_timeline := (p_urgencia IS NOT NULL);

  UPDATE leads SET
    metadata       = COALESCE(metadata, '{}'::jsonb) || v_patch,
    bant_budget    = COALESCE(bant_budget, false)   OR v_budget,
    bant_need      = COALESCE(bant_need, false)      OR v_need,
    bant_timeline  = COALESCE(bant_timeline, false)  OR v_timeline,
    updated_at     = now()
  WHERE id = p_lead_id
  RETURNING
    (CASE WHEN bant_budget THEN 1 ELSE 0 END)
    + (CASE WHEN bant_authority THEN 1 ELSE 0 END)
    + (CASE WHEN bant_need THEN 1 ELSE 0 END)
    + (CASE WHEN bant_timeline THEN 1 ELSE 0 END)
  INTO v_bant;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'lead_not_found', 'lead_id', p_lead_id);
  END IF;

  -- Score simples proporcional ao BANT preenchido (25 por item)
  v_score := LEAST(100, COALESCE(v_bant, 0) * 25);
  UPDATE leads SET sales_score = v_score WHERE id = p_lead_id;

  RETURN jsonb_build_object(
    'ok', true,
    'lead_id', p_lead_id,
    'saved', v_patch,
    'bant_count', v_bant,
    'score', v_score
  );
END $function$;

-- 2) Catálogo de skills v2 — expõe a skill pro agente poder usar
INSERT INTO public.agents_skill_catalog (
  slug, display_name, description, category, emoji,
  parameters_schema, action_type, action_config,
  default_usage_mode, is_recommended, provider
) VALUES (
  'capturar_perfil_compra',
  'Capturar perfil de compra (automotivo)',
  'Grava o perfil de compra do lead (veículo, orçamento, financiamento, entrada, troca, forma de pagamento, urgência) em leads.metadata. Use assim que o cliente revelar qualquer um desses dados.',
  'sales',
  '🚗',
  '{"type":"object","properties":{
      "veiculo_interesse":{"type":"string","description":"Qual veículo o cliente quer (marca/modelo/versão/ano, texto livre)"},
      "faixa_preco_min":{"type":"number","description":"Orçamento mínimo em reais (só número)"},
      "faixa_preco_max":{"type":"number","description":"Orçamento máximo em reais (só número)"},
      "precisa_financiar":{"type":"boolean","description":"true se precisa/quer financiar; false se paga à vista"},
      "entrada_disponivel":{"type":"number","description":"Entrada disponível em reais (só número)"},
      "tem_veiculo_troca":{"type":"boolean","description":"true se tem veículo para dar na troca"},
      "forma_pagamento":{"type":"string","enum":["a_vista","financiamento","consorcio","misto"],"description":"Forma de pagamento pretendida"},
      "urgencia":{"type":"string","enum":["imediata","ate_30_dias","ate_90_dias","pesquisando"],"description":"Urgência de compra"}
  }}'::jsonb,
  'sql',
  '{"function":"agent_capture_buyer_profile","params_map":{
      "p_lead_id":"{{lead_id}}",
      "p_agent_id":"{{agent_id}}",
      "p_session_id":"{{session_id}}",
      "p_veiculo_interesse":"{{veiculo_interesse}}",
      "p_faixa_preco_min":"{{faixa_preco_min}}",
      "p_faixa_preco_max":"{{faixa_preco_max}}",
      "p_precisa_financiar":"{{precisa_financiar}}",
      "p_entrada_disponivel":"{{entrada_disponivel}}",
      "p_tem_veiculo_troca":"{{tem_veiculo_troca}}",
      "p_forma_pagamento":"{{forma_pagamento}}",
      "p_urgencia":"{{urgencia}}"
  }}'::jsonb,
  'always',
  't',
  NULL
) ON CONFLICT (slug) DO UPDATE SET
  display_name      = EXCLUDED.display_name,
  description       = EXCLUDED.description,
  parameters_schema = EXCLUDED.parameters_schema,
  action_type       = EXCLUDED.action_type,
  action_config     = EXCLUDED.action_config;
