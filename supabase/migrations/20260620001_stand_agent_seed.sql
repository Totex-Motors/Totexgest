-- Seed do agente do stand: placeholder de config + skill de handoff no catálogo.
-- Idempotente. NÃO cria o agente nem liga nada — isso é feito na Fase 3 (operação),
-- preenchendo config.stand_agent_config com os IDs reais e instalando a skill.

-- 1. Config placeholder (desligado). Preencher com IDs reais na ativação:
--    { "enabled": true, "stand_tenant_id": "...", "stand_instance_id": "...",
--      "stand_group_jids": ["...@g.us"], "stand_agent_slug": "agente-stand" }
DO $$ BEGIN
  IF to_regclass('public.config') IS NOT NULL THEN
    INSERT INTO public.config (key, value)
    SELECT 'stand_agent_config',
      '{"enabled": false, "stand_tenant_id": null, "stand_instance_id": null, "stand_group_jids": [], "stand_agent_slug": "agente-stand"}'
    WHERE NOT EXISTS (SELECT 1 FROM public.config WHERE key = 'stand_agent_config');
  END IF;
END $$;

-- 2. Skill de handoff no catálogo (instalável no agente do stand pela UI da plataforma).
DO $$ BEGIN
  IF to_regclass('public.agents_skill_catalog') IS NOT NULL THEN
    INSERT INTO public.agents_skill_catalog (
      slug, display_name, description, category, emoji,
      parameters_schema, action_type, action_config, default_usage_mode, is_recommended, provider
    )
    SELECT
      'repassar_lead_loja',
      'Repassar lead para a loja dona',
      'Envia o resumo do lead qualificado pro grupo do stand e pro WhatsApp da loja dona, e cria o lead no CRM da loja. Use quando terminar a qualificação.',
      'sales',
      '🤝',
      '{
        "type": "object",
        "properties": {
          "resumo": {"type": "string", "description": "Resumo da conversa e do interesse do cliente"},
          "score": {"type": "number", "description": "Score de 0 a 100 da qualidade do lead"},
          "orcamento": {"type": "string", "description": "Orçamento/faixa de preço que o cliente busca"},
          "prazo": {"type": "string", "description": "Prazo de compra do cliente"},
          "forma_pagamento": {"type": "string", "description": "Forma de pagamento (à vista, financiamento, etc)"}
        },
        "required": ["resumo"]
      }'::jsonb,
      'edge_function',
      '{"name": "stand-handoff", "verify_jwt": false}'::jsonb,
      'always',
      true,
      NULL
    WHERE NOT EXISTS (SELECT 1 FROM public.agents_skill_catalog WHERE slug = 'repassar_lead_loja');
  END IF;
END $$;
