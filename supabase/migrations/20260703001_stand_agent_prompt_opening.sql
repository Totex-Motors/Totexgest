-- Ajuste do prompt do agente de qualificação (ex-"agente do stand").
--
-- Contexto: o marketplace e o QR Code do totem agora mandam o cliente pro WhatsApp
-- da Totex Motors com uma MENSAGEM PRONTA padronizada que já cita o veículo e a loja.
-- Ex.: "Olá! Eu vi o BMW X1 X1 XDRIVE 25i Sport 2.0/2.0 Flex Aut. da loja Quest
-- Multimarcas no site da TotexMotors e gostaria de saber mais."
--
-- Este patch ANEXA (não sobrescreve) um bloco orientando o agente a extrair veículo +
-- loja já na 1ª mensagem e repassá-los à tool `repassar_lead_loja` (edge stand-handoff)
-- via os argumentos `carro`, `loja` e `vehicle_id`.
--
-- Idempotente: só anexa se ainda não houver o marcador. Mira a linha do agente pelo
-- config.stand_agent_config (stand_tenant_id + stand_agent_slug) — nada de hardcode.

DO $$
DECLARE
  v_cfg        jsonb;
  v_tenant_id  uuid;
  v_slug       text;
  v_marker     text := '[[ia_qualificacao_opening_v1]]';
  v_block      text;
BEGIN
  IF to_regclass('public.agents_registry') IS NULL
     OR to_regclass('public.config') IS NULL THEN
    RAISE NOTICE '[stand_agent_prompt] tabelas ausentes — nada a fazer.';
    RETURN;
  END IF;

  SELECT value::jsonb INTO v_cfg
  FROM public.config
  WHERE key = 'stand_agent_config'
  LIMIT 1;

  IF v_cfg IS NULL THEN
    RAISE NOTICE '[stand_agent_prompt] config.stand_agent_config ausente — nada a fazer.';
    RETURN;
  END IF;

  v_tenant_id := NULLIF(v_cfg->>'stand_tenant_id', '')::uuid;
  v_slug      := COALESCE(NULLIF(v_cfg->>'stand_agent_slug', ''), 'agente-stand');

  IF v_tenant_id IS NULL THEN
    RAISE NOTICE '[stand_agent_prompt] stand_tenant_id não configurado — rode de novo após ativar o agente.';
    RETURN;
  END IF;

  v_block :=
E'\n\n--- ' || v_marker || E' ---\n' ||
E'# Abertura padronizada (marketplace e totem)\n' ||
E'Toda conversa começa por uma MENSAGEM PRONTA que o próprio cliente dispara ao ' ||
E'escanear o QR Code do totem físico ou clicar no botão de WhatsApp do site da Totex ' ||
E'Motors (marketplace). Essa mensagem já traz o veículo de interesse e a loja dona. ' ||
E'Formato típico:\n' ||
E'"Olá! Eu vi o {VEÍCULO} da loja {LOJA} no site da TotexMotors e gostaria de saber mais."\n' ||
E'(a variação do totem pode dizer "no totem" ou "no stand" em vez de "no site").\n\n' ||
E'Na PRIMEIRA mensagem, extraia e memorize:\n' ||
E'- veículo de interesse (marca + modelo + versão, exatamente como citado);\n' ||
E'- nome da loja dona citada (ex.: "Quest Multimarcas").\n\n' ||
E'Ao chamar a tool de repasse (repassar_lead_loja), preencha:\n' ||
E'- `carro`  = o veículo extraído;\n' ||
E'- `loja`   = o nome da loja citada;\n' ||
E'- `vehicle_id` = só se a mensagem/link trouxer um id explícito do veículo.\n\n' ||
E'Regras: NUNCA invente veículo ou loja — se a mensagem não trouxer algum deles, ' ||
E'pergunte ao cliente de forma natural antes de qualificar. NÃO repita a mensagem ' ||
E'pronta de volta; apenas siga a conversa e a qualificação normalmente.';

  UPDATE public.agents_registry
  SET system_prompt = system_prompt || v_block,
      updated_at    = now()
  WHERE tenant_id = v_tenant_id
    AND slug      = v_slug
    AND position(v_marker in system_prompt) = 0;

  IF NOT FOUND THEN
    RAISE NOTICE '[stand_agent_prompt] nada atualizado (agente % / tenant % não encontrado ou já com o marcador).', v_slug, v_tenant_id;
  ELSE
    RAISE NOTICE '[stand_agent_prompt] prompt do agente % atualizado.', v_slug;
  END IF;
END $$;
