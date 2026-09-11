-- ============================================================================
-- INTERMEDIAÇÃO — Fase 1: núcleo (2026-09-11)
-- PRD "Contrato-Mestre de Intermediação v4" do Marco. Decisões desta fase:
--   • INTERMEDIAÇÃO vira a entidade-mãe (intermediations). "Captação" é só a
--     origem/1ª etapa. Lead do proprietário, veículo (seller_vehicles), deal
--     do funil, contrato, prazo, estados alternativos e prêmios apontam pra ela.
--   • Funil de 8 macroetapas (Captação · Avaliação · Contratar · Preparação ·
--     Em vitrine · Interessados · Fechamento · Concluída) + Encerrada.
--     Pagamento/financiamento/documento são submáquinas (fases 2–4), não colunas.
--   • REGRA DE OURO: o estágio é consequência do evento. Gate no funil impede
--     arrastar pra Preparação/Vitrine/… sem contrato e pra Concluída sem venda.
--   • FORMALIZADA (R$ 25 da promotora) = contrato assinado. Até o provedor de
--     assinatura entrar (fase 3, Clicksign), o caminho oficial é o fallback do
--     PRD 13.2.13: admin importa o PDF assinado (hash SHA-256 + motivo).
--   • CONCLUÍDA (R$ 50) = venda com evidência (regra de ontem) → fecha a
--     intermediação e move o funil sozinha.
--   • Prazo: cron diário avisa "vence em 7 dias" e "venceu" (tarefa pro
--     especialista). Ponto que faltava no PRD.
--   • Comunicação às promotoras sobre a mudança do R$ 25 (evento no feed).
-- ============================================================================

-- ─── 1) Entidade jurídica (razão social/CNPJ do contrato) ────────────────────
CREATE TABLE IF NOT EXISTS public.legal_entities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT public.get_tenant_id(),
  legal_name    text NOT NULL,
  trade_name    text,
  cnpj          text,
  address       text,
  city_name     text,
  state         text,
  zip           text,
  phone         text,
  email         text,
  is_default    boolean NOT NULL DEFAULT false,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS legal_entities_tenant_idx ON public.legal_entities(tenant_id);
ALTER TABLE public.legal_entities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS legal_entities_select ON public.legal_entities;
CREATE POLICY legal_entities_select ON public.legal_entities FOR SELECT TO authenticated
  USING (tenant_id = public.get_tenant_id() OR public.is_superadmin());
DROP POLICY IF EXISTS legal_entities_write ON public.legal_entities;
CREATE POLICY legal_entities_write ON public.legal_entities FOR ALL TO authenticated
  USING ((tenant_id = public.get_tenant_id() AND public.is_admin()) OR public.is_superadmin())
  WITH CHECK ((tenant_id = public.get_tenant_id() AND public.is_admin()) OR public.is_superadmin());
GRANT SELECT, INSERT, UPDATE ON public.legal_entities TO authenticated;
GRANT ALL ON public.legal_entities TO service_role;

-- ─── 2) INTERMEDIAÇÃO (entidade-mãe) ─────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS public.intermediation_code_seq;

CREATE TABLE IF NOT EXISTS public.intermediations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL,
  code                    text NOT NULL UNIQUE DEFAULT ('INT-' || lpad(nextval('public.intermediation_code_seq')::text, 5, '0')),
  legal_entity_id         uuid REFERENCES public.legal_entities(id) ON DELETE SET NULL,
  location_id             uuid REFERENCES public.capture_locations(id) ON DELETE SET NULL,
  -- partes
  owner_lead_id           uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  promoter_id             uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  source                  text NOT NULL DEFAULT 'promotora'
                          CHECK (source IN ('promotora', 'qr', 'indicacao', 'campanha', 'franqueado', 'manual', 'outro')),
  vehicle_id              uuid REFERENCES public.seller_vehicles(id) ON DELETE SET NULL,
  buyer_lead_id           uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  buyer_deal_id           uuid REFERENCES public.deals(id) ON DELETE SET NULL,
  -- ciclo de vida
  status                  text NOT NULL DEFAULT 'lead'
                          CHECK (status IN ('lead', 'contracting', 'active', 'completed',
                                            'paused', 'cancelled_by_owner', 'refused_by_totex', 'lost',
                                            'sold_outside', 'docs_pending')),
  status_before_pause     text,
  status_reason           text,
  activated_at            timestamptz,
  completed_at            timestamptz,
  closed_at               timestamptz,
  -- condições comerciais (Condições Específicas do contrato)
  asking_price            numeric,
  minimum_authorized_price numeric,
  commission_type         text CHECK (commission_type IS NULL OR commission_type IN ('fixed', 'percent')),
  commission_value        numeric,
  exclusive               boolean NOT NULL DEFAULT false,
  starts_at               date,
  ends_at                 date,
  custody_mode            text NOT NULL DEFAULT 'owner' CHECK (custody_mode IN ('owner', 'totex')),
  physical_display_authorized boolean NOT NULL DEFAULT true,
  test_drive_policy       text NOT NULL DEFAULT 'accompanied' CHECK (test_drive_policy IN ('accompanied', 'specific_authorization', 'not_allowed')),
  terms_notes             text,
  terms_set_at            timestamptz,
  terms_set_by            uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  -- contrato (fase 1: importado; fases 2/3: gerado + provedor)
  contract_status         text NOT NULL DEFAULT 'none'
                          CHECK (contract_status IN ('none', 'generated', 'sent', 'partial', 'signed', 'imported', 'declined', 'expired', 'cancelled')),
  contract_signed_at      timestamptz,
  contract_file_path      text,
  contract_sha256         text,
  contract_imported_by    uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  contract_import_reason  text,
  contract_document_id    uuid,
  -- prazo
  deadline_status         text NOT NULL DEFAULT 'ok' CHECK (deadline_status IN ('ok', 'expiring', 'expired')),
  deadline_alerted_at     timestamptz,
  -- fechamento / financeiro (fase 4 detalha)
  sale_price              numeric,
  payment_status          text NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'partial', 'satisfied', 'failed', 'cancelled')),
  transfer_status         text NOT NULL DEFAULT 'pending' CHECK (transfer_status IN ('pending', 'started', 'completed')),
  delivered_at            timestamptz,
  commission_due          numeric,
  commission_status       text NOT NULL DEFAULT 'pending' CHECK (commission_status IN ('pending', 'invoiced', 'paid', 'waived', 'disputed')),
  commission_paid_at      timestamptz,
  -- auditoria
  created_by              uuid,
  updated_by              uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS intermediations_owner_lead_uidx ON public.intermediations(owner_lead_id);
CREATE INDEX IF NOT EXISTS intermediations_tenant_status_idx ON public.intermediations(tenant_id, status);
CREATE INDEX IF NOT EXISTS intermediations_promoter_idx ON public.intermediations(promoter_id);
CREATE INDEX IF NOT EXISTS intermediations_ends_idx ON public.intermediations(ends_at) WHERE status = 'active';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_intermediations_updated_at') THEN
    CREATE TRIGGER update_intermediations_updated_at BEFORE UPDATE ON public.intermediations
      FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
  END IF;
EXCEPTION WHEN undefined_function THEN NULL; END $$;

ALTER TABLE public.seller_vehicles ADD COLUMN IF NOT EXISTS intermediation_id uuid REFERENCES public.intermediations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS seller_vehicles_intermediation_idx ON public.seller_vehicles(intermediation_id);

-- Trilha de auditoria da intermediação (PRD §11)
CREATE TABLE IF NOT EXISTS public.intermediation_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  intermediation_id  uuid NOT NULL REFERENCES public.intermediations(id) ON DELETE CASCADE,
  event_type         text NOT NULL,
  actor_member_id    uuid,
  payload            jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key    text UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS intermediation_events_int_idx ON public.intermediation_events(intermediation_id, created_at DESC);

-- RLS: tenant lê/edita; promotora só lê as suas (RESTRICTIVE); escrita real via RPCs
ALTER TABLE public.intermediations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intermediation_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS intermediations_tenant_select ON public.intermediations;
CREATE POLICY intermediations_tenant_select ON public.intermediations FOR SELECT TO authenticated
  USING (tenant_id = public.get_tenant_id() OR public.is_superadmin());
DROP POLICY IF EXISTS intermediations_tenant_update ON public.intermediations;
CREATE POLICY intermediations_tenant_update ON public.intermediations FOR UPDATE TO authenticated
  USING ((tenant_id = public.get_tenant_id() AND NOT public.is_promotora()) OR public.is_superadmin())
  WITH CHECK ((tenant_id = public.get_tenant_id() AND NOT public.is_promotora()) OR public.is_superadmin());
DROP POLICY IF EXISTS promotora_intermediations_own ON public.intermediations;
CREATE POLICY promotora_intermediations_own ON public.intermediations AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT public.is_promotora() OR promoter_id = public.current_member_id());
DROP POLICY IF EXISTS intermediation_events_select ON public.intermediation_events;
CREATE POLICY intermediation_events_select ON public.intermediation_events FOR SELECT TO authenticated
  USING (tenant_id = public.get_tenant_id() OR public.is_superadmin());
DROP POLICY IF EXISTS promotora_intermediation_events_own ON public.intermediation_events;
CREATE POLICY promotora_intermediation_events_own ON public.intermediation_events AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT public.is_promotora() OR EXISTS (SELECT 1 FROM public.intermediations i WHERE i.id = intermediation_id AND i.promoter_id = public.current_member_id()));
GRANT SELECT, UPDATE ON public.intermediations TO authenticated;
GRANT SELECT ON public.intermediation_events TO authenticated;
GRANT ALL ON public.intermediations, public.intermediation_events TO service_role;

CREATE OR REPLACE FUNCTION public.intermediation_log(p_id uuid, p_type text, p_payload jsonb DEFAULT '{}'::jsonb, p_key text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid;
BEGIN
  SELECT tenant_id INTO v_tenant FROM intermediations WHERE id = p_id;
  IF v_tenant IS NULL THEN RETURN; END IF;
  INSERT INTO intermediation_events (tenant_id, intermediation_id, event_type, actor_member_id, payload, idempotency_key)
  VALUES (v_tenant, p_id, p_type, public.current_member_id(), coalesce(p_payload, '{}'::jsonb), p_key)
  ON CONFLICT (idempotency_key) DO NOTHING;
END;
$$;

-- ─── 3) Nasce junto com o lead captado ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trg_intermediation_from_lead() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_le uuid;
BEGIN
  IF NEW.captured_by_member_id IS NULL THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM intermediations WHERE owner_lead_id = NEW.id) THEN RETURN NEW; END IF;
  SELECT id INTO v_le FROM legal_entities WHERE tenant_id = NEW.tenant_id AND is_active ORDER BY is_default DESC, created_at LIMIT 1;
  INSERT INTO intermediations (tenant_id, legal_entity_id, location_id, owner_lead_id, promoter_id, source, created_by)
  VALUES (NEW.tenant_id, v_le, NEW.capture_location_id, NEW.id, NEW.captured_by_member_id,
          CASE WHEN coalesce(NEW.capture_channel, '') ILIKE 'qr%' THEN 'qr' ELSE 'promotora' END, NEW.captured_by_member_id)
  RETURNING id INTO v_id;
  PERFORM intermediation_log(v_id, 'intermediation_lead_created', jsonb_build_object('lead_id', NEW.id, 'promoter_id', NEW.captured_by_member_id));
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_intermediation_from_lead ON public.leads;
CREATE TRIGGER trg_intermediation_from_lead AFTER INSERT ON public.leads
  FOR EACH ROW WHEN (NEW.captured_by_member_id IS NOT NULL)
  EXECUTE FUNCTION public.trg_intermediation_from_lead();

CREATE OR REPLACE FUNCTION public.trg_intermediation_link_vehicle() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM intermediations WHERE owner_lead_id = NEW.lead_id;
  IF v_id IS NULL THEN RETURN NEW; END IF;
  UPDATE seller_vehicles SET intermediation_id = v_id WHERE id = NEW.id AND intermediation_id IS NULL;
  UPDATE intermediations SET vehicle_id = NEW.id, asking_price = coalesce(asking_price, NEW.expected_price)
  WHERE id = v_id AND (vehicle_id IS NULL OR vehicle_id <> NEW.id);
  PERFORM intermediation_log(v_id, 'vehicle_registered', jsonb_build_object('vehicle_id', NEW.id));
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_intermediation_link_vehicle ON public.seller_vehicles;
CREATE TRIGGER trg_intermediation_link_vehicle AFTER INSERT ON public.seller_vehicles
  FOR EACH ROW EXECUTE FUNCTION public.trg_intermediation_link_vehicle();

-- ─── 4) Funil de 8 macroetapas + Encerrada ───────────────────────────────────
-- Vale pra todo pipeline cujo nome começa com "Capta"/"Intermedia" (um por tenant).
CREATE OR REPLACE FUNCTION public.intermediation_setup_pipeline(p_pipeline uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid; s record; fk record; v_old uuid; v_new uuid;
  v_map constant text[][] := ARRAY[
    -- nome antigo (ILIKE)         → nome novo
    ARRAY['Nova Capta%',            'Captação'],
    ARRAY['Novo',                   'Captação'],
    ARRAY['Contato feito',          'Captação'],
    ARRAY['Nutri%',                 'Captação'],
    ARRAY['Avalia%',                'Avaliação'],
    ARRAY['Veio%',                  'Avaliação'],
    ARRAY['Proposta',               'Contratar'],
    ARRAY['Ganho',                  'Concluída'],
    ARRAY['Captado',                'Concluída'],
    ARRAY['Perdido',                'Encerrada']
  ];
  v_stages constant text[][] := ARRAY[
    ARRAY['Captação',     '1', 'slate',   'Proprietário captado (promotora/QR/indicação). 1º contato e qualificação.'],
    ARRAY['Avaliação',    '2', 'blue',    'Avaliação/visita marcada ou feita, fotos, curadoria do carro.'],
    ARRAY['Contratar',    '3', 'orange',  'Condições comerciais (preço, comissão, prazo) e contrato de intermediação.'],
    ARRAY['Preparação',   '4', 'amber',   'Contrato assinado. Fotos, higienização, laudos, material de anúncio.'],
    ARRAY['Em vitrine',   '5', 'zinc',    'Anunciado no site/stand. Acende sozinho quando aparece no estoque do marketplace.'],
    ARRAY['Interessados', '6', 'purple',  'Compradores interessados, visitas, test drive, propostas.'],
    ARRAY['Fechamento',   '7', 'yellow',  'Proposta aprovada, compra e venda, pagamento e entrega.'],
    ARRAY['Concluída',    '8', 'green',   'Venda registrada com evidência. Acende sozinha.'],
    ARRAY['Encerrada',    '9', 'red',     'Cancelada, recusada, perdida ou prazo encerrado sem venda.']
  ];
BEGIN
  SELECT tenant_id INTO v_tenant FROM sales_pipelines WHERE id = p_pipeline;
  IF v_tenant IS NULL THEN RETURN; END IF;

  UPDATE sales_pipeline_stages SET position = position + 100 WHERE pipeline_id = p_pipeline;

  -- garante as 9 etapas novas
  FOR i IN 1 .. array_length(v_stages, 1) LOOP
    IF NOT EXISTS (SELECT 1 FROM sales_pipeline_stages WHERE pipeline_id = p_pipeline AND name = v_stages[i][1]) THEN
      INSERT INTO sales_pipeline_stages (tenant_id, pipeline_id, name, position, color, description, is_won, is_lost)
      VALUES (v_tenant, p_pipeline, v_stages[i][1], v_stages[i][2]::int, v_stages[i][3], v_stages[i][4],
              v_stages[i][1] = 'Concluída', v_stages[i][1] = 'Encerrada');
    ELSE
      UPDATE sales_pipeline_stages SET position = v_stages[i][2]::int, color = v_stages[i][3], description = v_stages[i][4],
             is_won = (v_stages[i][1] = 'Concluída'), is_lost = (v_stages[i][1] = 'Encerrada')
      WHERE pipeline_id = p_pipeline AND name = v_stages[i][1];
    END IF;
  END LOOP;

  -- migra deals/leads/regras das etapas antigas e remove as antigas
  FOR i IN 1 .. array_length(v_map, 1) LOOP
    FOR s IN SELECT id FROM sales_pipeline_stages WHERE pipeline_id = p_pipeline AND name ILIKE v_map[i][1] AND position > 100 LOOP
      v_old := s.id;
      SELECT id INTO v_new FROM sales_pipeline_stages WHERE pipeline_id = p_pipeline AND name = v_map[i][2] AND position <= 100 LIMIT 1;
      IF v_new IS NULL THEN CONTINUE; END IF;
      -- reponta TODA FK que aponte pra etapa antiga (deals, leads, lead_distribution_config, …)
      FOR fk IN
        SELECT c.conrelid::regclass AS tbl, a.attname AS col
        FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.contype = 'f' AND c.confrelid = 'public.sales_pipeline_stages'::regclass
      LOOP
        EXECUTE format('UPDATE %s SET %I = $1 WHERE %I = $2', fk.tbl, fk.col, fk.col) USING v_new, v_old;
      END LOOP;
      UPDATE sales_automation_rules SET action_config = action_config || jsonb_build_object('target_stage_id', v_new::text)
        WHERE (action_config->>'target_stage_id') = v_old::text;
      DELETE FROM sales_pipeline_stages WHERE id = v_old;
    END LOOP;
  END LOOP;
  -- sobras desconhecidas voltam pro fim (não apaga o que não conhecemos)
  UPDATE sales_pipeline_stages SET position = position - 100 + 20 WHERE pipeline_id = p_pipeline AND position > 100;

  UPDATE sales_pipelines SET name = regexp_replace(name, '^Capta[çc][aã]o( de Ve[ií]culos)?', 'Intermediação'),
         description = 'Intermediação de veículos: da captação (promotora) à venda. Estágio = consequência do evento (contrato, anúncio, venda).'
  WHERE id = p_pipeline AND name ILIKE 'Capta%';
END;
$$;

DO $$ DECLARE p record; BEGIN
  FOR p IN SELECT id FROM sales_pipelines WHERE name ILIKE 'Capta%' OR name ILIKE 'Intermedia%' LOOP
    PERFORM intermediation_setup_pipeline(p.id);
  END LOOP;
END $$;

-- Quem procura o funil pelo nome passa a aceitar "Intermediação…" (e ainda "Captação…")
CREATE OR REPLACE FUNCTION public.capture_pipeline_id(p_tenant uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM sales_pipelines WHERE tenant_id = p_tenant AND (name ILIKE 'Intermedia%' OR name ILIKE 'Capta%') AND is_active
  ORDER BY (name ILIKE 'Intermedia%') DESC, position LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.capture_pipeline_first_stage(p_tenant uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id FROM sales_pipeline_stages s
  WHERE s.pipeline_id = public.capture_pipeline_id(p_tenant)
  ORDER BY s.position LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.ensure_capture_pipeline() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid := public.get_tenant_id(); v_pipeline uuid;
BEGIN
  IF NOT (public.is_admin() OR public.is_superadmin()) THEN RAISE EXCEPTION 'Apenas admin pode criar o funil de intermediação'; END IF;
  v_pipeline := public.capture_pipeline_id(v_tenant);
  IF v_pipeline IS NULL THEN
    INSERT INTO sales_pipelines (tenant_id, name, description, position, is_default, is_active)
    VALUES (v_tenant, 'Intermediação de Veículos',
            'Intermediação de veículos: da captação (promotora) à venda. Estágio = consequência do evento.',
            (SELECT coalesce(max(position), 0) + 1 FROM sales_pipelines WHERE tenant_id = v_tenant), false, true)
    RETURNING id INTO v_pipeline;
  END IF;
  PERFORM public.intermediation_setup_pipeline(v_pipeline);
  RETURN v_pipeline;
END;
$$;

-- ─── 5) Gate do funil: o estágio é consequência do evento ────────────────────
CREATE OR REPLACE FUNCTION public.trg_intermediation_deal_gate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i intermediations%ROWTYPE; s record;
BEGIN
  SELECT * INTO i FROM intermediations WHERE owner_lead_id = NEW.lead_id;
  IF i.id IS NULL THEN RETURN NEW; END IF;
  IF current_setting('app.intermediation_bypass', true) = 'on' THEN RETURN NEW; END IF;
  SELECT name, is_won, is_lost INTO s FROM sales_pipeline_stages WHERE id = NEW.pipeline_stage_id;

  IF coalesce(s.is_won, false) AND i.status <> 'completed' THEN
    RAISE EXCEPTION 'Concluída acende sozinha: registre a venda no card Intermediação (valor + comprador) no detalhe do lead.';
  END IF;
  IF (s.name ILIKE 'Prepara%' OR s.name ILIKE 'Em vitrine%' OR s.name ILIKE 'Interessad%' OR s.name ILIKE 'Fechamento%')
     AND i.status NOT IN ('active', 'completed', 'paused', 'docs_pending') THEN
    RAISE EXCEPTION 'Só depois do contrato de intermediação assinado (%). Registre as condições e importe o contrato no card Intermediação.', i.code;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_intermediation_deal_gate ON public.deals;
CREATE TRIGGER trg_intermediation_deal_gate BEFORE UPDATE OF pipeline_stage_id ON public.deals
  FOR EACH ROW WHEN (OLD.pipeline_stage_id IS DISTINCT FROM NEW.pipeline_stage_id)
  EXECUTE FUNCTION public.trg_intermediation_deal_gate();

-- capture_move_stage (automações, só pra frente) passa por fora do gate: quem move é o evento
CREATE OR REPLACE FUNCTION public.capture_move_stage(p_lead_id uuid, p_pattern text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_deal_id uuid; v_stage uuid; v_pipeline uuid; v_cur_pos integer; v_cur_won boolean; v_cur_lost boolean; v_target_id uuid; v_target_pos integer;
BEGIN
  SELECT id, pipeline_stage_id, pipeline_id INTO v_deal_id, v_stage, v_pipeline FROM deals
  WHERE lead_id = p_lead_id AND status = 'negotiation' ORDER BY created_at DESC LIMIT 1;
  IF v_deal_id IS NULL THEN SELECT pipeline_stage_id INTO v_stage FROM leads WHERE id = p_lead_id; END IF;
  IF v_stage IS NULL THEN RETURN false; END IF;
  SELECT coalesce(v_pipeline, s.pipeline_id), s.position, coalesce(s.is_won, false), coalesce(s.is_lost, false)
    INTO v_pipeline, v_cur_pos, v_cur_won, v_cur_lost FROM sales_pipeline_stages s WHERE s.id = v_stage;
  IF v_pipeline IS NULL OR v_cur_won OR v_cur_lost THEN RETURN false; END IF;
  SELECT id, position INTO v_target_id, v_target_pos FROM sales_pipeline_stages
  WHERE pipeline_id = v_pipeline AND name ILIKE p_pattern ORDER BY position LIMIT 1;
  IF v_target_id IS NULL OR v_target_pos <= coalesce(v_cur_pos, 0) THEN RETURN false; END IF;
  PERFORM set_config('app.intermediation_bypass', 'on', true);
  IF v_deal_id IS NOT NULL THEN
    UPDATE deals SET pipeline_stage_id = v_target_id, stage_changed_at = now(), updated_at = now() WHERE id = v_deal_id;
  ELSE
    UPDATE leads SET pipeline_stage_id = v_target_id WHERE id = p_lead_id;
  END IF;
  PERFORM set_config('app.intermediation_bypass', 'off', true);
  RETURN true;
END;
$$;

-- Mover o deal por nome de etapa, em qualquer direção, sem o gate (uso interno)
CREATE OR REPLACE FUNCTION public.intermediation_move_deal(p_lead_id uuid, p_pattern text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_deal uuid; v_pipe uuid; v_target uuid; v_cur uuid;
BEGIN
  SELECT id, pipeline_id, pipeline_stage_id INTO v_deal, v_pipe, v_cur FROM deals
  WHERE lead_id = p_lead_id AND status = 'negotiation' ORDER BY created_at DESC LIMIT 1;
  IF v_deal IS NULL THEN
    SELECT s.pipeline_id, l.pipeline_stage_id INTO v_pipe, v_cur FROM leads l JOIN sales_pipeline_stages s ON s.id = l.pipeline_stage_id WHERE l.id = p_lead_id;
  END IF;
  IF v_pipe IS NULL THEN RETURN false; END IF;
  SELECT id INTO v_target FROM sales_pipeline_stages WHERE pipeline_id = v_pipe AND name ILIKE p_pattern ORDER BY position LIMIT 1;
  IF v_target IS NULL OR v_target = v_cur THEN RETURN false; END IF;
  PERFORM set_config('app.intermediation_bypass', 'on', true);
  IF v_deal IS NOT NULL THEN
    UPDATE deals SET pipeline_stage_id = v_target, stage_changed_at = now(), updated_at = now() WHERE id = v_deal;
  ELSE
    UPDATE leads SET pipeline_stage_id = v_target WHERE id = p_lead_id;
  END IF;
  PERFORM set_config('app.intermediation_bypass', 'off', true);
  RETURN true;
END;
$$;

-- Deal → estágio → status do carro/intermediação (substitui trg_capture_deal_vehicle)
CREATE OR REPLACE FUNCTION public.trg_capture_deal_vehicle() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s record; v_vid uuid; i record;
BEGIN
  SELECT id, status INTO i FROM intermediations WHERE owner_lead_id = NEW.lead_id;
  IF i.id IS NULL THEN RETURN NEW; END IF;
  SELECT name, is_won, is_lost INTO s FROM sales_pipeline_stages WHERE id = NEW.pipeline_stage_id;
  SELECT id INTO v_vid FROM seller_vehicles WHERE lead_id = NEW.lead_id ORDER BY created_at DESC LIMIT 1;

  IF s.name ILIKE 'Avalia%' AND v_vid IS NOT NULL THEN
    UPDATE seller_vehicles SET status = 'avaliacao', status_changed_at = now() WHERE id = v_vid AND status = 'lead';
  ELSIF s.name ILIKE 'Contratar%' AND i.status = 'lead' THEN
    UPDATE intermediations SET status = 'contracting' WHERE id = i.id;
  ELSIF s.name ILIKE 'Prepara%' AND v_vid IS NOT NULL THEN
    UPDATE seller_vehicles SET status = 'preparacao', status_changed_at = now() WHERE id = v_vid AND status IN ('lead', 'avaliacao', 'captado');
  ELSIF s.name ILIKE 'Interessad%' AND v_vid IS NOT NULL THEN
    UPDATE seller_vehicles SET status = 'negociacao', status_changed_at = now() WHERE id = v_vid AND status IN ('captado', 'preparacao', 'anunciado');
  ELSIF coalesce(s.is_lost, false) AND i.status NOT IN ('completed', 'cancelled_by_owner', 'refused_by_totex', 'lost', 'sold_outside') THEN
    UPDATE intermediations SET status = 'lost', status_reason = coalesce(status_reason, 'Encerrada no funil'), closed_at = now() WHERE id = i.id;
  END IF;
  RETURN NEW;
END;
$$;
-- (trigger trg_capture_deal_vehicle já existe apontando pra esta função)

-- Tarefas movem o funil (nomes novos)
CREATE OR REPLACE FUNCTION public.trg_capture_task_stage() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.lead_id IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM leads WHERE id = NEW.lead_id AND captured_by_member_id IS NOT NULL) THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.task_type IN ('trade_eval', 'visit', 'meeting', 'video_call') AND NEW.scheduled_at IS NOT NULL
       AND coalesce(NEW.source_type, '') <> 'captacao' THEN
      PERFORM public.capture_move_stage(NEW.lead_id, 'Avalia%');
    ELSIF NEW.task_type = 'proposal' THEN
      PERFORM public.capture_move_stage(NEW.lead_id, 'Contratar%');
    END IF;
  ELSIF TG_OP = 'UPDATE' AND NEW.completed = true AND OLD.completed IS DISTINCT FROM true THEN
    IF NEW.task_type IN ('trade_eval', 'visit', 'photo_session') THEN
      PERFORM public.capture_move_stage(NEW.lead_id, 'Avalia%');
    ELSIF NEW.task_type = 'proposal' THEN
      PERFORM public.capture_move_stage(NEW.lead_id, 'Contratar%');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- 1º contato: só registra (não existe mais coluna "Contato feito")
CREATE OR REPLACE FUNCTION public.capture_mark_first_contact(p_lead_id uuid, p_source text, p_actor uuid DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_lead record; v_rep text; v_int uuid;
BEGIN
  UPDATE leads SET first_contact_at = now(), handoff_status = 'contacted'
  WHERE id = p_lead_id AND captured_by_member_id IS NOT NULL AND first_contact_at IS NULL
  RETURNING id, name, sales_rep_id INTO v_lead;
  IF v_lead.id IS NULL THEN RETURN false; END IF;
  SELECT name INTO v_rep FROM team_members WHERE id = coalesce(p_actor, v_lead.sales_rep_id);
  PERFORM public.capture_add_event(p_lead_id, 'contacted', v_lead.name || ' foi contatado',
    coalesce(split_part(v_rep, ' ', 1), 'O especialista') || ' fez o 1º contato'
      || CASE p_source WHEN 'whatsapp' THEN ' pelo WhatsApp' WHEN 'tarefa' THEN ' (tarefa concluída)' ELSE '' END || '.',
    coalesce(p_actor, v_lead.sales_rep_id));
  SELECT id INTO v_int FROM intermediations WHERE owner_lead_id = p_lead_id;
  IF v_int IS NOT NULL THEN PERFORM intermediation_log(v_int, 'intermediation_qualified', jsonb_build_object('source', p_source)); END IF;
  RETURN true;
END;
$$;

-- 3 dias em Captação com 1º contato feito e sem avaliação → follow-up
CREATE OR REPLACE FUNCTION public.capture_stale_followups(p_days integer DEFAULT 3)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; v_out jsonb := '[]'::jsonb; v_task uuid; v_rep text;
BEGIN
  FOR r IN
    SELECT d.id AS deal_id, d.tenant_id, d.lead_id, d.sales_rep_id, l.name AS lead_name,
           floor(extract(epoch FROM (now() - coalesce(l.first_contact_at, d.stage_changed_at, d.updated_at))) / 86400)::int AS dias
    FROM deals d
    JOIN sales_pipeline_stages s ON s.id = d.pipeline_stage_id AND s.name ILIKE 'Capta%'
    JOIN leads l ON l.id = d.lead_id AND l.captured_by_member_id IS NOT NULL AND l.first_contact_at IS NOT NULL
    LEFT JOIN intermediations i ON i.owner_lead_id = l.id
    WHERE d.status = 'negotiation'
      AND coalesce(i.status, 'lead') IN ('lead', 'contracting')
      AND coalesce(l.first_contact_at, d.stage_changed_at, d.updated_at) < now() - make_interval(days => p_days)
      AND (d.metadata->>'stale_followup_at') IS NULL
      AND NOT EXISTS (SELECT 1 FROM company_activities t
                      WHERE t.lead_id = d.lead_id AND t.completed = false
                        AND t.status <> 'cancelled' AND t.scheduled_at > now()
                        AND t.task_type IN ('trade_eval', 'visit', 'meeting', 'video_call'))
  LOOP
    INSERT INTO company_activities (tenant_id, name, description, task_type, priority, status, completed,
      due_datetime, lead_id, responsavel_id, team, source_type, source_id, metadata)
    VALUES (r.tenant_id, 'Follow-up intermediação — agendar avaliação: ' || r.lead_name,
      '1º contato feito há ' || r.dias || ' dias e nenhuma avaliação marcada. Retomar contato e agendar (ou pausar/encerrar a intermediação).',
      'follow_up', 'high', 'not_started', false, now(), r.lead_id, r.sales_rep_id, 'sales', 'captacao', r.lead_id,
      jsonb_build_object('captacao', true, 'stale_followup', true))
    RETURNING id INTO v_task;
    UPDATE deals SET metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('stale_followup_at', now(), 'stale_followup_task', v_task)
    WHERE id = r.deal_id;
    SELECT split_part(name, ' ', 1) INTO v_rep FROM team_members WHERE id = r.sales_rep_id;
    v_out := v_out || jsonb_build_object('tenant_id', r.tenant_id, 'lead', r.lead_name, 'rep', coalesce(v_rep, '—'), 'dias', r.dias);
  END LOOP;
  RETURN v_out;
END;
$$;

-- ─── 6) Prêmios: FORMALIZADA (R$ 25) e CONCLUÍDA (R$ 50) ────────────────────
ALTER TABLE public.capture_reward_rules DROP CONSTRAINT IF EXISTS capture_reward_rules_event_type_check;
ALTER TABLE public.capture_reward_rules ADD CONSTRAINT capture_reward_rules_event_type_check
  CHECK (event_type IN ('lead_validated', 'vehicle_captured', 'vehicle_sold', 'monthly_champion', 'intermediation_formalized', 'intermediation_completed'));
ALTER TABLE public.capture_events DROP CONSTRAINT IF EXISTS capture_events_event_type_check;
ALTER TABLE public.capture_events ADD CONSTRAINT capture_events_event_type_check
  CHECK (event_type IN ('lead_submitted', 'lead_validated', 'lead_invalidated', 'vehicle_captured', 'vehicle_sold', 'monthly_champion',
                        'reward_approved', 'reward_paid', 'reward_cancelled', 'intermediation_formalized', 'intermediation_completed'));
UPDATE capture_reward_rules SET event_type = 'intermediation_formalized', name = CASE WHEN name = 'Veículo captado' THEN 'Intermediação formalizada (contrato assinado)' ELSE name END
  WHERE event_type = 'vehicle_captured';
UPDATE capture_reward_rules SET event_type = 'intermediation_completed', name = CASE WHEN name = 'Veículo vendido' THEN 'Intermediação concluída (venda)' ELSE name END
  WHERE event_type = 'vehicle_sold';

-- Status da intermediação → eventos, prêmios, funil, feed da promotora
CREATE OR REPLACE FUNCTION public.trg_intermediation_status() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE l record; ev record; r capture_reward_rules%ROWTYPE; v_desc text; v_ledger uuid; v_evidence text; v record;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  SELECT id, tenant_id, name, captured_by_member_id, capture_campaign_id INTO l FROM leads WHERE id = NEW.owner_lead_id;
  SELECT * INTO v FROM seller_vehicles WHERE id = coalesce(NEW.vehicle_id, (SELECT id FROM seller_vehicles WHERE lead_id = NEW.owner_lead_id ORDER BY created_at DESC LIMIT 1));
  v_desc := coalesce(v.description, nullif(concat_ws(' ', v.brand, v.model), ''), 'veículo') || coalesce(' ' || v.year_model::text, '');

  IF NEW.status = 'active' AND OLD.status IS DISTINCT FROM 'active' AND NEW.activated_at IS NOT NULL THEN
    PERFORM intermediation_log(NEW.id, 'intermediation_activated', jsonb_build_object('contract_status', NEW.contract_status), 'activated:' || NEW.id);
    IF NEW.promoter_id IS NOT NULL THEN
      SELECT * INTO ev FROM capture_emit_event(NEW.tenant_id, NEW.promoter_id, 'intermediation_formalized', 'intermediation_formalized:' || NEW.id, NEW.owner_lead_id, NULL, v.id,
                                               jsonb_build_object('intermediation_id', NEW.id, 'code', NEW.code, 'contract_status', NEW.contract_status));
      IF ev.created THEN
        PERFORM capture_add_event(NEW.owner_lead_id, 'won', '📝 ' || NEW.code || ' formalizada: ' || v_desc, 'Contrato de intermediação assinado. Agora é preparar e anunciar.');
        FOR r IN SELECT * FROM capture_reward_rules WHERE tenant_id = NEW.tenant_id AND active AND event_type = 'intermediation_formalized'
                 AND (campaign_id IS NULL OR campaign_id = l.capture_campaign_id) LOOP
          v_ledger := capture_award(r, NEW.promoter_id, ev.event_id, NEW.owner_lead_id, capture_period_start('month'),
                                    'rule:' || r.id || ':lead:' || NEW.owner_lead_id, r.name || ' — ' || v_desc);
          IF v_ledger IS NOT NULL THEN UPDATE capture_reward_ledger SET note = 'Contrato ' || NEW.contract_status || coalesce(' · hash ' || left(NEW.contract_sha256, 12), '') || coalesce(' · ' || NEW.contract_import_reason, '') WHERE id = v_ledger; END IF;
        END LOOP;
      END IF;
    END IF;

  ELSIF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed' THEN
    PERFORM intermediation_log(NEW.id, 'intermediation_completed', jsonb_build_object('sale_price', NEW.sale_price, 'commission_due', NEW.commission_due), 'completed:' || NEW.id);
    IF NEW.promoter_id IS NOT NULL THEN
      v_evidence := 'Venda ' || coalesce(capture_fmt_brl(NEW.sale_price), 'sem valor') || coalesce(' · ' || v.sold_note, '')
        || CASE WHEN v.sold_marked_by IS NOT NULL THEN ' · marcado por ' || coalesce((SELECT name FROM team_members WHERE id = v.sold_marked_by), '?') ELSE ' · automático (negócio do comprador)' END;
      SELECT * INTO ev FROM capture_emit_event(NEW.tenant_id, NEW.promoter_id, 'intermediation_completed', 'intermediation_completed:' || NEW.id, NEW.owner_lead_id, v.sold_deal_id, v.id,
                                               jsonb_build_object('intermediation_id', NEW.id, 'code', NEW.code, 'sale_price', NEW.sale_price, 'evidence', v_evidence));
      IF ev.created THEN
        PERFORM capture_add_event(NEW.owner_lead_id, 'sold', '🎉 VENDEU! ' || v_desc, 'A intermediação ' || NEW.code || ' foi concluída.');
        FOR r IN SELECT * FROM capture_reward_rules WHERE tenant_id = NEW.tenant_id AND active AND event_type = 'intermediation_completed'
                 AND (campaign_id IS NULL OR campaign_id = l.capture_campaign_id) LOOP
          v_ledger := capture_award(r, NEW.promoter_id, ev.event_id, NEW.owner_lead_id, capture_period_start('month'),
                                    'rule:' || r.id || ':lead:' || NEW.owner_lead_id, r.name || ' — ' || v_desc);
          IF v_ledger IS NOT NULL THEN UPDATE capture_reward_ledger SET note = v_evidence WHERE id = v_ledger; END IF;
        END LOOP;
      END IF;
    END IF;
    PERFORM intermediation_move_deal(NEW.owner_lead_id, 'Conclu%');

  ELSIF NEW.status IN ('cancelled_by_owner', 'refused_by_totex', 'lost', 'sold_outside') THEN
    PERFORM intermediation_log(NEW.id, 'intermediation_cancelled', jsonb_build_object('status', NEW.status, 'reason', NEW.status_reason));
    PERFORM intermediation_move_deal(NEW.owner_lead_id, 'Encerrada%');
    IF v.id IS NOT NULL AND v.status NOT IN ('vendido', 'perdido') THEN
      UPDATE seller_vehicles SET status = 'perdido', status_changed_at = now() WHERE id = v.id;
    END IF;
    PERFORM capture_add_event(NEW.owner_lead_id, 'lost', NEW.code || ' encerrada: ' || v_desc,
      CASE NEW.status WHEN 'cancelled_by_owner' THEN 'O proprietário desistiu.' WHEN 'refused_by_totex' THEN 'Não seguimos com esse carro.'
                      WHEN 'sold_outside' THEN 'Proprietário vendeu por fora — comissão em análise.' ELSE 'Não converteu dessa vez.' END);
  ELSIF NEW.status = 'paused' THEN
    PERFORM intermediation_log(NEW.id, 'intermediation_paused', jsonb_build_object('reason', NEW.status_reason));
  ELSIF NEW.status = 'docs_pending' THEN
    PERFORM intermediation_log(NEW.id, 'documentation_pending', jsonb_build_object('reason', NEW.status_reason));
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_intermediation_status ON public.intermediations;
CREATE TRIGGER trg_intermediation_status AFTER UPDATE OF status ON public.intermediations
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.trg_intermediation_status();

-- Carro: captado não paga mais (paga o contrato); vendido/anunciado atualizam a intermediação
CREATE OR REPLACE FUNCTION public.trg_capture_vehicle_status() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE l record; v_desc text; i intermediations%ROWTYPE; v_comm numeric;
BEGIN
  SELECT id, tenant_id, name, captured_by_member_id INTO l FROM leads WHERE id = NEW.lead_id;
  IF l.captured_by_member_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO i FROM intermediations WHERE owner_lead_id = NEW.lead_id;
  v_desc := coalesce(NEW.description, nullif(concat_ws(' ', NEW.brand, NEW.model), ''), 'veículo') || coalesce(' ' || NEW.year_model::text, '');

  IF NEW.status = 'vendido' AND OLD.status IS DISTINCT FROM 'vendido' THEN
    UPDATE seller_vehicles SET sold_at = coalesce(sold_at, now()) WHERE id = NEW.id AND sold_at IS NULL;
    IF i.id IS NOT NULL AND i.status <> 'completed' THEN
      v_comm := CASE i.commission_type WHEN 'fixed' THEN i.commission_value
                                       WHEN 'percent' THEN round(coalesce(NEW.sold_price, 0) * i.commission_value / 100.0, 2) END;
      UPDATE intermediations SET status = 'completed', completed_at = now(), closed_at = now(), sale_price = NEW.sold_price,
             buyer_deal_id = coalesce(NEW.sold_deal_id, buyer_deal_id),
             buyer_lead_id = coalesce((SELECT lead_id FROM deals WHERE id = NEW.sold_deal_id), buyer_lead_id),
             commission_due = v_comm
      WHERE id = i.id;
    END IF;
  ELSIF NEW.status = 'anunciado' AND OLD.status IS DISTINCT FROM 'anunciado' THEN
    PERFORM capture_add_event(NEW.lead_id, 'stage', '📢 ' || v_desc || ' foi anunciado!',
      'Já está no site da Totex' || coalesce(' por ' || capture_fmt_brl(NEW.listing_price, false), '') || '. Agora é atrair comprador.');
    IF i.id IS NOT NULL THEN
      PERFORM intermediation_log(i.id, 'vehicle_published', jsonb_build_object('listing_url', NEW.listing_url, 'listing_price', NEW.listing_price));
      PERFORM capture_move_stage(NEW.lead_id, 'Em vitrine%');
    END IF;
  ELSIF NEW.status = 'negociacao' AND OLD.status IS DISTINCT FROM 'negociacao' THEN
    PERFORM capture_add_event(NEW.lead_id, 'stage', '🤝 ' || v_desc || ' em negociação', 'Tem comprador interessado e proposta na mesa.');
    IF i.id IS NOT NULL THEN
      PERFORM intermediation_log(i.id, 'buyer_linked', '{}'::jsonb);
      PERFORM capture_move_stage(NEW.lead_id, 'Interessad%');
    END IF;
  ELSIF NEW.status = 'captado' AND OLD.status IS DISTINCT FROM 'captado' THEN
    PERFORM capture_add_event(NEW.lead_id, 'stage', v_desc || ' → Captado', 'Carro entrou pra intermediação. O prêmio vem com o contrato assinado.');
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM capture_add_event(NEW.lead_id, 'stage', v_desc || ' → ' || initcap(NEW.status), NULL);
  END IF;
  RETURN NEW;
END;
$$;

-- ─── 7) RPCs ─────────────────────────────────────────────────────────────────
-- Condições comerciais (comercial/admin). p_terms: asking_price, minimum_authorized_price,
-- commission_type, commission_value, exclusive, starts_at, ends_at, custody_mode,
-- physical_display_authorized, test_drive_policy, terms_notes
CREATE OR REPLACE FUNCTION public.intermediation_set_terms(p_id uuid, p_terms jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i intermediations%ROWTYPE; v_complete boolean; v_ct text; v_cv numeric;
BEGIN
  IF public.is_promotora() THEN RAISE EXCEPTION 'Promotora não define condições comerciais'; END IF;
  SELECT * INTO i FROM intermediations WHERE id = p_id;
  IF i.id IS NULL OR (i.tenant_id <> public.get_tenant_id() AND NOT public.is_superadmin()) THEN RAISE EXCEPTION 'Intermediação não encontrada'; END IF;
  IF i.status IN ('completed', 'cancelled_by_owner', 'refused_by_totex', 'lost', 'sold_outside') THEN RAISE EXCEPTION 'Intermediação encerrada (%)', i.status; END IF;
  IF i.status = 'active' AND (p_terms ? 'commission_value' OR p_terms ? 'commission_type' OR p_terms ? 'asking_price' OR p_terms ? 'ends_at') THEN
    RAISE EXCEPTION 'Contrato já assinado: preço, comissão e prazo mudam só por aditivo/nova versão (fase 2).';
  END IF;

  v_ct := coalesce(nullif(p_terms->>'commission_type', ''), i.commission_type);
  v_cv := CASE WHEN p_terms ? 'commission_value' THEN nullif(p_terms->>'commission_value', '')::numeric ELSE i.commission_value END;
  IF v_ct = 'percent' AND v_cv IS NOT NULL AND (v_cv <= 0 OR v_cv > 30) THEN RAISE EXCEPTION 'Comissão em %% fora do razoável (0–30)'; END IF;
  IF v_ct = 'fixed' AND v_cv IS NOT NULL AND v_cv < 0 THEN RAISE EXCEPTION 'Comissão fixa inválida'; END IF;

  UPDATE intermediations SET
    asking_price             = CASE WHEN p_terms ? 'asking_price' THEN nullif(p_terms->>'asking_price', '')::numeric ELSE asking_price END,
    minimum_authorized_price = CASE WHEN p_terms ? 'minimum_authorized_price' THEN nullif(p_terms->>'minimum_authorized_price', '')::numeric ELSE minimum_authorized_price END,
    commission_type          = v_ct,
    commission_value         = v_cv,
    exclusive                = coalesce((p_terms->>'exclusive')::boolean, exclusive),
    starts_at                = CASE WHEN p_terms ? 'starts_at' THEN nullif(p_terms->>'starts_at', '')::date ELSE starts_at END,
    ends_at                  = CASE WHEN p_terms ? 'ends_at' THEN nullif(p_terms->>'ends_at', '')::date ELSE ends_at END,
    custody_mode             = coalesce(nullif(p_terms->>'custody_mode', ''), custody_mode),
    physical_display_authorized = coalesce((p_terms->>'physical_display_authorized')::boolean, physical_display_authorized),
    test_drive_policy        = coalesce(nullif(p_terms->>'test_drive_policy', ''), test_drive_policy),
    terms_notes              = CASE WHEN p_terms ? 'terms_notes' THEN nullif(p_terms->>'terms_notes', '') ELSE terms_notes END,
    terms_set_at             = now(),
    terms_set_by             = public.current_member_id(),
    updated_by               = public.current_member_id()
  WHERE id = p_id
  RETURNING * INTO i;

  IF i.ends_at IS NOT NULL AND i.starts_at IS NOT NULL AND i.ends_at < i.starts_at THEN RAISE EXCEPTION 'Prazo final antes do início'; END IF;
  IF i.minimum_authorized_price IS NOT NULL AND i.asking_price IS NOT NULL AND i.minimum_authorized_price > i.asking_price THEN
    RAISE EXCEPTION 'Preço mínimo maior que o preço pretendido';
  END IF;

  v_complete := i.asking_price IS NOT NULL AND i.commission_type IS NOT NULL AND i.commission_value IS NOT NULL AND i.ends_at IS NOT NULL;
  PERFORM intermediation_log(p_id, 'commercial_terms_set', p_terms || jsonb_build_object('complete', v_complete));
  IF v_complete AND i.status = 'lead' THEN
    UPDATE intermediations SET status = 'contracting' WHERE id = p_id;
    PERFORM capture_move_stage(i.owner_lead_id, 'Contratar%');
  END IF;
  RETURN jsonb_build_object('ok', true, 'complete', v_complete, 'status', (SELECT status FROM intermediations WHERE id = p_id));
END;
$$;
GRANT EXECUTE ON FUNCTION public.intermediation_set_terms(uuid, jsonb) TO authenticated;

-- Importar contrato assinado (fallback PRD 13.2.13 — só admin). Formaliza + R$ 25.
CREATE OR REPLACE FUNCTION public.intermediation_import_signed_contract(
  p_id uuid, p_file_path text, p_sha256 text, p_signed_at timestamptz DEFAULT now(), p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i intermediations%ROWTYPE; v_vid uuid;
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

  UPDATE intermediations SET
    contract_status = 'imported', contract_signed_at = coalesce(p_signed_at, now()), contract_file_path = p_file_path,
    contract_sha256 = p_sha256, contract_imported_by = public.current_member_id(), contract_import_reason = btrim(p_reason),
    status = 'active', activated_at = now(), status_before_pause = NULL, status_reason = NULL,
    starts_at = coalesce(starts_at, coalesce(p_signed_at, now())::date), updated_by = public.current_member_id()
  WHERE id = p_id;
  PERFORM intermediation_log(p_id, 'intermediation_contract_signed',
    jsonb_build_object('mode', 'imported', 'sha256', p_sha256, 'file', p_file_path, 'reason', p_reason), 'contract_signed:' || p_id);

  SELECT id INTO v_vid FROM seller_vehicles WHERE lead_id = i.owner_lead_id ORDER BY created_at DESC LIMIT 1;
  IF v_vid IS NOT NULL THEN
    UPDATE seller_vehicles SET status = 'captado', captured_at = coalesce(captured_at, now()), status_changed_at = now()
    WHERE id = v_vid AND status IN ('lead', 'avaliacao');
  END IF;
  PERFORM intermediation_move_deal(i.owner_lead_id, 'Prepara%');
  RETURN jsonb_build_object('ok', true, 'code', i.code, 'status', 'active');
END;
$$;
GRANT EXECUTE ON FUNCTION public.intermediation_import_signed_contract(uuid, text, text, timestamptz, text) TO authenticated;

-- Estados alternativos (comercial/admin)
CREATE OR REPLACE FUNCTION public.intermediation_set_status(p_id uuid, p_status text, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i intermediations%ROWTYPE; v_new text; v_vid uuid; v_listed boolean; v_task uuid; v_desc text;
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
  IF p_status IN ('cancelled_by_owner', 'refused_by_totex', 'lost', 'sold_outside') AND NOT (public.is_admin() OR public.is_superadmin())
     AND i.status = 'active' THEN
    RAISE EXCEPTION 'Encerrar uma intermediação com contrato assinado é só admin (alçada).';
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

  -- Anúncio no ar? O CRM não publica no marketplace, então "retirar anúncio" vira tarefa.
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
GRANT EXECUTE ON FUNCTION public.intermediation_set_status(uuid, text, text) TO authenticated;

-- Comissão: apurada/faturada/paga (admin)
CREATE OR REPLACE FUNCTION public.intermediation_set_commission(p_id uuid, p_status text, p_amount numeric DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (public.is_admin() OR public.is_superadmin()) THEN RAISE EXCEPTION 'Só admin'; END IF;
  IF p_status NOT IN ('pending', 'invoiced', 'paid', 'waived', 'disputed') THEN RAISE EXCEPTION 'Status inválido'; END IF;
  UPDATE intermediations SET commission_status = p_status, commission_due = coalesce(p_amount, commission_due),
         commission_paid_at = CASE WHEN p_status = 'paid' THEN now() ELSE commission_paid_at END, updated_by = public.current_member_id()
  WHERE id = p_id AND (tenant_id = public.get_tenant_id() OR public.is_superadmin());
  PERFORM intermediation_log(p_id, CASE p_status WHEN 'paid' THEN 'commission_paid' WHEN 'invoiced' THEN 'commission_invoiced' ELSE 'commission_status_changed' END,
                             jsonb_build_object('status', p_status, 'amount', p_amount));
END;
$$;
GRANT EXECUTE ON FUNCTION public.intermediation_set_commission(uuid, text, numeric) TO authenticated;

-- Funil do gestor (PRD §12)
CREATE OR REPLACE FUNCTION public.intermediation_funnel(p_period text DEFAULT 'month')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid := public.get_tenant_id(); v_ps timestamptz;
BEGIN
  IF public.is_promotora() THEN RAISE EXCEPTION 'Sem acesso'; END IF;
  v_ps := CASE p_period WHEN 'week' THEN date_trunc('week', now()) WHEN 'all' THEN '2000-01-01'::timestamptz ELSE date_trunc('month', now()) END;
  RETURN (
    WITH i AS (
      SELECT i.*, l.capture_valid, v.status AS vstatus
      FROM intermediations i JOIN leads l ON l.id = i.owner_lead_id
      LEFT JOIN seller_vehicles v ON v.id = i.vehicle_id
      WHERE i.tenant_id = v_tenant AND i.created_at >= v_ps
    )
    SELECT jsonb_build_object(
      'period_start', v_ps,
      'captadas', count(*),
      'validas', count(*) FILTER (WHERE capture_valid),
      'formalizadas', count(*) FILTER (WHERE activated_at IS NOT NULL),
      'em_vitrine', count(*) FILTER (WHERE vstatus IN ('anunciado', 'negociacao', 'vendido')),
      'com_proposta', count(*) FILTER (WHERE vstatus IN ('negociacao', 'vendido')),
      'vendidas', count(*) FILTER (WHERE status = 'completed'),
      'encerradas', count(*) FILTER (WHERE status IN ('cancelled_by_owner', 'refused_by_totex', 'lost', 'sold_outside')),
      'ativas', count(*) FILTER (WHERE status = 'active'),
      'vencendo', count(*) FILTER (WHERE status = 'active' AND deadline_status <> 'ok'),
      'comissao_apurada', coalesce(sum(commission_due) FILTER (WHERE status = 'completed'), 0),
      'comissao_paga', coalesce(sum(commission_due) FILTER (WHERE commission_status = 'paid'), 0),
      'dias_para_formalizar', round(avg(extract(epoch FROM (activated_at - created_at)) / 86400.0) FILTER (WHERE activated_at IS NOT NULL), 1),
      'dias_para_vender', round(avg(extract(epoch FROM (completed_at - activated_at)) / 86400.0) FILTER (WHERE completed_at IS NOT NULL AND activated_at IS NOT NULL), 1)
    ) FROM i
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.intermediation_funnel(text) TO authenticated;

-- ─── 8) Lista da promotora: intermediação + contrato + prazo ─────────────────
DROP FUNCTION IF EXISTS public.list_my_capture_vehicles(uuid);
CREATE OR REPLACE FUNCTION public.list_my_capture_vehicles(p_member_id uuid DEFAULT NULL)
RETURNS TABLE (
  vehicle_id uuid, lead_id uuid, lead_name text, description text, brand text, model text, year_model integer, km integer,
  status text, status_changed_at timestamptz, captured_at timestamptz, sold_at timestamptz,
  stage_name text, sales_rep_name text, reward_captured_cents integer, reward_sold_cents integer,
  ledger_captured_status text, ledger_sold_status text,
  listing_url text, listing_price numeric,
  intermediation_id uuid, intermediation_code text, intermediation_status text, contract_status text, contract_signed_at timestamptz,
  ends_at date, deadline_status text
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
         (SELECT amount_cents FROM capture_reward_rules WHERE tenant_id = v_tenant AND active AND event_type = 'intermediation_formalized' ORDER BY position LIMIT 1),
         (SELECT amount_cents FROM capture_reward_rules WHERE tenant_id = v_tenant AND active AND event_type = 'intermediation_completed' ORDER BY position LIMIT 1),
         (SELECT lg.status FROM capture_reward_ledger lg JOIN capture_reward_rules rr ON rr.id = lg.rule_id
           WHERE lg.lead_id = l.id AND rr.event_type IN ('intermediation_formalized', 'vehicle_captured') ORDER BY lg.earned_at DESC LIMIT 1),
         (SELECT lg.status FROM capture_reward_ledger lg JOIN capture_reward_rules rr ON rr.id = lg.rule_id
           WHERE lg.lead_id = l.id AND rr.event_type IN ('intermediation_completed', 'vehicle_sold') ORDER BY lg.earned_at DESC LIMIT 1),
         v.listing_url, v.listing_price,
         i.id, i.code, i.status, i.contract_status, i.contract_signed_at, i.ends_at, i.deadline_status
  FROM leads l
  JOIN LATERAL (SELECT * FROM seller_vehicles sv WHERE sv.lead_id = l.id ORDER BY sv.created_at DESC LIMIT 1) v ON true
  LEFT JOIN intermediations i ON i.owner_lead_id = l.id
  LEFT JOIN sales_pipeline_stages s ON s.id = l.pipeline_stage_id
  LEFT JOIN team_members tm ON tm.id = l.sales_rep_id
  WHERE l.captured_by_member_id = v_target
  ORDER BY CASE v.status WHEN 'vendido' THEN 0 WHEN 'negociacao' THEN 1 WHEN 'anunciado' THEN 2 WHEN 'preparacao' THEN 3 WHEN 'captado' THEN 4 WHEN 'avaliacao' THEN 5 ELSE 6 END,
           coalesce(v.status_changed_at, v.created_at) DESC;
END;
$$;
GRANT EXECUTE ON FUNCTION public.list_my_capture_vehicles(uuid) TO authenticated;

-- ─── 9) Prazo da intermediação (ponto que faltava no PRD) ────────────────────
CREATE OR REPLACE FUNCTION public.intermediation_check_deadlines(p_days integer DEFAULT 7)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; v_out jsonb := '[]'::jsonb; v_new text; v_desc text;
BEGIN
  FOR r IN
    SELECT i.*, l.name AS lead_name, l.sales_rep_id,
           coalesce(v.description, nullif(concat_ws(' ', v.brand, v.model), ''), 'veículo') || coalesce(' ' || v.year_model::text, '') AS vdesc
    FROM intermediations i JOIN leads l ON l.id = i.owner_lead_id
    LEFT JOIN seller_vehicles v ON v.id = i.vehicle_id
    WHERE i.status = 'active' AND i.ends_at IS NOT NULL
      AND (i.ends_at < current_date OR i.ends_at <= current_date + p_days)
  LOOP
    v_new := CASE WHEN r.ends_at < current_date THEN 'expired' ELSE 'expiring' END;
    IF r.deadline_status = v_new THEN CONTINUE; END IF;
    UPDATE intermediations SET deadline_status = v_new, deadline_alerted_at = now() WHERE id = r.id;
    INSERT INTO company_activities (tenant_id, name, description, task_type, priority, status, completed, due_datetime, lead_id, responsavel_id, team, source_type, source_id, metadata)
    VALUES (r.tenant_id,
      CASE v_new WHEN 'expired' THEN 'Prazo VENCEU — renovar ou encerrar: ' ELSE 'Prazo vence em ' || (r.ends_at - current_date) || ' dias — renovar ou encerrar: ' END || r.vdesc || ' (' || r.code || ')',
      'Contrato de intermediação de ' || r.lead_name || ' válido até ' || to_char(r.ends_at, 'DD/MM/YYYY') || '. Falar com o proprietário: renovar (novo prazo/aditivo) ou encerrar e retirar o anúncio.',
      'follow_up', 'high', 'not_started', false, now(), r.owner_lead_id, r.sales_rep_id, 'sales', 'intermediacao', r.id,
      jsonb_build_object('intermediacao', true, 'deadline', v_new));
    PERFORM intermediation_log(r.id, CASE v_new WHEN 'expired' THEN 'deadline_expired' ELSE 'deadline_expiring' END, jsonb_build_object('ends_at', r.ends_at), 'deadline:' || v_new || ':' || r.id || ':' || r.ends_at);
    v_out := v_out || jsonb_build_object('code', r.code, 'status', v_new, 'ends_at', r.ends_at);
  END LOOP;
  RETURN v_out;
END;
$$;
GRANT EXECUTE ON FUNCTION public.intermediation_check_deadlines(integer) TO service_role;

DO $$ DECLARE j record; BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN RAISE NOTICE 'pg_cron ausente — cron intermediation-deadlines não agendado'; RETURN; END IF;
  FOR j IN SELECT jobid FROM cron.job WHERE jobname = 'intermediation-deadlines' LOOP PERFORM cron.unschedule(j.jobid); END LOOP;
  PERFORM cron.schedule('intermediation-deadlines', '15 12 * * *', $c$SELECT public.intermediation_check_deadlines(7)$c$);  -- 09:15 BRT
END $$;

-- ─── 10) Storage: contratos importados (privado) ─────────────────────────────
DO $$ BEGIN
  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('intermediation-contracts', 'intermediation-contracts', false, 26214400, ARRAY['application/pdf'])
  ON CONFLICT (id) DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'intermediation_contracts_rw') THEN
    CREATE POLICY intermediation_contracts_rw ON storage.objects FOR ALL TO authenticated
      USING (bucket_id = 'intermediation-contracts' AND NOT public.is_promotora() AND (storage.foldername(name))[1] = public.get_tenant_id()::text)
      WITH CHECK (bucket_id = 'intermediation-contracts' AND NOT public.is_promotora() AND (storage.foldername(name))[1] = public.get_tenant_id()::text);
  END IF;
EXCEPTION WHEN undefined_table OR undefined_function OR undefined_column THEN NULL; END $$;

-- ─── 11) Backfill: leads captados existentes ─────────────────────────────────
INSERT INTO legal_entities (tenant_id, legal_name, trade_name, cnpj, address, city_name, state, zip, phone, is_default)
SELECT t.id, 'TOTEX DIGITAL MIDIA LTDA', 'TotexMotors', '62.011.971/0001-94',
       'Av. Andrômeda, 885, Sala 407 BCO, Green Valley Comercial Alphaville', 'Barueri', 'SP', '06473-000', '(11) 4187-0129', true
FROM tenants t WHERE t.id = 'c13681e3-5db9-48d1-9c5c-856e6041d77f'
  AND NOT EXISTS (SELECT 1 FROM legal_entities le WHERE le.tenant_id = t.id);

INSERT INTO intermediations (tenant_id, legal_entity_id, location_id, owner_lead_id, promoter_id, source, vehicle_id, asking_price,
                             status, activated_at, completed_at, closed_at, sale_price, contract_status, created_by, created_at)
SELECT l.tenant_id,
       (SELECT id FROM legal_entities le WHERE le.tenant_id = l.tenant_id ORDER BY is_default DESC LIMIT 1),
       l.capture_location_id, l.id, l.captured_by_member_id, 'promotora', v.id, v.expected_price,
       CASE v.status WHEN 'vendido' THEN 'completed' WHEN 'perdido' THEN 'lost'
                     WHEN 'captado' THEN 'active' WHEN 'preparacao' THEN 'active' WHEN 'anunciado' THEN 'active' WHEN 'negociacao' THEN 'active'
                     ELSE 'lead' END,
       CASE WHEN v.status IN ('captado', 'preparacao', 'anunciado', 'negociacao', 'vendido') THEN coalesce(v.captured_at, v.status_changed_at, now()) END,
       CASE WHEN v.status = 'vendido' THEN coalesce(v.sold_at, now()) END,
       CASE WHEN v.status IN ('vendido', 'perdido') THEN coalesce(v.sold_at, v.status_changed_at, now()) END,
       v.sold_price,
       'none', l.captured_by_member_id, coalesce(l.captured_at, l.created_at)
FROM leads l
LEFT JOIN LATERAL (SELECT * FROM seller_vehicles sv WHERE sv.lead_id = l.id ORDER BY sv.created_at DESC LIMIT 1) v ON true
WHERE l.captured_by_member_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM intermediations i WHERE i.owner_lead_id = l.id);
UPDATE seller_vehicles v SET intermediation_id = i.id FROM intermediations i WHERE i.owner_lead_id = v.lead_id AND v.intermediation_id IS NULL;
INSERT INTO intermediation_events (tenant_id, intermediation_id, event_type, payload, idempotency_key)
SELECT tenant_id, id, 'intermediation_lead_created', jsonb_build_object('backfill', true), 'backfill:' || id FROM intermediations
ON CONFLICT (idempotency_key) DO NOTHING;

-- ─── 12) Aviso às promotoras: o R$ 25 agora vem com o contrato assinado ──────
INSERT INTO capture_lead_events (tenant_id, lead_id, promotora_member_id, event_type, title, body)
SELECT tm.tenant_id, l.id, tm.id, 'info', '📣 Novidade nos prêmios',
  'A partir de agora o prêmio de captação (R$ 25) entra quando o CONTRATO de intermediação do proprietário é assinado, não mais quando o carro entra. '
  || 'Sua meta semanal de leads válidos e o prêmio de venda (R$ 50) continuam iguais. Quanto mais completo o cadastro, mais rápido o contrato sai.'
FROM team_members tm
JOIN LATERAL (SELECT id FROM leads WHERE captured_by_member_id = tm.id ORDER BY captured_at DESC NULLS LAST LIMIT 1) l ON true
WHERE tm.role = 'promotora' AND tm.is_active
  AND EXISTS (SELECT 1 FROM capture_reward_rules r WHERE r.tenant_id = tm.tenant_id AND r.event_type = 'intermediation_formalized')
  AND NOT EXISTS (SELECT 1 FROM capture_lead_events e WHERE e.promotora_member_id = tm.id AND e.title = '📣 Novidade nos prêmios');
