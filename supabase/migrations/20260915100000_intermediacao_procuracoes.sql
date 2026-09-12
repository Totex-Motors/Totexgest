-- ============================================================================
-- INTERMEDIAÇÃO — Fase 5a: Representação / procurações (2026-09-15)
-- PRD v4 §14 (representação, prepostos, alçadas, validação eletrônica de poderes).
-- Quem assina pela empresa deixa de ser um nome fixo em legal_entities e passa a
-- vir de `powers_of_attorney` (administradora ou procurador, com escopo, alçada de
-- valor, validade e poder de aprovar exceções). O padrão (is_default) é espelhado
-- em legal_entities.signer_* — então o snapshot/contrato continua funcionando sem
-- alteração. Cada documento gerado registra a autoridade usada (auditoria).
-- ============================================================================

-- ─── 1) Procurações / representação ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.powers_of_attorney (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  legal_entity_id uuid,                                  -- null = vale pra qualquer entidade jurídica do tenant
  member_id       uuid,                                  -- team_member correspondente (opcional)
  signer_name     text NOT NULL,
  signer_cpf      text,
  signer_role     text NOT NULL DEFAULT 'Procurador' CHECK (signer_role IN ('Administradora','Administrador','Procuradora','Procurador')),
  signature_mode  text NOT NULL DEFAULT 'isolated' CHECK (signature_mode IN ('isolated','joint')),
  doc_number      text,                                  -- nº da procuração / ato societário
  doc_url         text,
  scopes          text[] NOT NULL DEFAULT ARRAY['*'],    -- document_types que pode assinar, ou ['*']
  max_value       numeric,                               -- alçada de valor por ato (null = ilimitado)
  can_approve     boolean NOT NULL DEFAULT false,        -- decide exceções (alçadas) — administradora = true
  valid_from      date,
  valid_until     date,
  is_default      boolean NOT NULL DEFAULT false,        -- assina por padrão
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS powers_of_attorney_tenant_idx ON public.powers_of_attorney(tenant_id, status);
-- um único padrão por (tenant, entidade jurídica)
CREATE UNIQUE INDEX IF NOT EXISTS powers_of_attorney_default_idx
  ON public.powers_of_attorney(tenant_id, coalesce(legal_entity_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE is_default AND status = 'active';
ALTER TABLE public.powers_of_attorney ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS powers_of_attorney_select ON public.powers_of_attorney;
CREATE POLICY powers_of_attorney_select ON public.powers_of_attorney FOR SELECT TO authenticated
  USING (NOT public.is_promotora() AND (tenant_id = public.get_tenant_id() OR public.is_superadmin()));
GRANT SELECT ON public.powers_of_attorney TO authenticated;
GRANT ALL ON public.powers_of_attorney TO service_role;

-- autoridade usada em cada documento (auditoria)
ALTER TABLE public.contract_documents ADD COLUMN IF NOT EXISTS company_authority jsonb;

-- ─── 2) Helper: quem pode aprovar exceções (alçadas) ────────────────────────
CREATE OR REPLACE FUNCTION public.member_can_approve(p_member uuid DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.is_superadmin()
      OR EXISTS (
        SELECT 1 FROM powers_of_attorney p
        JOIN team_members m ON m.id = coalesce(p_member, public.current_member_id())
        WHERE p.tenant_id = m.tenant_id AND p.can_approve AND p.status = 'active'
          AND p.member_id = m.id
          AND (p.valid_until IS NULL OR p.valid_until >= current_date)
      )
      OR public.is_admin();  -- admin do tenant sempre pode (fallback operacional)
$$;
GRANT EXECUTE ON FUNCTION public.member_can_approve(uuid) TO authenticated;

-- ─── 3) Procuração padrão que cobre um tipo de documento ────────────────────
CREATE OR REPLACE FUNCTION public.poa_active_default(p_tenant uuid, p_legal_entity uuid, p_document_type text DEFAULT NULL)
RETURNS powers_of_attorney LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT * FROM powers_of_attorney p
  WHERE p.tenant_id = p_tenant AND p.status = 'active'
    AND (p.legal_entity_id IS NULL OR p.legal_entity_id = p_legal_entity)
    AND (p.valid_until IS NULL OR p.valid_until >= current_date)
    AND (p.valid_from IS NULL OR p.valid_from <= current_date)
    AND (p_document_type IS NULL OR p.scopes @> ARRAY['*'] OR p.scopes @> ARRAY[p_document_type])
  ORDER BY (p.legal_entity_id = p_legal_entity) DESC, p.is_default DESC, (p.signer_role LIKE 'Administrador%') DESC, p.created_at
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.poa_active_default(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.poa_active_default(uuid, uuid, text) TO authenticated, service_role;

-- ─── 4) CRUD (admin) ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.poa_upsert(p_data jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid := public.get_tenant_id(); v_id uuid := nullif(p_data->>'id','')::uuid; v_le uuid := nullif(p_data->>'legal_entity_id','')::uuid;
BEGIN
  IF NOT (public.is_admin() OR public.is_superadmin()) THEN RAISE EXCEPTION 'Só admin gerencia procurações'; END IF;
  IF length(coalesce(btrim(p_data->>'signer_name'),'')) < 3 THEN RAISE EXCEPTION 'Informe o nome de quem assina'; END IF;
  IF v_id IS NULL THEN
    INSERT INTO powers_of_attorney (tenant_id, legal_entity_id, member_id, signer_name, signer_cpf, signer_role, signature_mode,
      doc_number, doc_url, scopes, max_value, can_approve, valid_from, valid_until, notes, created_by)
    VALUES (v_tenant, v_le, nullif(p_data->>'member_id','')::uuid, btrim(p_data->>'signer_name'), nullif(p_data->>'signer_cpf',''),
      coalesce(nullif(p_data->>'signer_role',''),'Procurador'), coalesce(nullif(p_data->>'signature_mode',''),'isolated'),
      nullif(p_data->>'doc_number',''), nullif(p_data->>'doc_url',''),
      coalesce((SELECT array_agg(value) FROM jsonb_array_elements_text(coalesce(p_data->'scopes','["*"]'::jsonb))), ARRAY['*']),
      nullif(p_data->>'max_value','')::numeric, coalesce((p_data->>'can_approve')::boolean, false),
      nullif(p_data->>'valid_from','')::date, nullif(p_data->>'valid_until','')::date, nullif(p_data->>'notes',''), public.current_member_id())
    RETURNING id INTO v_id;
  ELSE
    UPDATE powers_of_attorney SET
      legal_entity_id = v_le, member_id = nullif(p_data->>'member_id','')::uuid, signer_name = btrim(p_data->>'signer_name'),
      signer_cpf = nullif(p_data->>'signer_cpf',''), signer_role = coalesce(nullif(p_data->>'signer_role',''), signer_role),
      signature_mode = coalesce(nullif(p_data->>'signature_mode',''), signature_mode), doc_number = nullif(p_data->>'doc_number',''),
      doc_url = nullif(p_data->>'doc_url',''),
      scopes = coalesce((SELECT array_agg(value) FROM jsonb_array_elements_text(p_data->'scopes')), scopes),
      max_value = nullif(p_data->>'max_value','')::numeric, can_approve = coalesce((p_data->>'can_approve')::boolean, can_approve),
      valid_from = nullif(p_data->>'valid_from','')::date, valid_until = nullif(p_data->>'valid_until','')::date,
      notes = nullif(p_data->>'notes',''), updated_at = now()
    WHERE id = v_id AND (tenant_id = v_tenant OR public.is_superadmin());
  END IF;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.poa_upsert(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.poa_set_status(p_id uuid, p_status text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (public.is_admin() OR public.is_superadmin()) THEN RAISE EXCEPTION 'Só admin'; END IF;
  IF p_status NOT IN ('active','revoked','expired') THEN RAISE EXCEPTION 'Status inválido'; END IF;
  UPDATE powers_of_attorney SET status = p_status, is_default = CASE WHEN p_status <> 'active' THEN false ELSE is_default END, updated_at = now()
  WHERE id = p_id AND (tenant_id = public.get_tenant_id() OR public.is_superadmin());
END;
$$;
GRANT EXECUTE ON FUNCTION public.poa_set_status(uuid, text) TO authenticated;

-- Define o padrão e ESPELHA em legal_entities.signer_* (snapshot/contrato usa isso).
CREATE OR REPLACE FUNCTION public.poa_set_default(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p powers_of_attorney%ROWTYPE; v_le uuid;
BEGIN
  IF NOT (public.is_admin() OR public.is_superadmin()) THEN RAISE EXCEPTION 'Só admin'; END IF;
  SELECT * INTO p FROM powers_of_attorney WHERE id = p_id;
  IF p.id IS NULL OR (p.tenant_id <> public.get_tenant_id() AND NOT public.is_superadmin()) THEN RAISE EXCEPTION 'Procuração não encontrada'; END IF;
  IF p.status <> 'active' THEN RAISE EXCEPTION 'Só uma procuração ativa pode ser o padrão'; END IF;
  UPDATE powers_of_attorney SET is_default = false
  WHERE tenant_id = p.tenant_id AND coalesce(legal_entity_id,'00000000-0000-0000-0000-000000000000'::uuid) = coalesce(p.legal_entity_id,'00000000-0000-0000-0000-000000000000'::uuid) AND id <> p_id;
  UPDATE powers_of_attorney SET is_default = true, updated_at = now() WHERE id = p_id;
  -- espelha nas entidades jurídicas alvo (a específica, ou todas do tenant se legal_entity_id null)
  UPDATE legal_entities SET signer_name = p.signer_name, signer_cpf = coalesce(p.signer_cpf, signer_cpf),
         signer_role = p.signer_role, updated_at = now()
  WHERE tenant_id = p.tenant_id AND (p.legal_entity_id IS NULL OR id = p.legal_entity_id);
  RETURN jsonb_build_object('ok', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.poa_set_default(uuid) TO authenticated;

-- ─── 5) Register grava a autoridade usada no documento ──────────────────────
-- (regénera a função da Fase 4 adicionando company_authority a partir da procuração padrão)
CREATE OR REPLACE FUNCTION public.contract_document_register(
  p_intermediation uuid, p_document_type text, p_template_id uuid, p_template_version integer,
  p_snapshot jsonb, p_file_path text, p_sha256 text, p_generated_by uuid DEFAULT NULL, p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i intermediations%ROWTYPE; le legal_entities%ROWTYPE; poa powers_of_attorney%ROWTYPE; v_auth jsonb;
        v_version integer; v_doc contract_documents%ROWTYPE; vars jsonb := coalesce(p_snapshot->'variables', p_snapshot);
BEGIN
  SELECT * INTO i FROM intermediations WHERE id = p_intermediation;
  IF i.id IS NULL THEN RAISE EXCEPTION 'Intermediação não encontrada'; END IF;
  IF coalesce(p_sha256, '') !~ '^[0-9a-f]{64}$' OR coalesce(p_file_path, '') = '' THEN RAISE EXCEPTION 'Arquivo e SHA-256 obrigatórios'; END IF;
  IF i.legal_entity_id IS NOT NULL THEN SELECT * INTO le FROM legal_entities WHERE id = i.legal_entity_id; END IF;

  poa := public.poa_active_default(i.tenant_id, i.legal_entity_id, p_document_type);
  IF poa.id IS NOT NULL THEN
    v_auth := jsonb_build_object('poa_id', poa.id, 'signer_name', poa.signer_name, 'signer_cpf', poa.signer_cpf,
      'signer_role', poa.signer_role, 'doc_number', poa.doc_number, 'valid_until', poa.valid_until,
      'max_value', poa.max_value, 'checked_at', now());
  END IF;

  UPDATE contract_documents SET status = 'cancelled', cancelled_at = now(), cancel_reason = coalesce(p_reason, 'Nova versão gerada'), updated_at = now()
  WHERE intermediation_id = p_intermediation AND document_type = p_document_type AND status IN ('draft', 'generated', 'ready', 'error');
  SELECT coalesce(max(version), 0) + 1 INTO v_version FROM contract_documents WHERE intermediation_id = p_intermediation AND document_type = p_document_type;

  INSERT INTO contract_documents (tenant_id, intermediation_id, document_type, template_id, template_version, version, status, snapshot_json,
                                  rendered_file_path, rendered_sha256, generated_at, generated_by, company_authority)
  VALUES (i.tenant_id, p_intermediation, p_document_type, p_template_id, p_template_version, v_version, 'generated', p_snapshot,
          p_file_path, p_sha256, now(), p_generated_by, v_auth)
  RETURNING * INTO v_doc;

  INSERT INTO contract_signers (tenant_id, document_id, party_type, party_id, name, cpf_cnpj, email, phone, signing_order)
  VALUES (i.tenant_id, v_doc.id, 'owner', i.owner_lead_id, coalesce(vars->>'seller.name', 'Proprietário'), vars->>'seller.cpf_cnpj', vars->>'seller.email', vars->>'seller.phone', 1);
  IF p_document_type = 'SALE_CONTRACT' THEN
    INSERT INTO contract_signers (tenant_id, document_id, party_type, party_id, name, cpf_cnpj, email, phone, signing_order)
    VALUES (i.tenant_id, v_doc.id, 'buyer', i.buyer_lead_id, coalesce(vars->>'buyer.name', 'Comprador'), vars->>'buyer.cpf_cnpj', vars->>'buyer.email', vars->>'buyer.phone', 2);
  END IF;
  INSERT INTO contract_signers (tenant_id, document_id, party_type, party_id, name, cpf_cnpj, email, phone, signing_order)
  VALUES (i.tenant_id, v_doc.id, 'company', i.legal_entity_id,
          coalesce(nullif(poa.signer_name,''), vars->>'company_signer.name', vars->>'legal_entity.name', 'TotexMotors'),
          coalesce(nullif(poa.signer_cpf,''), vars->>'company_signer.cpf'),
          coalesce(nullif(le.signer_email, ''), vars->>'legal_entity.email'), coalesce(nullif(le.signer_phone, ''), vars->>'legal_entity.phone'),
          CASE WHEN p_document_type = 'SALE_CONTRACT' THEN 3 ELSE 2 END);

  IF p_document_type = 'INTERMEDIATION_CONTRACT' AND i.contract_status NOT IN ('signed', 'imported') THEN
    UPDATE intermediations SET contract_status = 'generated', contract_document_id = v_doc.id, updated_by = p_generated_by WHERE id = p_intermediation;
  ELSIF p_document_type = 'SALE_CONTRACT' AND i.sale_contract_status NOT IN ('signed', 'imported') THEN
    UPDATE intermediations SET sale_contract_status = 'generated', sale_document_id = v_doc.id, updated_by = p_generated_by WHERE id = p_intermediation;
  END IF;
  PERFORM intermediation_log(p_intermediation, 'intermediation_document_generated',
    jsonb_build_object('document_id', v_doc.id, 'document_type', p_document_type, 'version', v_version, 'template_version', p_template_version, 'sha256', p_sha256, 'authority', v_auth, 'reason', p_reason),
    'doc_generated:' || v_doc.id);
  RETURN to_jsonb(v_doc);
END;
$$;

-- ─── 6) Seed: administradora padrão de cada entidade jurídica + Renata (Totex) ──
-- Fabiana (ou o signatário já configurado) vira a procuração padrão de cada tenant.
INSERT INTO public.powers_of_attorney (tenant_id, legal_entity_id, signer_name, signer_cpf, signer_role, signature_mode, scopes, can_approve, is_default, notes)
SELECT le.tenant_id, le.id, le.signer_name, le.signer_cpf, coalesce(le.signer_role, 'Administradora'), 'isolated', ARRAY['*'], true, true,
       'Migrado de legal_entities (Fase 5a)'
FROM legal_entities le
WHERE le.signer_name IS NOT NULL AND btrim(le.signer_name) <> ''
  AND NOT EXISTS (SELECT 1 FROM powers_of_attorney p WHERE p.tenant_id = le.tenant_id AND coalesce(p.legal_entity_id,'00000000-0000-0000-0000-000000000000'::uuid) = le.id);

-- Renata como segunda administradora da Totex (CPF a preencher na UI).
INSERT INTO public.powers_of_attorney (tenant_id, legal_entity_id, signer_name, signer_role, signature_mode, scopes, can_approve, is_default, notes)
SELECT 'c13681e3-5db9-48d1-9c5c-856e6041d77f'::uuid, NULL, 'Renata Parentel Gomes de Souza Leite', 'Administradora', 'isolated', ARRAY['*'], true, false,
       'Sócia-administradora (alteração societária formalizada). Preencher CPF e nº do ato.'
WHERE EXISTS (SELECT 1 FROM legal_entities WHERE tenant_id = 'c13681e3-5db9-48d1-9c5c-856e6041d77f'::uuid)
  AND NOT EXISTS (SELECT 1 FROM powers_of_attorney WHERE tenant_id = 'c13681e3-5db9-48d1-9c5c-856e6041d77f'::uuid AND signer_name ILIKE 'Renata%');
