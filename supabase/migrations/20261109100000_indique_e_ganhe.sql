-- ============================================================================
-- INDIQUE E GANHE (2026-11-09) — programa de indicação aberto a QUALQUER pessoa.
-- Decisão do Marco: R$ 200 quando o indicado dá o SINAL, R$ 800 quando a VENDA fecha
-- (R$ 1.000 por indicação), teto de 5 indicações pagas por indicador (R$ 5.000).
--
-- Fluxo: a pessoa se cadastra em /indique (nome + WhatsApp) → ganha um código e um link
-- do WhatsApp OFICIAL com texto pronto ("Vim pela indicação ABC123") → o indicado clica,
-- a Nina atende, o webhook amarra o lead à indicação (um telefone = um indicador, o
-- primeiro vence) → o CRM registra o sinal (deals.commitment_amount) e a venda (won_at)
-- → os gatilhos criam os pagamentos → gestor marca como pago.
-- Painel público do indicador: /indique/<codigo>. Visão do gestor: Claude (mcp_indicacoes).
-- ============================================================================

-- 0) "Registrar Sinal" do CRM escrevia em colunas que não existiam no banco. Agora existem
--    (e são o gatilho do R$ 200).
ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS commitment_amount numeric;
ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS commitment_date timestamptz;

-- 1) Config (valores em centavos; tenant dono do programa = matriz)
INSERT INTO public.config (key, value) SELECT 'INDIQUE_VALOR_SINAL_CENTS', '20000' WHERE NOT EXISTS (SELECT 1 FROM config WHERE key = 'INDIQUE_VALOR_SINAL_CENTS');
INSERT INTO public.config (key, value) SELECT 'INDIQUE_VALOR_VENDA_CENTS', '80000' WHERE NOT EXISTS (SELECT 1 FROM config WHERE key = 'INDIQUE_VALOR_VENDA_CENTS');
INSERT INTO public.config (key, value) SELECT 'INDIQUE_MAX_PAGAS', '5' WHERE NOT EXISTS (SELECT 1 FROM config WHERE key = 'INDIQUE_MAX_PAGAS');
INSERT INTO public.config (key, value) SELECT 'INDIQUE_TENANT_ID', 'c13681e3-5db9-48d1-9c5c-856e6041d77f' WHERE NOT EXISTS (SELECT 1 FROM config WHERE key = 'INDIQUE_TENANT_ID');
INSERT INTO public.config (key, value) SELECT 'app_url', 'https://totexgest.vercel.app' WHERE NOT EXISTS (SELECT 1 FROM config WHERE key = 'app_url');

-- 2) Tabelas
CREATE TABLE IF NOT EXISTS public.indicadores (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  code        text NOT NULL UNIQUE,
  nome        text NOT NULL,
  telefone    text NOT NULL,                       -- só dígitos, com 55
  email       text,
  pix_chave   text,
  status      text NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo','bloqueado')),
  origem      text NOT NULL DEFAULT 'site',
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, telefone)
);

CREATE TABLE IF NOT EXISTS public.indicacoes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  indicador_id  uuid NOT NULL REFERENCES public.indicadores(id),
  lead_id       uuid,
  deal_id       uuid,
  phone         text NOT NULL,
  nome          text,
  status        text NOT NULL DEFAULT 'contato' CHECK (status IN ('contato','sinal','venda','cancelada')),
  origem        text NOT NULL DEFAULT 'whatsapp_link',
  contato_em    timestamptz NOT NULL DEFAULT now(),
  sinal_em      timestamptz,
  venda_em      timestamptz,
  cancelada_em  timestamptz,
  motivo        text,
  meta          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone)                          -- um telefone = um indicador (primeiro vence)
);
CREATE INDEX IF NOT EXISTS indicacoes_indicador_idx ON public.indicacoes(indicador_id, created_at DESC);
CREATE INDEX IF NOT EXISTS indicacoes_lead_idx ON public.indicacoes(lead_id);

CREATE TABLE IF NOT EXISTS public.indicacao_pagamentos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  indicador_id  uuid NOT NULL REFERENCES public.indicadores(id),
  indicacao_id  uuid NOT NULL REFERENCES public.indicacoes(id),
  tipo          text NOT NULL CHECK (tipo IN ('sinal','venda')),
  valor_cents   integer NOT NULL,
  status        text NOT NULL DEFAULT 'a_pagar' CHECK (status IN ('a_pagar','pago','cancelado')),
  pago_em       timestamptz,
  pago_por      uuid,
  nota          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (indicacao_id, tipo)
);

ALTER TABLE public.indicadores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.indicacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.indicacao_pagamentos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS indicadores_gestao ON public.indicadores;
CREATE POLICY indicadores_gestao ON public.indicadores FOR SELECT TO authenticated
  USING (public.is_superadmin() OR (tenant_id = public.get_tenant_id() AND NOT public.is_promotora()));
DROP POLICY IF EXISTS indicacoes_gestao ON public.indicacoes;
CREATE POLICY indicacoes_gestao ON public.indicacoes FOR SELECT TO authenticated
  USING (public.is_superadmin() OR (tenant_id = public.get_tenant_id() AND NOT public.is_promotora()));
DROP POLICY IF EXISTS indicacao_pagamentos_gestao ON public.indicacao_pagamentos;
CREATE POLICY indicacao_pagamentos_gestao ON public.indicacao_pagamentos FOR SELECT TO authenticated
  USING (public.is_superadmin() OR (tenant_id = public.get_tenant_id() AND NOT public.is_promotora()));
GRANT SELECT ON public.indicadores, public.indicacoes, public.indicacao_pagamentos TO authenticated;
GRANT ALL ON public.indicadores, public.indicacoes, public.indicacao_pagamentos TO service_role;

-- 3) Helpers
CREATE OR REPLACE FUNCTION public.indique_norm_phone(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN length(d) IN (10,11) THEN '55' || d ELSE d END
  FROM (SELECT regexp_replace(coalesce(p,''), '\D', '', 'g') AS d) x;
$$;

CREATE OR REPLACE FUNCTION public.indique_cfg_int(p_key text, p_default integer) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT nullif(btrim(value),'')::int FROM config WHERE key = p_key), p_default);
$$;

-- número oficial (Cloud API) do tenant — o link de indicação só pode ser o oficial
CREATE OR REPLACE FUNCTION public.indique_numero_oficial(p_tenant uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT regexp_replace(phone_number, '\D', '', 'g') FROM whatsapp_instances
   WHERE tenant_id = p_tenant AND provider = 'meta_cloud' AND status = 'connected' AND phone_number IS NOT NULL
   ORDER BY created_at LIMIT 1;
$$;

-- 4) Cadastro (chamado pela edge fn pública `indique`, com service role)
CREATE OR REPLACE FUNCTION public.indique_cadastrar(p_nome text, p_telefone text, p_email text DEFAULT NULL, p_tenant uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE t uuid; fone text; v_nome text := btrim(coalesce(p_nome,'')); r indicadores%ROWTYPE; v_code text; v_try int := 0;
BEGIN
  t := coalesce(p_tenant, (SELECT value::uuid FROM config WHERE key = 'INDIQUE_TENANT_ID'));
  IF t IS NULL THEN RAISE EXCEPTION 'Programa não configurado (INDIQUE_TENANT_ID)'; END IF;
  fone := indique_norm_phone(p_telefone);
  IF length(fone) < 12 OR length(fone) > 13 THEN RAISE EXCEPTION 'WhatsApp inválido'; END IF;
  IF length(v_nome) < 2 THEN RAISE EXCEPTION 'Diga seu nome'; END IF;
  SELECT * INTO r FROM indicadores WHERE tenant_id = t AND telefone = fone;
  IF r.id IS NOT NULL THEN
    UPDATE indicadores SET nome = CASE WHEN length(v_nome) >= 2 THEN v_nome ELSE indicadores.nome END,
           email = coalesce(nullif(btrim(p_email),''), email), updated_at = now() WHERE id = r.id;
    RETURN jsonb_build_object('ok', true, 'novo', false, 'code', r.code, 'nome', r.nome, 'status', r.status,
                              'whatsapp', indique_numero_oficial(t));
  END IF;
  LOOP
    v_try := v_try + 1;
    -- md5(uuid) em vez de gen_random_bytes (pgcrypto mora no schema extensions, fora do search_path)
    v_code := upper(translate(substr(md5(gen_random_uuid()::text || clock_timestamp()::text), 1, 6), '01', 'xz'));
    EXIT WHEN NOT EXISTS (SELECT 1 FROM indicadores WHERE code = v_code)
          AND NOT EXISTS (SELECT 1 FROM team_members WHERE lower(repasse_code) = lower(v_code));
    IF v_try > 10 THEN RAISE EXCEPTION 'Não consegui gerar o código'; END IF;
  END LOOP;
  INSERT INTO indicadores (tenant_id, code, nome, telefone, email)
  VALUES (t, v_code, v_nome, fone, nullif(btrim(p_email),''))
  RETURNING * INTO r;
  RETURN jsonb_build_object('ok', true, 'novo', true, 'code', r.code, 'nome', r.nome, 'status', r.status,
                            'whatsapp', indique_numero_oficial(t));
END;
$$;
REVOKE ALL ON FUNCTION public.indique_cadastrar(text,text,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.indique_cadastrar(text,text,text,uuid) TO service_role;

-- 5) Contato: o indicado escreveu no WhatsApp oficial com o código (chamado pelo webhook)
CREATE OR REPLACE FUNCTION public.indique_registrar_contato(p_tenant uuid, p_code text, p_phone text, p_lead uuid DEFAULT NULL, p_nome text DEFAULT NULL, p_lead_novo boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE ind indicadores%ROWTYPE; fone text; ex indicacoes%ROWTYPE; l leads%ROWTYPE; v_id uuid; v_status text := 'contato'; v_motivo text;
BEGIN
  SELECT * INTO ind FROM indicadores WHERE code = upper(btrim(p_code)) AND status = 'ativo';
  IF ind.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'motivo', 'codigo_invalido'); END IF;
  fone := indique_norm_phone(p_phone);
  IF fone = ind.telefone THEN RETURN jsonb_build_object('ok', false, 'motivo', 'auto_indicacao'); END IF;
  SELECT * INTO ex FROM indicacoes WHERE tenant_id = ind.tenant_id AND phone = fone;
  IF ex.id IS NOT NULL THEN
    IF ex.lead_id IS NULL AND p_lead IS NOT NULL THEN UPDATE indicacoes SET lead_id = p_lead, updated_at = now() WHERE id = ex.id; END IF;
    RETURN jsonb_build_object('ok', true, 'ja_existia', true, 'mesmo_indicador', ex.indicador_id = ind.id, 'indicacao_id', ex.id, 'indicador_nome', ind.nome, 'code', ind.code);
  END IF;
  -- quem já estava em negociação com a loja não vale (evita "indicar" cliente que já é da casa)
  IF p_lead IS NOT NULL AND NOT coalesce(p_lead_novo, true) THEN
    SELECT * INTO l FROM leads WHERE id = p_lead;
    IF l.id IS NOT NULL AND l.created_at < now() - interval '1 day'
       AND coalesce(l.last_interaction_at, l.last_message_received_at, l.created_at) > now() - interval '90 days' THEN
      v_status := 'cancelada'; v_motivo := 'ja_cliente';
    END IF;
  END IF;
  INSERT INTO indicacoes (tenant_id, indicador_id, lead_id, phone, nome, status, origem, cancelada_em, motivo)
  VALUES (ind.tenant_id, ind.id, p_lead, fone, nullif(btrim(p_nome),''), v_status, 'whatsapp_link',
          CASE WHEN v_status = 'cancelada' THEN now() END, v_motivo)
  RETURNING id INTO v_id;
  IF p_lead IS NOT NULL THEN
    UPDATE leads SET
      metadata = coalesce(metadata,'{}'::jsonb) || jsonb_build_object('indicacao', jsonb_build_object(
        'codigo', ind.code, 'indicador_id', ind.id, 'indicador_nome', ind.nome, 'indicacao_id', v_id, 'status', v_status, 'em', now())),
      utm_source = coalesce(utm_source, 'indicacao'), utm_campaign = coalesce(utm_campaign, 'indique_e_ganhe'), utm_content = coalesce(utm_content, ind.code),
      source = coalesce(source, 'indicacao'), updated_at = now()
    WHERE id = p_lead;
  END IF;
  RETURN jsonb_build_object('ok', true, 'ja_existia', false, 'indicacao_id', v_id, 'status', v_status, 'motivo', v_motivo, 'indicador_nome', ind.nome, 'code', ind.code);
END;
$$;
REVOKE ALL ON FUNCTION public.indique_registrar_contato(uuid,text,text,uuid,text,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.indique_registrar_contato(uuid,text,text,uuid,text,boolean) TO service_role;

-- 6) Eventos do CRM: sinal (R$ 200) e venda (R$ 800), com teto por indicador
CREATE OR REPLACE FUNCTION public.indique_evento(p_lead uuid, p_tipo text, p_deal uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i indicacoes%ROWTYPE; v_fone text; v_max int; v_pagas int; v_sinal int; v_venda int; criados text[] := '{}';
BEGIN
  IF p_lead IS NULL OR p_tipo NOT IN ('sinal','venda') THEN RETURN jsonb_build_object('ok', false); END IF;
  SELECT * INTO i FROM indicacoes WHERE lead_id = p_lead AND status <> 'cancelada' ORDER BY created_at LIMIT 1;
  IF i.id IS NULL THEN
    SELECT indique_norm_phone(phone) INTO v_fone FROM leads WHERE id = p_lead;
    IF v_fone IS NOT NULL THEN SELECT * INTO i FROM indicacoes WHERE phone = v_fone AND status <> 'cancelada' ORDER BY created_at LIMIT 1; END IF;
  END IF;
  IF i.id IS NULL THEN RETURN jsonb_build_object('ok', true, 'indicacao', false); END IF;
  IF i.lead_id IS NULL THEN UPDATE indicacoes SET lead_id = p_lead WHERE id = i.id; END IF;

  v_max := indique_cfg_int('INDIQUE_MAX_PAGAS', 5);
  v_sinal := indique_cfg_int('INDIQUE_VALOR_SINAL_CENTS', 20000);
  v_venda := indique_cfg_int('INDIQUE_VALOR_VENDA_CENTS', 80000);
  -- indicações desse indicador que já geraram pagamento (fora esta) — conta pro teto
  SELECT count(DISTINCT indicacao_id) INTO v_pagas FROM indicacao_pagamentos
   WHERE indicador_id = i.indicador_id AND status <> 'cancelado' AND indicacao_id <> i.id;

  IF p_tipo = 'sinal' AND i.status = 'contato' THEN
    UPDATE indicacoes SET status = 'sinal', sinal_em = now(), deal_id = coalesce(p_deal, deal_id), updated_at = now() WHERE id = i.id;
  END IF;
  IF p_tipo = 'venda' AND i.status IN ('contato','sinal') THEN
    UPDATE indicacoes SET status = 'venda', venda_em = now(), sinal_em = coalesce(sinal_em, now()), deal_id = coalesce(p_deal, deal_id), updated_at = now() WHERE id = i.id;
  END IF;

  IF v_pagas < v_max THEN
    -- sinal: paga no sinal E também na venda (venda sem sinal registrado ainda vale os R$ 200)
    INSERT INTO indicacao_pagamentos (tenant_id, indicador_id, indicacao_id, tipo, valor_cents)
    VALUES (i.tenant_id, i.indicador_id, i.id, 'sinal', v_sinal) ON CONFLICT (indicacao_id, tipo) DO NOTHING;
    IF FOUND THEN criados := array_append(criados, 'sinal'); END IF;
    IF p_tipo = 'venda' THEN
      INSERT INTO indicacao_pagamentos (tenant_id, indicador_id, indicacao_id, tipo, valor_cents)
      VALUES (i.tenant_id, i.indicador_id, i.id, 'venda', v_venda) ON CONFLICT (indicacao_id, tipo) DO NOTHING;
      IF FOUND THEN criados := array_append(criados, 'venda'); END IF;
    END IF;
  ELSE
    UPDATE indicacoes SET meta = meta || jsonb_build_object('teto_atingido', true) WHERE id = i.id;
  END IF;
  UPDATE leads SET metadata = jsonb_set(coalesce(metadata,'{}'::jsonb), '{indicacao,status}', to_jsonb((SELECT status FROM indicacoes WHERE id = i.id))) WHERE id = p_lead AND metadata ? 'indicacao';
  RETURN jsonb_build_object('ok', true, 'indicacao', true, 'indicacao_id', i.id, 'pagamentos_criados', to_jsonb(criados), 'teto', v_pagas >= v_max);
END;
$$;
REVOKE ALL ON FUNCTION public.indique_evento(uuid,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.indique_evento(uuid,text,uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trg_indicacao_deal_events_fn() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.lead_id IS NULL THEN RETURN NEW; END IF;
  IF coalesce(NEW.commitment_amount, 0) > 0 AND coalesce(OLD.commitment_amount, 0) <= 0 THEN
    PERFORM indique_evento(NEW.lead_id, 'sinal', NEW.id);
  END IF;
  IF NEW.won_at IS NOT NULL AND OLD.won_at IS NULL THEN
    PERFORM indique_evento(NEW.lead_id, 'venda', NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_indicacao_deal_events ON public.deals;
CREATE TRIGGER trg_indicacao_deal_events AFTER UPDATE OF commitment_amount, won_at ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.trg_indicacao_deal_events_fn();

-- 7) Painel público do indicador (edge fn `indique`, service role)
CREATE OR REPLACE FUNCTION public.indique_painel(p_code text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE ind indicadores%ROWTYPE; v_max int := indique_cfg_int('INDIQUE_MAX_PAGAS', 5);
BEGIN
  SELECT * INTO ind FROM indicadores WHERE code = upper(btrim(p_code));
  IF ind.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'motivo', 'codigo_invalido'); END IF;
  RETURN jsonb_build_object('ok', true, 'code', ind.code, 'nome', ind.nome, 'status', ind.status,
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
REVOKE ALL ON FUNCTION public.indique_painel(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.indique_painel(text) TO service_role;

-- 8) Gestão: visão no Claude + marcar pago
CREATE OR REPLACE FUNCTION public.mcp_indicacoes()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE t uuid;
BEGIN
  PERFORM public.mcp_guard_gestor();
  t := public.get_tenant_id();
  RETURN jsonb_build_object(
    'tipo', 'indicacoes',
    'resumo', jsonb_build_object(
      'indicadores', (SELECT count(*) FROM indicadores WHERE tenant_id = t),
      'indicacoes', (SELECT count(*) FROM indicacoes WHERE tenant_id = t AND status <> 'cancelada'),
      'em_conversa', (SELECT count(*) FROM indicacoes WHERE tenant_id = t AND status = 'contato'),
      'com_sinal', (SELECT count(*) FROM indicacoes WHERE tenant_id = t AND status = 'sinal'),
      'vendas', (SELECT count(*) FROM indicacoes WHERE tenant_id = t AND status = 'venda'),
      'a_pagar_cents', (SELECT coalesce(sum(valor_cents),0) FROM indicacao_pagamentos WHERE tenant_id = t AND status = 'a_pagar'),
      'pago_cents', (SELECT coalesce(sum(valor_cents),0) FROM indicacao_pagamentos WHERE tenant_id = t AND status = 'pago')),
    'a_pagar', coalesce((SELECT jsonb_agg(x) FROM (
      SELECT p.id, ind.nome AS indicador, ind.telefone AS indicador_whatsapp, ind.pix_chave, p.tipo, p.valor_cents,
             coalesce(i.nome, i.phone) AS indicado, l.codigo AS lead_codigo, to_char(p.created_at AT TIME ZONE 'America/Sao_Paulo','DD/MM') AS desde
        FROM indicacao_pagamentos p JOIN indicadores ind ON ind.id = p.indicador_id JOIN indicacoes i ON i.id = p.indicacao_id LEFT JOIN leads l ON l.id = i.lead_id
       WHERE p.tenant_id = t AND p.status = 'a_pagar' ORDER BY p.created_at LIMIT 50) x), '[]'::jsonb),
    'ranking', coalesce((SELECT jsonb_agg(x) FROM (
      SELECT ind.nome, ind.code, ind.telefone,
             (SELECT count(*) FROM indicacoes i WHERE i.indicador_id = ind.id AND i.status <> 'cancelada') AS indicados,
             (SELECT count(*) FROM indicacoes i WHERE i.indicador_id = ind.id AND i.status = 'venda') AS vendas,
             (SELECT coalesce(sum(valor_cents),0) FROM indicacao_pagamentos p WHERE p.indicador_id = ind.id AND p.status <> 'cancelado') AS ganho_cents,
             to_char(ind.created_at AT TIME ZONE 'America/Sao_Paulo','DD/MM') AS desde
        FROM indicadores ind WHERE ind.tenant_id = t ORDER BY 5 DESC, 4 DESC LIMIT 30) x), '[]'::jsonb),
    'link_cadastro', coalesce((SELECT value FROM config WHERE key = 'app_url'), 'https://totexgest.vercel.app') || '/indique'
  );
END;
$$;
REVOKE ALL ON FUNCTION public.mcp_indicacoes() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mcp_indicacoes() TO authenticated;

CREATE OR REPLACE FUNCTION public.mcp_indicacao_marcar_pago(p_pagamento uuid, p_nota text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE m uuid; t uuid; p indicacao_pagamentos%ROWTYPE;
BEGIN
  m := public.mcp_guard_gestor(); t := public.get_tenant_id();
  SELECT * INTO p FROM indicacao_pagamentos WHERE id = p_pagamento AND tenant_id = t;
  IF p.id IS NULL THEN RAISE EXCEPTION 'Pagamento não encontrado'; END IF;
  IF p.status = 'pago' THEN RETURN jsonb_build_object('ok', true, 'ja_pago', true); END IF;
  UPDATE indicacao_pagamentos SET status = 'pago', pago_em = now(), pago_por = m, nota = coalesce(p_nota, nota) WHERE id = p.id;
  RETURN jsonb_build_object('ok', true, 'valor_cents', p.valor_cents, 'tipo', p.tipo);
END;
$$;
REVOKE ALL ON FUNCTION public.mcp_indicacao_marcar_pago(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mcp_indicacao_marcar_pago(uuid,text) TO authenticated;
