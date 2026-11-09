-- INDIQUE E GANHE — correção de privacidade (09/11/2026)
-- Antes: o código compartilhável abria o painel (dados dos indicados e comissões) e o
-- recadastro pelo telefone devolvia o código e trocava nome/e-mail sem provar posse.
-- Agora:
--   • código (6 chars) = só pra amarrar a indicação no link do WhatsApp (público);
--   • painel = token privado longo (indicadores.painel_token), mostrado uma vez no cadastro;
--   • recadastro com telefone já existente NÃO devolve nada nem altera dados;
--   • recuperação do painel só pelo WhatsApp cadastrado ("meu painel" no número oficial →
--     o webhook responde com o link, prova de posse do telefone).

ALTER TABLE public.indicadores ADD COLUMN IF NOT EXISTS painel_token text;
UPDATE public.indicadores SET painel_token = encode(sha256((gen_random_uuid()::text || clock_timestamp()::text)::bytea), 'hex') WHERE painel_token IS NULL;
ALTER TABLE public.indicadores ALTER COLUMN painel_token SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS indicadores_painel_token_idx ON public.indicadores(painel_token);

-- Cadastro: só cria. Telefone já cadastrado → ja_cadastrado (sem código, sem token, sem update).
CREATE OR REPLACE FUNCTION public.indique_cadastrar(p_nome text, p_telefone text, p_email text DEFAULT NULL, p_tenant uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE t uuid; fone text; v_nome text := btrim(coalesce(p_nome,'')); r indicadores%ROWTYPE; v_code text; v_try int := 0; v_token text;
BEGIN
  t := coalesce(p_tenant, (SELECT value::uuid FROM config WHERE key = 'INDIQUE_TENANT_ID'));
  IF t IS NULL THEN RAISE EXCEPTION 'Programa não configurado (INDIQUE_TENANT_ID)'; END IF;
  fone := indique_norm_phone(p_telefone);
  IF length(fone) < 12 OR length(fone) > 13 THEN RAISE EXCEPTION 'WhatsApp inválido'; END IF;
  IF length(v_nome) < 2 THEN RAISE EXCEPTION 'Diga seu nome'; END IF;
  IF EXISTS (SELECT 1 FROM indicadores WHERE tenant_id = t AND telefone = fone) THEN
    RETURN jsonb_build_object('ok', true, 'novo', false, 'ja_cadastrado', true, 'whatsapp', indique_numero_oficial(t));
  END IF;
  LOOP
    v_try := v_try + 1;
    v_code := upper(translate(substr(md5(gen_random_uuid()::text || clock_timestamp()::text), 1, 6), '01', 'xz'));
    EXIT WHEN NOT EXISTS (SELECT 1 FROM indicadores WHERE code = v_code)
          AND NOT EXISTS (SELECT 1 FROM team_members WHERE lower(repasse_code) = lower(v_code));
    IF v_try > 10 THEN RAISE EXCEPTION 'Não consegui gerar o código'; END IF;
  END LOOP;
  v_token := encode(sha256((gen_random_uuid()::text || clock_timestamp()::text || fone)::bytea), 'hex');
  INSERT INTO indicadores (tenant_id, code, nome, telefone, email, painel_token)
  VALUES (t, v_code, v_nome, fone, nullif(btrim(p_email),''), v_token)
  RETURNING * INTO r;
  RETURN jsonb_build_object('ok', true, 'novo', true, 'code', r.code, 'nome', r.nome, 'status', r.status,
                            'painel_token', r.painel_token, 'whatsapp', indique_numero_oficial(t));
END;
$$;

-- Painel: só pelo token privado.
DROP FUNCTION IF EXISTS public.indique_painel(text);
CREATE OR REPLACE FUNCTION public.indique_painel_token(p_token text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE ind indicadores%ROWTYPE; v_max int := indique_cfg_int('INDIQUE_MAX_PAGAS', 5);
BEGIN
  IF length(coalesce(p_token,'')) < 32 THEN RETURN jsonb_build_object('ok', false, 'motivo', 'token_invalido'); END IF;
  SELECT * INTO ind FROM indicadores WHERE painel_token = p_token;
  IF ind.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'motivo', 'token_invalido'); END IF;
  RETURN jsonb_build_object('ok', true, 'code', ind.code, 'nome', ind.nome, 'status', ind.status, 'painel_token', ind.painel_token,
    'whatsapp', indique_numero_oficial(ind.tenant_id),
    'valores', jsonb_build_object('sinal_cents', indique_cfg_int('INDIQUE_VALOR_SINAL_CENTS', 20000), 'venda_cents', indique_cfg_int('INDIQUE_VALOR_VENDA_CENTS', 80000), 'max_pagas', v_max),
    'totais', jsonb_build_object(
      'indicados', (SELECT count(*) FROM indicacoes WHERE indicador_id = ind.id AND status <> 'cancelada'),
      'em_conversa', (SELECT count(*) FROM indicacoes WHERE indicador_id = ind.id AND status = 'contato'),
      'com_sinal', (SELECT count(*) FROM indicacoes WHERE indicador_id = ind.id AND status = 'sinal'),
      'vendas', (SELECT count(*) FROM indicacoes WHERE indicador_id = ind.id AND status = 'venda'),
      'pagas_no_teto', (SELECT count(DISTINCT indicacao_id) FROM indicacao_pagamentos WHERE indicador_id = ind.id AND status <> 'cancelado'),
      'a_receber_cents', (SELECT coalesce(sum(valor_cents),0) FROM indicacao_pagamentos WHERE indicador_id = ind.id AND status = 'a_pagar'),
      'recebido_cents', (SELECT coalesce(sum(valor_cents),0) FROM indicacao_pagamentos WHERE indicador_id = ind.id AND status = 'pago')),
    'indicados', coalesce((SELECT jsonb_agg(x) FROM (
      SELECT split_part(coalesce(nullif(nome,''), 'Contato'), ' ', 1) || ' ···' || right(phone, 4) AS quem, status,
             to_char(contato_em AT TIME ZONE 'America/Sao_Paulo','DD/MM') AS em,
             (SELECT coalesce(sum(valor_cents),0) FROM indicacao_pagamentos p WHERE p.indicacao_id = i.id AND p.status <> 'cancelado') AS valor_cents,
             (SELECT bool_and(status = 'pago') FROM indicacao_pagamentos p WHERE p.indicacao_id = i.id AND p.status <> 'cancelado') AS pago
        FROM indicacoes i WHERE indicador_id = ind.id ORDER BY created_at DESC LIMIT 50) x), '[]'::jsonb));
END;
$$;
REVOKE ALL ON FUNCTION public.indique_painel_token(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.indique_painel_token(text) TO service_role;

-- Recuperação pelo WhatsApp cadastrado (webhook do número oficial = prova de posse do telefone).
CREATE OR REPLACE FUNCTION public.indique_recuperar_painel(p_tenant uuid, p_phone text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE ind indicadores%ROWTYPE;
BEGIN
  SELECT * INTO ind FROM indicadores WHERE tenant_id = p_tenant AND telefone = indique_norm_phone(p_phone) AND status = 'ativo';
  IF ind.id IS NULL THEN RETURN jsonb_build_object('ok', false); END IF;
  RETURN jsonb_build_object('ok', true, 'nome', ind.nome, 'code', ind.code, 'painel_token', ind.painel_token);
END;
$$;
REVOKE ALL ON FUNCTION public.indique_recuperar_painel(uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.indique_recuperar_painel(uuid,text) TO service_role;
