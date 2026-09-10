-- ============================================================================
-- Captação de Veículos — base para o papel PROMOTORA (Fase 1 + 2 do plano
-- "Captação Promotoras / Franquias").
--
-- O que entra aqui:
--   1) Helpers: current_member_id(), is_promotora().
--   2) leads: lead_intent, captured_by_member_id (imutável), captured_at,
--      capture_location_id, capture_campaign_id, capture_channel,
--      seller_qualification (jsonb).
--   3) Tabelas novas: capture_locations, capture_campaigns, seller_vehicles.
--   4) RLS: a promotora NÃO tem CRUD direto em leads/deals — só enxerga os
--      leads que ela mesma captou e opera via RPC (superfície mínima).
--      Para os demais papéis nada muda (policies RESTRICTIVE só mordem
--      quando is_promotora() = true).
--   5) RPCs: compute_capture_score, create_capture_lead,
--      update_my_capture_lead, list_my_capture_leads, capture_home_stats,
--      ensure_capture_pipeline.
--
-- NÃO reutiliza source='stand' (leads compradores). Lead de proprietário que
-- quer vender/intermediar nasce com lead_intent = 'sell_intermediation' e
-- source = 'captacao'.
--
-- Nada destrutivo: só ADD COLUMN IF NOT EXISTS / CREATE IF NOT EXISTS.
-- ============================================================================

-- ─── 1) Helpers ─────────────────────────────────────────────────────────────

-- team_members.id do usuário logado (membro ativo). NULL se não for membro.
CREATE OR REPLACE FUNCTION public.current_member_id() RETURNS uuid
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT id FROM team_members
  WHERE auth_user_id = auth.uid() AND is_active
  ORDER BY created_at
  LIMIT 1;
$$;

-- true quando o usuário logado é uma promotora ativa (team_members.role).
CREATE OR REPLACE FUNCTION public.is_promotora() RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM team_members
    WHERE auth_user_id = auth.uid() AND role = 'promotora' AND is_active
  );
$$;

GRANT EXECUTE ON FUNCTION public.current_member_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_promotora() TO authenticated;

-- ─── 2) Tabelas de apoio ────────────────────────────────────────────────────

-- Onde a captação acontece (shopping, stand, evento, loja).
CREATE TABLE IF NOT EXISTS public.capture_locations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL DEFAULT public.get_tenant_id(),
  name        text NOT NULL,
  kind        text NOT NULL DEFAULT 'stand'
              CHECK (kind IN ('shopping', 'stand', 'evento', 'loja', 'outro')),
  address     text,
  city_name   text,
  state       text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Ação/campanha que gerou o lead ("Venda seu carro no shopping", feirão...).
CREATE TABLE IF NOT EXISTS public.capture_campaigns (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT public.get_tenant_id(),
  location_id   uuid REFERENCES public.capture_locations(id) ON DELETE SET NULL,
  name          text NOT NULL,
  starts_at     date,
  ends_at       date,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Veículo do PROPRIETÁRIO que quer vender (objeto central da captação).
-- Não reutiliza trade_in_vehicles — semântica diferente (troca na compra).
CREATE TABLE IF NOT EXISTS public.seller_vehicles (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL DEFAULT public.get_tenant_id(),
  lead_id               uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  brand                 text,
  model                 text,
  version               text,
  -- Texto livre digitado no Quick Capture ("Civic EXL 2020") antes de normalizar
  description           text,
  year_model            integer CHECK (year_model IS NULL OR year_model BETWEEN 1950 AND 2100),
  km                    integer CHECK (km IS NULL OR km >= 0),
  plate_last4           text,
  fuel                  text,
  color                 text,
  is_owner              boolean,
  has_financing         boolean,
  expected_price        numeric,
  condition_notes       text,
  photos                jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by_member_id  uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS seller_vehicles_lead_idx ON public.seller_vehicles(lead_id);
CREATE INDEX IF NOT EXISTS seller_vehicles_tenant_idx ON public.seller_vehicles(tenant_id);

-- updated_at automático (função já existe no schema base)
DO $$ BEGIN
  CREATE TRIGGER update_capture_locations_updated_at BEFORE UPDATE ON public.capture_locations
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER update_capture_campaigns_updated_at BEFORE UPDATE ON public.capture_campaigns
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER update_seller_vehicles_updated_at BEFORE UPDATE ON public.seller_vehicles
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── 3) leads: intenção + atribuição ────────────────────────────────────────

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS lead_intent           text,
  ADD COLUMN IF NOT EXISTS captured_by_member_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS captured_at           timestamptz,
  ADD COLUMN IF NOT EXISTS capture_location_id   uuid REFERENCES public.capture_locations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS capture_campaign_id   uuid REFERENCES public.capture_campaigns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS capture_channel       text,
  ADD COLUMN IF NOT EXISTS seller_qualification  jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$ BEGIN
  ALTER TABLE public.leads ADD CONSTRAINT leads_lead_intent_check
    CHECK (lead_intent IS NULL OR lead_intent IN ('buy', 'sell_intermediation', 'trade_in', 'consignment', 'unknown'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.leads ADD CONSTRAINT leads_capture_channel_check
    CHECK (capture_channel IS NULL OR capture_channel IN ('presencial', 'whatsapp', 'indicacao', 'qr_code', 'online', 'outro'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS leads_captured_by_idx ON public.leads(captured_by_member_id) WHERE captured_by_member_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_lead_intent_idx ON public.leads(tenant_id, lead_intent) WHERE lead_intent IS NOT NULL;

COMMENT ON COLUMN public.leads.lead_intent IS
  'O que o cliente quer: buy (comprador) | sell_intermediation (proprietário quer vender via Totex) | trade_in | consignment | unknown.';
COMMENT ON COLUMN public.leads.captured_by_member_id IS
  'Quem ORIGINOU o lead (promotora). Imutável depois de definido — diferente de sales_rep_id (quem atende, pode mudar).';
COMMENT ON COLUMN public.leads.seller_qualification IS
  'Qualificação de intermediação (prazo_venda, motivo, is_owner, aceita_avaliacao, autoriza_contato, expectativa_valor, observacao, temperatura, score).';

-- captured_by_member_id só pode ser definido uma vez. Só admin/superadmin
-- corrige (ex.: lead atribuído à promotora errada).
CREATE OR REPLACE FUNCTION public.protect_captured_by() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.captured_by_member_id IS NOT NULL
     AND NEW.captured_by_member_id IS DISTINCT FROM OLD.captured_by_member_id
     AND NOT (public.is_admin() OR public.is_superadmin())
     AND auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'captured_by_member_id é imutável (só admin pode corrigir)';
  END IF;
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER trg_protect_captured_by BEFORE UPDATE ON public.leads
    FOR EACH ROW WHEN (OLD.captured_by_member_id IS DISTINCT FROM NEW.captured_by_member_id)
    EXECUTE FUNCTION public.protect_captured_by();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── 4) RLS ─────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON public.capture_locations, public.capture_campaigns, public.seller_vehicles
  TO authenticated, service_role;

ALTER TABLE public.capture_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capture_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seller_vehicles   ENABLE ROW LEVEL SECURITY;

-- Locais/campanhas: todo o tenant lê; escreve admin (ou superadmin).
DROP POLICY IF EXISTS capture_locations_select ON public.capture_locations;
CREATE POLICY capture_locations_select ON public.capture_locations
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_tenant_id() OR public.is_superadmin());
DROP POLICY IF EXISTS capture_locations_write ON public.capture_locations;
CREATE POLICY capture_locations_write ON public.capture_locations
  FOR ALL TO authenticated
  USING ((tenant_id = public.get_tenant_id() AND public.is_admin()) OR public.is_superadmin())
  WITH CHECK ((tenant_id = public.get_tenant_id() AND public.is_admin()) OR public.is_superadmin());

DROP POLICY IF EXISTS capture_campaigns_select ON public.capture_campaigns;
CREATE POLICY capture_campaigns_select ON public.capture_campaigns
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_tenant_id() OR public.is_superadmin());
DROP POLICY IF EXISTS capture_campaigns_write ON public.capture_campaigns;
CREATE POLICY capture_campaigns_write ON public.capture_campaigns
  FOR ALL TO authenticated
  USING ((tenant_id = public.get_tenant_id() AND public.is_admin()) OR public.is_superadmin())
  WITH CHECK ((tenant_id = public.get_tenant_id() AND public.is_admin()) OR public.is_superadmin());

-- seller_vehicles: tenant inteiro (não-promotora) lê/escreve; promotora só
-- enxerga veículos dos leads que ela captou e escreve via RPC.
DROP POLICY IF EXISTS seller_vehicles_select ON public.seller_vehicles;
CREATE POLICY seller_vehicles_select ON public.seller_vehicles
  FOR SELECT TO authenticated
  USING (
    (tenant_id = public.get_tenant_id() OR public.is_superadmin())
    AND (
      NOT public.is_promotora()
      OR EXISTS (SELECT 1 FROM public.leads l
                 WHERE l.id = seller_vehicles.lead_id
                   AND l.captured_by_member_id = public.current_member_id())
    )
  );
DROP POLICY IF EXISTS seller_vehicles_write ON public.seller_vehicles;
CREATE POLICY seller_vehicles_write ON public.seller_vehicles
  FOR ALL TO authenticated
  USING ((tenant_id = public.get_tenant_id() OR public.is_superadmin()) AND NOT public.is_promotora())
  WITH CHECK ((tenant_id = public.get_tenant_id() OR public.is_superadmin()) AND NOT public.is_promotora());

-- leads/deals: policies RESTRITIVAS — combinam com AND às permissivas já
-- existentes. Para quem não é promotora avaliam TRUE (zero impacto).
DROP POLICY IF EXISTS promotora_leads_select_own ON public.leads;
CREATE POLICY promotora_leads_select_own ON public.leads
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT public.is_promotora() OR captured_by_member_id = public.current_member_id());

DROP POLICY IF EXISTS promotora_leads_no_direct_insert ON public.leads;
CREATE POLICY promotora_leads_no_direct_insert ON public.leads
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_promotora());

DROP POLICY IF EXISTS promotora_leads_no_direct_update ON public.leads;
CREATE POLICY promotora_leads_no_direct_update ON public.leads
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_promotora());

DROP POLICY IF EXISTS promotora_leads_no_delete ON public.leads;
CREATE POLICY promotora_leads_no_delete ON public.leads
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_promotora());

DROP POLICY IF EXISTS promotora_deals_select_own ON public.deals;
CREATE POLICY promotora_deals_select_own ON public.deals
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (
    NOT public.is_promotora()
    OR lead_id IN (SELECT id FROM public.leads WHERE captured_by_member_id = public.current_member_id())
  );

DROP POLICY IF EXISTS promotora_deals_no_insert ON public.deals;
CREATE POLICY promotora_deals_no_insert ON public.deals
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_promotora());
DROP POLICY IF EXISTS promotora_deals_no_update ON public.deals;
CREATE POLICY promotora_deals_no_update ON public.deals
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (NOT public.is_promotora());
DROP POLICY IF EXISTS promotora_deals_no_delete ON public.deals;
CREATE POLICY promotora_deals_no_delete ON public.deals
  AS RESTRICTIVE FOR DELETE TO authenticated
  USING (NOT public.is_promotora());

-- ─── 5) Score transparente (regra do plano, sem IA) ─────────────────────────
--   ≤30 dias +30 | aceita avaliação +20 | autoriza contato +20 |
--   veículo+ano+km +15 | proprietário +10 | contexto/expectativa +5
--   70–100 quente · 45–69 morno · <45 frio
CREATE OR REPLACE FUNCTION public.compute_capture_score(q jsonb, v jsonb)
RETURNS integer
LANGUAGE sql IMMUTABLE
AS $$
  SELECT LEAST(100,
      CASE WHEN q->>'prazo_venda' IN ('agora', 'ate_30_dias') THEN 30 ELSE 0 END
    + CASE WHEN q->>'aceita_avaliacao' = 'sim' THEN 20 ELSE 0 END
    + CASE WHEN q->>'autoriza_contato' = 'true' THEN 20 ELSE 0 END
    + CASE WHEN coalesce(nullif(btrim(v->>'description'), ''), nullif(btrim(v->>'model'), '')) IS NOT NULL
             AND (v->>'year_model') ~ '^\d{4}$'
             AND (v->>'km') ~ '^\d+$' THEN 15 ELSE 0 END
    + CASE WHEN q->>'is_owner' = 'true' THEN 10 ELSE 0 END
    + CASE WHEN length(coalesce(q->>'observacao', '')) >= 10
             OR (q->>'expectativa_valor') ~ '^\d+(\.\d+)?$' THEN 5 ELSE 0 END
  );
$$;

CREATE OR REPLACE FUNCTION public.capture_temperature(score integer)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE WHEN score >= 70 THEN 'quente' WHEN score >= 45 THEN 'morno' ELSE 'frio' END;
$$;

-- ─── 6) Pipeline "Captação de Veículos" (idempotente, por tenant) ───────────
-- Cria o funil dedicado do tenant do usuário logado, se ainda não existir.
-- Só admin/superadmin. create_capture_lead usa o funil se ele existir.
CREATE OR REPLACE FUNCTION public.ensure_capture_pipeline() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := public.get_tenant_id();
  v_pipeline uuid;
  v_stage record;
  v_pos integer := 0;
BEGIN
  IF NOT (public.is_admin() OR public.is_superadmin()) THEN
    RAISE EXCEPTION 'Apenas admin pode criar o funil de captação';
  END IF;

  SELECT id INTO v_pipeline FROM sales_pipelines
  WHERE tenant_id = v_tenant AND name ILIKE 'Captação de Veículos%'
  LIMIT 1;

  IF v_pipeline IS NULL THEN
    INSERT INTO sales_pipelines (tenant_id, name, description, position, is_default, is_active)
    VALUES (v_tenant, 'Captação de Veículos',
            'Proprietários que querem vender/intermediar o carro (captação das promotoras)',
            (SELECT coalesce(max(position), 0) + 1 FROM sales_pipelines WHERE tenant_id = v_tenant),
            false, true)
    RETURNING id INTO v_pipeline;

    FOR v_stage IN
      SELECT * FROM (VALUES
        ('Novo',        'gray',   false, false),
        ('Validado',    'blue',   false, false),
        ('Qualificado', 'purple', false, false),
        ('Avaliação',   'amber',  false, false),
        ('Proposta',    'orange', false, false),
        ('Captado',     'green',  true,  false),
        ('Perdido',     'red',    false, true)
      ) AS s(name, color, is_won, is_lost)
    LOOP
      v_pos := v_pos + 1;
      INSERT INTO sales_pipeline_stages (tenant_id, pipeline_id, name, position, color, is_won, is_lost)
      VALUES (v_tenant, v_pipeline, v_stage.name, v_pos, v_stage.color, v_stage.is_won, v_stage.is_lost);
    END LOOP;
  END IF;

  RETURN v_pipeline;
END;
$$;

-- Primeiro estágio do funil de captação do tenant (NULL se não criado ainda).
CREATE OR REPLACE FUNCTION public.capture_pipeline_first_stage(p_tenant uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.id
  FROM sales_pipelines p
  JOIN sales_pipeline_stages s ON s.pipeline_id = p.id
  WHERE p.tenant_id = p_tenant AND p.name ILIKE 'Captação de Veículos%' AND p.is_active
  ORDER BY s.position
  LIMIT 1;
$$;

-- ─── 7) RPC: create_capture_lead ────────────────────────────────────────────
-- Quick Capture (6 campos + opcionais). Chamado pela promotora (ou qualquer
-- membro ativo). O servidor carimba tenant, captured_by, captured_at,
-- lead_intent, canal, score e temperatura. Faz dedupe por telefone.
--
-- p_payload:
--   name*, phone*, email?, intent* ('vender'|'trocar'|'entender'),
--   vehicle* { description, brand?, model?, year_model*, km? },
--   qualification { prazo_venda* ('agora'|'ate_30_dias'|'ate_90_dias'|'sem_prazo'),
--                   motivo?, is_owner?, aceita_avaliacao? ('sim'|'talvez'|'nao'),
--                   autoriza_contato?, expectativa_valor?, observacao? },
--   location_id?, campaign_id?, channel? (default 'presencial'),
--   city_name?, state?
-- Retorna { lead_id, duplicate, score, temperatura }.
CREATE OR REPLACE FUNCTION public.create_capture_lead(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member   team_members%ROWTYPE;
  v_name     text := nullif(btrim(p_payload->>'name'), '');
  v_phone    text := regexp_replace(coalesce(p_payload->>'phone', ''), '\D', '', 'g');
  v_email    text := nullif(lower(btrim(p_payload->>'email')), '');
  v_intent   text := coalesce(p_payload->>'intent', 'vender');
  v_vehicle  jsonb := coalesce(p_payload->'vehicle', '{}'::jsonb);
  v_qual     jsonb := coalesce(p_payload->'qualification', '{}'::jsonb);
  v_channel  text := coalesce(nullif(p_payload->>'channel', ''), 'presencial');
  v_lead_intent text;
  v_score    integer;
  v_temp     text;
  v_existing uuid;
  v_lead_id  uuid;
  v_stage    uuid;
  v_last8    text;
BEGIN
  SELECT * INTO v_member FROM team_members
  WHERE auth_user_id = auth.uid() AND is_active
  ORDER BY created_at LIMIT 1;
  IF v_member.id IS NULL THEN
    RAISE EXCEPTION 'Usuário não é membro ativo de nenhum tenant';
  END IF;

  IF v_name IS NULL THEN RAISE EXCEPTION 'Nome é obrigatório'; END IF;
  IF length(v_phone) < 10 THEN RAISE EXCEPTION 'WhatsApp inválido'; END IF;
  IF coalesce(nullif(btrim(v_vehicle->>'description'), ''), nullif(btrim(v_vehicle->>'model'), '')) IS NULL THEN
    RAISE EXCEPTION 'Veículo é obrigatório';
  END IF;
  IF NOT ((v_vehicle->>'year_model') ~ '^\d{4}$') THEN
    RAISE EXCEPTION 'Ano do veículo é obrigatório';
  END IF;
  IF v_intent NOT IN ('vender', 'trocar', 'entender') THEN
    RAISE EXCEPTION 'Intenção inválida';
  END IF;
  IF coalesce(v_qual->>'prazo_venda', '') NOT IN ('agora', 'ate_30_dias', 'ate_90_dias', 'sem_prazo') THEN
    RAISE EXCEPTION 'Prazo é obrigatório';
  END IF;

  -- Normaliza pro padrão do WhatsApp (55 + DDD + número)
  IF length(v_phone) IN (10, 11) THEN v_phone := '55' || v_phone; END IF;
  v_last8 := right(v_phone, 8);

  v_lead_intent := CASE v_intent WHEN 'trocar' THEN 'trade_in' ELSE 'sell_intermediation' END;
  v_qual := v_qual || jsonb_build_object('intent', v_intent, 'versao', 1);
  v_score := public.compute_capture_score(v_qual, v_vehicle);
  v_temp  := public.capture_temperature(v_score);
  v_qual := v_qual || jsonb_build_object('score', v_score, 'temperatura', v_temp,
                                         'qualificado_em', now(), 'origem', 'promotora');

  -- Dedupe: mesmo telefone no tenant. Se já existe, NÃO cria outro — anexa
  -- veículo e qualificação, preserva captured_by original (imutável).
  SELECT id INTO v_existing FROM leads
  WHERE tenant_id = v_member.tenant_id
    AND phone IS NOT NULL AND right(regexp_replace(phone, '\D', '', 'g'), 8) = v_last8
  ORDER BY created_at LIMIT 1;

  v_stage := public.capture_pipeline_first_stage(v_member.tenant_id);

  IF v_existing IS NOT NULL THEN
    v_lead_id := v_existing;
    UPDATE leads SET
      lead_intent           = coalesce(lead_intent, v_lead_intent),
      captured_by_member_id = coalesce(captured_by_member_id, v_member.id),
      captured_at           = coalesce(captured_at, now()),
      capture_location_id   = coalesce(capture_location_id, nullif(p_payload->>'location_id', '')::uuid),
      capture_campaign_id   = coalesce(capture_campaign_id, nullif(p_payload->>'campaign_id', '')::uuid),
      capture_channel       = coalesce(capture_channel, v_channel),
      seller_qualification  = seller_qualification || v_qual,
      sales_score           = v_score,
      sales_score_reason    = 'Score de captação (reconversão)',
      email                 = coalesce(email, v_email),
      last_interaction_at   = now(),
      metadata              = coalesce(metadata, '{}'::jsonb)
                              || jsonb_build_object('captacao_reconversao_em', now())
    WHERE id = v_existing;
  ELSE
    INSERT INTO leads (
      tenant_id, name, phone, email, source, original_source, utm_source,
      lead_intent, captured_by_member_id, captured_at, capture_location_id,
      capture_campaign_id, capture_channel, seller_qualification,
      sales_score, sales_score_reason, sales_stage, status, pipeline_stage_id,
      city_name, state, context, metadata
    ) VALUES (
      v_member.tenant_id, v_name, v_phone, v_email, 'captacao', 'captacao', 'promotora',
      v_lead_intent, v_member.id, now(), nullif(p_payload->>'location_id', '')::uuid,
      nullif(p_payload->>'campaign_id', '')::uuid, v_channel, v_qual,
      v_score, 'Score de captação (regra transparente)', 'new', 'new', v_stage,
      nullif(p_payload->>'city_name', ''), nullif(p_payload->>'state', ''),
      nullif(v_qual->>'observacao', ''),
      jsonb_build_object('origin_actor', 'promotora', 'captured_by_name', v_member.name)
    ) RETURNING id INTO v_lead_id;
  END IF;

  INSERT INTO seller_vehicles (
    tenant_id, lead_id, description, brand, model, version, year_model, km,
    is_owner, expected_price, condition_notes, created_by_member_id
  ) VALUES (
    v_member.tenant_id, v_lead_id,
    nullif(btrim(v_vehicle->>'description'), ''),
    nullif(btrim(v_vehicle->>'brand'), ''),
    nullif(btrim(v_vehicle->>'model'), ''),
    nullif(btrim(v_vehicle->>'version'), ''),
    (v_vehicle->>'year_model')::integer,
    CASE WHEN (v_vehicle->>'km') ~ '^\d+$' THEN (v_vehicle->>'km')::integer END,
    CASE WHEN v_qual->>'is_owner' IN ('true','false') THEN (v_qual->>'is_owner')::boolean END,
    CASE WHEN (v_qual->>'expectativa_valor') ~ '^\d+(\.\d+)?$' THEN (v_qual->>'expectativa_valor')::numeric END,
    nullif(v_vehicle->>'condition_notes', ''),
    v_member.id
  );

  RETURN jsonb_build_object(
    'lead_id', v_lead_id,
    'duplicate', v_existing IS NOT NULL,
    'score', v_score,
    'temperatura', v_temp
  );
END;
$$;

-- ─── 8) RPC: update_my_capture_lead ─────────────────────────────────────────
-- Promotora corrige dados básicos + qualificação dos PRÓPRIOS leads.
-- Campos comerciais (sales_rep_id, estágio, deal) ficam fora de alcance.
-- p_patch: { name?, email?, qualification? (merge), vehicle? (merge no mais recente) }
CREATE OR REPLACE FUNCTION public.update_my_capture_lead(p_lead_id uuid, p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member_id uuid := public.current_member_id();
  v_lead leads%ROWTYPE;
  v_qual jsonb;
  v_vehicle jsonb := p_patch->'vehicle';
  v_vehicle_id uuid;
  v_vehicle_row jsonb;
  v_score integer;
BEGIN
  IF v_member_id IS NULL THEN RAISE EXCEPTION 'Sem membro ativo'; END IF;

  SELECT * INTO v_lead FROM leads WHERE id = p_lead_id;
  IF v_lead.id IS NULL THEN RAISE EXCEPTION 'Lead não encontrado'; END IF;
  IF v_lead.captured_by_member_id IS DISTINCT FROM v_member_id
     AND NOT (public.is_admin() OR public.is_superadmin()) THEN
    RAISE EXCEPTION 'Você só pode editar leads que você captou';
  END IF;

  v_qual := coalesce(v_lead.seller_qualification, '{}'::jsonb)
            || coalesce(p_patch->'qualification', '{}'::jsonb);

  -- veículo mais recente do lead (merge de campos enviados)
  SELECT id INTO v_vehicle_id FROM seller_vehicles
  WHERE lead_id = p_lead_id ORDER BY created_at DESC LIMIT 1;

  IF v_vehicle IS NOT NULL AND v_vehicle_id IS NOT NULL THEN
    UPDATE seller_vehicles SET
      description = coalesce(nullif(btrim(v_vehicle->>'description'), ''), description),
      brand       = coalesce(nullif(btrim(v_vehicle->>'brand'), ''), brand),
      model       = coalesce(nullif(btrim(v_vehicle->>'model'), ''), model),
      version     = coalesce(nullif(btrim(v_vehicle->>'version'), ''), version),
      year_model  = CASE WHEN (v_vehicle->>'year_model') ~ '^\d{4}$' THEN (v_vehicle->>'year_model')::integer ELSE year_model END,
      km          = CASE WHEN (v_vehicle->>'km') ~ '^\d+$' THEN (v_vehicle->>'km')::integer ELSE km END,
      is_owner    = CASE WHEN v_qual->>'is_owner' IN ('true','false') THEN (v_qual->>'is_owner')::boolean ELSE is_owner END,
      expected_price = CASE WHEN (v_qual->>'expectativa_valor') ~ '^\d+(\.\d+)?$' THEN (v_qual->>'expectativa_valor')::numeric ELSE expected_price END,
      condition_notes = coalesce(nullif(v_vehicle->>'condition_notes', ''), condition_notes)
    WHERE id = v_vehicle_id;
  END IF;

  SELECT to_jsonb(sv) INTO v_vehicle_row FROM seller_vehicles sv WHERE sv.id = v_vehicle_id;
  v_score := public.compute_capture_score(v_qual, coalesce(v_vehicle_row, '{}'::jsonb));
  v_qual := v_qual || jsonb_build_object('score', v_score, 'temperatura', public.capture_temperature(v_score));

  UPDATE leads SET
    name  = coalesce(nullif(btrim(p_patch->>'name'), ''), name),
    email = coalesce(nullif(lower(btrim(p_patch->>'email')), ''), email),
    seller_qualification = v_qual,
    context = coalesce(nullif(v_qual->>'observacao', ''), context),
    sales_score = v_score,
    last_interaction_at = now()
  WHERE id = p_lead_id;

  RETURN jsonb_build_object('lead_id', p_lead_id, 'score', v_score,
                            'temperatura', v_qual->>'temperatura');
END;
$$;

-- ─── 9) RPC: list_my_capture_leads ──────────────────────────────────────────
-- Lista dos leads captados pelo usuário logado (admin pode passar p_member_id
-- pra ver de outra promotora). Traz veículo + estágio do funil.
CREATE OR REPLACE FUNCTION public.list_my_capture_leads(
  p_search text DEFAULT NULL,
  p_temperatura text DEFAULT NULL,
  p_limit integer DEFAULT 200,
  p_member_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  name text,
  phone text,
  email text,
  created_at timestamptz,
  captured_at timestamptz,
  lead_intent text,
  sales_score integer,
  temperatura text,
  seller_qualification jsonb,
  stage_name text,
  stage_position integer,
  sales_rep_name text,
  vehicle jsonb
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member_id uuid := public.current_member_id();
  v_target uuid;
BEGIN
  IF v_member_id IS NULL THEN RETURN; END IF;
  -- promotora: sempre os próprios. admin/superadmin: pode olhar outra pessoa.
  v_target := CASE
    WHEN p_member_id IS NOT NULL AND (public.is_admin() OR public.is_superadmin()) THEN p_member_id
    ELSE v_member_id END;

  RETURN QUERY
  SELECT
    l.id, l.name, l.phone, l.email, l.created_at, l.captured_at, l.lead_intent,
    l.sales_score,
    coalesce(l.seller_qualification->>'temperatura', public.capture_temperature(coalesce(l.sales_score, 0))) AS temperatura,
    l.seller_qualification,
    s.name AS stage_name,
    s.position AS stage_position,
    tm.name AS sales_rep_name,
    (SELECT to_jsonb(sv) FROM seller_vehicles sv
      WHERE sv.lead_id = l.id ORDER BY sv.created_at DESC LIMIT 1) AS vehicle
  FROM leads l
  LEFT JOIN sales_pipeline_stages s ON s.id = l.pipeline_stage_id
  LEFT JOIN team_members tm ON tm.id = l.sales_rep_id
  WHERE l.captured_by_member_id = v_target
    AND (p_search IS NULL OR btrim(p_search) = ''
         OR l.name ILIKE '%' || p_search || '%'
         OR l.phone ILIKE '%' || regexp_replace(p_search, '\D', '', 'g') || '%')
    AND (p_temperatura IS NULL
         OR coalesce(l.seller_qualification->>'temperatura', public.capture_temperature(coalesce(l.sales_score, 0))) = p_temperatura)
  ORDER BY l.created_at DESC
  LIMIT greatest(1, least(p_limit, 500));
END;
$$;

-- ─── 10) RPC: capture_home_stats ────────────────────────────────────────────
-- KPIs da tela "Hoje": hoje / semana / mês / quentes / pendências.
CREATE OR REPLACE FUNCTION public.capture_home_stats(p_member_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member_id uuid := public.current_member_id();
  v_target uuid;
  v_tz text := 'America/Sao_Paulo';
  v_today_start timestamptz := date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo';
  v_week_start  timestamptz := date_trunc('week', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo';
  v_month_start timestamptz := date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo';
  r jsonb;
BEGIN
  IF v_member_id IS NULL THEN RETURN '{}'::jsonb; END IF;
  v_target := CASE
    WHEN p_member_id IS NOT NULL AND (public.is_admin() OR public.is_superadmin()) THEN p_member_id
    ELSE v_member_id END;

  SELECT jsonb_build_object(
    'hoje',          count(*) FILTER (WHERE captured_at >= v_today_start),
    'semana',        count(*) FILTER (WHERE captured_at >= v_week_start),
    'mes',           count(*) FILTER (WHERE captured_at >= v_month_start),
    'quentes_semana',count(*) FILTER (WHERE captured_at >= v_week_start
                                        AND seller_qualification->>'temperatura' = 'quente'),
    'qualificados_hoje', count(*) FILTER (WHERE captured_at >= v_today_start
                                            AND coalesce(sales_score, 0) >= 45),
    -- lead sem autorização de contato ou sem km = "aguardando complemento"
    'pendentes_complemento', count(*) FILTER (WHERE captured_at >= v_week_start
                                                AND (seller_qualification->>'autoriza_contato' IS DISTINCT FROM 'true'
                                                     OR NOT EXISTS (SELECT 1 FROM seller_vehicles sv
                                                                    WHERE sv.lead_id = l.id AND sv.km IS NOT NULL))),
    -- quente sem vendedor atribuído = handoff pendente
    'handoff_pendente', count(*) FILTER (WHERE seller_qualification->>'temperatura' = 'quente'
                                           AND sales_rep_id IS NULL
                                           AND captured_at >= v_week_start),
    'em_atendimento', count(*) FILTER (WHERE sales_rep_id IS NOT NULL AND captured_at >= v_month_start)
  ) INTO r
  FROM leads l
  WHERE l.captured_by_member_id = v_target;

  RETURN coalesce(r, '{}'::jsonb) || jsonb_build_object('timezone', v_tz);
END;
$$;

GRANT EXECUTE ON FUNCTION public.compute_capture_score(jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.capture_temperature(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_capture_pipeline() TO authenticated;
GRANT EXECUTE ON FUNCTION public.capture_pipeline_first_stage(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_capture_lead(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_my_capture_lead(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_my_capture_leads(text, text, integer, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.capture_home_stats(uuid) TO authenticated;

COMMENT ON FUNCTION public.create_capture_lead(jsonb) IS
  'Quick Capture da promotora: cria lead de intermediação (lead_intent=sell_intermediation) com dedupe por telefone, score transparente e seller_vehicle.';
COMMENT ON FUNCTION public.list_my_capture_leads(text, text, integer, uuid) IS
  'Leads captados pelo usuário logado (tela Meus Leads). Admin pode consultar outra promotora via p_member_id.';
