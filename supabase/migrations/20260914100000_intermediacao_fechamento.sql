-- ============================================================================
-- INTERMEDIAÇÃO — Fase 4: Comprador e Pagamento (2026-09-14)
-- PRD v4 Parte II (fechamento). Reaproveita o motor de contrato/assinatura da Fase 3.
--   • Comprador + proposta (valor, forma de pagamento, entrada); aceite do proprietário.
--   • Termo de Compra e Venda (document_type SALE_CONTRACT): mesmo fluxo gerar → enviar
--     (Clicksign) OU importar papel. Assinantes: proprietário + comprador + Totex.
--   • Pagamento: admin confirma manualmente (valor + observação). Sem pagamento confirmado,
--     a venda NÃO conclui e a entrega fica travada.
--   • Conclusão: Termo assinado + pagamento confirmado → carro vendido → intermediação
--     completed → R$ 50 (via triggers da Fase 1). Credere fica pra fase 4.1.
-- As funções de provedor (mark_sent / apply_event / finalize) passam a ser CONSCIENTES do
-- document_type: espelham no contrato de intermediação OU no termo de compra e venda.
-- ============================================================================

-- ─── 1) Colunas de comprador / venda / pagamento ────────────────────────────
ALTER TABLE public.intermediations
  ADD COLUMN IF NOT EXISTS buyer_data          jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS payment_method      text CHECK (payment_method IS NULL OR payment_method IN ('cash','financing','mixed','consortium','other')),
  ADD COLUMN IF NOT EXISTS down_payment        numeric,
  ADD COLUMN IF NOT EXISTS financed_amount     numeric,
  ADD COLUMN IF NOT EXISTS installments        integer,
  ADD COLUMN IF NOT EXISTS paid_amount         numeric,
  ADD COLUMN IF NOT EXISTS payment_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS payment_confirmed_by uuid,
  ADD COLUMN IF NOT EXISTS payment_note        text,
  ADD COLUMN IF NOT EXISTS sale_document_id    uuid,
  ADD COLUMN IF NOT EXISTS sale_contract_status text NOT NULL DEFAULT 'none'
    CHECK (sale_contract_status IN ('none','generated','sent','partial','signed','imported','declined','expired','cancelled')),
  ADD COLUMN IF NOT EXISTS sale_signed_at      timestamptz;

-- ─── 2) Propostas do comprador (histórico + aceite do proprietário) ─────────
CREATE TABLE IF NOT EXISTS public.intermediation_proposals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  intermediation_id uuid NOT NULL REFERENCES public.intermediations(id) ON DELETE CASCADE,
  buyer_lead_id     uuid,
  buyer_name        text,
  amount            numeric NOT NULL CHECK (amount > 0),
  payment_method    text CHECK (payment_method IS NULL OR payment_method IN ('cash','financing','mixed','consortium','other')),
  down_payment      numeric,
  financed_amount   numeric,
  installments      integer,
  notes             text,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','countered','withdrawn','superseded')),
  created_by        uuid,
  decided_by        uuid,
  decided_at        timestamptz,
  decision_note     text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS intermediation_proposals_int_idx ON public.intermediation_proposals(intermediation_id, created_at DESC);
ALTER TABLE public.intermediation_proposals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS intermediation_proposals_select ON public.intermediation_proposals;
CREATE POLICY intermediation_proposals_select ON public.intermediation_proposals FOR SELECT TO authenticated
  USING (NOT public.is_promotora() AND (tenant_id = public.get_tenant_id() OR public.is_superadmin()));
GRANT SELECT ON public.intermediation_proposals TO authenticated;
GRANT ALL ON public.intermediation_proposals TO service_role;

-- ─── 3) Snapshot: variáveis de comprador e de venda (pro SALE_CONTRACT) ─────
CREATE OR REPLACE FUNCTION public.intermediation_contract_snapshot(p_id uuid, p_document_type text DEFAULT 'INTERMEDIATION_CONTRACT')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  i intermediations%ROWTYPE; l leads%ROWTYPE; b leads%ROWTYPE; v seller_vehicles%ROWTYPE; le legal_entities%ROWTYPE; t contract_templates%ROWTYPE;
  bd jsonb; vars jsonb; missing jsonb := '[]'::jsonb; k text; v_val text; v_next_version integer; v_pay text;
  labels constant jsonb := '{
    "legal_entity.name":"Razão social da empresa","legal_entity.cnpj":"CNPJ da empresa","legal_entity.address":"Endereço da empresa",
    "company_signer.name":"Quem assina pela empresa (nome)","company_signer.cpf":"CPF de quem assina pela empresa","company_signer.role":"Qualidade de quem assina (Administradora/Procurador)",
    "seller.name":"Nome do proprietário","seller.cpf_cnpj":"CPF/CNPJ do proprietário","seller.rg":"RG do proprietário","seller.address":"Endereço do proprietário",
    "seller.zip":"CEP do proprietário","seller.city_uf":"Cidade/UF do proprietário","seller.phone":"Telefone do proprietário","seller.email":"E-mail do proprietário",
    "buyer.name":"Nome do comprador","buyer.cpf_cnpj":"CPF/CNPJ do comprador","buyer.rg":"RG do comprador","buyer.address":"Endereço do comprador",
    "buyer.zip":"CEP do comprador","buyer.city_uf":"Cidade/UF do comprador","buyer.phone":"Telefone do comprador","buyer.email":"E-mail do comprador",
    "vehicle.make":"Marca do veículo","vehicle.model":"Modelo do veículo","vehicle.year":"Ano do veículo","vehicle.plate":"Placa","vehicle.chassis":"Chassi",
    "vehicle.renavam":"Renavam","vehicle.mileage":"Quilometragem","vehicle.color":"Cor","vehicle.fuel":"Combustível",
    "intermediation.asking_price":"Preço pretendido","intermediation.commission_text":"Comissão","intermediation.starts_at":"Início do prazo","intermediation.ends_at":"Fim do prazo",
    "sale.price":"Valor da venda","sale.payment_text":"Forma de pagamento",
    "contract.city":"Cidade do contrato (entidade jurídica)"
  }'::jsonb;
  sources constant jsonb := '{
    "legal_entity":"legal_entity","company_signer":"legal_entity","seller":"contract_data.owner","buyer":"buyer_data","vehicle":"contract_data.vehicle","intermediation":"terms","sale":"sale","contract":"legal_entity","brand":"legal_entity"
  }'::jsonb;
BEGIN
  IF public.is_promotora() THEN RAISE EXCEPTION 'Sem acesso'; END IF;
  SELECT * INTO i FROM intermediations WHERE id = p_id;
  IF i.id IS NULL OR (i.tenant_id <> public.get_tenant_id() AND NOT public.is_superadmin() AND public.current_member_id() IS NOT NULL) THEN
    RAISE EXCEPTION 'Intermediação não encontrada';
  END IF;
  SELECT * INTO l FROM leads WHERE id = i.owner_lead_id;
  IF i.buyer_lead_id IS NOT NULL THEN SELECT * INTO b FROM leads WHERE id = i.buyer_lead_id; END IF;
  SELECT * INTO v FROM seller_vehicles WHERE id = coalesce(i.vehicle_id, (SELECT id FROM seller_vehicles WHERE lead_id = i.owner_lead_id ORDER BY created_at DESC LIMIT 1));
  SELECT * INTO le FROM legal_entities WHERE id = coalesce(i.legal_entity_id, (SELECT id FROM legal_entities WHERE tenant_id = i.tenant_id AND is_active ORDER BY is_default DESC LIMIT 1));
  t := public.contract_template_current(i.tenant_id, p_document_type);
  SELECT coalesce(max(version), 0) + 1 INTO v_next_version FROM contract_documents WHERE intermediation_id = p_id AND document_type = p_document_type;
  bd := coalesce(i.buyer_data, '{}'::jsonb);

  -- forma de pagamento por extenso
  v_pay := CASE i.payment_method
    WHEN 'cash' THEN 'À vista' || coalesce(', ' || capture_fmt_brl(i.sale_price), '')
    WHEN 'financing' THEN 'Financiamento' || coalesce(' — entrada de ' || capture_fmt_brl(i.down_payment), '') || coalesce(' + ' || capture_fmt_brl(i.financed_amount) || ' financiados', '') || coalesce(' em ' || i.installments::text || 'x', '')
    WHEN 'mixed' THEN 'Misto — entrada de ' || coalesce(capture_fmt_brl(i.down_payment), '—') || ' e ' || coalesce(capture_fmt_brl(i.financed_amount), '—') || ' financiados'
    WHEN 'consortium' THEN 'Consórcio / carta de crédito' || coalesce(' — ' || capture_fmt_brl(i.sale_price), '')
    WHEN 'other' THEN 'A combinar (ver observações)'
    ELSE NULL END;

  -- jsonb_build_object tem limite de 100 args (50 pares) → montado em blocos com ||
  vars := jsonb_build_object(
    'legal_entity.name', le.legal_name, 'legal_entity.trade_name', le.trade_name, 'legal_entity.cnpj', le.cnpj,
    'legal_entity.address', nullif(concat_ws(', ', le.address, nullif(concat_ws('/', le.city_name, le.state), ''), nullif('CEP ' || le.zip, 'CEP ')), ''),
    'legal_entity.phone', le.phone, 'legal_entity.email', le.email,
    'brand.name', coalesce(le.trade_name, 'TotexMotors'),
    'company_signer.name', le.signer_name, 'company_signer.cpf', le.signer_cpf, 'company_signer.role', le.signer_role,
    'seller.name', l.name,
    'seller.cpf_cnpj', coalesce(nullif(i.owner_data->>'cpf_cnpj', ''), l.cpf_cnpj),
    'seller.rg', nullif(i.owner_data->>'rg', ''),
    'seller.address', nullif(concat_ws(', ', coalesce(nullif(i.owner_data->>'address', ''), l.address),
                                          coalesce(nullif(i.owner_data->>'address_number', ''), l.address_number),
                                          coalesce(nullif(i.owner_data->>'complement', ''), l.address_complement),
                                          coalesce(nullif(i.owner_data->>'district', ''), l.address_province)), ''),
    'seller.zip', nullif(i.owner_data->>'zip', ''),
    'seller.city_uf', nullif(concat_ws('/', coalesce(nullif(i.owner_data->>'city', ''), l.city_name), coalesce(nullif(i.owner_data->>'state', ''), l.state)), ''),
    'seller.phone', coalesce(nullif(i.owner_data->>'phone', ''), l.phone),
    'seller.email', coalesce(nullif(i.owner_data->>'email', ''), l.email)
  ) || jsonb_build_object(
    'buyer.name', coalesce(nullif(bd->>'name', ''), b.name),
    'buyer.cpf_cnpj', coalesce(nullif(bd->>'cpf_cnpj', ''), b.cpf_cnpj),
    'buyer.rg', nullif(bd->>'rg', ''),
    'buyer.address', nullif(concat_ws(', ', coalesce(nullif(bd->>'address', ''), b.address),
                                          nullif(bd->>'address_number', ''), nullif(bd->>'complement', ''), nullif(bd->>'district', '')), ''),
    'buyer.zip', nullif(bd->>'zip', ''),
    'buyer.city_uf', nullif(concat_ws('/', coalesce(nullif(bd->>'city', ''), b.city_name), coalesce(nullif(bd->>'state', ''), b.state)), ''),
    'buyer.phone', coalesce(nullif(bd->>'phone', ''), b.phone),
    'buyer.email', coalesce(nullif(bd->>'email', ''), b.email),
    'vehicle.make', v.brand, 'vehicle.model', coalesce(v.model, v.description), 'vehicle.version', v.version,
    'vehicle.year', v.year_model::text, 'vehicle.color', v.color, 'vehicle.plate', v.plate, 'vehicle.chassis', v.chassis, 'vehicle.renavam', v.renavam,
    'vehicle.mileage', CASE WHEN v.km IS NOT NULL THEN to_char(v.km, 'FM999G999G990') || ' km' END,
    'vehicle.fuel', v.fuel, 'vehicle.accessories', v.condition_notes
  ) || jsonb_build_object(
    'intermediation.code', i.code,
    'intermediation.asking_price', capture_fmt_brl(i.asking_price),
    'intermediation.minimum_price', coalesce(capture_fmt_brl(i.minimum_authorized_price), 'não definido (o proprietário aprova cada proposta)'),
    'intermediation.commission_text', CASE i.commission_type WHEN 'percent' THEN replace(rtrim(rtrim(to_char(i.commission_value, 'FM990D99'), '0'), '.'), '.', ',') || '% sobre o preço final da venda'
                                                             WHEN 'fixed' THEN capture_fmt_brl(i.commission_value) || ' (valor fixo)' END,
    'intermediation.starts_at', to_char(i.starts_at, 'DD/MM/YYYY'), 'intermediation.ends_at', to_char(i.ends_at, 'DD/MM/YYYY'),
    'sale.price', capture_fmt_brl(i.sale_price),
    'sale.payment_text', v_pay,
    'sale.down_payment', capture_fmt_brl(i.down_payment),
    'sale.financed_amount', capture_fmt_brl(i.financed_amount),
    'contract.code', i.code, 'contract.version', v_next_version::text,
    'contract.city', coalesce(le.contract_city, le.city_name), 'contract.date_long', capture_fmt_date_long(current_date)
  );

  IF t.id IS NOT NULL THEN
    FOREACH k IN ARRAY t.required_variables LOOP
      v_val := vars->>k;
      IF v_val IS NULL OR btrim(v_val) = '' THEN
        missing := missing || jsonb_build_object('key', k, 'label', coalesce(labels->>k, k), 'source', coalesce(sources->>split_part(k, '.', 1), 'other'));
      END IF;
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'variables', vars, 'missing', missing, 'ready', jsonb_array_length(missing) = 0 AND t.id IS NOT NULL,
    'template', CASE WHEN t.id IS NULL THEN NULL ELSE jsonb_build_object('id', t.id, 'name', t.name, 'version', t.version, 'document_type', t.document_type, 'global', t.tenant_id IS NULL) END,
    'next_version', v_next_version, 'legal_entity_id', le.id
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.intermediation_contract_snapshot(uuid, text) TO authenticated, service_role;

-- ─── 4) Registrar documento: SALE_CONTRACT ganha o signatário COMPRADOR ─────
CREATE OR REPLACE FUNCTION public.contract_document_register(
  p_intermediation uuid, p_document_type text, p_template_id uuid, p_template_version integer,
  p_snapshot jsonb, p_file_path text, p_sha256 text, p_generated_by uuid DEFAULT NULL, p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i intermediations%ROWTYPE; le legal_entities%ROWTYPE; v_version integer; v_doc contract_documents%ROWTYPE; vars jsonb := coalesce(p_snapshot->'variables', p_snapshot);
BEGIN
  SELECT * INTO i FROM intermediations WHERE id = p_intermediation;
  IF i.id IS NULL THEN RAISE EXCEPTION 'Intermediação não encontrada'; END IF;
  IF coalesce(p_sha256, '') !~ '^[0-9a-f]{64}$' OR coalesce(p_file_path, '') = '' THEN RAISE EXCEPTION 'Arquivo e SHA-256 obrigatórios'; END IF;
  IF i.legal_entity_id IS NOT NULL THEN SELECT * INTO le FROM legal_entities WHERE id = i.legal_entity_id; END IF;

  UPDATE contract_documents SET status = 'cancelled', cancelled_at = now(), cancel_reason = coalesce(p_reason, 'Nova versão gerada'), updated_at = now()
  WHERE intermediation_id = p_intermediation AND document_type = p_document_type AND status IN ('draft', 'generated', 'ready', 'error');
  SELECT coalesce(max(version), 0) + 1 INTO v_version FROM contract_documents WHERE intermediation_id = p_intermediation AND document_type = p_document_type;

  INSERT INTO contract_documents (tenant_id, intermediation_id, document_type, template_id, template_version, version, status, snapshot_json,
                                  rendered_file_path, rendered_sha256, generated_at, generated_by)
  VALUES (i.tenant_id, p_intermediation, p_document_type, p_template_id, p_template_version, v_version, 'generated', p_snapshot,
          p_file_path, p_sha256, now(), p_generated_by)
  RETURNING * INTO v_doc;

  -- signatários: proprietário + empresa sempre; comprador entra no Termo de Compra e Venda
  INSERT INTO contract_signers (tenant_id, document_id, party_type, party_id, name, cpf_cnpj, email, phone, signing_order)
  VALUES (i.tenant_id, v_doc.id, 'owner', i.owner_lead_id, coalesce(vars->>'seller.name', 'Proprietário'), vars->>'seller.cpf_cnpj', vars->>'seller.email', vars->>'seller.phone', 1);
  IF p_document_type = 'SALE_CONTRACT' THEN
    INSERT INTO contract_signers (tenant_id, document_id, party_type, party_id, name, cpf_cnpj, email, phone, signing_order)
    VALUES (i.tenant_id, v_doc.id, 'buyer', i.buyer_lead_id, coalesce(vars->>'buyer.name', 'Comprador'), vars->>'buyer.cpf_cnpj', vars->>'buyer.email', vars->>'buyer.phone', 2);
  END IF;
  INSERT INTO contract_signers (tenant_id, document_id, party_type, party_id, name, cpf_cnpj, email, phone, signing_order)
  VALUES (i.tenant_id, v_doc.id, 'company', i.legal_entity_id, coalesce(vars->>'company_signer.name', vars->>'legal_entity.name', 'TotexMotors'), vars->>'company_signer.cpf',
          coalesce(nullif(le.signer_email, ''), vars->>'legal_entity.email'), coalesce(nullif(le.signer_phone, ''), vars->>'legal_entity.phone'),
          CASE WHEN p_document_type = 'SALE_CONTRACT' THEN 3 ELSE 2 END);

  IF p_document_type = 'INTERMEDIATION_CONTRACT' AND i.contract_status NOT IN ('signed', 'imported') THEN
    UPDATE intermediations SET contract_status = 'generated', contract_document_id = v_doc.id, updated_by = p_generated_by WHERE id = p_intermediation;
  ELSIF p_document_type = 'SALE_CONTRACT' AND i.sale_contract_status NOT IN ('signed', 'imported') THEN
    UPDATE intermediations SET sale_contract_status = 'generated', sale_document_id = v_doc.id, updated_by = p_generated_by WHERE id = p_intermediation;
  END IF;
  PERFORM intermediation_log(p_intermediation, 'intermediation_document_generated',
    jsonb_build_object('document_id', v_doc.id, 'document_type', p_document_type, 'version', v_version, 'template_version', p_template_version, 'sha256', p_sha256, 'reason', p_reason),
    'doc_generated:' || v_doc.id);
  RETURN to_jsonb(v_doc);
END;
$$;

-- ─── 5) Espelho por tipo de documento no card da intermediação ───────────────
-- Coluna-alvo: contract_status/contract_document_id (intermediação) ou sale_contract_status/sale_document_id (venda).
CREATE OR REPLACE FUNCTION public.intermediation_mirror_doc_status(p_int uuid, p_document_type text, p_document_id uuid, p_status text, p_actor uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_document_type = 'INTERMEDIATION_CONTRACT' THEN
    UPDATE intermediations SET contract_status = p_status, contract_document_id = coalesce(p_document_id, contract_document_id), updated_by = coalesce(p_actor, updated_by)
    WHERE id = p_int AND contract_status NOT IN ('signed', 'imported');
  ELSIF p_document_type = 'SALE_CONTRACT' THEN
    UPDATE intermediations SET sale_contract_status = p_status, sale_document_id = coalesce(p_document_id, sale_document_id), updated_by = coalesce(p_actor, updated_by)
    WHERE id = p_int AND sale_contract_status NOT IN ('signed', 'imported');
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.intermediation_mirror_doc_status(uuid, text, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.intermediation_mirror_doc_status(uuid, text, uuid, text, uuid) TO service_role;

-- mark_sent: espelha no documento certo
CREATE OR REPLACE FUNCTION public.contract_document_mark_sent(
  p_document_id uuid, p_provider text, p_envelope_id text, p_provider_document_id text, p_signers jsonb,
  p_deadline_at timestamptz DEFAULT NULL, p_meta jsonb DEFAULT '{}'::jsonb, p_actor uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d contract_documents%ROWTYPE; s jsonb;
BEGIN
  SELECT * INTO d FROM contract_documents WHERE id = p_document_id;
  IF d.id IS NULL THEN RAISE EXCEPTION 'Documento não encontrado'; END IF;
  IF d.status NOT IN ('generated', 'ready', 'error') THEN RAISE EXCEPTION 'Documento v% não pode ser enviado (status %)', d.version, d.status; END IF;

  UPDATE contract_documents SET status = 'sent', provider = p_provider, provider_envelope_id = p_envelope_id,
         provider_document_id = p_provider_document_id, provider_status = 'running', provider_meta = coalesce(p_meta, '{}'::jsonb),
         deadline_at = p_deadline_at, sent_at = now(), last_event_at = now(), error_message = NULL, updated_at = now()
  WHERE id = p_document_id;
  FOR s IN SELECT * FROM jsonb_array_elements(coalesce(p_signers, '[]'::jsonb)) LOOP
    UPDATE contract_signers SET provider_signer_id = s->>'provider_signer_id', channel = nullif(s->>'channel', ''),
           auth_method = nullif(s->>'auth_method', ''), status = 'sent', sent_at = now()
    WHERE id = (s->>'signer_id')::uuid AND document_id = p_document_id;
  END LOOP;
  PERFORM intermediation_mirror_doc_status(d.intermediation_id, d.document_type, p_document_id, 'sent', p_actor);
  PERFORM intermediation_log(d.intermediation_id, 'intermediation_document_sent',
    jsonb_build_object('document_id', p_document_id, 'document_type', d.document_type, 'version', d.version, 'provider', p_provider, 'envelope', p_envelope_id), 'doc_sent:' || p_document_id);
  RETURN jsonb_build_object('ok', true, 'document_id', p_document_id, 'status', 'sent');
END;
$$;
REVOKE ALL ON FUNCTION public.contract_document_mark_sent(uuid, text, text, text, jsonb, timestamptz, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.contract_document_mark_sent(uuid, text, text, text, jsonb, timestamptz, jsonb, uuid) TO service_role;

-- apply_provider_event: mesma lógica de transição, mas espelha no documento certo
CREATE OR REPLACE FUNCTION public.contract_apply_provider_event(p_document_id uuid, p_event jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  d contract_documents%ROWTYPE; v_type text := lower(coalesce(p_event->>'event_type', 'info')); v_key text; v_digest text;
  v_ref text := nullif(p_event->>'signer_ref', ''); v_sid uuid; v_occ timestamptz := coalesce((p_event->>'occurred_at')::timestamptz, now());
  v_all_signed boolean; v_any boolean; v_new_status text; v_ins int; v_mirror text;
BEGIN
  SELECT * INTO d FROM contract_documents WHERE id = p_document_id;
  IF d.id IS NULL THEN RAISE EXCEPTION 'Documento não encontrado'; END IF;
  v_digest := encode(sha256(convert_to(coalesce(p_event->'payload', '{}'::jsonb)::text, 'UTF8')), 'hex');
  v_key := coalesce(p_event->>'provider', 'provider') || ':' || coalesce(nullif(p_event->>'provider_event_id', ''), v_type || ':' || coalesce(v_ref, '-') || ':' || v_digest);

  INSERT INTO contract_events (tenant_id, document_id, provider, provider_event_id, event_type, raw_event_name, signer_ref, payload_digest, payload, occurred_at, idempotency_key)
  VALUES (d.tenant_id, p_document_id, coalesce(p_event->>'provider', d.provider, 'provider'), nullif(p_event->>'provider_event_id', ''), v_type,
          p_event->>'raw_event_name', v_ref, v_digest, coalesce(p_event->'payload', '{}'::jsonb), v_occ, v_key)
  ON CONFLICT (idempotency_key) DO NOTHING;
  GET DIAGNOSTICS v_ins = ROW_COUNT;
  IF v_ins = 0 THEN
    RETURN jsonb_build_object('applied', false, 'duplicate', true, 'document_status', d.status, 'intermediation_id', d.intermediation_id);
  END IF;

  IF v_ref IS NOT NULL THEN
    SELECT id INTO v_sid FROM contract_signers WHERE document_id = p_document_id
      AND (provider_signer_id = v_ref OR lower(email) = lower(v_ref) OR regexp_replace(coalesce(phone, ''), '\D', '', 'g') = regexp_replace(v_ref, '\D', '', 'g'))
    ORDER BY (provider_signer_id = v_ref) DESC LIMIT 1;
  END IF;

  IF v_type = 'viewed' AND v_sid IS NOT NULL THEN
    UPDATE contract_signers SET status = CASE WHEN status IN ('signed', 'declined') THEN status ELSE 'viewed' END, viewed_at = coalesce(viewed_at, v_occ) WHERE id = v_sid;
  ELSIF v_type = 'signed' AND v_sid IS NOT NULL THEN
    UPDATE contract_signers SET status = 'signed', signed_at = coalesce(signed_at, v_occ), viewed_at = coalesce(viewed_at, v_occ) WHERE id = v_sid;
  ELSIF v_type = 'refused' AND v_sid IS NOT NULL THEN
    UPDATE contract_signers SET status = 'declined', refused_at = coalesce(refused_at, v_occ), refusal_reason = coalesce(p_event->'payload'->>'reason', refusal_reason) WHERE id = v_sid;
  ELSIF v_type = 'sent' AND v_sid IS NOT NULL THEN
    UPDATE contract_signers SET status = CASE WHEN status = 'pending' THEN 'sent' ELSE status END, sent_at = coalesce(sent_at, v_occ) WHERE id = v_sid;
  END IF;

  SELECT bool_and(status = 'signed'), bool_or(status = 'signed') INTO v_all_signed, v_any FROM contract_signers WHERE document_id = p_document_id;

  IF d.status IN ('validated', 'archived') THEN v_new_status := d.status;
  ELSIF v_type = 'refused' THEN v_new_status := 'declined';
  ELSIF v_type = 'canceled' THEN v_new_status := 'cancelled';
  ELSIF v_type = 'expired' THEN v_new_status := 'expired';
  ELSIF v_type = 'error' THEN v_new_status := 'error';
  ELSIF v_type = 'completed' OR coalesce(v_all_signed, false) THEN v_new_status := 'completed';
  ELSIF coalesce(v_any, false) THEN v_new_status := 'partial';
  ELSIF d.status IN ('generated', 'ready') THEN v_new_status := 'sent';
  ELSE v_new_status := d.status;
  END IF;

  UPDATE contract_documents SET status = v_new_status, last_event_at = now(),
         provider_status = coalesce(p_event->'payload'->>'provider_status', provider_status),
         error_message = CASE WHEN v_type = 'error' THEN coalesce(p_event->'payload'->>'message', error_message) ELSE error_message END,
         completed_at = CASE WHEN v_new_status = 'completed' THEN coalesce(completed_at, v_occ) ELSE completed_at END,
         cancelled_at = CASE WHEN v_new_status IN ('cancelled', 'declined', 'expired') THEN coalesce(cancelled_at, v_occ) ELSE cancelled_at END,
         cancel_reason = CASE WHEN v_new_status = 'declined' THEN coalesce(cancel_reason, 'Recusado pelo signatário') WHEN v_new_status = 'expired' THEN coalesce(cancel_reason, 'Prazo de assinatura expirou') ELSE cancel_reason END,
         updated_at = now()
  WHERE id = p_document_id;

  -- espelho: sent/partial/completed→partial/declined/expired/cancelled (só antes de assinado)
  v_mirror := CASE v_new_status WHEN 'sent' THEN 'sent' WHEN 'partial' THEN 'partial' WHEN 'completed' THEN 'partial'
                                WHEN 'declined' THEN 'declined' WHEN 'expired' THEN 'expired' WHEN 'cancelled' THEN 'cancelled' ELSE NULL END;
  IF v_mirror IS NOT NULL THEN
    IF d.document_type = 'INTERMEDIATION_CONTRACT' THEN
      UPDATE intermediations SET contract_status = v_mirror WHERE id = d.intermediation_id AND contract_status NOT IN ('signed','imported') AND contract_document_id = p_document_id;
    ELSIF d.document_type = 'SALE_CONTRACT' THEN
      UPDATE intermediations SET sale_contract_status = v_mirror WHERE id = d.intermediation_id AND sale_contract_status NOT IN ('signed','imported') AND sale_document_id = p_document_id;
    END IF;
  END IF;

  PERFORM intermediation_log(d.intermediation_id, 'contract_provider_event',
    jsonb_build_object('document_id', p_document_id, 'document_type', d.document_type, 'event_type', v_type, 'raw', p_event->>'raw_event_name', 'signer', v_ref, 'document_status', v_new_status));
  RETURN jsonb_build_object('applied', true, 'duplicate', false, 'document_status', v_new_status, 'all_signed', coalesce(v_all_signed, false), 'intermediation_id', d.intermediation_id);
END;
$$;
REVOKE ALL ON FUNCTION public.contract_apply_provider_event(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.contract_apply_provider_event(uuid, jsonb) TO service_role;

-- ─── 6) Finalizar: despacha por tipo de documento ───────────────────────────
CREATE OR REPLACE FUNCTION public.intermediation_sale_contract_finalize(p_int uuid, p_document_id uuid, p_mode text, p_signed_at timestamptz, p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i intermediations%ROWTYPE;
BEGIN
  SELECT * INTO i FROM intermediations WHERE id = p_int;
  IF i.id IS NULL THEN RAISE EXCEPTION 'Intermediação não encontrada'; END IF;
  IF i.sale_contract_status IN ('signed', 'imported') THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'code', i.code, 'sale_contract_status', i.sale_contract_status);
  END IF;
  UPDATE intermediations SET sale_contract_status = p_mode, sale_document_id = coalesce(p_document_id, sale_document_id),
         sale_signed_at = coalesce(p_signed_at, now()), updated_by = p_actor
  WHERE id = p_int;
  PERFORM intermediation_log(p_int, 'sale_contract_signed',
    jsonb_build_object('document_id', p_document_id, 'mode', p_mode, 'signed_at', coalesce(p_signed_at, now())), 'sale_signed:' || p_document_id);
  RETURN jsonb_build_object('ok', true, 'code', i.code, 'sale_contract_status', p_mode, 'document_id', p_document_id);
END;
$$;
REVOKE ALL ON FUNCTION public.intermediation_sale_contract_finalize(uuid, uuid, text, timestamptz, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.contract_document_finalize(p_document_id uuid, p_signed_path text, p_sha256 text, p_provider_status jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d contract_documents%ROWTYPE; r jsonb;
BEGIN
  SELECT * INTO d FROM contract_documents WHERE id = p_document_id;
  IF d.id IS NULL THEN RAISE EXCEPTION 'Documento não encontrado'; END IF;
  IF coalesce(p_sha256, '') !~ '^[0-9a-f]{64}$' OR coalesce(p_signed_path, '') = '' THEN RAISE EXCEPTION 'PDF assinado e SHA-256 obrigatórios'; END IF;
  IF d.status <> 'validated' THEN
    IF d.status IN ('cancelled', 'declined', 'expired') THEN RAISE EXCEPTION 'Documento v% está %; não pode ser finalizado', d.version, d.status; END IF;
    UPDATE contract_documents SET status = 'validated', signed_file_path = p_signed_path, signed_sha256 = p_sha256,
           completed_at = coalesce(completed_at, now()), validated_at = now(), last_reconciled_at = now(),
           provider_meta = provider_meta || coalesce(p_provider_status, '{}'::jsonb), provider_status = 'closed', updated_at = now()
    WHERE id = p_document_id;
    UPDATE contract_signers SET status = 'signed', signed_at = coalesce(signed_at, now()) WHERE document_id = p_document_id AND status <> 'signed';
    PERFORM intermediation_log(d.intermediation_id, 'contract_validated', jsonb_build_object('document_id', p_document_id, 'document_type', d.document_type, 'sha256', p_sha256, 'provider', d.provider), 'contract_validated:' || p_document_id);
  END IF;

  -- Reler estado atual pra idempotência
  SELECT * INTO d FROM contract_documents WHERE id = p_document_id;
  IF d.document_type = 'SALE_CONTRACT' THEN
    r := public.intermediation_sale_contract_finalize(d.intermediation_id, p_document_id, 'signed', coalesce(d.completed_at, now()), NULL);
  ELSE
    r := public.intermediation_formalize(d.intermediation_id, p_document_id, 'signed', p_signed_path, p_sha256, coalesce(d.completed_at, now()), NULL);
  END IF;
  RETURN jsonb_build_object('ok', true, 'document_id', p_document_id, 'document_type', d.document_type) || r;
END;
$$;
REVOKE ALL ON FUNCTION public.contract_document_finalize(uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.contract_document_finalize(uuid, text, text, jsonb) TO service_role;

-- ─── 7) RPCs de comprador / proposta / pagamento / conclusão (UI) ───────────
-- Comprador (dados do Termo de Compra e Venda). Bloqueado depois do termo assinado.
CREATE OR REPLACE FUNCTION public.intermediation_set_buyer(p_id uuid, p_buyer jsonb, p_buyer_lead_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i intermediations%ROWTYPE;
BEGIN
  IF public.is_promotora() THEN RAISE EXCEPTION 'Sem acesso'; END IF;
  SELECT * INTO i FROM intermediations WHERE id = p_id;
  IF i.id IS NULL OR (i.tenant_id <> public.get_tenant_id() AND NOT public.is_superadmin()) THEN RAISE EXCEPTION 'Intermediação não encontrada'; END IF;
  IF i.sale_contract_status IN ('signed', 'imported') AND NOT (public.is_admin() OR public.is_superadmin()) THEN
    RAISE EXCEPTION 'Termo já assinado: dados do comprador só mudam por aditivo (admin)';
  END IF;
  UPDATE intermediations SET
    buyer_data = coalesce(p_buyer, '{}'::jsonb),
    buyer_lead_id = coalesce(p_buyer_lead_id, buyer_lead_id),
    updated_by = public.current_member_id()
  WHERE id = p_id;
  PERFORM intermediation_log(p_id, 'buyer_data_set', jsonb_build_object('buyer_lead_id', coalesce(p_buyer_lead_id, i.buyer_lead_id)), NULL);
  RETURN jsonb_build_object('ok', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.intermediation_set_buyer(uuid, jsonb, uuid) TO authenticated;

-- Registrar proposta do comprador (histórico).
CREATE OR REPLACE FUNCTION public.intermediation_add_proposal(p_id uuid, p_data jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i intermediations%ROWTYPE; v_id uuid; v_amount numeric := (p_data->>'amount')::numeric;
BEGIN
  IF public.is_promotora() THEN RAISE EXCEPTION 'Sem acesso'; END IF;
  SELECT * INTO i FROM intermediations WHERE id = p_id;
  IF i.id IS NULL OR (i.tenant_id <> public.get_tenant_id() AND NOT public.is_superadmin()) THEN RAISE EXCEPTION 'Intermediação não encontrada'; END IF;
  IF i.status NOT IN ('active', 'docs_pending') THEN RAISE EXCEPTION 'A intermediação precisa estar ativa pra receber proposta'; END IF;
  IF coalesce(v_amount, 0) <= 0 THEN RAISE EXCEPTION 'Informe o valor da proposta'; END IF;
  INSERT INTO intermediation_proposals (tenant_id, intermediation_id, buyer_lead_id, buyer_name, amount, payment_method, down_payment, financed_amount, installments, notes, created_by)
  VALUES (i.tenant_id, p_id, nullif(p_data->>'buyer_lead_id', '')::uuid, nullif(p_data->>'buyer_name', ''), v_amount,
          nullif(p_data->>'payment_method', ''), nullif(p_data->>'down_payment', '')::numeric, nullif(p_data->>'financed_amount', '')::numeric,
          nullif(p_data->>'installments', '')::integer, nullif(p_data->>'notes', ''), public.current_member_id())
  RETURNING id INTO v_id;
  PERFORM intermediation_log(p_id, 'buyer_proposal_added', jsonb_build_object('proposal_id', v_id, 'amount', v_amount), NULL);
  RETURN jsonb_build_object('ok', true, 'proposal_id', v_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.intermediation_add_proposal(uuid, jsonb) TO authenticated;

-- Decisão do proprietário (via Totex): aceita → carimba venda; recusa → arquiva.
CREATE OR REPLACE FUNCTION public.intermediation_decide_proposal(p_proposal_id uuid, p_decision text, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p intermediation_proposals%ROWTYPE; i intermediations%ROWTYPE;
BEGIN
  IF public.is_promotora() THEN RAISE EXCEPTION 'Sem acesso'; END IF;
  IF p_decision NOT IN ('accepted', 'rejected') THEN RAISE EXCEPTION 'Decisão inválida'; END IF;
  SELECT * INTO p FROM intermediation_proposals WHERE id = p_proposal_id;
  IF p.id IS NULL OR (p.tenant_id <> public.get_tenant_id() AND NOT public.is_superadmin()) THEN RAISE EXCEPTION 'Proposta não encontrada'; END IF;
  IF p.status <> 'pending' THEN RAISE EXCEPTION 'Proposta já foi decidida (%).', p.status; END IF;
  SELECT * INTO i FROM intermediations WHERE id = p.intermediation_id;

  UPDATE intermediation_proposals SET status = p_decision, decided_by = public.current_member_id(), decided_at = now(), decision_note = nullif(btrim(p_note), '')
  WHERE id = p_proposal_id;

  IF p_decision = 'accepted' THEN
    -- demais propostas pendentes saem de cena
    UPDATE intermediation_proposals SET status = 'superseded' WHERE intermediation_id = p.intermediation_id AND id <> p_proposal_id AND status = 'pending';
    -- carimba a venda pretendida na intermediação (ainda não conclui)
    UPDATE intermediations SET
      sale_price = p.amount, payment_method = coalesce(p.payment_method, payment_method),
      down_payment = coalesce(p.down_payment, down_payment), financed_amount = coalesce(p.financed_amount, financed_amount),
      installments = coalesce(p.installments, installments), buyer_lead_id = coalesce(p.buyer_lead_id, buyer_lead_id),
      buyer_data = CASE WHEN coalesce(buyer_data->>'name','') = '' AND p.buyer_name IS NOT NULL THEN buyer_data || jsonb_build_object('name', p.buyer_name) ELSE buyer_data END,
      updated_by = public.current_member_id()
    WHERE id = p.intermediation_id;
    -- move o funil pra Fechamento (bypass do gate)
    PERFORM intermediation_move_deal(i.owner_lead_id, 'Fechamento%');
  END IF;
  PERFORM intermediation_log(p.intermediation_id, 'buyer_proposal_' || p_decision, jsonb_build_object('proposal_id', p_proposal_id, 'amount', p.amount, 'note', p_note), NULL);
  RETURN jsonb_build_object('ok', true, 'decision', p_decision);
END;
$$;
GRANT EXECUTE ON FUNCTION public.intermediation_decide_proposal(uuid, text, text) TO authenticated;

-- Importar Termo de Compra e Venda assinado em papel (admin).
CREATE OR REPLACE FUNCTION public.intermediation_import_sale_contract(
  p_id uuid, p_file_path text, p_sha256 text, p_signed_at timestamptz DEFAULT now(), p_reason text DEFAULT NULL, p_document_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i intermediations%ROWTYPE; v_doc uuid;
BEGIN
  IF NOT (public.is_admin() OR public.is_superadmin()) THEN RAISE EXCEPTION 'Só admin importa termo assinado'; END IF;
  SELECT * INTO i FROM intermediations WHERE id = p_id;
  IF i.id IS NULL OR (i.tenant_id <> public.get_tenant_id() AND NOT public.is_superadmin()) THEN RAISE EXCEPTION 'Intermediação não encontrada'; END IF;
  IF i.sale_contract_status IN ('signed', 'imported') THEN RETURN jsonb_build_object('ok', true, 'already', true, 'code', i.code); END IF;
  IF coalesce(p_file_path, '') = '' OR coalesce(p_sha256, '') !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Arquivo e hash SHA-256 do PDF são obrigatórios'; END IF;
  IF length(coalesce(btrim(p_reason), '')) < 3 THEN RAISE EXCEPTION 'Informe o motivo/origem da importação (ex.: assinado em papel na loja)'; END IF;

  v_doc := coalesce(p_document_id, i.sale_document_id);
  IF v_doc IS NOT NULL AND EXISTS (SELECT 1 FROM contract_documents WHERE id = v_doc AND intermediation_id = p_id AND document_type = 'SALE_CONTRACT') THEN
    UPDATE contract_documents SET status = 'validated', signed_file_path = p_file_path, signed_sha256 = p_sha256,
           completed_at = coalesce(p_signed_at, now()), validated_at = now(), provider = coalesce(provider, 'manual_import'), updated_at = now()
    WHERE id = v_doc;
    UPDATE contract_signers SET status = 'signed', signed_at = coalesce(signed_at, p_signed_at, now()) WHERE document_id = v_doc AND status <> 'signed';
  ELSE
    INSERT INTO contract_documents (tenant_id, intermediation_id, document_type, version, status, snapshot_json, signed_file_path, signed_sha256, provider, completed_at, validated_at, generated_by)
    VALUES (i.tenant_id, p_id, 'SALE_CONTRACT',
            (SELECT coalesce(max(version), 0) + 1 FROM contract_documents WHERE intermediation_id = p_id AND document_type = 'SALE_CONTRACT'),
            'validated', jsonb_build_object('imported', true, 'reason', p_reason), p_file_path, p_sha256, 'manual_import', coalesce(p_signed_at, now()), now(), public.current_member_id())
    RETURNING id INTO v_doc;
  END IF;
  RETURN public.intermediation_sale_contract_finalize(p_id, v_doc, 'imported', p_signed_at, public.current_member_id());
END;
$$;
GRANT EXECUTE ON FUNCTION public.intermediation_import_sale_contract(uuid, text, text, timestamptz, text, uuid) TO authenticated;

-- Confirmar pagamento (admin/comercial). Sem isso a venda não conclui.
CREATE OR REPLACE FUNCTION public.intermediation_confirm_payment(p_id uuid, p_amount numeric, p_note text DEFAULT NULL, p_full boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i intermediations%ROWTYPE;
BEGIN
  IF public.is_promotora() THEN RAISE EXCEPTION 'Sem acesso'; END IF;
  SELECT * INTO i FROM intermediations WHERE id = p_id;
  IF i.id IS NULL OR (i.tenant_id <> public.get_tenant_id() AND NOT public.is_superadmin()) THEN RAISE EXCEPTION 'Intermediação não encontrada'; END IF;
  IF coalesce(p_amount, 0) <= 0 THEN RAISE EXCEPTION 'Informe o valor recebido'; END IF;
  UPDATE intermediations SET
    paid_amount = p_amount, payment_status = CASE WHEN p_full THEN 'satisfied' ELSE 'partial' END,
    payment_confirmed_at = CASE WHEN p_full THEN now() ELSE payment_confirmed_at END,
    payment_confirmed_by = CASE WHEN p_full THEN public.current_member_id() ELSE payment_confirmed_by END,
    payment_note = nullif(btrim(p_note), ''), updated_by = public.current_member_id()
  WHERE id = p_id;
  PERFORM intermediation_log(p_id, 'payment_' || CASE WHEN p_full THEN 'confirmed' ELSE 'partial' END,
    jsonb_build_object('amount', p_amount, 'note', p_note), NULL);
  RETURN jsonb_build_object('ok', true, 'payment_status', CASE WHEN p_full THEN 'satisfied' ELSE 'partial' END);
END;
$$;
GRANT EXECUTE ON FUNCTION public.intermediation_confirm_payment(uuid, numeric, text, boolean) TO authenticated;

-- Concluir a venda: exige termo assinado + pagamento confirmado. Marca carro vendido → R$50.
CREATE OR REPLACE FUNCTION public.intermediation_conclude_sale(p_id uuid, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i intermediations%ROWTYPE; v_vid uuid; v_note text;
BEGIN
  IF public.is_promotora() THEN RAISE EXCEPTION 'Sem acesso'; END IF;
  SELECT * INTO i FROM intermediations WHERE id = p_id;
  IF i.id IS NULL OR (i.tenant_id <> public.get_tenant_id() AND NOT public.is_superadmin()) THEN RAISE EXCEPTION 'Intermediação não encontrada'; END IF;
  IF i.status = 'completed' THEN RETURN jsonb_build_object('ok', true, 'already', true, 'code', i.code); END IF;
  IF i.status <> 'active' THEN RAISE EXCEPTION 'A intermediação precisa estar ativa pra concluir (status %)', i.status; END IF;
  IF i.sale_contract_status NOT IN ('signed', 'imported') THEN RAISE EXCEPTION 'Antes de concluir, o Termo de Compra e Venda precisa estar assinado'; END IF;
  IF i.payment_status <> 'satisfied' THEN RAISE EXCEPTION 'Antes de concluir, confirme o pagamento do comprador'; END IF;
  IF coalesce(i.sale_price, 0) <= 0 THEN RAISE EXCEPTION 'Valor da venda não definido'; END IF;

  -- registra entrega
  UPDATE intermediations SET transfer_status = 'completed', delivered_at = coalesce(delivered_at, now()), updated_by = public.current_member_id() WHERE id = p_id;

  -- marca o carro vendido → dispara conclusão + R$50 (triggers da Fase 1)
  SELECT id INTO v_vid FROM seller_vehicles WHERE lead_id = i.owner_lead_id ORDER BY created_at DESC LIMIT 1;
  IF v_vid IS NULL THEN RAISE EXCEPTION 'Veículo da intermediação não encontrado'; END IF;
  v_note := coalesce(nullif(btrim(p_note), ''), 'Venda concluída pela intermediação ' || i.code);
  PERFORM set_seller_vehicle_status(v_vid, 'vendido', i.sale_price, i.buyer_deal_id, v_note);

  PERFORM intermediation_log(p_id, 'sale_concluded', jsonb_build_object('sale_price', i.sale_price, 'buyer_deal_id', i.buyer_deal_id), 'sale_concluded:' || p_id);
  RETURN jsonb_build_object('ok', true, 'code', i.code, 'status', 'completed');
END;
$$;
GRANT EXECUTE ON FUNCTION public.intermediation_conclude_sale(uuid, text) TO authenticated;

-- ─── 8) Template SALE_CONTRACT v1 (rascunho — revisar no jurídico) ──────────
INSERT INTO public.contract_templates (tenant_id, document_type, name, version, status, body, required_variables)
SELECT NULL, 'SALE_CONTRACT', 'Termo de Compra e Venda de Veículo (rascunho v1 — revisar)', 1, 'published',
$body$# TERMO DE COMPRA E VENDA DE VEÍCULO USADO

**Intermediado por {{brand.name}} — Contrato de Intermediação {{contract.code}}**

## Partes

**VENDEDOR(A) / PROPRIETÁRIO(A):** {{seller.name}}, inscrito(a) no CPF/CNPJ sob nº {{seller.cpf_cnpj}}, residente em {{seller.address}} — {{seller.city_uf}}.

**COMPRADOR(A):** {{buyer.name}}, inscrito(a) no CPF/CNPJ sob nº {{buyer.cpf_cnpj}}, residente em {{buyer.address}} — {{buyer.city_uf}}.

**INTERVENIENTE (intermediadora):** {{legal_entity.name}}, CNPJ {{legal_entity.cnpj}}, neste ato representada por {{company_signer.name}}, na qualidade de {{company_signer.role}}.

As partes acima têm entre si, justo e contratado, o presente Termo de Compra e Venda, que se regerá pelas cláusulas seguintes.

## 1. Objeto

O(A) VENDEDOR(A) vende ao(à) COMPRADOR(A) o veículo usado abaixo descrito, livre e desembaraçado de ônus, salvo o que estiver expressamente informado neste Termo:

- **Marca/Modelo:** {{vehicle.make}} {{vehicle.model}} {{vehicle.version}}
- **Ano:** {{vehicle.year}}  ·  **Cor:** {{vehicle.color}}  ·  **Combustível:** {{vehicle.fuel}}
- **Placa:** {{vehicle.plate}}  ·  **Renavam:** {{vehicle.renavam}}
- **Chassi:** {{vehicle.chassis}}
- **Quilometragem:** {{vehicle.mileage}}

## 2. Preço e forma de pagamento

O preço total da venda é de **{{sale.price}}**, a ser pago da seguinte forma: **{{sale.payment_text}}**.

O reconhecimento da quitação, total ou parcial, dependerá da confirmação do efetivo recebimento pelo(a) VENDEDOR(A) ou pela INTERVENIENTE.

## 3. Entrega e transferência

A entrega do veículo e da documentação ocorrerá após a confirmação do pagamento nos termos da cláusula 2. A transferência de propriedade no órgão de trânsito é de responsabilidade do(a) COMPRADOR(A), no prazo legal, salvo acordo diverso registrado nas observações.

## 4. Estado do veículo

O(A) COMPRADOR(A) declara ter vistoriado o veículo e o recebe no estado em que se encontra, ciente de tratar-se de bem usado. Eventuais garantias legais aplicáveis ao vendedor permanecem resguardadas na forma da lei.

## 5. Papel da intermediadora

A {{brand.name}} atua exclusivamente como intermediadora da aproximação entre as partes, nos termos do Contrato de Intermediação {{contract.code}}, não respondendo por vícios ocultos, débitos ou pendências não informados pelo(a) VENDEDOR(A).

## 6. Foro

Fica eleito o foro da comarca de {{contract.city}} para dirimir eventuais controvérsias oriundas deste Termo.

{{contract.city}}, {{contract.date_long}}.

[[signature:seller]]
**{{seller.name}}** — Vendedor(a)

[[signature:buyer]]
**{{buyer.name}}** — Comprador(a)

[[signature:company]]
**{{company_signer.name}}** — {{brand.name}} (interveniente)
$body$,
ARRAY['legal_entity.name','legal_entity.cnpj','company_signer.name','company_signer.role',
      'seller.name','seller.cpf_cnpj','buyer.name','buyer.cpf_cnpj',
      'vehicle.make','vehicle.model','vehicle.year','vehicle.plate','vehicle.chassis','vehicle.renavam',
      'sale.price','sale.payment_text','contract.city','contract.date_long']
WHERE NOT EXISTS (SELECT 1 FROM public.contract_templates WHERE document_type = 'SALE_CONTRACT' AND tenant_id IS NULL AND version = 1);
