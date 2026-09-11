-- ============================================================================
-- INTERMEDIAÇÃO — Fase 3: Assinatura eletrônica (2026-09-13)
-- PRD v4, Parte III 13.2.7–13.2.16. Provedor plugável (adapter em
-- supabase/functions/_shared/signature/*); primeiro provedor: Clicksign (API v3, envelopes).
--   • contract_events: todo evento do provedor entra aqui primeiro, com chave de idempotência
--     (provider_event_id ou digest do payload). Depois uma função de domínio calcula a transição.
--   • Transições toleram evento fora de ordem ("signed" antes de "viewed" → estado final prevalece).
--   • "completed" do provedor NÃO formaliza: a edge fn reconcilia via API, baixa o PDF assinado,
--     calcula SHA-256, guarda no bucket e só então chama contract_document_finalize(), que
--     formaliza a intermediação (mesma rotina do import manual) → R$ 25 idempotente.
--   • Chaves por tenant: CLICKSIGN_API_KEY, CLICKSIGN_ENV (sandbox|production), CLICKSIGN_WEBHOOK_SECRET.
--   • Cron contract-reconcile (30 min): documentos sent/partial sem webhook há > 2h são consultados.
-- ============================================================================

-- ─── 1) Colunas ─────────────────────────────────────────────────────────────
ALTER TABLE public.contract_documents
  ADD COLUMN IF NOT EXISTS provider_envelope_id text,
  ADD COLUMN IF NOT EXISTS provider_status      text,
  ADD COLUMN IF NOT EXISTS provider_meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS deadline_at          timestamptz,
  ADD COLUMN IF NOT EXISTS last_event_at        timestamptz,
  ADD COLUMN IF NOT EXISTS last_reconciled_at   timestamptz,
  ADD COLUMN IF NOT EXISTS error_message        text;
CREATE INDEX IF NOT EXISTS contract_documents_envelope_idx ON public.contract_documents(provider, provider_envelope_id) WHERE provider_envelope_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS contract_documents_pending_idx ON public.contract_documents(status, last_event_at) WHERE status IN ('sent', 'partial', 'completed');

ALTER TABLE public.contract_signers
  ADD COLUMN IF NOT EXISTS channel        text CHECK (channel IS NULL OR channel IN ('email', 'whatsapp', 'sms')),
  ADD COLUMN IF NOT EXISTS auth_method    text CHECK (auth_method IS NULL OR auth_method IN ('email', 'whatsapp', 'sms', 'pix')),
  ADD COLUMN IF NOT EXISTS sent_at        timestamptz,
  ADD COLUMN IF NOT EXISTS refused_at     timestamptz,
  ADD COLUMN IF NOT EXISTS refusal_reason text,
  ADD COLUMN IF NOT EXISTS provider_meta  jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Quem assina pela empresa precisa de e-mail/telefone pra receber o convite
ALTER TABLE public.legal_entities
  ADD COLUMN IF NOT EXISTS signer_email text,
  ADD COLUMN IF NOT EXISTS signer_phone text;

-- ─── 2) Eventos do provedor (trilha bruta + idempotência) ────────────────────
CREATE TABLE IF NOT EXISTS public.contract_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  document_id        uuid NOT NULL REFERENCES public.contract_documents(id) ON DELETE CASCADE,
  provider           text NOT NULL,
  provider_event_id  text,
  event_type         text NOT NULL,        -- normalizado: created|sent|viewed|signed|refused|completed|canceled|expired|error|info
  raw_event_name     text,
  signer_ref         text,                 -- provider_signer_id ou e-mail/telefone do signatário
  payload_digest     text NOT NULL,
  payload            jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at        timestamptz,
  received_at        timestamptz NOT NULL DEFAULT now(),
  idempotency_key    text NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS contract_events_doc_idx ON public.contract_events(document_id, received_at DESC);
ALTER TABLE public.contract_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contract_events_select ON public.contract_events;
CREATE POLICY contract_events_select ON public.contract_events FOR SELECT TO authenticated
  USING (NOT public.is_promotora() AND (tenant_id = public.get_tenant_id() OR public.is_superadmin()));
GRANT SELECT ON public.contract_events TO authenticated;
GRANT ALL ON public.contract_events TO service_role;

-- ─── 3) Formalização única (import manual e assinatura eletrônica) ───────────
CREATE OR REPLACE FUNCTION public.intermediation_formalize(
  p_id uuid, p_document_id uuid, p_mode text, p_file_path text, p_sha256 text, p_signed_at timestamptz, p_actor uuid, p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i intermediations%ROWTYPE; v_vid uuid;
BEGIN
  SELECT * INTO i FROM intermediations WHERE id = p_id;
  IF i.id IS NULL THEN RAISE EXCEPTION 'Intermediação não encontrada'; END IF;
  IF i.status = 'active' OR i.activated_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'code', i.code, 'status', i.status);
  END IF;
  IF i.status NOT IN ('lead', 'contracting', 'docs_pending', 'paused') THEN
    RAISE EXCEPTION 'Intermediação % não pode ser formalizada (status %)', i.code, i.status;
  END IF;
  IF p_mode NOT IN ('imported', 'signed') THEN RAISE EXCEPTION 'Modo inválido'; END IF;

  UPDATE intermediations SET
    contract_status = p_mode, contract_signed_at = coalesce(p_signed_at, now()), contract_file_path = p_file_path,
    contract_sha256 = p_sha256, contract_document_id = coalesce(p_document_id, contract_document_id),
    contract_imported_by = CASE WHEN p_mode = 'imported' THEN p_actor ELSE contract_imported_by END,
    contract_import_reason = CASE WHEN p_mode = 'imported' THEN btrim(p_reason) ELSE contract_import_reason END,
    status = 'active', activated_at = now(), status_before_pause = NULL, status_reason = NULL,
    starts_at = coalesce(starts_at, coalesce(p_signed_at, now())::date), updated_by = p_actor
  WHERE id = p_id;
  PERFORM intermediation_log(p_id, 'intermediation_contract_signed',
    jsonb_build_object('mode', p_mode, 'document_id', p_document_id, 'sha256', p_sha256, 'file', p_file_path, 'reason', p_reason), 'contract_signed:' || p_id);

  SELECT id INTO v_vid FROM seller_vehicles WHERE lead_id = i.owner_lead_id ORDER BY created_at DESC LIMIT 1;
  IF v_vid IS NOT NULL THEN
    UPDATE seller_vehicles SET status = 'captado', captured_at = coalesce(captured_at, now()), status_changed_at = now()
    WHERE id = v_vid AND status IN ('lead', 'avaliacao');
  END IF;
  PERFORM intermediation_move_deal(i.owner_lead_id, 'Prepara%');
  RETURN jsonb_build_object('ok', true, 'code', i.code, 'status', 'active', 'document_id', p_document_id);
END;
$$;
REVOKE ALL ON FUNCTION public.intermediation_formalize(uuid, uuid, text, text, text, timestamptz, uuid, text) FROM PUBLIC, anon, authenticated;

-- Import manual passa a usar a rotina única
CREATE OR REPLACE FUNCTION public.intermediation_import_signed_contract(
  p_id uuid, p_file_path text, p_sha256 text, p_signed_at timestamptz DEFAULT now(), p_reason text DEFAULT NULL, p_document_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i intermediations%ROWTYPE; v_doc uuid;
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

  v_doc := coalesce(p_document_id, i.contract_document_id);
  IF v_doc IS NOT NULL AND EXISTS (SELECT 1 FROM contract_documents WHERE id = v_doc AND intermediation_id = p_id) THEN
    UPDATE contract_documents SET status = 'validated', signed_file_path = p_file_path, signed_sha256 = p_sha256,
           completed_at = coalesce(p_signed_at, now()), validated_at = now(), provider = coalesce(provider, 'manual_import'), updated_at = now()
    WHERE id = v_doc;
    UPDATE contract_signers SET status = 'signed', signed_at = coalesce(signed_at, p_signed_at, now()) WHERE document_id = v_doc AND status <> 'signed';
  ELSE
    INSERT INTO contract_documents (tenant_id, intermediation_id, document_type, version, status, snapshot_json, signed_file_path, signed_sha256,
                                    provider, completed_at, validated_at, generated_by)
    VALUES (i.tenant_id, p_id, 'INTERMEDIATION_CONTRACT',
            (SELECT coalesce(max(version), 0) + 1 FROM contract_documents WHERE intermediation_id = p_id AND document_type = 'INTERMEDIATION_CONTRACT'),
            'validated', jsonb_build_object('imported', true, 'reason', p_reason), p_file_path, p_sha256, 'manual_import', coalesce(p_signed_at, now()), now(), public.current_member_id())
    RETURNING id INTO v_doc;
  END IF;
  RETURN public.intermediation_formalize(p_id, v_doc, 'imported', p_file_path, p_sha256, p_signed_at, public.current_member_id(), p_reason);
END;
$$;
GRANT EXECUTE ON FUNCTION public.intermediation_import_signed_contract(uuid, text, text, timestamptz, text, uuid) TO authenticated;

-- ─── 3b) Registro do documento: signatário da empresa recebe e-mail/telefone de quem assina ───
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

  INSERT INTO contract_signers (tenant_id, document_id, party_type, party_id, name, cpf_cnpj, email, phone, signing_order)
  VALUES (i.tenant_id, v_doc.id, 'owner', i.owner_lead_id, coalesce(vars->>'seller.name', 'Proprietário'), vars->>'seller.cpf_cnpj', vars->>'seller.email', vars->>'seller.phone', 1),
         (i.tenant_id, v_doc.id, 'company', i.legal_entity_id, coalesce(vars->>'company_signer.name', vars->>'legal_entity.name', 'TotexMotors'), vars->>'company_signer.cpf',
          coalesce(nullif(le.signer_email, ''), vars->>'legal_entity.email'), coalesce(nullif(le.signer_phone, ''), vars->>'legal_entity.phone'), 2);

  IF p_document_type = 'INTERMEDIATION_CONTRACT' AND i.contract_status NOT IN ('signed', 'imported') THEN
    UPDATE intermediations SET contract_status = 'generated', contract_document_id = v_doc.id, updated_by = p_generated_by WHERE id = p_intermediation;
  END IF;
  PERFORM intermediation_log(p_intermediation, 'intermediation_contract_generated',
    jsonb_build_object('document_id', v_doc.id, 'version', v_version, 'template_version', p_template_version, 'sha256', p_sha256, 'reason', p_reason),
    'contract_generated:' || v_doc.id);
  RETURN to_jsonb(v_doc);
END;
$$;

-- ─── 4) Enviado pro provedor ────────────────────────────────────────────────
-- p_signers: [{signer_id, provider_signer_id, channel, auth_method}]
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
  UPDATE intermediations SET contract_status = 'sent', contract_document_id = p_document_id, updated_by = p_actor
  WHERE id = d.intermediation_id AND contract_status NOT IN ('signed', 'imported');
  PERFORM intermediation_log(d.intermediation_id, 'intermediation_contract_sent',
    jsonb_build_object('document_id', p_document_id, 'version', d.version, 'provider', p_provider, 'envelope', p_envelope_id), 'contract_sent:' || p_document_id);
  RETURN jsonb_build_object('ok', true, 'document_id', p_document_id, 'status', 'sent');
END;
$$;
REVOKE ALL ON FUNCTION public.contract_document_mark_sent(uuid, text, text, text, jsonb, timestamptz, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.contract_document_mark_sent(uuid, text, text, text, jsonb, timestamptz, jsonb, uuid) TO service_role;

-- ─── 5) Evento do provedor → transição (idempotente, tolera fora de ordem) ───
-- p_event: {provider, provider_event_id?, event_type, raw_event_name?, signer_ref?, occurred_at?, payload}
-- signer_ref casa com contract_signers.provider_signer_id, ou e-mail, ou telefone (só dígitos).
-- Retorna {applied, duplicate, document_status, all_signed, intermediation_id}
CREATE OR REPLACE FUNCTION public.contract_apply_provider_event(p_document_id uuid, p_event jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  d contract_documents%ROWTYPE; v_type text := lower(coalesce(p_event->>'event_type', 'info')); v_key text; v_digest text;
  v_ref text := nullif(p_event->>'signer_ref', ''); v_sid uuid; v_occ timestamptz := coalesce((p_event->>'occurred_at')::timestamptz, now());
  v_all_signed boolean; v_any boolean; v_new_status text; v_ins int;
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

  -- signatário afetado
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

  -- estado do documento: terminal nunca regride
  IF d.status IN ('validated', 'archived') THEN
    v_new_status := d.status;
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

  -- espelho no card da intermediação (só antes de formalizada)
  UPDATE intermediations SET contract_status = CASE v_new_status WHEN 'sent' THEN 'sent' WHEN 'partial' THEN 'partial' WHEN 'completed' THEN 'partial'
                                                                 WHEN 'declined' THEN 'declined' WHEN 'expired' THEN 'expired' WHEN 'cancelled' THEN 'cancelled' ELSE contract_status END
  WHERE id = d.intermediation_id AND contract_status NOT IN ('signed', 'imported') AND contract_document_id = p_document_id;

  PERFORM intermediation_log(d.intermediation_id, 'contract_provider_event',
    jsonb_build_object('document_id', p_document_id, 'event_type', v_type, 'raw', p_event->>'raw_event_name', 'signer', v_ref, 'document_status', v_new_status));
  RETURN jsonb_build_object('applied', true, 'duplicate', false, 'document_status', v_new_status, 'all_signed', coalesce(v_all_signed, false), 'intermediation_id', d.intermediation_id);
END;
$$;
REVOKE ALL ON FUNCTION public.contract_apply_provider_event(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.contract_apply_provider_event(uuid, jsonb) TO service_role;

-- ─── 6) Finalizar: PDF assinado baixado e conferido → validated → FORMALIZADA ─
CREATE OR REPLACE FUNCTION public.contract_document_finalize(p_document_id uuid, p_signed_path text, p_sha256 text, p_provider_status jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d contract_documents%ROWTYPE; r jsonb;
BEGIN
  SELECT * INTO d FROM contract_documents WHERE id = p_document_id;
  IF d.id IS NULL THEN RAISE EXCEPTION 'Documento não encontrado'; END IF;
  IF coalesce(p_sha256, '') !~ '^[0-9a-f]{64}$' OR coalesce(p_signed_path, '') = '' THEN RAISE EXCEPTION 'PDF assinado e SHA-256 obrigatórios'; END IF;
  IF d.status = 'validated' THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'document_id', p_document_id) || public.intermediation_formalize(d.intermediation_id, p_document_id, 'signed', d.signed_file_path, d.signed_sha256, d.completed_at, NULL);
  END IF;
  IF d.status IN ('cancelled', 'declined', 'expired') THEN RAISE EXCEPTION 'Documento v% está %; não pode ser finalizado', d.version, d.status; END IF;

  UPDATE contract_documents SET status = 'validated', signed_file_path = p_signed_path, signed_sha256 = p_sha256,
         completed_at = coalesce(completed_at, now()), validated_at = now(), last_reconciled_at = now(),
         provider_meta = provider_meta || coalesce(p_provider_status, '{}'::jsonb), provider_status = 'closed', updated_at = now()
  WHERE id = p_document_id;
  UPDATE contract_signers SET status = 'signed', signed_at = coalesce(signed_at, now()) WHERE document_id = p_document_id AND status <> 'signed';
  PERFORM intermediation_log(d.intermediation_id, 'contract_validated', jsonb_build_object('document_id', p_document_id, 'sha256', p_sha256, 'provider', d.provider), 'contract_validated:' || p_document_id);
  r := public.intermediation_formalize(d.intermediation_id, p_document_id, 'signed', p_signed_path, p_sha256, coalesce(d.completed_at, now()), NULL);
  RETURN jsonb_build_object('ok', true, 'document_id', p_document_id) || r;
END;
$$;
REVOKE ALL ON FUNCTION public.contract_document_finalize(uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.contract_document_finalize(uuid, text, text, jsonb) TO service_role;

-- Cancelamento local (a edge fn cancela no provedor antes) / erro
CREATE OR REPLACE FUNCTION public.contract_document_set_status(p_document_id uuid, p_status text, p_reason text DEFAULT NULL, p_actor uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d contract_documents%ROWTYPE;
BEGIN
  IF p_status NOT IN ('cancelled', 'error', 'ready') THEN RAISE EXCEPTION 'Status inválido'; END IF;
  SELECT * INTO d FROM contract_documents WHERE id = p_document_id;
  IF d.id IS NULL THEN RAISE EXCEPTION 'Documento não encontrado'; END IF;
  IF d.status = 'validated' THEN RAISE EXCEPTION 'Documento assinado não muda de status'; END IF;
  UPDATE contract_documents SET status = p_status,
         cancelled_at = CASE WHEN p_status = 'cancelled' THEN now() ELSE cancelled_at END,
         cancel_reason = CASE WHEN p_status = 'cancelled' THEN p_reason ELSE cancel_reason END,
         error_message = CASE WHEN p_status = 'error' THEN p_reason ELSE NULL END, updated_at = now()
  WHERE id = p_document_id;
  IF p_status = 'cancelled' THEN
    UPDATE intermediations SET contract_status = 'cancelled', updated_by = p_actor
    WHERE id = d.intermediation_id AND contract_document_id = p_document_id AND contract_status NOT IN ('signed', 'imported');
  END IF;
  PERFORM intermediation_log(d.intermediation_id, 'contract_document_' || p_status, jsonb_build_object('document_id', p_document_id, 'reason', p_reason));
END;
$$;
REVOKE ALL ON FUNCTION public.contract_document_set_status(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.contract_document_set_status(uuid, text, text, uuid) TO service_role;

-- Documentos que o job de reconciliação deve consultar (service_role)
CREATE OR REPLACE FUNCTION public.contract_documents_to_reconcile(p_stale_minutes integer DEFAULT 120)
RETURNS SETOF public.contract_documents LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT * FROM contract_documents
  WHERE provider_envelope_id IS NOT NULL
    AND (status = 'completed'
         OR (status IN ('sent', 'partial') AND coalesce(last_event_at, sent_at, created_at) < now() - make_interval(mins => p_stale_minutes))
         OR (status IN ('sent', 'partial') AND deadline_at IS NOT NULL AND deadline_at < now()))
  ORDER BY (status = 'completed') DESC, coalesce(last_event_at, sent_at) LIMIT 50;
$$;
REVOKE ALL ON FUNCTION public.contract_documents_to_reconcile(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.contract_documents_to_reconcile(integer) TO service_role;

-- ─── 7) Chaves por tenant: webhook secret ────────────────────────────────────
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
    'CLICKSIGN_API_KEY', 'CLICKSIGN_ENV', 'CLICKSIGN_WEBHOOK_SECRET'
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

-- Localizar o documento (e o tenant) a partir do id do provedor — usado pelo webhook antes de validar o HMAC
CREATE OR REPLACE FUNCTION public.contract_document_by_provider_ref(p_provider text, p_ref text)
RETURNS TABLE (document_id uuid, tenant_id uuid, intermediation_id uuid, status text, provider_envelope_id text, provider_document_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id, tenant_id, intermediation_id, status, provider_envelope_id, provider_document_id FROM contract_documents
  WHERE provider = p_provider AND (provider_document_id = p_ref OR provider_envelope_id = p_ref)
  ORDER BY created_at DESC LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.contract_document_by_provider_ref(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.contract_document_by_provider_ref(text, text) TO service_role;

-- ─── 8) Cron de reconciliação (30 min) ───────────────────────────────────────
DO $$ DECLARE v_url text; j record; BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN RAISE NOTICE 'pg_cron ausente'; RETURN; END IF;
  SELECT value INTO v_url FROM public.config WHERE key = 'SUPABASE_PROJECT_URL';
  v_url := rtrim(coalesce(v_url, ''), '/');
  IF v_url = '' OR v_url NOT LIKE 'http%' THEN RAISE WARNING 'SUPABASE_PROJECT_URL ausente'; RETURN; END IF;
  FOR j IN SELECT jobid FROM cron.job WHERE jobname = 'contract-reconcile' LOOP PERFORM cron.unschedule(j.jobid); END LOOP;
  PERFORM cron.schedule('contract-reconcile', '*/30 * * * *',
    format($f$SELECT net.http_post(url := %L, headers := '{"Content-Type":"application/json"}'::jsonb, body := '{"mode":"reconcile"}'::jsonb)$f$, v_url || '/functions/v1/contract-reconcile'));
END $$;
