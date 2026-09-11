-- ============================================================================
-- INTERMEDIAÇÃO — Fase 2: Documentos (2026-09-12)
-- PRD v4, Parte III (13.2.5 templates/versões, 13.2.6 modelo de dados) — sem provedor ainda.
--   • contract_templates: jurídico, versionado, imutável depois de publicado. Global (tenant_id
--     NULL = Totex) ou do tenant. Body em "markdown-lite" com {{variáveis}}.
--   • contract_documents: cada geração cria uma versão (snapshot_json + PDF + SHA-256).
--     Regenerar nunca sobrescreve: cancela a anterior e cria a próxima.
--   • contract_signers: signatários previstos (proprietário + empresa) — a fase 3 liga ao provedor.
--   • Dados do contrato: intermediations.owner_data (CPF/RG/endereço do proprietário),
--     seller_vehicles.plate/renavam/chassis, legal_entities.signer_* (quem assina pela empresa —
--     a fase 5 troca por procurações).
--   • intermediation_contract_snapshot(): monta as variáveis e lista o que falta (UI mostra
--     "Falta: …" e leva ao campo). contract_document_register(): só service_role (edge fn
--     contract-render grava o PDF gerado). Importar assinado agora pode apontar pro documento.
--   • CLICKSIGN_API_KEY / CLICKSIGN_ENV entram no allowlist de chaves por tenant (fase 3 usa).
-- ============================================================================

-- ─── 1) Dados que o contrato precisa ─────────────────────────────────────────
ALTER TABLE public.intermediations ADD COLUMN IF NOT EXISTS owner_data jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.seller_vehicles
  ADD COLUMN IF NOT EXISTS plate   text,
  ADD COLUMN IF NOT EXISTS renavam text,
  ADD COLUMN IF NOT EXISTS chassis text;
ALTER TABLE public.legal_entities
  ADD COLUMN IF NOT EXISTS signer_name text,
  ADD COLUMN IF NOT EXISTS signer_cpf  text,
  ADD COLUMN IF NOT EXISTS signer_role text CHECK (signer_role IS NULL OR signer_role IN ('Administradora', 'Administrador', 'Procuradora', 'Procurador')),
  ADD COLUMN IF NOT EXISTS contract_city text;

-- ─── 2) Templates (jurídico, versionado) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.contract_templates (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid,                       -- NULL = global (Totex) — superadmin edita
  document_type      text NOT NULL CHECK (document_type IN ('INTERMEDIATION_CONTRACT', 'PRICE_AUTHORIZATION', 'CUSTODY_TERM', 'TEST_DRIVE_TERM', 'BUYER_PROPOSAL', 'SALE_CONTRACT', 'DELIVERY_TERM', 'CANCELLATION_TERM')),
  name               text NOT NULL,
  version            integer NOT NULL DEFAULT 1,
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  body               text NOT NULL,
  required_variables text[] NOT NULL DEFAULT '{}',
  signer_policy      jsonb NOT NULL DEFAULT '{"signers": ["owner", "company"]}'::jsonb,
  notes              text,
  effective_from     timestamptz,
  retired_at         timestamptz,
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS contract_templates_scope_type_version_uidx
  ON public.contract_templates (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), document_type, version);
ALTER TABLE public.contract_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contract_templates_select ON public.contract_templates;
CREATE POLICY contract_templates_select ON public.contract_templates FOR SELECT TO authenticated
  USING (NOT public.is_promotora() AND (tenant_id IS NULL OR tenant_id = public.get_tenant_id() OR public.is_superadmin()));
DROP POLICY IF EXISTS contract_templates_write ON public.contract_templates;
CREATE POLICY contract_templates_write ON public.contract_templates FOR ALL TO authenticated
  USING (public.is_superadmin() OR (tenant_id = public.get_tenant_id() AND public.is_admin()))
  WITH CHECK (public.is_superadmin() OR (tenant_id = public.get_tenant_id() AND public.is_admin()));
GRANT SELECT, INSERT, UPDATE ON public.contract_templates TO authenticated;
GRANT ALL ON public.contract_templates TO service_role;

-- Publicado é imutável: só status/retired_at/notes mudam. Mudou cláusula? Nova versão.
CREATE OR REPLACE FUNCTION public.trg_contract_template_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('published', 'retired') AND (NEW.body IS DISTINCT FROM OLD.body OR NEW.required_variables IS DISTINCT FROM OLD.required_variables
     OR NEW.document_type IS DISTINCT FROM OLD.document_type OR NEW.version IS DISTINCT FROM OLD.version OR NEW.signer_policy IS DISTINCT FROM OLD.signer_policy) THEN
    RAISE EXCEPTION 'Template publicado é imutável (v%). Crie uma nova versão.', OLD.version;
  END IF;
  IF NEW.status = 'published' AND OLD.status = 'draft' THEN
    NEW.effective_from := coalesce(NEW.effective_from, now());
    UPDATE contract_templates SET status = 'retired', retired_at = now()
    WHERE id <> NEW.id AND document_type = NEW.document_type AND status = 'published'
      AND coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(NEW.tenant_id, '00000000-0000-0000-0000-000000000000'::uuid);
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_contract_template_immutable ON public.contract_templates;
CREATE TRIGGER trg_contract_template_immutable BEFORE UPDATE ON public.contract_templates
  FOR EACH ROW EXECUTE FUNCTION public.trg_contract_template_immutable();

-- Template vigente pro tenant: o do tenant, senão o global
CREATE OR REPLACE FUNCTION public.contract_template_current(p_tenant uuid, p_type text)
RETURNS public.contract_templates LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.* FROM contract_templates t
  WHERE t.document_type = p_type AND t.status = 'published' AND (t.tenant_id = p_tenant OR t.tenant_id IS NULL)
  ORDER BY (t.tenant_id IS NOT NULL) DESC, t.version DESC LIMIT 1;
$$;

-- ─── 3) Documentos gerados ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.contract_documents (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  intermediation_id    uuid NOT NULL REFERENCES public.intermediations(id) ON DELETE CASCADE,
  document_type        text NOT NULL,
  template_id          uuid REFERENCES public.contract_templates(id) ON DELETE SET NULL,
  template_version     integer,
  version              integer NOT NULL DEFAULT 1,
  status               text NOT NULL DEFAULT 'generated'
                       CHECK (status IN ('draft', 'generated', 'ready', 'sent', 'partial', 'completed', 'validated', 'declined', 'expired', 'cancelled', 'error', 'archived')),
  snapshot_json        jsonb NOT NULL DEFAULT '{}'::jsonb,
  rendered_file_path   text,
  rendered_sha256      text,
  signed_file_path     text,
  signed_sha256        text,
  provider             text,
  provider_document_id text,
  generated_at         timestamptz,
  sent_at              timestamptz,
  completed_at         timestamptz,
  validated_at         timestamptz,
  cancelled_at         timestamptz,
  cancel_reason        text,
  generated_by         uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contract_documents_int_idx ON public.contract_documents(intermediation_id, document_type, version DESC);
CREATE INDEX IF NOT EXISTS contract_documents_provider_idx ON public.contract_documents(provider, provider_document_id) WHERE provider_document_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.contract_signers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  document_id        uuid NOT NULL REFERENCES public.contract_documents(id) ON DELETE CASCADE,
  party_type         text NOT NULL CHECK (party_type IN ('owner', 'company', 'buyer', 'witness')),
  party_id           uuid,
  name               text NOT NULL,
  cpf_cnpj           text,
  email              text,
  phone              text,
  signing_order      integer NOT NULL DEFAULT 1,
  provider_signer_id text,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'viewed', 'signed', 'declined')),
  viewed_at          timestamptz,
  signed_at          timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contract_signers_doc_idx ON public.contract_signers(document_id);

ALTER TABLE public.contract_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_signers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contract_documents_select ON public.contract_documents;
CREATE POLICY contract_documents_select ON public.contract_documents FOR SELECT TO authenticated
  USING (NOT public.is_promotora() AND (tenant_id = public.get_tenant_id() OR public.is_superadmin()));
DROP POLICY IF EXISTS contract_signers_select ON public.contract_signers;
CREATE POLICY contract_signers_select ON public.contract_signers FOR SELECT TO authenticated
  USING (NOT public.is_promotora() AND (tenant_id = public.get_tenant_id() OR public.is_superadmin()));
GRANT SELECT ON public.contract_documents, public.contract_signers TO authenticated;
GRANT ALL ON public.contract_documents, public.contract_signers TO service_role;

-- ─── 4) Dados do contrato (proprietário + veículo) ───────────────────────────
-- p_data: { owner: {cpf_cnpj, rg, address, address_number, complement, district, zip, city, state, email, phone},
--           vehicle: {plate, renavam, chassis, color, fuel, version, brand, model, year_model, km, accessories} }
CREATE OR REPLACE FUNCTION public.intermediation_set_contract_data(p_id uuid, p_data jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i intermediations%ROWTYPE; o jsonb := coalesce(p_data->'owner', '{}'::jsonb); v jsonb := coalesce(p_data->'vehicle', '{}'::jsonb); v_vid uuid;
BEGIN
  IF public.is_promotora() THEN RAISE EXCEPTION 'Promotora não edita dados do contrato'; END IF;
  SELECT * INTO i FROM intermediations WHERE id = p_id;
  IF i.id IS NULL OR (i.tenant_id <> public.get_tenant_id() AND NOT public.is_superadmin()) THEN RAISE EXCEPTION 'Intermediação não encontrada'; END IF;
  IF i.contract_status IN ('signed', 'imported') AND NOT (public.is_admin() OR public.is_superadmin()) THEN
    RAISE EXCEPTION 'Contrato já assinado: dados só mudam por aditivo (admin).';
  END IF;

  UPDATE intermediations SET owner_data = owner_data || o, updated_by = public.current_member_id() WHERE id = p_id;
  -- espelha no lead (CRM) o que ele não tinha
  UPDATE leads SET
    cpf_cnpj  = coalesce(nullif(o->>'cpf_cnpj', ''), cpf_cnpj),
    address   = coalesce(nullif(o->>'address', ''), address),
    address_number = coalesce(nullif(o->>'address_number', ''), address_number),
    address_complement = coalesce(nullif(o->>'complement', ''), address_complement),
    address_province = coalesce(nullif(o->>'district', ''), address_province),
    city_name = coalesce(nullif(o->>'city', ''), city_name),
    state     = coalesce(nullif(o->>'state', ''), state),
    email     = coalesce(nullif(lower(o->>'email'), ''), email)
  WHERE id = i.owner_lead_id;

  SELECT id INTO v_vid FROM seller_vehicles WHERE id = coalesce(i.vehicle_id, (SELECT id FROM seller_vehicles WHERE lead_id = i.owner_lead_id ORDER BY created_at DESC LIMIT 1));
  IF v_vid IS NOT NULL AND v <> '{}'::jsonb THEN
    UPDATE seller_vehicles SET
      plate      = CASE WHEN v ? 'plate' THEN upper(nullif(regexp_replace(v->>'plate', '[^A-Za-z0-9]', '', 'g'), '')) ELSE plate END,
      renavam    = CASE WHEN v ? 'renavam' THEN nullif(regexp_replace(v->>'renavam', '\D', '', 'g'), '') ELSE renavam END,
      chassis    = CASE WHEN v ? 'chassis' THEN upper(nullif(regexp_replace(v->>'chassis', '[^A-Za-z0-9]', '', 'g'), '')) ELSE chassis END,
      color      = CASE WHEN v ? 'color' THEN nullif(btrim(v->>'color'), '') ELSE color END,
      fuel       = CASE WHEN v ? 'fuel' THEN nullif(btrim(v->>'fuel'), '') ELSE fuel END,
      version    = CASE WHEN v ? 'version' THEN nullif(btrim(v->>'version'), '') ELSE version END,
      brand      = CASE WHEN v ? 'brand' THEN nullif(btrim(v->>'brand'), '') ELSE brand END,
      model      = CASE WHEN v ? 'model' THEN nullif(btrim(v->>'model'), '') ELSE model END,
      year_model = CASE WHEN v ? 'year_model' AND (v->>'year_model') ~ '^\d{4}$' THEN (v->>'year_model')::int ELSE year_model END,
      km         = CASE WHEN v ? 'km' AND (v->>'km') ~ '^\d+$' THEN (v->>'km')::int ELSE km END,
      condition_notes = CASE WHEN v ? 'accessories' THEN nullif(btrim(v->>'accessories'), '') ELSE condition_notes END,
      plate_last4 = CASE WHEN v ? 'plate' THEN right(upper(regexp_replace(v->>'plate', '[^A-Za-z0-9]', '', 'g')), 4) ELSE plate_last4 END
    WHERE id = v_vid;
  END IF;
  PERFORM intermediation_log(p_id, 'contract_data_set', jsonb_build_object('owner_keys', (SELECT array_agg(k) FROM jsonb_object_keys(o) k), 'vehicle_keys', (SELECT array_agg(k) FROM jsonb_object_keys(v) k)));
  RETURN public.intermediation_contract_snapshot(p_id, 'INTERMEDIATION_CONTRACT');
END;
$$;

-- ─── 5) Snapshot das variáveis + o que falta ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.capture_fmt_date_long(d date) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN d IS NULL THEN NULL ELSE
    extract(day FROM d)::int || ' de ' ||
    (ARRAY['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'])[extract(month FROM d)::int]
    || ' de ' || extract(year FROM d)::int END;
$$;

CREATE OR REPLACE FUNCTION public.intermediation_contract_snapshot(p_id uuid, p_document_type text DEFAULT 'INTERMEDIATION_CONTRACT')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  i intermediations%ROWTYPE; l leads%ROWTYPE; v seller_vehicles%ROWTYPE; le legal_entities%ROWTYPE; t contract_templates%ROWTYPE;
  vars jsonb; missing jsonb := '[]'::jsonb; k text; v_val text; v_next_version integer;
  labels constant jsonb := '{
    "legal_entity.name":"Razão social da empresa","legal_entity.cnpj":"CNPJ da empresa","legal_entity.address":"Endereço da empresa",
    "company_signer.name":"Quem assina pela empresa (nome)","company_signer.cpf":"CPF de quem assina pela empresa","company_signer.role":"Qualidade de quem assina (Administradora/Procurador)",
    "seller.name":"Nome do proprietário","seller.cpf_cnpj":"CPF/CNPJ do proprietário","seller.rg":"RG do proprietário","seller.address":"Endereço do proprietário",
    "seller.zip":"CEP do proprietário","seller.city_uf":"Cidade/UF do proprietário","seller.phone":"Telefone do proprietário","seller.email":"E-mail do proprietário",
    "vehicle.make":"Marca do veículo","vehicle.model":"Modelo do veículo","vehicle.year":"Ano do veículo","vehicle.plate":"Placa","vehicle.chassis":"Chassi",
    "vehicle.renavam":"Renavam","vehicle.mileage":"Quilometragem","vehicle.color":"Cor","vehicle.fuel":"Combustível",
    "intermediation.asking_price":"Preço pretendido","intermediation.commission_text":"Comissão","intermediation.starts_at":"Início do prazo","intermediation.ends_at":"Fim do prazo",
    "contract.city":"Cidade do contrato (entidade jurídica)"
  }'::jsonb;
  sources constant jsonb := '{
    "legal_entity":"legal_entity","company_signer":"legal_entity","seller":"contract_data.owner","vehicle":"contract_data.vehicle","intermediation":"terms","contract":"legal_entity","brand":"legal_entity"
  }'::jsonb;
BEGIN
  IF public.is_promotora() THEN RAISE EXCEPTION 'Sem acesso'; END IF;
  SELECT * INTO i FROM intermediations WHERE id = p_id;
  IF i.id IS NULL OR (i.tenant_id <> public.get_tenant_id() AND NOT public.is_superadmin() AND public.current_member_id() IS NOT NULL) THEN
    RAISE EXCEPTION 'Intermediação não encontrada';
  END IF;
  SELECT * INTO l FROM leads WHERE id = i.owner_lead_id;
  SELECT * INTO v FROM seller_vehicles WHERE id = coalesce(i.vehicle_id, (SELECT id FROM seller_vehicles WHERE lead_id = i.owner_lead_id ORDER BY created_at DESC LIMIT 1));
  SELECT * INTO le FROM legal_entities WHERE id = coalesce(i.legal_entity_id, (SELECT id FROM legal_entities WHERE tenant_id = i.tenant_id AND is_active ORDER BY is_default DESC LIMIT 1));
  t := public.contract_template_current(i.tenant_id, p_document_type);
  SELECT coalesce(max(version), 0) + 1 INTO v_next_version FROM contract_documents WHERE intermediation_id = p_id AND document_type = p_document_type;

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
    'seller.email', coalesce(nullif(i.owner_data->>'email', ''), l.email),
    'vehicle.make', v.brand, 'vehicle.model', coalesce(v.model, v.description), 'vehicle.version', v.version,
    'vehicle.year', v.year_model::text, 'vehicle.color', v.color, 'vehicle.plate', v.plate, 'vehicle.chassis', v.chassis, 'vehicle.renavam', v.renavam,
    'vehicle.mileage', CASE WHEN v.km IS NOT NULL THEN to_char(v.km, 'FM999G999G990') || ' km' END,
    'vehicle.fuel', v.fuel, 'vehicle.accessories', v.condition_notes,
    'intermediation.code', i.code,
    'intermediation.asking_price', capture_fmt_brl(i.asking_price),
    'intermediation.minimum_price', coalesce(capture_fmt_brl(i.minimum_authorized_price), 'não definido (o proprietário aprova cada proposta)'),
    'intermediation.commission_text', CASE i.commission_type WHEN 'percent' THEN replace(rtrim(rtrim(to_char(i.commission_value, 'FM990D99'), '0'), '.'), '.', ',') || '% sobre o preço final da venda'
                                                             WHEN 'fixed' THEN capture_fmt_brl(i.commission_value) || ' (valor fixo)' END,
    'intermediation.starts_at', to_char(i.starts_at, 'DD/MM/YYYY'), 'intermediation.ends_at', to_char(i.ends_at, 'DD/MM/YYYY'),
    'intermediation.exclusive_text', CASE WHEN i.exclusive THEN 'SIM, durante o prazo acima' ELSE 'NÃO' END,
    'intermediation.custody_text', CASE i.custody_mode WHEN 'totex' THEN 'fica temporariamente sob guarda da TotexMotors mediante termo próprio' ELSE 'permanece com o proprietário' END,
    'intermediation.display_text', CASE WHEN i.physical_display_authorized THEN 'autorizada' ELSE 'não autorizada' END,
    'intermediation.test_drive_text', CASE i.test_drive_policy WHEN 'accompanied' THEN 'autorizado' WHEN 'specific_authorization' THEN 'depende de autorização específica' ELSE 'não autorizado' END,
    'intermediation.notes', coalesce(i.terms_notes, '—'),
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
GRANT EXECUTE ON FUNCTION public.intermediation_set_contract_data(uuid, jsonb) TO authenticated;

-- ─── 6) Registrar documento gerado (só a edge fn contract-render) ────────────
CREATE OR REPLACE FUNCTION public.contract_document_register(
  p_intermediation uuid, p_document_type text, p_template_id uuid, p_template_version integer,
  p_snapshot jsonb, p_file_path text, p_sha256 text, p_generated_by uuid DEFAULT NULL, p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i intermediations%ROWTYPE; v_version integer; v_doc contract_documents%ROWTYPE; vars jsonb := coalesce(p_snapshot->'variables', p_snapshot);
BEGIN
  SELECT * INTO i FROM intermediations WHERE id = p_intermediation;
  IF i.id IS NULL THEN RAISE EXCEPTION 'Intermediação não encontrada'; END IF;
  IF coalesce(p_sha256, '') !~ '^[0-9a-f]{64}$' OR coalesce(p_file_path, '') = '' THEN RAISE EXCEPTION 'Arquivo e SHA-256 obrigatórios'; END IF;

  -- versões anteriores ainda não assinadas saem de cena (nunca são apagadas)
  UPDATE contract_documents SET status = 'cancelled', cancelled_at = now(), cancel_reason = coalesce(p_reason, 'Nova versão gerada'), updated_at = now()
  WHERE intermediation_id = p_intermediation AND document_type = p_document_type AND status IN ('draft', 'generated', 'ready', 'error');
  SELECT coalesce(max(version), 0) + 1 INTO v_version FROM contract_documents WHERE intermediation_id = p_intermediation AND document_type = p_document_type;

  INSERT INTO contract_documents (tenant_id, intermediation_id, document_type, template_id, template_version, version, status, snapshot_json,
                                  rendered_file_path, rendered_sha256, generated_at, generated_by)
  VALUES (i.tenant_id, p_intermediation, p_document_type, p_template_id, p_template_version, v_version, 'generated', p_snapshot,
          p_file_path, p_sha256, now(), p_generated_by)
  RETURNING * INTO v_doc;

  INSERT INTO contract_signers (tenant_id, document_id, party_type, party_id, name, cpf_cnpj, email, phone, signing_order)
  VALUES (i.tenant_id, v_doc.id, 'owner', i.owner_lead_id, coalesce(vars->>'seller.name', 'Proprietário'), vars->>'seller.cpf_cnpj', vars->>'seller.email', vars->>'seller.phone', 1),
         (i.tenant_id, v_doc.id, 'company', i.legal_entity_id, coalesce(vars->>'company_signer.name', vars->>'legal_entity.name', 'TotexMotors'), vars->>'company_signer.cpf', vars->>'legal_entity.email', vars->>'legal_entity.phone', 2);

  IF p_document_type = 'INTERMEDIATION_CONTRACT' AND i.contract_status NOT IN ('signed', 'imported') THEN
    UPDATE intermediations SET contract_status = 'generated', contract_document_id = v_doc.id, updated_by = p_generated_by WHERE id = p_intermediation;
  END IF;
  PERFORM intermediation_log(p_intermediation, 'intermediation_contract_generated',
    jsonb_build_object('document_id', v_doc.id, 'version', v_version, 'template_version', p_template_version, 'sha256', p_sha256, 'reason', p_reason),
    'contract_generated:' || v_doc.id);
  RETURN to_jsonb(v_doc);
END;
$$;
REVOKE ALL ON FUNCTION public.contract_document_register(uuid, text, uuid, integer, jsonb, text, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.contract_document_register(uuid, text, uuid, integer, jsonb, text, text, uuid, text) TO service_role;

-- ─── 7) Importar assinado: agora vincula ao documento gerado ─────────────────
DROP FUNCTION IF EXISTS public.intermediation_import_signed_contract(uuid, text, text, timestamptz, text);
CREATE OR REPLACE FUNCTION public.intermediation_import_signed_contract(
  p_id uuid, p_file_path text, p_sha256 text, p_signed_at timestamptz DEFAULT now(), p_reason text DEFAULT NULL, p_document_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i intermediations%ROWTYPE; v_vid uuid; v_doc uuid;
BEGIN
  IF NOT (public.is_admin() OR public.is_superadmin()) THEN RAISE EXCEPTION 'Só admin importa contrato assinado'; END IF;
  SELECT * INTO i FROM intermediations WHERE id = p_id;
  IF i.id IS NULL OR (i.tenant_id <> public.get_tenant_id() AND NOT public.is_superadmin()) THEN RAISE EXCEPTION 'Intermediação não encontrada'; END IF;
  IF i.status = 'active' THEN RETURN jsonb_build_object('ok', true, 'already', true, 'code', i.code); END IF;
  IF i.status NOT IN ('lead', 'contracting', 'docs_pending', 'paused') THEN RAISE EXCEPTION 'Intermediação % não pode ser formalizada (status %)', i.code, i.status; END IF;
  IF i.asking_price IS NULL OR i.commission_type IS NULL OR i.commission_value IS NULL OR i.ends_at IS NULL THEN
    RAISE EXCEPTION 'Antes de importar o contrato, preencha preço pretendido, comissão e prazo nas condições comerciais.';
  END IF;
  IF coalesce(p_file_path, '') = '' OR coalesce(p_sha256, '') !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Arquivo e hash SHA-256 do PDF são obrigatórios'; END IF;
  IF length(coalesce(btrim(p_reason), '')) < 3 THEN RAISE EXCEPTION 'Informe o motivo/origem da importação (ex.: assinado em papel na loja)'; END IF;

  -- documento: o gerado (se informado ou o atual) vira "validated"; sem gerado, cria um registro de importação
  v_doc := coalesce(p_document_id, i.contract_document_id);
  IF v_doc IS NOT NULL AND EXISTS (SELECT 1 FROM contract_documents WHERE id = v_doc AND intermediation_id = p_id) THEN
    UPDATE contract_documents SET status = 'validated', signed_file_path = p_file_path, signed_sha256 = p_sha256,
           completed_at = coalesce(p_signed_at, now()), validated_at = now(), provider = 'manual_import', updated_at = now()
    WHERE id = v_doc;
    UPDATE contract_signers SET status = 'signed', signed_at = coalesce(p_signed_at, now()) WHERE document_id = v_doc;
  ELSE
    INSERT INTO contract_documents (tenant_id, intermediation_id, document_type, version, status, snapshot_json, signed_file_path, signed_sha256,
                                    provider, completed_at, validated_at, generated_by)
    VALUES (i.tenant_id, p_id, 'INTERMEDIATION_CONTRACT',
            (SELECT coalesce(max(version), 0) + 1 FROM contract_documents WHERE intermediation_id = p_id AND document_type = 'INTERMEDIATION_CONTRACT'),
            'validated', jsonb_build_object('imported', true, 'reason', p_reason), p_file_path, p_sha256, 'manual_import', coalesce(p_signed_at, now()), now(), public.current_member_id())
    RETURNING id INTO v_doc;
  END IF;

  UPDATE intermediations SET
    contract_status = 'imported', contract_signed_at = coalesce(p_signed_at, now()), contract_file_path = p_file_path,
    contract_sha256 = p_sha256, contract_imported_by = public.current_member_id(), contract_import_reason = btrim(p_reason),
    contract_document_id = v_doc,
    status = 'active', activated_at = now(), status_before_pause = NULL, status_reason = NULL,
    starts_at = coalesce(starts_at, coalesce(p_signed_at, now())::date), updated_by = public.current_member_id()
  WHERE id = p_id;
  PERFORM intermediation_log(p_id, 'intermediation_contract_signed',
    jsonb_build_object('mode', 'imported', 'document_id', v_doc, 'sha256', p_sha256, 'file', p_file_path, 'reason', p_reason), 'contract_signed:' || p_id);

  SELECT id INTO v_vid FROM seller_vehicles WHERE lead_id = i.owner_lead_id ORDER BY created_at DESC LIMIT 1;
  IF v_vid IS NOT NULL THEN
    UPDATE seller_vehicles SET status = 'captado', captured_at = coalesce(captured_at, now()), status_changed_at = now()
    WHERE id = v_vid AND status IN ('lead', 'avaliacao');
  END IF;
  PERFORM intermediation_move_deal(i.owner_lead_id, 'Prepara%');
  RETURN jsonb_build_object('ok', true, 'code', i.code, 'status', 'active', 'document_id', v_doc);
END;
$$;
GRANT EXECUTE ON FUNCTION public.intermediation_import_signed_contract(uuid, text, text, timestamptz, text, uuid) TO authenticated;

-- ─── 8) Chaves da Clicksign por tenant (fase 3 lê via getIntegrationKey) ─────
CREATE OR REPLACE FUNCTION public.set_my_tenant_integration_key(p_key text, p_value text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tid uuid := public.get_tenant_id();
  v_allowed text[] := ARRAY[
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY',
    'UAZAPI_ADMIN_URL', 'UAZAPI_ADMIN_TOKEN',
    'WHATSAPP_CLOUD_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID',
    'SONIOX_API_KEY', 'WAVOIP_API_KEY',
    'ASAAS_API_KEY', 'RESEND_API_KEY',
    'CLICKSIGN_API_KEY', 'CLICKSIGN_ENV'
  ];
  v_clean text := NULLIF(btrim(COALESCE(p_value, '')), '');
BEGIN
  IF NOT public.is_tenant_admin() THEN RAISE EXCEPTION 'forbidden: tenant admin required'; END IF;
  IF v_tid IS NULL THEN RAISE EXCEPTION 'tenant context missing'; END IF;
  IF NOT (p_key = ANY (v_allowed)) THEN RAISE EXCEPTION 'key % is not configurable per-tenant', p_key; END IF;
  IF v_clean IS NULL THEN
    DELETE FROM public.tenant_integration_keys WHERE tenant_id = v_tid AND key = p_key;
    RETURN;
  END IF;
  INSERT INTO public.tenant_integration_keys (tenant_id, key, value, updated_at)
  VALUES (v_tid, p_key, v_clean, now())
  ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
END;
$$;

-- ─── 9) Template v1 (global) — texto da Parte I do PRD ───────────────────────
INSERT INTO public.contract_templates (tenant_id, document_type, name, version, status, body, required_variables, effective_from, notes)
SELECT NULL, 'INTERMEDIATION_CONTRACT', 'Contrato de Intermediação de Veículo Usado (TotexMotors)', 1, 'published', $tpl$# CONTRATO DE INTERMEDIAÇÃO PARA VENDA DE VEÍCULO USADO
## E AUTORIZAÇÃO DE DIVULGAÇÃO, APRESENTAÇÃO E NEGOCIAÇÃO DE PROPOSTAS
Contrato {{contract.code}} · versão {{contract.version}}

Pelo presente instrumento particular, as partes abaixo identificadas celebram o presente Contrato de Intermediação de Veículo Usado (“Contrato”), que será regido pelas Condições Específicas e Condições Gerais seguintes.

## A. CONDIÇÕES ESPECÍFICAS
### 1. INTERMEDIADORA
- **Razão Social:** {{legal_entity.name}}
- **Marca comercial:** {{brand.name}}
- **CNPJ:** {{legal_entity.cnpj}}
- **Endereço:** {{legal_entity.address}}
- **Telefone:** {{legal_entity.phone}}
- **E-mail:** {{legal_entity.email}}
### 2. PROPRIETÁRIO / CONTRATANTE
- **Nome/Razão Social:** {{seller.name}}
- **CPF/CNPJ:** {{seller.cpf_cnpj}}
- **RG/IE:** {{seller.rg}}
- **Endereço:** {{seller.address}}
- **CEP:** {{seller.zip}}
- **Cidade/UF:** {{seller.city_uf}}
- **Telefone/WhatsApp:** {{seller.phone}}
- **E-mail:** {{seller.email}}
### 3. VEÍCULO OBJETO DA INTERMEDIAÇÃO
- **Marca:** {{vehicle.make}}
- **Modelo:** {{vehicle.model}}
- **Versão:** {{vehicle.version}}
- **Ano fabricação/modelo:** {{vehicle.year}}
- **Cor:** {{vehicle.color}}
- **Placa:** {{vehicle.plate}}
- **Chassi:** {{vehicle.chassis}}
- **Renavam:** {{vehicle.renavam}}
- **Quilometragem declarada:** {{vehicle.mileage}}
- **Combustível:** {{vehicle.fuel}}
- **Acessórios relevantes:** {{vehicle.accessories}}
### 4. CONDIÇÕES COMERCIAIS DA INTERMEDIAÇÃO
- **Preço pretendido pelo PROPRIETÁRIO:** {{intermediation.asking_price}}
- **Preço mínimo expressamente autorizado para fechamento, se houver:** {{intermediation.minimum_price}}
- **Comissão da INTERMEDIADORA:** {{intermediation.commission_text}}
- **Prazo da intermediação:** de {{intermediation.starts_at}} até {{intermediation.ends_at}}
- **Exclusividade:** {{intermediation.exclusive_text}}
- **Custódia do veículo:** {{intermediation.custody_text}}
- **Exposição física:** {{intermediation.display_text}}
- **Test drive acompanhado:** {{intermediation.test_drive_text}}
- **Observações comerciais:** {{intermediation.notes}}
### 5. AUTORIZAÇÕES DO PROPRIETÁRIO
O PROPRIETÁRIO autoriza a INTERMEDIADORA a:
- fotografar, filmar e cadastrar o veículo para fins de intermediação;
- divulgar o veículo nos canais da TotexMotors, marketplace, site, redes sociais, totens, campanhas digitais, rede de franqueados/parceiros e, quando aplicável, em espaço físico de shopping;
- apresentar o veículo a potenciais compradores, receber manifestações de interesse e propostas e repassá-las ao PROPRIETÁRIO;
- realizar triagem de interessados e agendar visitas, inspeções, vistorias e test drives dentro das condições deste Contrato;
- compartilhar dados estritamente necessários do veículo e da operação com fornecedores de vistoria, assinatura eletrônica, financiamento, documentação, meios de pagamento, despachantes e parceiros operacionais, observada a legislação de proteção de dados;
- utilizar fotografias e informações do veículo durante a vigência da intermediação e pelo período necessário à conclusão, comprovação e arquivo da operação.
### 6. DOCUMENTOS INTEGRANTES
Integram a operação, quando aplicáveis: (i) cadastro do veículo; (ii) checklist/laudo e registros de condição; (iii) autorização de preço e alterações; (iv) propostas de compradores; (v) termo de test drive; (vi) Termo/Contrato de Compra e Venda entre Particulares com Intermediação; (vii) termo de entrega; e (viii) registros eletrônicos gerados pelo TotexGest e pelo provedor de assinatura.

## B. CONDIÇÕES GERAIS
### 1. OBJETO E NATUREZA DA OPERAÇÃO
A INTERMEDIADORA prestará ao PROPRIETÁRIO serviços de intermediação destinados a aproximá-lo de potenciais compradores do veículo identificado nas Condições Específicas, promovendo sua apresentação, divulgação, qualificação de interessados, encaminhamento de propostas e apoio à formalização da negociação. A INTERMEDIADORA não adquire a propriedade do veículo e não atua, por este Contrato, como revendedora ou compradora do bem.
**1.1.** Nomenclatura. Para todos os fins internos e externos, a operação será denominada INTERMEDIAÇÃO. A expressão “captação” designa apenas a fase/origem em que o proprietário e o veículo ingressam no processo.
**1.2.** Sem mandato para alienar. A INTERMEDIADORA não poderá transferir a propriedade do veículo, aceitar preço definitivo em nome do PROPRIETÁRIO ou concluir a venda sem a manifestação de vontade do PROPRIETÁRIO, salvo autorização específica e expressa em instrumento próprio.
**1.3.** Limites legais. As limitações de responsabilidade previstas neste Contrato não afastam obrigações legais inderrogáveis da INTERMEDIADORA quanto aos serviços que efetivamente prestar.
### 2. ESCOPO DOS SERVIÇOS
A INTERMEDIADORA poderá executar, diretamente ou por parceiros, as atividades necessárias à promoção da intermediação, incluindo curadoria comercial, organização de informações, captação de imagens, publicação de anúncios, exposição física ou digital, atendimento inicial, triagem de interessados, agendamento, coleta e apresentação de propostas, apoio documental e acompanhamento do fechamento.
**2.1.** Serviços adicionais. Vistorias cautelares, laudos mecânicos, higienização, reparos, transporte, despachante, publicidade extraordinária, seguros, financiamento ou outros serviços somente serão cobrados do PROPRIETÁRIO quando houver contratação ou autorização específica, com indicação prévia de valores ou critérios de cobrança.
### 3. OBRIGAÇÕES DA INTERMEDIADORA
A INTERMEDIADORA deverá conduzir a mediação com diligência, prudência e transparência, manter o PROPRIETÁRIO informado sobre o andamento relevante da operação e comunicar riscos, propostas, alterações materiais ou fatos que possam influenciar o resultado da intermediação.
• identificar no TotexGest a origem, responsável pela captação e histórico da intermediação;
• manter registro das propostas recebidas e das aprovações do PROPRIETÁRIO;
• não anunciar condição materialmente diferente da autorizada sem anuência do PROPRIETÁRIO;
• preservar documentos e evidências essenciais da operação conforme política de retenção e legislação aplicável.
### 4. DECLARAÇÕES E OBRIGAÇÕES DO PROPRIETÁRIO
O PROPRIETÁRIO declara, sob sua responsabilidade, ser legítimo proprietário ou representante com poderes suficientes, e compromete-se a prestar informações verdadeiras, completas e atualizadas sobre o veículo e sua situação documental.
• informar restrições, gravames, débitos, sinistros relevantes, histórico de leilão, alterações estruturais, recuperações, vícios conhecidos ou qualquer fato que possa afetar a segurança, o valor ou a transferência;
• manter a quilometragem e demais dados do veículo corretamente informados;
• disponibilizar documentação necessária às verificações e à transferência;
• comunicar imediatamente alteração de preço, indisponibilidade do veículo, nova avaria, sinistro ou negociação paralela;
• responder por fatos, débitos, restrições e informações relativas ao período anterior à transferência, conforme a lei e o que for apurado no caso concreto.
### 5. CONDIÇÃO DO VEÍCULO, INSPEÇÕES E TRANSPARÊNCIA
O veículo é usado e poderá apresentar desgaste compatível com idade, quilometragem, histórico e uso. A INTERMEDIADORA poderá recomendar ou organizar vistorias e inspeções, mas eventual laudo de terceiro será regido por seus próprios critérios e não converterá a INTERMEDIADORA em garantidora técnica do veículo.
**5.1.** Dever de informação. Informações relevantes conhecidas pela INTERMEDIADORA e documentadas durante a intermediação deverão ser apresentadas às partes no momento apropriado. O PROPRIETÁRIO autoriza o registro, no TotexGest, de apontamentos técnicos e documentais necessários à negociação.
**5.2.** Comprador. Antes do fechamento, o potencial comprador deverá ter oportunidade razoável de examinar o veículo, solicitar vistoria ou inspeção de sua confiança e, se autorizado, realizar test drive.
### 6. CUSTÓDIA, EXPOSIÇÃO E TEST DRIVE
Se o veículo permanecer com o PROPRIETÁRIO, este continuará responsável por sua guarda, utilização e conservação. Se o veículo for entregue temporariamente à INTERMEDIADORA para exposição, fotografia, vistoria ou demonstração, deverá ser emitido termo específico de recebimento, com data, quilometragem, condição aparente, chaves, acessórios e finalidade.
**6.1.** Test drive. Test drives dependerão de identificação do condutor, autorização pertinente e regras operacionais da unidade. Multas, danos, franquias de seguro e demais ocorrências deverão ser tratadas conforme termo próprio e apuração de responsabilidade.
### 7. PREÇO, PROPOSTAS E AUTORIZAÇÃO DE FECHAMENTO
O preço anunciado será o preço autorizado pelo PROPRIETÁRIO no TotexGest ou em documento/aceite eletrônico posterior. Propostas recebidas serão apresentadas ao PROPRIETÁRIO, que poderá aceitar, recusar ou contrapropor.
**7.1.** Alteração de preço. Qualquer redução relevante de preço ou mudança de condição comercial deverá ficar registrada por aceite eletrônico, mensagem auditável, assinatura ou outro meio que permita comprovar a manifestação do PROPRIETÁRIO.
### 8. COMISSÃO DE INTERMEDIAÇÃO
A comissão será aquela definida nas Condições Específicas e será devida quando a intermediação produzir o resultado contratado, especialmente quando ocorrer a venda a interessado apresentado, qualificado, atendido ou encaminhado pela INTERMEDIADORA.
**8.1.** Negociação direta com lead apresentado. Se o PROPRIETÁRIO concluir diretamente o negócio com interessado comprovadamente originado pela atuação da INTERMEDIADORA durante a vigência do Contrato ou dentro de 90 (noventa) dias após seu término, a comissão continuará devida, desde que demonstrado o nexo entre a atuação da INTERMEDIADORA e o negócio concluído.
**8.2.** Exclusividade. Quando a exclusividade estiver expressamente marcada nas Condições Específicas, sua extensão, prazo e efeitos deverão observar a legislação aplicável e as condições pactuadas, não dispensando a atuação diligente da INTERMEDIADORA.
### 9. FLUXO FINANCEIRO DA VENDA
A forma de pagamento da compra e venda deverá ser expressamente identificada como (i) à vista, (ii) financiamento bancário, (iii) mista - entrada mais financiamento, (iv) consórcio/carta de crédito, ou (v) outra modalidade expressamente aprovada. Em qualquer hipótese, a INTERMEDIADORA permanecerá na posição de intermediadora do negócio, sem adquirir a propriedade do veículo por força do fluxo de pagamento.
**9.1.** Destinatário do preço do veículo. Como regra, o preço do veículo será pago pelo COMPRADOR, pela instituição financeira ou pela administradora de consórcio diretamente ao PROPRIETÁRIO/VENDEDOR ou a conta por ele validamente indicada para o recebimento. A TotexMotors não deverá figurar como recebedora do preço integral do veículo, salvo se vier a existir estrutura jurídica e financeira específica, formalmente contratada e compatível com a legislação aplicável.
**9.2.** Pagamento da comissão. A comissão de intermediação será paga à INTERMEDIADORA nos termos das Condições Específicas, de forma separada do preço do veículo, podendo ser paga diretamente pelo PROPRIETÁRIO ou deduzida por parceiro financeiro/arranjo de pagamento formalmente estruturado, quando juridicamente permitido, sempre com discriminação documental e emissão fiscal correspondente.
**9.3.** Venda à vista. Na modalidade à vista, o COMPRADOR pagará o preço diretamente ao PROPRIETÁRIO/VENDEDOR, que deverá confirmar o recebimento pelos meios definidos na operação. A INTERMEDIADORA poderá registrar comprovantes, confirmação do PROPRIETÁRIO e conciliação do valor para liberar as etapas de entrega e transferência.
**9.4.** Financiamento bancário. Quando o COMPRADOR necessitar de financiamento, a INTERMEDIADORA poderá encaminhá-lo a instituição financeira, correspondente bancário ou parceiro de crédito regularmente contratado. A análise, decisão, contratação e liberação do crédito pertencem à instituição financeira e/ou ao correspondente responsável pelo produto, não havendo garantia de aprovação pela TotexMotors.
**9.4.1.** Identidade das partes no financiamento. A existência de financiamento não altera a natureza da compra e venda: o PROPRIETÁRIO continuará figurando como VENDEDOR e o interessado aprovado como COMPRADOR. A TotexMotors continuará figurando apenas como INTERMEDIADORA do veículo e, se futuramente contratada diretamente por instituição financeira para tanto, poderá atuar também como correspondente nos limites do respectivo contrato e da regulamentação aplicável.
**9.4.2.** Liberação do crédito. A aprovação de crédito, por si só, não será considerada pagamento. Para fins de liberação do veículo e avanço da operação, deverá existir confirmação de contratação e de liberação/repasse dos recursos destinados ao PROPRIETÁRIO/VENDEDOR, conforme os procedimentos da instituição financeira.
**9.4.3.** Negativa ou expiração do crédito. A recusa, expiração ou cancelamento do financiamento não extingue automaticamente a intermediação. As partes poderão negociar nova instituição, alterar entrada/valor financiado, migrar para pagamento à vista ou outra modalidade. Caso o COMPRADOR desista, o veículo poderá retornar à etapa de exposição/interessados, sem prejuízo das obrigações já constituídas.
**9.5.** Pagamento misto - entrada mais financiamento. Na modalidade mista, a parcela de entrada e a parcela financiada serão tratadas separadamente. A operação somente poderá ser marcada como financeiramente satisfeita quando a entrada tiver sido confirmada e o valor financiado tiver sido efetivamente liberado ao PROPRIETÁRIO/VENDEDOR, ressalvadas condições expressamente pactuadas e documentadas.
**9.6.** Consórcio/carta de crédito. Quando houver carta de crédito de consórcio, a efetivação ficará condicionada aos procedimentos da administradora, incluindo análise do bem, documentação, eventual registro de garantia e liberação dos recursos. A simples apresentação de carta de crédito ou contemplação não será tratada como pagamento até a confirmação da liberação financeira.
**9.7.** Parceiro financeiro e correspondente. O parceiro responsável por simulação, encaminhamento e acompanhamento de financiamento deverá ser identificado na operação. Caso a TotexMotors utilize correspondente parceiro, este atuará no produto financeiro; caso a TotexMotors venha a ser contratada diretamente como correspondente de instituição financeira, essa atuação deverá permanecer jurídica, contábil e operacionalmente separada da intermediação do veículo.
**9.8.** Remunerações distintas. A comissão de intermediação do veículo e eventual remuneração paga por instituição financeira ao correspondente são receitas de naturezas contratuais distintas e deverão ser registradas separadamente, sem confundir o preço do veículo com receita própria da INTERMEDIADORA.
**9.9.** Dados para análise de crédito. Quando o COMPRADOR solicitar financiamento, seus dados poderão ser encaminhados às instituições financeiras e parceiros necessários à simulação, análise e contratação, observadas as bases legais, avisos de privacidade e autorizações aplicáveis. O TotexGest deverá preservar a trilha de consentimentos/solicitações e o parceiro ao qual os dados foram enviados.
**9.10.** Trava de entrega. A entrega do veículo e a conclusão financeira da operação somente deverão ocorrer após o TotexGest registrar, conforme a modalidade aplicável, a confirmação do pagamento à vista, a liberação do financiamento, a liberação da carta de crédito ou a satisfação integral das parcelas que compõem o pagamento misto.
### 10. FORMALIZAÇÃO DA COMPRA E VENDA
Após aprovação de proposta, será gerado Termo/Contrato de Compra e Venda Entre Particulares com Intermediação, contendo vendedor, comprador, veículo, preço, forma de pagamento, comissão e condições específicas. O fechamento somente será considerado formalizado após os aceites/assinaturas requeridos e o cumprimento das condições precedentes.
**10.1.** Transferência. Comprador e vendedor praticarão os atos necessários à transferência de propriedade conforme a legislação de trânsito e os procedimentos do órgão competente, inclusive ATPV-e/CRV ou fluxo eletrônico aplicável. A INTERMEDIADORA poderá orientar e acompanhar, sem substituir as obrigações legais das partes.
**10.2.** Entrega. A entrega do veículo e de seus documentos/chaves deverá ser registrada por termo ou evidência eletrônica no TotexGest.
### 11. RESPONSABILIDADES ENTRE VENDEDOR E COMPRADOR
No instrumento de compra e venda, vendedor e comprador definirão as declarações relativas à propriedade, estado de conservação, inspeção, débitos, restrições, entrega e demais condições da alienação. A INTERMEDIADORA responde pelos serviços de intermediação que efetivamente prestar, nos limites da lei, não se tornando proprietária do veículo apenas por promover ou facilitar a negociação.
### 12. RESCISÃO E ENCERRAMENTO DA INTERMEDIAÇÃO
O Contrato poderá ser encerrado por término do prazo, venda do veículo, desistência, recusa documental/técnica, indisponibilidade, inadimplemento ou manifestação escrita de uma das partes, ressalvadas as obrigações já constituídas, inclusive comissão eventualmente devida por negócio decorrente da intermediação.
**12.1.** Retirada de anúncios. Após encerramento, a INTERMEDIADORA retirará a oferta dos canais sob seu controle em prazo operacional razoável, preservando os registros necessários à comprovação e arquivo da operação.
### 13. PROTEÇÃO DE DADOS
Os dados pessoais serão tratados para execução do Contrato, procedimentos preliminares, atendimento de obrigações legais, exercício regular de direitos, prevenção a fraudes, segurança da operação e, quando necessário, mediante consentimento específico. O titular poderá exercer os direitos previstos em lei pelos canais indicados pela INTERMEDIADORA.
**13.1.** Compartilhamento. Poderão receber dados, na medida necessária: plataforma TotexGest, provedor de assinatura, empresas de vistoria, despachantes, instituições financeiras, meios de pagamento, prestadores tecnológicos, franqueados/parceiros envolvidos na operação e autoridades competentes.
**13.2.** Marketing. Uso de dados para campanhas não diretamente relacionadas à execução da intermediação deverá observar base legal adequada e mecanismo de oposição/revogação quando aplicável.
### 14. ASSINATURA ELETRÔNICA E REGISTROS DIGITAIS
As partes reconhecem a validade de assinaturas eletrônicas e de registros digitais que permitam comprovar autoria, integridade e manifestação de vontade, inclusive por provedor de assinatura eletrônica, token, e-mail, SMS, autenticação, IP, timestamp, hash ou outros mecanismos admitidos pelas partes e pela legislação aplicável.
**14.1.** TotexGest. Eventos, alterações de status, aprovações de preço, propostas, anexos e documentos associados à intermediação poderão ser registrados no TotexGest para fins de operação, auditoria e prova.
**14.2.** Representação da INTERMEDIADORA. A TOTEX DIGITAL MÍDIA LTDA poderá ser representada neste Contrato por administradora com poderes societários vigentes ou por procurador devidamente constituído, dentro dos limites expressos no respectivo instrumento de mandato.
**14.3.** Funcionários e prepostos. Funcionários, gerentes, consultores ou outros prepostos não se tornam parte contratante nem assumem pessoalmente as obrigações da INTERMEDIADORA. Quando assinarem em nome da empresa, deverão fazê-lo na qualidade de procuradores ou representantes autorizados, com poderes suficientes e vigentes para o ato.
**14.4.** Alçadas e exceções. Contratos padronizados poderão ser assinados por procuradores dentro da alçada concedida. Alterações extraordinárias de comissão, assunção de obrigações não padronizadas, concessões financeiras excepcionais, garantias, avais, fianças, endividamento, movimentação bancária ou outros atos fora da rotina dependerão de autorização societária ou administrativa específica conforme a matriz de alçadas vigente.
**14.5.** Validação eletrônica de poderes. Quando o documento for gerado pelo TotexGest, o sistema poderá validar previamente a qualidade do signatário da empresa, a vigência da procuração, os atos permitidos e a alçada aplicável. A assinatura operacional não substitui a necessidade de poderes jurídicos suficientes para o ato.
### 15. COMUNICAÇÕES
As comunicações relacionadas à intermediação poderão ocorrer pelo TotexGest, WhatsApp, e-mail, telefone ou plataforma de assinatura informados pelas partes, devendo alterações de dados de contato ser comunicadas.
### 16. LEGISLAÇÃO E FORO
O Contrato será regido pelas leis da República Federativa do Brasil. Quando aplicável legislação de proteção ao consumidor, será preservado o foro legalmente assegurado ao consumidor; nos demais casos, fica eleito o foro da Comarca de Barueri/SP, sem prejuízo de solução consensual prévia.

## C. ASSINATURAS
Local e data: {{contract.city}}, {{contract.date_long}}.

[[signature:owner]]
**PROPRIETÁRIO / CONTRATANTE**
{{seller.name}} · CPF/CNPJ {{seller.cpf_cnpj}}

[[signature:company]]
**INTERMEDIADORA — {{legal_entity.name}}**
CNPJ {{legal_entity.cnpj}} · Marca: {{brand.name}}
Representada por: {{company_signer.name}} · CPF {{company_signer.cpf}} · Qualidade: {{company_signer.role}}$tpl$,
  ARRAY['legal_entity.name','legal_entity.cnpj','legal_entity.address','company_signer.name','company_signer.cpf','company_signer.role',
        'seller.name','seller.cpf_cnpj','seller.address','seller.city_uf','seller.phone',
        'vehicle.model','vehicle.year','vehicle.plate','vehicle.chassis','vehicle.renavam','vehicle.mileage',
        'intermediation.asking_price','intermediation.commission_text','intermediation.starts_at','intermediation.ends_at','contract.city'],
  now(),
  'v1 = modelo do PRD (Contrato-Mestre v4, Parte I). Revisão final por advogado e contador antes do uso em produção (nota do próprio PRD).'
WHERE NOT EXISTS (SELECT 1 FROM public.contract_templates WHERE tenant_id IS NULL AND document_type = 'INTERMEDIATION_CONTRACT');

-- Quem assina pela Totex hoje (fase 5 troca por procurações): Fabiana é a administradora registrada
UPDATE public.legal_entities SET signer_name = coalesce(signer_name, 'Fabiana dos Anjos Moretti'), signer_role = coalesce(signer_role, 'Administradora'),
       contract_city = coalesce(contract_city, city_name)
WHERE tenant_id = 'c13681e3-5db9-48d1-9c5c-856e6041d77f';
