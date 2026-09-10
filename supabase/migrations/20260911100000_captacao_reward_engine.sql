-- ============================================================================
-- Captação — REWARD ENGINE (PRD "Gamificação & Incentivos", F4/F5/F7).
--
-- Princípios do PRD: dinheiro nasce SÓ no servidor, por evento verificável,
-- com idempotência e ledger (pendente → aprovado → pago). O front nunca
-- decide saldo. Lead só conta na meta quando é VÁLIDO (nome + telefone +
-- veículo + ano + intenção + consentimento de contato).
--
--   capture_reward_rules   — regras configuráveis por tenant/campanha
--   capture_events         — eventos imutáveis (idempotency_key UNIQUE)
--   capture_reward_ledger  — extrato (idempotency_key UNIQUE, auditoria)
--   leads.capture_valid    — validade do lead (trigger reavalia sozinho)
--   seller_vehicles.status — jornada do carro: lead → … → captado → … → vendido
--   RPCs: capture_wallet, capture_ranking, capture_ledger_set_status,
--         set_seller_vehicle_status, capture_close_month, capture_invalidate_lead
-- ============================================================================

-- ─── 1) Regras de prêmio ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.capture_reward_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL DEFAULT public.get_tenant_id(),
  campaign_id     uuid REFERENCES public.capture_campaigns(id) ON DELETE SET NULL,
  name            text NOT NULL,
  event_type      text NOT NULL CHECK (event_type IN ('lead_validated', 'vehicle_captured', 'vehicle_sold', 'monthly_champion')),
  threshold       integer CHECK (threshold IS NULL OR threshold > 0),      -- ex.: 40 leads válidos
  period_type     text CHECK (period_type IS NULL OR period_type IN ('week', 'month')),
  reward_type     text NOT NULL CHECK (reward_type IN ('cash', 'voucher', 'badge')),
  amount_cents    integer NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  voucher_label   text,
  reward_id       uuid REFERENCES public.capture_rewards(id) ON DELETE SET NULL, -- imagem/estoque do voucher
  cap_per_period  integer NOT NULL DEFAULT 1 CHECK (cap_per_period > 0),
  min_valid_leads integer,                                                   -- campeã do mês: mínimo pra elegibilidade
  active          boolean NOT NULL DEFAULT true,
  position        integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS capture_reward_rules_tenant_idx ON public.capture_reward_rules(tenant_id, event_type) WHERE active;
DO $$ BEGIN
  CREATE TRIGGER update_capture_reward_rules_updated_at BEFORE UPDATE ON public.capture_reward_rules
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.capture_reward_rules TO authenticated, service_role;
ALTER TABLE public.capture_reward_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS capture_reward_rules_select ON public.capture_reward_rules;
CREATE POLICY capture_reward_rules_select ON public.capture_reward_rules
  FOR SELECT TO authenticated USING (tenant_id = public.get_tenant_id() OR public.is_superadmin());
DROP POLICY IF EXISTS capture_reward_rules_write ON public.capture_reward_rules;
CREATE POLICY capture_reward_rules_write ON public.capture_reward_rules
  FOR ALL TO authenticated
  USING ((tenant_id = public.get_tenant_id() AND public.is_admin()) OR public.is_superadmin())
  WITH CHECK ((tenant_id = public.get_tenant_id() AND public.is_admin()) OR public.is_superadmin());

-- ─── 2) Eventos imutáveis ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.capture_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  promoter_id     uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  lead_id         uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  deal_id         uuid,
  vehicle_id      uuid,
  event_type      text NOT NULL CHECK (event_type IN (
                    'lead_submitted', 'lead_validated', 'lead_invalidated',
                    'vehicle_captured', 'vehicle_sold', 'monthly_champion',
                    'reward_approved', 'reward_paid', 'reward_cancelled')),
  event_at        timestamptz NOT NULL DEFAULT now(),
  actor_member_id uuid,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS capture_events_promoter_idx ON public.capture_events(tenant_id, promoter_id, event_type, event_at);
CREATE INDEX IF NOT EXISTS capture_events_lead_idx ON public.capture_events(lead_id);
GRANT SELECT ON public.capture_events TO authenticated;
GRANT ALL ON public.capture_events TO service_role;
ALTER TABLE public.capture_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS capture_events_select ON public.capture_events;
CREATE POLICY capture_events_select ON public.capture_events
  FOR SELECT TO authenticated
  USING ((tenant_id = public.get_tenant_id() OR public.is_superadmin())
         AND (NOT public.is_promotora() OR promoter_id = public.current_member_id()));

-- ─── 3) Ledger (extrato) ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.capture_reward_ledger (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  promoter_id      uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  rule_id          uuid REFERENCES public.capture_reward_rules(id) ON DELETE SET NULL,
  event_id         uuid REFERENCES public.capture_events(id) ON DELETE SET NULL,
  lead_id          uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  reward_type      text NOT NULL CHECK (reward_type IN ('cash', 'voucher', 'badge')),
  amount_cents     integer NOT NULL DEFAULT 0,
  voucher_label    text,
  reward_image_url text,
  title            text NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'paid', 'cancelled')),
  period_start     date,
  earned_at        timestamptz NOT NULL DEFAULT now(),
  approved_at      timestamptz, approved_by uuid,
  paid_at          timestamptz, paid_by uuid,
  cancelled_at     timestamptz, cancelled_by uuid, cancel_reason text,
  idempotency_key  text NOT NULL UNIQUE,
  note             text
);
CREATE INDEX IF NOT EXISTS capture_reward_ledger_tenant_status_idx ON public.capture_reward_ledger(tenant_id, status);
CREATE INDEX IF NOT EXISTS capture_reward_ledger_promoter_idx ON public.capture_reward_ledger(promoter_id, earned_at DESC);
GRANT SELECT ON public.capture_reward_ledger TO authenticated;
GRANT ALL ON public.capture_reward_ledger TO service_role;
ALTER TABLE public.capture_reward_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS capture_reward_ledger_select ON public.capture_reward_ledger;
CREATE POLICY capture_reward_ledger_select ON public.capture_reward_ledger
  FOR SELECT TO authenticated
  USING ((tenant_id = public.get_tenant_id() OR public.is_superadmin())
         AND (NOT public.is_promotora() OR promoter_id = public.current_member_id()));
-- escrita SÓ por função SECURITY DEFINER (nenhuma policy de INSERT/UPDATE/DELETE)

-- ─── 4) Validade do lead + jornada do veículo ──────────────────────────────
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS capture_valid          boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS capture_validated_at   timestamptz,
  ADD COLUMN IF NOT EXISTS capture_invalid_reason text;

ALTER TABLE public.seller_vehicles
  ADD COLUMN IF NOT EXISTS status            text NOT NULL DEFAULT 'lead',
  ADD COLUMN IF NOT EXISTS status_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS captured_at       timestamptz,
  ADD COLUMN IF NOT EXISTS sold_at           timestamptz,
  ADD COLUMN IF NOT EXISTS sold_price        numeric;
DO $$ BEGIN
  ALTER TABLE public.seller_vehicles ADD CONSTRAINT seller_vehicles_status_check
    CHECK (status IN ('lead', 'avaliacao', 'captado', 'preparacao', 'anunciado', 'negociacao', 'vendido', 'perdido'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- evento 'sold' no feed da promotora
ALTER TABLE public.capture_lead_events DROP CONSTRAINT IF EXISTS capture_lead_events_event_type_check;
ALTER TABLE public.capture_lead_events ADD CONSTRAINT capture_lead_events_event_type_check
  CHECK (event_type IN ('handoff', 'contacted', 'stage', 'won', 'sold', 'lost', 'reassigned', 'sla', 'info', 'reward'));

-- campanha: frase/objeção do dia configuráveis (sai do código)
ALTER TABLE public.capture_campaigns
  ADD COLUMN IF NOT EXISTS focus_phrase     text,
  ADD COLUMN IF NOT EXISTS objection_phrase text,
  ADD COLUMN IF NOT EXISTS objection_answer text;

-- ─── 5) Helpers de período (fuso SP) ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.capture_period_start(p_period text, p_at timestamptz DEFAULT now())
RETURNS date LANGUAGE sql IMMUTABLE AS $$
  SELECT (date_trunc(CASE WHEN p_period = 'month' THEN 'month' ELSE 'week' END,
                     p_at AT TIME ZONE 'America/Sao_Paulo'))::date;
$$;

-- ─── 6) Emissão de evento (idempotente) ────────────────────────────────────
-- Devolve o id do evento (novo ou já existente) e se foi criado agora.
CREATE OR REPLACE FUNCTION public.capture_emit_event(
  p_tenant uuid, p_promoter uuid, p_type text, p_key text,
  p_lead uuid DEFAULT NULL, p_deal uuid DEFAULT NULL, p_vehicle uuid DEFAULT NULL,
  p_meta jsonb DEFAULT '{}'::jsonb, p_actor uuid DEFAULT NULL,
  OUT event_id uuid, OUT created boolean
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO capture_events (tenant_id, promoter_id, lead_id, deal_id, vehicle_id, event_type, actor_member_id, metadata, idempotency_key)
  VALUES (p_tenant, p_promoter, p_lead, p_deal, p_vehicle, p_type, p_actor, coalesce(p_meta, '{}'::jsonb), p_key)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO event_id;
  created := event_id IS NOT NULL;
  IF event_id IS NULL THEN SELECT id INTO event_id FROM capture_events WHERE idempotency_key = p_key; END IF;
END;
$$;

-- ─── 7) Lançamento no ledger (idempotente) ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.capture_award(
  p_rule capture_reward_rules, p_promoter uuid, p_event uuid, p_lead uuid, p_period_start date, p_key text, p_title text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_img text; v_promo_name text;
BEGIN
  IF p_rule.reward_id IS NOT NULL THEN SELECT image_url INTO v_img FROM capture_rewards WHERE id = p_rule.reward_id; END IF;
  INSERT INTO capture_reward_ledger (tenant_id, promoter_id, rule_id, event_id, lead_id, reward_type, amount_cents,
                                     voucher_label, reward_image_url, title, period_start, idempotency_key)
  VALUES (p_rule.tenant_id, p_promoter, p_rule.id, p_event, p_lead, p_rule.reward_type, coalesce(p_rule.amount_cents, 0),
          p_rule.voucher_label, v_img, p_title, p_period_start, p_key)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    -- estoque do voucher (se tiver)
    IF p_rule.reward_id IS NOT NULL THEN
      UPDATE capture_rewards SET stock = stock - 1 WHERE id = p_rule.reward_id AND stock IS NOT NULL AND stock > 0;
    END IF;
    -- retorno pra promotora (feed)
    IF p_lead IS NOT NULL THEN
      PERFORM capture_add_event(p_lead, 'reward', '🎁 ' || p_title,
        CASE WHEN p_rule.reward_type = 'cash' THEN '+R$ ' || to_char(coalesce(p_rule.amount_cents, 0) / 100.0, 'FM999G990D00') || ' pendentes de aprovação.'
             ELSE coalesce(p_rule.voucher_label, 'Prêmio') || ' — o gestor vai entregar.' END);
    ELSE
      SELECT name INTO v_promo_name FROM team_members WHERE id = p_promoter;
      INSERT INTO capture_lead_events (tenant_id, lead_id, promotora_member_id, event_type, title, body)
      SELECT p_rule.tenant_id, l.id, p_promoter, 'reward', '🎁 ' || p_title,
             CASE WHEN p_rule.reward_type = 'cash' THEN '+R$ ' || to_char(coalesce(p_rule.amount_cents, 0) / 100.0, 'FM999G990D00') || ' pendentes de aprovação.'
                  ELSE coalesce(p_rule.voucher_label, 'Prêmio') || ' — o gestor vai entregar.' END
      FROM leads l WHERE l.captured_by_member_id = p_promoter ORDER BY l.captured_at DESC NULLS LAST LIMIT 1;
    END IF;
  END IF;
  RETURN v_id;
END;
$$;

-- ─── 8) Validade do lead → evento → meta semanal → voucher ─────────────────
CREATE OR REPLACE FUNCTION public.capture_evaluate_lead(p_lead_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  l leads%ROWTYPE; v seller_vehicles%ROWTYPE; q jsonb; v_reason text; v_valid boolean;
  ev record; r capture_reward_rules%ROWTYPE; v_ps date; v_count integer; v_cap integer;
BEGIN
  SELECT * INTO l FROM leads WHERE id = p_lead_id;
  IF l.id IS NULL OR l.captured_by_member_id IS NULL THEN RETURN false; END IF;
  SELECT * INTO v FROM seller_vehicles WHERE lead_id = p_lead_id ORDER BY created_at DESC LIMIT 1;
  q := coalesce(l.seller_qualification, '{}'::jsonb);

  v_reason := CASE
    WHEN length(coalesce(btrim(l.name), '')) < 2 THEN 'nome'
    WHEN length(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g')) < 10 THEN 'telefone'
    WHEN v.id IS NULL OR coalesce(nullif(btrim(v.description), ''), nullif(btrim(v.model), '')) IS NULL THEN 'veículo'
    WHEN v.year_model IS NULL THEN 'ano do veículo'
    WHEN coalesce(q->>'intent', '') NOT IN ('vender', 'trocar', 'entender') THEN 'intenção'
    WHEN q->>'autoriza_contato' IS DISTINCT FROM 'true' THEN 'autorização de contato'
    ELSE NULL END;
  v_valid := v_reason IS NULL;

  IF v_valid AND NOT l.capture_valid THEN
    UPDATE leads SET capture_valid = true, capture_validated_at = now(), capture_invalid_reason = NULL WHERE id = p_lead_id;
    SELECT * INTO ev FROM capture_emit_event(l.tenant_id, l.captured_by_member_id, 'lead_validated', 'lead_validated:' || p_lead_id, p_lead_id);
    -- regras de limiar (ex.: 40 válidos na semana → voucher)
    FOR r IN SELECT * FROM capture_reward_rules
             WHERE tenant_id = l.tenant_id AND active AND event_type = 'lead_validated' AND threshold IS NOT NULL
               AND (campaign_id IS NULL OR campaign_id = l.capture_campaign_id)
    LOOP
      v_ps := capture_period_start(coalesce(r.period_type, 'week'));
      SELECT count(*) INTO v_count FROM leads
      WHERE captured_by_member_id = l.captured_by_member_id AND capture_valid
        AND capture_period_start(coalesce(r.period_type, 'week'), capture_validated_at) = v_ps;
      SELECT count(*) INTO v_cap FROM capture_reward_ledger
      WHERE rule_id = r.id AND promoter_id = l.captured_by_member_id AND period_start = v_ps AND status <> 'cancelled';
      IF v_count >= r.threshold AND v_cap < r.cap_per_period THEN
        PERFORM capture_award(r, l.captured_by_member_id, ev.event_id, p_lead_id, v_ps,
          'rule:' || r.id || ':' || l.captured_by_member_id || ':' || v_ps || ':' || (v_cap + 1),
          coalesce(r.voucher_label, r.name) || ' — ' || r.threshold || ' leads válidos ' || CASE r.period_type WHEN 'month' THEN 'no mês' ELSE 'na semana' END);
      END IF;
    END LOOP;
  ELSIF NOT v_valid THEN
    UPDATE leads SET capture_invalid_reason = v_reason WHERE id = p_lead_id AND capture_invalid_reason IS DISTINCT FROM v_reason;
  END IF;
  RETURN v_valid;
END;
$$;

-- Gestor invalida um lead (fraude/erro): tira da meta e cancela voucher pendente se a meta cair.
CREATE OR REPLACE FUNCTION public.capture_invalidate_lead(p_lead_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE l leads%ROWTYPE; r capture_reward_rules%ROWTYPE; v_ps date; v_count integer;
BEGIN
  IF NOT (public.is_admin() OR public.is_superadmin()) THEN RAISE EXCEPTION 'Apenas admin'; END IF;
  SELECT * INTO l FROM leads WHERE id = p_lead_id;
  IF l.id IS NULL OR NOT l.capture_valid THEN RETURN; END IF;
  UPDATE leads SET capture_valid = false, capture_invalid_reason = 'invalidado: ' || coalesce(p_reason, 'gestor') WHERE id = p_lead_id;
  PERFORM capture_emit_event(l.tenant_id, l.captured_by_member_id, 'lead_invalidated', 'lead_invalidated:' || p_lead_id || ':' || now()::text,
                             p_lead_id, NULL, NULL, jsonb_build_object('reason', p_reason), public.current_member_id());
  FOR r IN SELECT * FROM capture_reward_rules WHERE tenant_id = l.tenant_id AND event_type = 'lead_validated' AND threshold IS NOT NULL LOOP
    v_ps := capture_period_start(coalesce(r.period_type, 'week'), coalesce(l.capture_validated_at, now()));
    SELECT count(*) INTO v_count FROM leads
    WHERE captured_by_member_id = l.captured_by_member_id AND capture_valid
      AND capture_period_start(coalesce(r.period_type, 'week'), capture_validated_at) = v_ps;
    IF v_count < r.threshold THEN
      UPDATE capture_reward_ledger SET status = 'cancelled', cancelled_at = now(), cancelled_by = public.current_member_id(),
             cancel_reason = 'Meta desfeita: lead invalidado (' || coalesce(p_reason, '') || ')'
      WHERE rule_id = r.id AND promoter_id = l.captured_by_member_id AND period_start = v_ps AND status = 'pending';
    END IF;
  END LOOP;
END;
$$;
GRANT EXECUTE ON FUNCTION public.capture_invalidate_lead(uuid, text) TO authenticated;

-- Triggers: reavalia quando lead/veículo mudam
CREATE OR REPLACE FUNCTION public.trg_capture_evaluate_lead() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_TABLE_NAME = 'seller_vehicles' THEN
    PERFORM capture_evaluate_lead(NEW.lead_id);
  ELSE
    PERFORM capture_evaluate_lead(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_capture_evaluate_lead ON public.leads;
CREATE TRIGGER trg_capture_evaluate_lead AFTER INSERT OR UPDATE OF name, phone, seller_qualification ON public.leads
  FOR EACH ROW WHEN (NEW.captured_by_member_id IS NOT NULL AND NEW.capture_valid = false)
  EXECUTE FUNCTION public.trg_capture_evaluate_lead();
DROP TRIGGER IF EXISTS trg_capture_evaluate_vehicle ON public.seller_vehicles;
CREATE TRIGGER trg_capture_evaluate_vehicle AFTER INSERT OR UPDATE OF description, model, year_model ON public.seller_vehicles
  FOR EACH ROW EXECUTE FUNCTION public.trg_capture_evaluate_lead();

-- ─── 9) Jornada do veículo → eventos financeiros ───────────────────────────
-- Deal chegou em etapa is_won ("Ganho"/"Captado") → veículo captado.
CREATE OR REPLACE FUNCTION public.trg_capture_deal_vehicle() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s record; v_vid uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM leads WHERE id = NEW.lead_id AND captured_by_member_id IS NOT NULL) THEN RETURN NEW; END IF;
  SELECT name, is_won INTO s FROM sales_pipeline_stages WHERE id = NEW.pipeline_stage_id;
  SELECT id INTO v_vid FROM seller_vehicles WHERE lead_id = NEW.lead_id ORDER BY created_at DESC LIMIT 1;
  IF v_vid IS NULL THEN RETURN NEW; END IF;
  IF coalesce(s.is_won, false) THEN
    UPDATE seller_vehicles SET status = 'captado', captured_at = coalesce(captured_at, now()), status_changed_at = now()
    WHERE id = v_vid AND status IN ('lead', 'avaliacao');
  ELSIF s.name ILIKE 'Avalia%' THEN
    UPDATE seller_vehicles SET status = 'avaliacao', status_changed_at = now() WHERE id = v_vid AND status = 'lead';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_capture_deal_vehicle ON public.deals;
CREATE TRIGGER trg_capture_deal_vehicle AFTER UPDATE OF pipeline_stage_id ON public.deals
  FOR EACH ROW WHEN (OLD.pipeline_stage_id IS DISTINCT FROM NEW.pipeline_stage_id)
  EXECUTE FUNCTION public.trg_capture_deal_vehicle();

-- Status do veículo mudou → evento + prêmio (captado R$25 / vendido R$50) + feed.
CREATE OR REPLACE FUNCTION public.trg_capture_vehicle_status() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE l record; ev record; r capture_reward_rules%ROWTYPE; v_desc text;
BEGIN
  SELECT id, tenant_id, name, captured_by_member_id, capture_campaign_id INTO l FROM leads WHERE id = NEW.lead_id;
  IF l.captured_by_member_id IS NULL THEN RETURN NEW; END IF;
  v_desc := coalesce(NEW.description, nullif(concat_ws(' ', NEW.brand, NEW.model), ''), 'veículo') || coalesce(' ' || NEW.year_model::text, '');

  IF NEW.status = 'captado' AND OLD.status IS DISTINCT FROM 'captado' THEN
    SELECT * INTO ev FROM capture_emit_event(l.tenant_id, l.captured_by_member_id, 'vehicle_captured', 'vehicle_captured:' || NEW.lead_id, NEW.lead_id, NULL, NEW.id);
    IF ev.created THEN
      FOR r IN SELECT * FROM capture_reward_rules WHERE tenant_id = l.tenant_id AND active AND event_type = 'vehicle_captured'
               AND (campaign_id IS NULL OR campaign_id = l.capture_campaign_id) LOOP
        PERFORM capture_award(r, l.captured_by_member_id, ev.event_id, NEW.lead_id, capture_period_start('month'),
                              'rule:' || r.id || ':lead:' || NEW.lead_id, r.name || ' — ' || v_desc);
      END LOOP;
    END IF;
  ELSIF NEW.status = 'vendido' AND OLD.status IS DISTINCT FROM 'vendido' THEN
    UPDATE seller_vehicles SET sold_at = coalesce(sold_at, now()) WHERE id = NEW.id AND sold_at IS NULL;
    SELECT * INTO ev FROM capture_emit_event(l.tenant_id, l.captured_by_member_id, 'vehicle_sold', 'vehicle_sold:' || NEW.lead_id, NEW.lead_id, NULL, NEW.id,
                                             jsonb_build_object('sold_price', NEW.sold_price));
    IF ev.created THEN
      PERFORM capture_add_event(NEW.lead_id, 'sold', '🎉 VENDEU! ' || v_desc, 'O carro que você captou foi vendido.');
      FOR r IN SELECT * FROM capture_reward_rules WHERE tenant_id = l.tenant_id AND active AND event_type = 'vehicle_sold'
               AND (campaign_id IS NULL OR campaign_id = l.capture_campaign_id) LOOP
        PERFORM capture_award(r, l.captured_by_member_id, ev.event_id, NEW.lead_id, capture_period_start('month'),
                              'rule:' || r.id || ':lead:' || NEW.lead_id, r.name || ' — ' || v_desc);
      END LOOP;
    END IF;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM capture_add_event(NEW.lead_id, 'stage', v_desc || ' → ' || initcap(NEW.status), NULL);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_capture_vehicle_status ON public.seller_vehicles;
CREATE TRIGGER trg_capture_vehicle_status AFTER UPDATE OF status ON public.seller_vehicles
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.trg_capture_vehicle_status();

-- Time comercial atualiza a jornada do carro (promotora não pode).
CREATE OR REPLACE FUNCTION public.set_seller_vehicle_status(p_vehicle_id uuid, p_status text, p_sold_price numeric DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid;
BEGIN
  IF public.is_promotora() THEN RAISE EXCEPTION 'Promotora não altera status do veículo'; END IF;
  SELECT tenant_id INTO v_tenant FROM seller_vehicles WHERE id = p_vehicle_id;
  IF v_tenant IS NULL OR (v_tenant <> public.get_tenant_id() AND NOT public.is_superadmin()) THEN RAISE EXCEPTION 'Veículo não encontrado'; END IF;
  UPDATE seller_vehicles SET status = p_status, status_changed_at = now(),
         captured_at = CASE WHEN p_status = 'captado' THEN coalesce(captured_at, now()) ELSE captured_at END,
         sold_price = coalesce(p_sold_price, sold_price)
  WHERE id = p_vehicle_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.set_seller_vehicle_status(uuid, text, numeric) TO authenticated;

-- ─── 10) Gestor: aprovar / pagar / cancelar (com auditoria) ────────────────
CREATE OR REPLACE FUNCTION public.capture_ledger_set_status(p_id uuid, p_status text, p_reason text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r capture_reward_ledger%ROWTYPE; v_actor uuid := public.current_member_id();
BEGIN
  IF NOT (public.is_admin() OR public.is_superadmin()) THEN RAISE EXCEPTION 'Apenas admin'; END IF;
  SELECT * INTO r FROM capture_reward_ledger WHERE id = p_id;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Lançamento não encontrado'; END IF;
  IF r.status IN ('paid', 'cancelled') THEN RAISE EXCEPTION 'Lançamento já %', r.status; END IF;
  IF p_status = 'approved' THEN
    UPDATE capture_reward_ledger SET status = 'approved', approved_at = now(), approved_by = v_actor, note = coalesce(p_reason, note) WHERE id = p_id;
  ELSIF p_status = 'paid' THEN
    UPDATE capture_reward_ledger SET status = 'paid', approved_at = coalesce(approved_at, now()), approved_by = coalesce(approved_by, v_actor),
           paid_at = now(), paid_by = v_actor, note = coalesce(p_reason, note) WHERE id = p_id;
  ELSIF p_status = 'cancelled' THEN
    UPDATE capture_reward_ledger SET status = 'cancelled', cancelled_at = now(), cancelled_by = v_actor, cancel_reason = coalesce(p_reason, 'sem motivo') WHERE id = p_id;
  ELSE RAISE EXCEPTION 'Status inválido'; END IF;
  PERFORM capture_emit_event(r.tenant_id, r.promoter_id, 'reward_' || p_status, 'ledger:' || p_id || ':' || p_status,
                             r.lead_id, NULL, NULL, jsonb_build_object('reason', p_reason, 'amount_cents', r.amount_cents), v_actor);
END;
$$;
GRANT EXECUTE ON FUNCTION public.capture_ledger_set_status(uuid, text, text) TO authenticated;

-- ─── 11) Carteira da promotora ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.capture_wallet(p_member_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_member uuid := public.current_member_id(); v_target uuid; r jsonb;
BEGIN
  IF v_member IS NULL THEN RETURN '{}'::jsonb; END IF;
  v_target := CASE WHEN p_member_id IS NOT NULL AND (public.is_admin() OR public.is_superadmin()) THEN p_member_id ELSE v_member END;
  SELECT jsonb_build_object(
    'pending_cents',  coalesce(sum(amount_cents) FILTER (WHERE status = 'pending'  AND reward_type = 'cash'), 0),
    'approved_cents', coalesce(sum(amount_cents) FILTER (WHERE status = 'approved' AND reward_type = 'cash'), 0),
    'paid_cents',     coalesce(sum(amount_cents) FILTER (WHERE status = 'paid'     AND reward_type = 'cash'), 0),
    'earned_cents',   coalesce(sum(amount_cents) FILTER (WHERE status IN ('approved', 'paid') AND reward_type = 'cash'), 0),
    'vouchers_pending',   count(*) FILTER (WHERE reward_type = 'voucher' AND status IN ('pending', 'approved')),
    'vouchers_delivered', count(*) FILTER (WHERE reward_type = 'voucher' AND status = 'paid'),
    'items', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', x.id, 'title', x.title, 'reward_type', x.reward_type, 'amount_cents', x.amount_cents,
        'voucher_label', x.voucher_label, 'image_url', x.reward_image_url, 'status', x.status,
        'earned_at', x.earned_at, 'paid_at', x.paid_at, 'cancel_reason', x.cancel_reason, 'lead_id', x.lead_id)
        ORDER BY x.earned_at DESC)
      FROM (SELECT * FROM capture_reward_ledger WHERE promoter_id = v_target ORDER BY earned_at DESC LIMIT 60) x), '[]'::jsonb)
  ) INTO r FROM capture_reward_ledger WHERE promoter_id = v_target;
  RETURN coalesce(r, '{}'::jsonb);
END;
$$;
GRANT EXECUTE ON FUNCTION public.capture_wallet(uuid) TO authenticated;

-- ─── 12) Meus carros ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.list_my_capture_vehicles(p_member_id uuid DEFAULT NULL)
RETURNS TABLE (
  vehicle_id uuid, lead_id uuid, lead_name text, description text, brand text, model text, year_model integer, km integer,
  status text, status_changed_at timestamptz, captured_at timestamptz, sold_at timestamptz,
  stage_name text, sales_rep_name text, reward_captured_cents integer, reward_sold_cents integer,
  ledger_captured_status text, ledger_sold_status text
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_member uuid := public.current_member_id(); v_target uuid; v_tenant uuid;
BEGIN
  IF v_member IS NULL THEN RETURN; END IF;
  v_target := CASE WHEN p_member_id IS NOT NULL AND (public.is_admin() OR public.is_superadmin()) THEN p_member_id ELSE v_member END;
  SELECT tenant_id INTO v_tenant FROM team_members WHERE id = v_target;
  RETURN QUERY
  SELECT v.id, l.id, l.name, v.description, v.brand, v.model, v.year_model, v.km,
         v.status, v.status_changed_at, v.captured_at, v.sold_at,
         s.name, tm.name,
         (SELECT amount_cents FROM capture_reward_rules WHERE tenant_id = v_tenant AND active AND event_type = 'vehicle_captured' ORDER BY position LIMIT 1),
         (SELECT amount_cents FROM capture_reward_rules WHERE tenant_id = v_tenant AND active AND event_type = 'vehicle_sold' ORDER BY position LIMIT 1),
         (SELECT lg.status FROM capture_reward_ledger lg JOIN capture_reward_rules rr ON rr.id = lg.rule_id
           WHERE lg.lead_id = l.id AND rr.event_type = 'vehicle_captured' ORDER BY lg.earned_at DESC LIMIT 1),
         (SELECT lg.status FROM capture_reward_ledger lg JOIN capture_reward_rules rr ON rr.id = lg.rule_id
           WHERE lg.lead_id = l.id AND rr.event_type = 'vehicle_sold' ORDER BY lg.earned_at DESC LIMIT 1)
  FROM leads l
  JOIN LATERAL (SELECT * FROM seller_vehicles sv WHERE sv.lead_id = l.id ORDER BY sv.created_at DESC LIMIT 1) v ON true
  LEFT JOIN sales_pipeline_stages s ON s.id = l.pipeline_stage_id
  LEFT JOIN team_members tm ON tm.id = l.sales_rep_id
  WHERE l.captured_by_member_id = v_target
  ORDER BY CASE v.status WHEN 'vendido' THEN 0 WHEN 'negociacao' THEN 1 WHEN 'anunciado' THEN 2 WHEN 'preparacao' THEN 3 WHEN 'captado' THEN 4 WHEN 'avaliacao' THEN 5 ELSE 6 END,
           coalesce(v.status_changed_at, v.created_at) DESC;
END;
$$;
GRANT EXECUTE ON FUNCTION public.list_my_capture_vehicles(uuid) TO authenticated;

-- ─── 13) Ranking / ROI do gestor ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.capture_ranking(p_period text DEFAULT 'month')
RETURNS TABLE (
  member_id uuid, name text, submitted integer, valid integer, validity_rate numeric,
  captured integer, sold integer, conv_captured numeric, conv_sold numeric,
  incentives_pending_cents bigint, incentives_approved_cents bigint, incentives_paid_cents bigint, cost_per_captured_cents bigint
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid := public.get_tenant_id(); v_ps date := capture_period_start(p_period);
BEGIN
  IF NOT (public.is_admin() OR public.is_superadmin()) THEN RETURN; END IF;
  RETURN QUERY
  SELECT tm.id, tm.name,
    count(l.id)::int,
    count(l.id) FILTER (WHERE l.capture_valid)::int,
    CASE WHEN count(l.id) > 0 THEN round(100.0 * count(l.id) FILTER (WHERE l.capture_valid) / count(l.id), 1) ELSE 0 END,
    count(l.id) FILTER (WHERE v.status IN ('captado', 'preparacao', 'anunciado', 'negociacao', 'vendido'))::int,
    count(l.id) FILTER (WHERE v.status = 'vendido')::int,
    CASE WHEN count(l.id) FILTER (WHERE l.capture_valid) > 0
         THEN round(100.0 * count(l.id) FILTER (WHERE v.status IN ('captado', 'preparacao', 'anunciado', 'negociacao', 'vendido')) / count(l.id) FILTER (WHERE l.capture_valid), 1) ELSE 0 END,
    CASE WHEN count(l.id) FILTER (WHERE v.status IN ('captado', 'preparacao', 'anunciado', 'negociacao', 'vendido')) > 0
         THEN round(100.0 * count(l.id) FILTER (WHERE v.status = 'vendido') / count(l.id) FILTER (WHERE v.status IN ('captado', 'preparacao', 'anunciado', 'negociacao', 'vendido')), 1) ELSE 0 END,
    coalesce((SELECT sum(amount_cents) FROM capture_reward_ledger g WHERE g.promoter_id = tm.id AND g.status = 'pending'  AND g.earned_at >= v_ps), 0),
    coalesce((SELECT sum(amount_cents) FROM capture_reward_ledger g WHERE g.promoter_id = tm.id AND g.status = 'approved' AND g.earned_at >= v_ps), 0),
    coalesce((SELECT sum(amount_cents) FROM capture_reward_ledger g WHERE g.promoter_id = tm.id AND g.status = 'paid'     AND g.earned_at >= v_ps), 0),
    CASE WHEN count(l.id) FILTER (WHERE v.status IN ('captado', 'preparacao', 'anunciado', 'negociacao', 'vendido')) > 0
         THEN coalesce((SELECT sum(amount_cents) FROM capture_reward_ledger g WHERE g.promoter_id = tm.id AND g.status <> 'cancelled' AND g.earned_at >= v_ps), 0)
              / count(l.id) FILTER (WHERE v.status IN ('captado', 'preparacao', 'anunciado', 'negociacao', 'vendido')) ELSE 0 END
  FROM team_members tm
  LEFT JOIN leads l ON l.captured_by_member_id = tm.id AND l.captured_at >= v_ps
  LEFT JOIN LATERAL (SELECT status FROM seller_vehicles sv WHERE sv.lead_id = l.id ORDER BY sv.created_at DESC LIMIT 1) v ON true
  WHERE tm.tenant_id = v_tenant AND (tm.role = 'promotora' OR EXISTS (SELECT 1 FROM leads x WHERE x.captured_by_member_id = tm.id))
  GROUP BY tm.id, tm.name
  ORDER BY 8 DESC, 4 DESC, tm.name;
END;
$$;
GRANT EXECUTE ON FUNCTION public.capture_ranking(text) TO authenticated;

-- Campeã do mês: melhor conversão (captados ÷ válidos) com mínimo de leads válidos.
CREATE OR REPLACE FUNCTION public.capture_close_month(p_month date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid := public.get_tenant_id(); v_ps date; r capture_reward_rules%ROWTYPE; w record; ev record; v_id uuid;
BEGIN
  IF NOT (public.is_admin() OR public.is_superadmin()) THEN RAISE EXCEPTION 'Apenas admin'; END IF;
  v_ps := coalesce(date_trunc('month', p_month)::date, capture_period_start('month', now() - interval '1 month'));
  SELECT * INTO r FROM capture_reward_rules WHERE tenant_id = v_tenant AND active AND event_type = 'monthly_champion' ORDER BY position LIMIT 1;
  IF r.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'sem regra de campeã do mês'); END IF;

  SELECT tm.id AS member_id, tm.name,
         count(l.id) FILTER (WHERE l.capture_valid) AS valid,
         count(l.id) FILTER (WHERE v.status IN ('captado', 'preparacao', 'anunciado', 'negociacao', 'vendido')) AS captured
  INTO w
  FROM team_members tm
  JOIN leads l ON l.captured_by_member_id = tm.id AND capture_period_start('month', l.captured_at) = v_ps
  LEFT JOIN LATERAL (SELECT status FROM seller_vehicles sv WHERE sv.lead_id = l.id ORDER BY sv.created_at DESC LIMIT 1) v ON true
  WHERE tm.tenant_id = v_tenant
  GROUP BY tm.id, tm.name
  HAVING count(l.id) FILTER (WHERE l.capture_valid) >= coalesce(r.min_valid_leads, 1)
  ORDER BY (count(l.id) FILTER (WHERE v.status IN ('captado', 'preparacao', 'anunciado', 'negociacao', 'vendido')))::numeric
           / greatest(count(l.id) FILTER (WHERE l.capture_valid), 1) DESC,
           count(l.id) FILTER (WHERE v.status IN ('captado', 'preparacao', 'anunciado', 'negociacao', 'vendido')) DESC,
           count(l.id) FILTER (WHERE l.capture_valid) DESC
  LIMIT 1;
  IF w.member_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'ninguém elegível', 'month', v_ps); END IF;

  SELECT * INTO ev FROM capture_emit_event(v_tenant, w.member_id, 'monthly_champion', 'monthly_champion:' || v_tenant || ':' || v_ps,
                                           NULL, NULL, NULL, jsonb_build_object('valid', w.valid, 'captured', w.captured), public.current_member_id());
  v_id := capture_award(r, w.member_id, ev.event_id, NULL, v_ps, 'rule:' || r.id || ':' || v_ps,
                        r.name || ' — ' || to_char(v_ps, 'MM/YYYY'));
  RETURN jsonb_build_object('ok', true, 'month', v_ps, 'champion', w.name, 'member_id', w.member_id,
                            'valid', w.valid, 'captured', w.captured, 'ledger_id', v_id, 'already', v_id IS NULL);
END;
$$;
GRANT EXECUTE ON FUNCTION public.capture_close_month(date) TO authenticated;

-- ─── 14) Home stats: meta de leads VÁLIDOS + carteira ──────────────────────
CREATE OR REPLACE FUNCTION public.capture_home_stats(p_member_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member_id uuid := public.current_member_id();
  v_target uuid; v_tenant uuid;
  v_today_start timestamptz := date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo';
  v_week_start  timestamptz := date_trunc('week', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo';
  v_month_start timestamptz := date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo';
  r jsonb; v_goal integer; v_goal_label text;
BEGIN
  IF v_member_id IS NULL THEN RETURN '{}'::jsonb; END IF;
  v_target := CASE WHEN p_member_id IS NOT NULL AND (public.is_admin() OR public.is_superadmin()) THEN p_member_id ELSE v_member_id END;
  SELECT tenant_id INTO v_tenant FROM team_members WHERE id = v_target;
  SELECT threshold, coalesce(voucher_label, name) INTO v_goal, v_goal_label FROM capture_reward_rules
  WHERE tenant_id = v_tenant AND active AND event_type = 'lead_validated' AND period_type = 'week' ORDER BY position LIMIT 1;

  SELECT jsonb_build_object(
    'hoje',           count(*) FILTER (WHERE captured_at >= v_today_start),
    'semana',         count(*) FILTER (WHERE captured_at >= v_week_start),
    'mes',            count(*) FILTER (WHERE captured_at >= v_month_start),
    'validos_semana', count(*) FILTER (WHERE capture_valid AND capture_validated_at >= v_week_start),
    'validos_hoje',   count(*) FILTER (WHERE capture_valid AND capture_validated_at >= v_today_start),
    'invalidos_semana', count(*) FILTER (WHERE NOT capture_valid AND captured_at >= v_week_start),
    'invalidos_motivos', (SELECT coalesce(jsonb_object_agg(m, n), '{}'::jsonb) FROM (
        SELECT capture_invalid_reason AS m, count(*) AS n FROM leads
        WHERE captured_by_member_id = v_target AND NOT capture_valid AND captured_at >= v_week_start AND capture_invalid_reason IS NOT NULL
        GROUP BY 1) t),
    'meta_semanal',   coalesce(v_goal, 40),
    'meta_label',     v_goal_label,
    'quentes_semana', count(*) FILTER (WHERE captured_at >= v_week_start AND seller_qualification->>'temperatura' = 'quente'),
    'qualificados_hoje', count(*) FILTER (WHERE captured_at >= v_today_start AND coalesce(sales_score, 0) >= 45),
    'pendentes_complemento', count(*) FILTER (WHERE NOT capture_valid AND captured_at >= v_week_start),
    'handoff_pendente', count(*) FILTER (WHERE first_contact_at IS NULL
                                           AND handoff_status IN ('pending', 'notified', 'sla_breached', 'escalated', 'unassigned')
                                           AND seller_qualification->>'temperatura' IN ('quente', 'morno')
                                           AND captured_at >= v_month_start),
    'contatados_semana', count(*) FILTER (WHERE first_contact_at >= v_week_start),
    'em_atendimento', count(*) FILTER (WHERE sales_rep_id IS NOT NULL AND captured_at >= v_month_start),
    'captados_mes', (SELECT count(*) FROM seller_vehicles sv JOIN leads x ON x.id = sv.lead_id
                     WHERE x.captured_by_member_id = v_target AND sv.status IN ('captado', 'preparacao', 'anunciado', 'negociacao', 'vendido')
                       AND sv.captured_at >= v_month_start),
    'vendidos_mes', (SELECT count(*) FROM seller_vehicles sv JOIN leads x ON x.id = sv.lead_id
                     WHERE x.captured_by_member_id = v_target AND sv.status = 'vendido' AND sv.sold_at >= v_month_start),
    'retornos_nao_lidos', (SELECT count(*) FROM capture_lead_events e WHERE e.promotora_member_id = v_target AND e.read_at IS NULL),
    'wallet', (SELECT jsonb_build_object(
        'pending_cents',  coalesce(sum(amount_cents) FILTER (WHERE status = 'pending'  AND reward_type = 'cash'), 0),
        'earned_cents',   coalesce(sum(amount_cents) FILTER (WHERE status IN ('approved', 'paid') AND reward_type = 'cash'), 0),
        'vouchers_pending', count(*) FILTER (WHERE reward_type = 'voucher' AND status IN ('pending', 'approved')))
       FROM capture_reward_ledger WHERE promoter_id = v_target)
  ) INTO r
  FROM leads l
  WHERE l.captured_by_member_id = v_target;

  RETURN coalesce(r, '{}'::jsonb);
END;
$$;

-- Prêmios (catálogo) — progresso agora vem do ledger, sem botão de resgate.
CREATE OR REPLACE FUNCTION public.capture_reward_progress(p_member_id uuid DEFAULT NULL)
RETURNS TABLE (
  id uuid, name text, description text, image_url text,
  goal_type text, goal_value integer, stock integer,
  current_value integer, period_start date, eligible boolean,
  claim_id uuid, claim_status text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_member uuid := public.current_member_id(); v_target uuid; v_tenant uuid;
BEGIN
  IF v_member IS NULL THEN RETURN; END IF;
  v_target := CASE WHEN p_member_id IS NOT NULL AND (public.is_admin() OR public.is_superadmin()) THEN p_member_id ELSE v_member END;
  SELECT tenant_id INTO v_tenant FROM team_members WHERE team_members.id = v_target;

  RETURN QUERY
  SELECT r.id, r.name, r.description, r.image_url, r.goal_type, r.goal_value, r.stock,
         CASE WHEN r.goal_type = 'pontos_semana' THEN p.value
              ELSE (SELECT count(*)::int FROM leads x WHERE x.captured_by_member_id = v_target AND x.capture_valid
                    AND capture_period_start(CASE WHEN r.goal_type = 'leads_mes' THEN 'month' ELSE 'week' END, x.capture_validated_at) = p.period_start) END,
         p.period_start,
         (p.value >= r.goal_value AND (r.stock IS NULL OR r.stock > 0)) AS eligible,
         coalesce(lg.id, c.id), coalesce(lg.status, c.status)
  FROM capture_rewards r
  CROSS JOIN LATERAL public.capture_member_progress(v_target, r.goal_type) p
  LEFT JOIN LATERAL (SELECT g.id, g.status FROM capture_reward_ledger g JOIN capture_reward_rules rr ON rr.id = g.rule_id
                     WHERE rr.reward_id = r.id AND g.promoter_id = v_target AND g.period_start = p.period_start
                     ORDER BY g.earned_at DESC LIMIT 1) lg ON true
  LEFT JOIN capture_reward_claims c ON c.reward_id = r.id AND c.member_id = v_target AND c.period_start = p.period_start
  WHERE r.tenant_id = v_tenant AND r.is_active
  ORDER BY r.position, r.goal_value, r.created_at;
END;
$$;

-- ─── 15) Seeds Totex Motors (regras do PRD) + campanha/local ───────────────
DO $$
DECLARE v_tenant uuid := 'c13681e3-5db9-48d1-9c5c-856e6041d77f'; v_reward uuid; v_loc uuid; v_camp uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = v_tenant) THEN RETURN; END IF;
  SELECT id INTO v_reward FROM capture_rewards WHERE tenant_id = v_tenant AND name ILIKE 'Voucher Outback%' LIMIT 1;

  IF NOT EXISTS (SELECT 1 FROM capture_reward_rules WHERE tenant_id = v_tenant) THEN
    INSERT INTO capture_reward_rules (tenant_id, name, event_type, threshold, period_type, reward_type, amount_cents, voucher_label, reward_id, cap_per_period, position) VALUES
      (v_tenant, 'Meta semanal', 'lead_validated', 40, 'week', 'voucher', 0, 'Voucher Outback R$ 100', v_reward, 1, 1),
      (v_tenant, 'Veículo captado', 'vehicle_captured', NULL, NULL, 'cash', 2500, NULL, NULL, 1, 2),
      (v_tenant, 'Veículo vendido', 'vehicle_sold', NULL, NULL, 'cash', 5000, NULL, NULL, 1, 3);
    INSERT INTO capture_reward_rules (tenant_id, name, event_type, period_type, reward_type, amount_cents, min_valid_leads, cap_per_period, position)
    VALUES (v_tenant, 'Campeã do mês', 'monthly_champion', 'month', 'cash', 10000, 10, 1, 4);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM capture_locations WHERE tenant_id = v_tenant) THEN
    INSERT INTO capture_locations (tenant_id, name, kind, city_name, state) VALUES (v_tenant, 'Shopping Tamboré', 'shopping', 'Barueri', 'SP') RETURNING id INTO v_loc;
    INSERT INTO capture_campaigns (tenant_id, location_id, name, starts_at, is_active, focus_phrase, objection_phrase, objection_answer)
    VALUES (v_tenant, v_loc, 'Venda seu carro no Tamboré', current_date, true,
      'Você tem carro? Já pensou em vender aqui no shopping? A Totex avalia de graça e cuida de tudo.',
      'Não quero vender agora.', 'Tranquilo! Está pensando em trocar nos próximos meses? Deixo registrado e nosso especialista te manda a avaliação, sem compromisso.');
  END IF;
END $$;

-- Backfill: reavalia validade dos leads já captados (gera eventos/ledger da semana atual se couber)
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT id FROM leads WHERE captured_by_member_id IS NOT NULL LOOP PERFORM capture_evaluate_lead(r.id); END LOOP;
END $$;
