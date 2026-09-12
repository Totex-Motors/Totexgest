-- ============================================================================
-- INTERMEDIAÇÃO — Fase 5b: Alçadas / fila de aprovação (2026-09-15)
-- PRD v4 §14.4 (matriz de alçadas). Quatro atos passam por aprovação de uma
-- administradora (quem tem procuração com can_approve) antes de acontecer:
--   1. vender abaixo do preço mínimo autorizado  (sell_below_minimum)
--   2. alterar/renunciar comissão fora do padrão (commission_change / commission_waive)
--   3. cancelar/encerrar intermediação ativa      (cancel_active)
--   4. concessão financeira excepcional            (financial_concession)
-- Regra de ouro: quem TEM a alçada (member_can_approve) executa direto; quem não
-- tem, abre um pedido que a administradora decide. Aprovar aplica o efeito.
-- ============================================================================

-- ─── 1) Colunas de concessão ────────────────────────────────────────────────
ALTER TABLE public.intermediations
  ADD COLUMN IF NOT EXISTS financial_concessions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS concession_total numeric NOT NULL DEFAULT 0;

-- ─── 2) Fila de aprovação ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.approval_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  intermediation_id uuid REFERENCES public.intermediations(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('sell_below_minimum','commission_change','commission_waive','cancel_active','financial_concession')),
  title             text,
  params            jsonb NOT NULL DEFAULT '{}'::jsonb,
  amount            numeric,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  requested_by      uuid,
  requested_at      timestamptz NOT NULL DEFAULT now(),
  decided_by        uuid,
  decided_at        timestamptz,
  decision_note     text,
  applied_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS approval_requests_tenant_status_idx ON public.approval_requests(tenant_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS approval_requests_int_idx ON public.approval_requests(intermediation_id);
ALTER TABLE public.approval_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS approval_requests_select ON public.approval_requests;
CREATE POLICY approval_requests_select ON public.approval_requests FOR SELECT TO authenticated
  USING (NOT public.is_promotora() AND (tenant_id = public.get_tenant_id() OR public.is_superadmin()));
GRANT SELECT ON public.approval_requests TO authenticated;
GRANT ALL ON public.approval_requests TO service_role;

-- abre um pedido (chamado de dentro das RPCs de domínio; não exposto direto)
CREATE OR REPLACE FUNCTION public.approval_open(p_kind text, p_int uuid, p_title text, p_params jsonb, p_amount numeric DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid; v_id uuid;
BEGIN
  SELECT tenant_id INTO v_tenant FROM intermediations WHERE id = p_int;
  v_tenant := coalesce(v_tenant, public.get_tenant_id());
  -- já existe pedido pendente igual? reaproveita (idempotência leve)
  SELECT id INTO v_id FROM approval_requests
  WHERE intermediation_id = p_int AND kind = p_kind AND status = 'pending'
    AND params = coalesce(p_params, '{}'::jsonb) LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  INSERT INTO approval_requests (tenant_id, intermediation_id, kind, title, params, amount, requested_by)
  VALUES (v_tenant, p_int, p_kind, p_title, coalesce(p_params, '{}'::jsonb), p_amount, public.current_member_id())
  RETURNING id INTO v_id;
  PERFORM intermediation_log(p_int, 'approval_requested', jsonb_build_object('request_id', v_id, 'kind', p_kind, 'title', p_title, 'amount', p_amount));
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.approval_open(text, uuid, text, jsonb, numeric) FROM PUBLIC, anon, authenticated;

-- ─── 3) Ações de domínio conscientes da alçada ──────────────────────────────
-- Dropar as assinaturas antigas (3 args) — as novas ganham p_via_approval (4 args).
DROP FUNCTION IF EXISTS public.intermediation_decide_proposal(uuid, text, text);
DROP FUNCTION IF EXISTS public.intermediation_set_status(uuid, text, text);
DROP FUNCTION IF EXISTS public.intermediation_set_commission(uuid, text, numeric);

-- aceitar proposta (Fase 4) + trava "abaixo do mínimo"
CREATE OR REPLACE FUNCTION public.intermediation_decide_proposal(p_proposal_id uuid, p_decision text, p_note text DEFAULT NULL, p_via_approval boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p intermediation_proposals%ROWTYPE; i intermediations%ROWTYPE; v_req uuid;
BEGIN
  IF public.is_promotora() THEN RAISE EXCEPTION 'Sem acesso'; END IF;
  IF p_decision NOT IN ('accepted', 'rejected') THEN RAISE EXCEPTION 'Decisão inválida'; END IF;
  SELECT * INTO p FROM intermediation_proposals WHERE id = p_proposal_id;
  IF p.id IS NULL OR (p.tenant_id <> public.get_tenant_id() AND NOT public.is_superadmin()) THEN RAISE EXCEPTION 'Proposta não encontrada'; END IF;
  IF p.status <> 'pending' THEN RAISE EXCEPTION 'Proposta já foi decidida (%).', p.status; END IF;
  SELECT * INTO i FROM intermediations WHERE id = p.intermediation_id;

  -- ALÇADA: aceitar abaixo do preço mínimo autorizado precisa de aprovação
  IF p_decision = 'accepted' AND coalesce(i.minimum_authorized_price, 0) > 0 AND p.amount < i.minimum_authorized_price
     AND NOT p_via_approval AND NOT public.member_can_approve() THEN
    v_req := public.approval_open('sell_below_minimum', p.intermediation_id,
      'Aceitar proposta abaixo do mínimo — ' || i.code,
      jsonb_build_object('proposal_id', p_proposal_id, 'amount', p.amount, 'minimum', i.minimum_authorized_price), p.amount);
    RETURN jsonb_build_object('ok', false, 'needs_approval', true, 'request_id', v_req, 'kind', 'sell_below_minimum');
  END IF;

  UPDATE intermediation_proposals SET status = p_decision, decided_by = public.current_member_id(), decided_at = now(), decision_note = nullif(btrim(p_note), '')
  WHERE id = p_proposal_id;

  IF p_decision = 'accepted' THEN
    UPDATE intermediation_proposals SET status = 'superseded' WHERE intermediation_id = p.intermediation_id AND id <> p_proposal_id AND status = 'pending';
    UPDATE intermediations SET
      sale_price = p.amount, payment_method = coalesce(p.payment_method, payment_method),
      down_payment = coalesce(p.down_payment, down_payment), financed_amount = coalesce(p.financed_amount, financed_amount),
      installments = coalesce(p.installments, installments), buyer_lead_id = coalesce(p.buyer_lead_id, buyer_lead_id),
      buyer_data = CASE WHEN coalesce(buyer_data->>'name','') = '' AND p.buyer_name IS NOT NULL THEN buyer_data || jsonb_build_object('name', p.buyer_name) ELSE buyer_data END,
      updated_by = public.current_member_id()
    WHERE id = p.intermediation_id;
    PERFORM intermediation_move_deal(i.owner_lead_id, 'Fechamento%');
  END IF;
  PERFORM intermediation_log(p.intermediation_id, 'buyer_proposal_' || p_decision, jsonb_build_object('proposal_id', p_proposal_id, 'amount', p.amount, 'note', p_note, 'via_approval', p_via_approval), NULL);
  RETURN jsonb_build_object('ok', true, 'decision', p_decision);
END;
$$;
GRANT EXECUTE ON FUNCTION public.intermediation_decide_proposal(uuid, text, text, boolean) TO authenticated;

-- alterar termos da comissão (novo) — alçada commission_change
CREATE OR REPLACE FUNCTION public.intermediation_change_commission(p_id uuid, p_type text, p_value numeric, p_reason text DEFAULT NULL, p_via_approval boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i intermediations%ROWTYPE; v_req uuid;
BEGIN
  IF public.is_promotora() THEN RAISE EXCEPTION 'Sem acesso'; END IF;
  SELECT * INTO i FROM intermediations WHERE id = p_id;
  IF i.id IS NULL OR (i.tenant_id <> public.get_tenant_id() AND NOT public.is_superadmin()) THEN RAISE EXCEPTION 'Intermediação não encontrada'; END IF;
  IF p_type NOT IN ('fixed','percent') THEN RAISE EXCEPTION 'Tipo de comissão inválido'; END IF;
  IF coalesce(p_value,0) < 0 THEN RAISE EXCEPTION 'Valor inválido'; END IF;
  IF NOT p_via_approval AND NOT public.member_can_approve() THEN
    v_req := public.approval_open('commission_change', p_id, 'Alterar comissão — ' || i.code,
      jsonb_build_object('commission_type', p_type, 'commission_value', p_value, 'reason', nullif(btrim(p_reason),'')), NULL);
    RETURN jsonb_build_object('ok', false, 'needs_approval', true, 'request_id', v_req, 'kind', 'commission_change');
  END IF;
  UPDATE intermediations SET commission_type = p_type, commission_value = p_value, updated_by = public.current_member_id() WHERE id = p_id;
  PERFORM intermediation_log(p_id, 'commission_changed', jsonb_build_object('type', p_type, 'value', p_value, 'reason', p_reason, 'via_approval', p_via_approval));
  RETURN jsonb_build_object('ok', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.intermediation_change_commission(uuid, text, numeric, text, boolean) TO authenticated;

-- comissão lifecycle + renúncia (waived precisa de alçada)
CREATE OR REPLACE FUNCTION public.intermediation_set_commission(p_id uuid, p_status text, p_amount numeric DEFAULT NULL, p_via_approval boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i intermediations%ROWTYPE; v_req uuid;
BEGIN
  IF p_status NOT IN ('pending', 'invoiced', 'paid', 'waived', 'disputed') THEN RAISE EXCEPTION 'Status inválido'; END IF;
  SELECT * INTO i FROM intermediations WHERE id = p_id;
  IF i.id IS NULL OR (i.tenant_id <> public.get_tenant_id() AND NOT public.is_superadmin()) THEN RAISE EXCEPTION 'Intermediação não encontrada'; END IF;
  -- renúncia de comissão = alçada
  IF p_status = 'waived' AND NOT p_via_approval AND NOT public.member_can_approve() THEN
    v_req := public.approval_open('commission_waive', p_id, 'Renunciar comissão — ' || i.code, jsonb_build_object('amount', coalesce(p_amount, i.commission_due)), coalesce(p_amount, i.commission_due));
    RETURN jsonb_build_object('ok', false, 'needs_approval', true, 'request_id', v_req, 'kind', 'commission_waive');
  END IF;
  IF NOT (public.is_admin() OR public.is_superadmin() OR p_via_approval OR public.member_can_approve()) THEN RAISE EXCEPTION 'Sem alçada para comissão'; END IF;
  UPDATE intermediations SET commission_status = p_status, commission_due = coalesce(p_amount, commission_due),
         commission_paid_at = CASE WHEN p_status = 'paid' THEN now() ELSE commission_paid_at END, updated_by = public.current_member_id()
  WHERE id = p_id;
  PERFORM intermediation_log(p_id, CASE p_status WHEN 'paid' THEN 'commission_paid' WHEN 'invoiced' THEN 'commission_invoiced' WHEN 'waived' THEN 'commission_waived' ELSE 'commission_status_changed' END,
                             jsonb_build_object('status', p_status, 'amount', p_amount, 'via_approval', p_via_approval));
  RETURN jsonb_build_object('ok', true, 'status', p_status);
END;
$$;
GRANT EXECUTE ON FUNCTION public.intermediation_set_commission(uuid, text, numeric, boolean) TO authenticated;

-- concessão financeira excepcional (novo) — sempre alçada
CREATE OR REPLACE FUNCTION public.intermediation_request_concession(p_id uuid, p_amount numeric, p_description text, p_via_approval boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i intermediations%ROWTYPE; v_req uuid;
BEGIN
  IF public.is_promotora() THEN RAISE EXCEPTION 'Sem acesso'; END IF;
  SELECT * INTO i FROM intermediations WHERE id = p_id;
  IF i.id IS NULL OR (i.tenant_id <> public.get_tenant_id() AND NOT public.is_superadmin()) THEN RAISE EXCEPTION 'Intermediação não encontrada'; END IF;
  IF coalesce(p_amount,0) <= 0 THEN RAISE EXCEPTION 'Informe o valor da concessão'; END IF;
  IF length(coalesce(btrim(p_description),'')) < 3 THEN RAISE EXCEPTION 'Descreva a concessão'; END IF;
  IF NOT p_via_approval AND NOT public.member_can_approve() THEN
    v_req := public.approval_open('financial_concession', p_id, 'Concessão financeira — ' || i.code,
      jsonb_build_object('amount', p_amount, 'description', btrim(p_description)), p_amount);
    RETURN jsonb_build_object('ok', false, 'needs_approval', true, 'request_id', v_req, 'kind', 'financial_concession');
  END IF;
  UPDATE intermediations SET
    financial_concessions = financial_concessions || jsonb_build_object('amount', p_amount, 'description', btrim(p_description), 'by', public.current_member_id(), 'at', now()),
    concession_total = concession_total + p_amount, updated_by = public.current_member_id()
  WHERE id = p_id;
  PERFORM intermediation_log(p_id, 'financial_concession', jsonb_build_object('amount', p_amount, 'description', btrim(p_description), 'via_approval', p_via_approval));
  RETURN jsonb_build_object('ok', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.intermediation_request_concession(uuid, numeric, text, boolean) TO authenticated;

-- encerrar/pausar (Fase 1) + trava "encerrar ativa"
CREATE OR REPLACE FUNCTION public.intermediation_set_status(p_id uuid, p_status text, p_reason text DEFAULT NULL, p_via_approval boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i intermediations%ROWTYPE; v_new text; v_vid uuid; v_listed boolean; v_task uuid; v_desc text; v_req uuid;
BEGIN
  IF public.is_promotora() THEN RAISE EXCEPTION 'Promotora não altera o status da intermediação'; END IF;
  SELECT * INTO i FROM intermediations WHERE id = p_id;
  IF i.id IS NULL OR (i.tenant_id <> public.get_tenant_id() AND NOT public.is_superadmin()) THEN RAISE EXCEPTION 'Intermediação não encontrada'; END IF;
  IF p_status NOT IN ('paused', 'cancelled_by_owner', 'refused_by_totex', 'lost', 'sold_outside', 'docs_pending', 'reactivate') THEN
    RAISE EXCEPTION 'Status inválido: %', p_status;
  END IF;
  IF i.status = 'completed' THEN RAISE EXCEPTION 'Intermediação concluída não muda de status'; END IF;
  IF p_status IN ('cancelled_by_owner', 'refused_by_totex', 'lost', 'sold_outside', 'paused', 'docs_pending') AND length(coalesce(btrim(p_reason), '')) < 3 THEN
    RAISE EXCEPTION 'Informe o motivo';
  END IF;
  -- ALÇADA: encerrar uma intermediação ATIVA precisa de aprovação
  IF p_status IN ('cancelled_by_owner', 'refused_by_totex', 'lost', 'sold_outside') AND i.status = 'active'
     AND NOT p_via_approval AND NOT public.member_can_approve() THEN
    v_req := public.approval_open('cancel_active', p_id, 'Encerrar intermediação ativa — ' || i.code,
      jsonb_build_object('new_status', p_status, 'reason', btrim(p_reason)), NULL);
    RETURN jsonb_build_object('ok', false, 'needs_approval', true, 'request_id', v_req, 'kind', 'cancel_active');
  END IF;

  IF p_status = 'reactivate' THEN
    IF i.status NOT IN ('paused', 'docs_pending') THEN RAISE EXCEPTION 'Só reativa intermediação pausada ou com documentação pendente'; END IF;
    v_new := coalesce(i.status_before_pause, CASE WHEN i.contract_status IN ('signed', 'imported') THEN 'active' ELSE 'lead' END);
    UPDATE intermediations SET status = v_new, status_before_pause = NULL, status_reason = NULL, updated_by = public.current_member_id() WHERE id = p_id;
    PERFORM intermediation_log(p_id, 'intermediation_reactivated', jsonb_build_object('to', v_new));
    RETURN jsonb_build_object('ok', true, 'status', v_new);
  END IF;

  IF p_status IN ('paused', 'docs_pending') AND i.status IN ('paused', 'docs_pending') THEN
    UPDATE intermediations SET status = p_status, status_reason = btrim(p_reason) WHERE id = p_id;
    RETURN jsonb_build_object('ok', true, 'status', p_status);
  END IF;

  UPDATE intermediations SET
    status = p_status,
    status_before_pause = CASE WHEN p_status IN ('paused', 'docs_pending') THEN i.status ELSE NULL END,
    status_reason = btrim(p_reason),
    closed_at = CASE WHEN p_status IN ('cancelled_by_owner', 'refused_by_totex', 'lost', 'sold_outside') THEN now() ELSE closed_at END,
    updated_by = public.current_member_id()
  WHERE id = p_id;

  SELECT id, listing_url IS NOT NULL AND listing_missing_since IS NULL,
         coalesce(description, nullif(concat_ws(' ', brand, model), ''), 'veículo') || coalesce(' ' || year_model::text, '')
    INTO v_vid, v_listed, v_desc
  FROM seller_vehicles WHERE lead_id = i.owner_lead_id ORDER BY created_at DESC LIMIT 1;
  IF v_listed AND p_status IN ('paused', 'cancelled_by_owner', 'refused_by_totex', 'lost', 'sold_outside') THEN
    INSERT INTO company_activities (tenant_id, name, description, task_type, priority, status, completed, due_datetime, lead_id, responsavel_id, team, source_type, source_id, metadata)
    VALUES (i.tenant_id, 'Retirar anúncio do marketplace: ' || v_desc || ' (' || i.code || ')',
      'A intermediação foi ' || CASE p_status WHEN 'paused' THEN 'pausada' ELSE 'encerrada' END || ' (' || btrim(p_reason) || '). O carro ainda aparece no site — retirar o anúncio e confirmar aqui.',
      'follow_up', 'high', 'not_started', false, now(), i.owner_lead_id, (SELECT sales_rep_id FROM leads WHERE id = i.owner_lead_id), 'sales', 'intermediacao', i.id,
      jsonb_build_object('intermediacao', true, 'unpublish', true))
    RETURNING id INTO v_task;
  END IF;
  IF p_status = 'sold_outside' THEN
    INSERT INTO company_activities (tenant_id, name, description, task_type, priority, status, completed, due_datetime, lead_id, responsavel_id, team, source_type, source_id, metadata)
    VALUES (i.tenant_id, 'Analisar comissão devida — venda por fora: ' || v_desc || ' (' || i.code || ')',
      'Proprietário fechou direto (' || btrim(p_reason) || '). Cláusula 8.1: comissão continua devida se o comprador foi originado pela Totex em até 90 dias. Levantar evidências.',
      'follow_up', 'high', 'not_started', false, now(), i.owner_lead_id, (SELECT sales_rep_id FROM leads WHERE id = i.owner_lead_id), 'sales', 'intermediacao', i.id,
      jsonb_build_object('intermediacao', true, 'commission_review', true));
  END IF;
  RETURN jsonb_build_object('ok', true, 'status', p_status, 'unpublish_task', v_task);
END;
$$;
GRANT EXECUTE ON FUNCTION public.intermediation_set_status(uuid, text, text, boolean) TO authenticated;

-- ─── 4) Decidir um pedido (administradora): aprovar aplica o efeito ─────────
CREATE OR REPLACE FUNCTION public.approval_decide(p_request_id uuid, p_decision text, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r approval_requests%ROWTYPE; v_res jsonb;
BEGIN
  IF p_decision NOT IN ('approved', 'rejected') THEN RAISE EXCEPTION 'Decisão inválida'; END IF;
  SELECT * INTO r FROM approval_requests WHERE id = p_request_id;
  IF r.id IS NULL OR (r.tenant_id <> public.get_tenant_id() AND NOT public.is_superadmin()) THEN RAISE EXCEPTION 'Pedido não encontrado'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'Pedido já foi decidido (%).', r.status; END IF;
  IF NOT public.member_can_approve() THEN RAISE EXCEPTION 'Você não tem alçada para aprovar (procuração de administradora)'; END IF;

  IF p_decision = 'rejected' THEN
    UPDATE approval_requests SET status = 'rejected', decided_by = public.current_member_id(), decided_at = now(), decision_note = nullif(btrim(p_note),'') WHERE id = p_request_id;
    PERFORM intermediation_log(r.intermediation_id, 'approval_rejected', jsonb_build_object('request_id', p_request_id, 'kind', r.kind, 'note', p_note));
    RETURN jsonb_build_object('ok', true, 'decision', 'rejected');
  END IF;

  -- aprovado → aplica o efeito
  CASE r.kind
    WHEN 'sell_below_minimum' THEN
      v_res := public.intermediation_decide_proposal((r.params->>'proposal_id')::uuid, 'accepted', coalesce(p_note, 'Aprovado pela administradora'), true);
    WHEN 'commission_change' THEN
      v_res := public.intermediation_change_commission(r.intermediation_id, r.params->>'commission_type', (r.params->>'commission_value')::numeric, coalesce(p_note, r.params->>'reason'), true);
    WHEN 'commission_waive' THEN
      v_res := public.intermediation_set_commission(r.intermediation_id, 'waived', nullif(r.params->>'amount','')::numeric, true);
    WHEN 'cancel_active' THEN
      v_res := public.intermediation_set_status(r.intermediation_id, r.params->>'new_status', r.params->>'reason', true);
    WHEN 'financial_concession' THEN
      v_res := public.intermediation_request_concession(r.intermediation_id, (r.params->>'amount')::numeric, r.params->>'description', true);
    ELSE RAISE EXCEPTION 'Tipo de pedido desconhecido: %', r.kind;
  END CASE;

  UPDATE approval_requests SET status = 'approved', decided_by = public.current_member_id(), decided_at = now(), decision_note = nullif(btrim(p_note),''), applied_at = now() WHERE id = p_request_id;
  PERFORM intermediation_log(r.intermediation_id, 'approval_approved', jsonb_build_object('request_id', p_request_id, 'kind', r.kind, 'result', v_res));
  RETURN jsonb_build_object('ok', true, 'decision', 'approved', 'result', v_res);
END;
$$;
GRANT EXECUTE ON FUNCTION public.approval_decide(uuid, text, text) TO authenticated;

-- cancelar o próprio pedido (quem abriu ou admin)
CREATE OR REPLACE FUNCTION public.approval_cancel(p_request_id uuid, p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r approval_requests%ROWTYPE;
BEGIN
  SELECT * INTO r FROM approval_requests WHERE id = p_request_id;
  IF r.id IS NULL OR (r.tenant_id <> public.get_tenant_id() AND NOT public.is_superadmin()) THEN RAISE EXCEPTION 'Pedido não encontrado'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'Pedido já decidido'; END IF;
  IF NOT (r.requested_by = public.current_member_id() OR public.is_admin() OR public.is_superadmin() OR public.member_can_approve()) THEN
    RAISE EXCEPTION 'Sem permissão para cancelar este pedido';
  END IF;
  UPDATE approval_requests SET status = 'cancelled', decided_by = public.current_member_id(), decided_at = now(), decision_note = nullif(btrim(p_note),'') WHERE id = p_request_id;
  PERFORM intermediation_log(r.intermediation_id, 'approval_cancelled', jsonb_build_object('request_id', p_request_id, 'kind', r.kind));
END;
$$;
GRANT EXECUTE ON FUNCTION public.approval_cancel(uuid, text) TO authenticated;
