-- ============================================================================
-- CAPTAÇÃO — Consulta de veículo por placa (2026-09-12)
-- Provedor: PuxaPlaca (portado de totexcar-copilot/vehicle-lookup). Token por tenant
-- (PUXAPLACA_TOKEN em Configurações › Integrações). Edge fn `vehicle-lookup` (JWT):
--   • cache por (tenant, placa) 30 dias em vehicle_plate_lookups — cada consulta é cobrada
--   • limite diário por membro (promotora 20 / demais 100) — só consultas que batem no provedor
--   • promotora recebe só marca/modelo/ano/cor/combustível; chassi e Renavam só admin/comercial
--   • avisa se a placa já foi captada por outro lead do tenant
-- create_capture_lead passa a gravar placa/cor/combustível quando a promotora informa.
-- ============================================================================

-- ─── 1) Cache das consultas ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.vehicle_plate_lookups (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  plate          text NOT NULL CHECK (plate ~ '^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$'),
  provider       text NOT NULL DEFAULT 'puxaplaca',
  vehicle        jsonb NOT NULL DEFAULT '{}'::jsonb,   -- normalizado: marca, modelo, ano_fabricacao, ano_modelo, cor, combustivel, chassi, renavam, municipio, uf
  raw            jsonb NOT NULL DEFAULT '{}'::jsonb,   -- resposta bruta do provedor (só service_role)
  found          boolean NOT NULL DEFAULT true,
  requested_by   uuid,                                 -- team_members.id de quem consultou
  hits           integer NOT NULL DEFAULT 1,           -- quantas vezes o cache serviu
  fetched_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, plate)
);
CREATE INDEX IF NOT EXISTS vehicle_plate_lookups_member_day_idx ON public.vehicle_plate_lookups (tenant_id, requested_by, fetched_at DESC);
ALTER TABLE public.vehicle_plate_lookups ENABLE ROW LEVEL SECURITY;
-- sem policy pra authenticated: só a edge fn (service_role) lê/grava e filtra o que cada perfil pode ver
GRANT ALL ON public.vehicle_plate_lookups TO service_role;

-- ─── 2) Chave por tenant ─────────────────────────────────────────────────────
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
    'CLICKSIGN_API_KEY', 'CLICKSIGN_ENV', 'CLICKSIGN_WEBHOOK_SECRET',
    'PUXAPLACA_TOKEN', 'PUXAPLACA_URL'
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

-- ─── 3) Placa já captada? (usada pela edge fn; service_role) ─────────────────
CREATE OR REPLACE FUNCTION public.seller_vehicle_by_plate(p_tenant uuid, p_plate text, p_exclude_lead uuid DEFAULT NULL)
RETURNS TABLE (vehicle_id uuid, lead_id uuid, lead_name text, vehicle_status text, promoter_name text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT v.id, v.lead_id, l.name, v.status, m.name, v.created_at
  FROM seller_vehicles v
  JOIN leads l ON l.id = v.lead_id
  LEFT JOIN team_members m ON m.id = v.created_by_member_id
  WHERE v.tenant_id = p_tenant
    AND upper(regexp_replace(coalesce(v.plate, ''), '[^A-Za-z0-9]', '', 'g')) = upper(regexp_replace(p_plate, '[^A-Za-z0-9]', '', 'g'))
    AND (p_exclude_lead IS NULL OR v.lead_id <> p_exclude_lead)
  ORDER BY v.created_at DESC LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.seller_vehicle_by_plate(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seller_vehicle_by_plate(uuid, text, uuid) TO service_role;

-- ─── 4) create_capture_lead grava placa / cor / combustível ──────────────────
-- (corpo idêntico ao de 20260910120000_captacao_handoff.sql, só o INSERT em seller_vehicles muda)
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
  v_existing_handoff timestamptz;
  v_lead_id  uuid;
  v_stage    uuid;
  v_last8    text;
  v_handoff  jsonb := '{}'::jsonb;
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

  IF length(v_phone) IN (10, 11) THEN v_phone := '55' || v_phone; END IF;
  v_last8 := right(v_phone, 8);

  v_lead_intent := CASE v_intent WHEN 'trocar' THEN 'trade_in' ELSE 'sell_intermediation' END;
  v_qual := v_qual || jsonb_build_object('intent', v_intent, 'versao', 1);
  v_score := public.compute_capture_score(v_qual, v_vehicle);
  v_temp  := public.capture_temperature(v_score);
  v_qual := v_qual || jsonb_build_object('score', v_score, 'temperatura', v_temp,
                                         'qualificado_em', now(), 'origem', 'promotora');

  SELECT id, handoff_at INTO v_existing, v_existing_handoff FROM leads
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
      pipeline_stage_id     = coalesce(pipeline_stage_id, v_stage),
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
    is_owner, expected_price, condition_notes, created_by_member_id,
    plate, plate_last4, color, fuel
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
    v_member.id,
    CASE WHEN upper(regexp_replace(coalesce(v_vehicle->>'plate', ''), '[^A-Za-z0-9]', '', 'g')) ~ '^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$'
         THEN upper(regexp_replace(v_vehicle->>'plate', '[^A-Za-z0-9]', '', 'g')) END,
    CASE WHEN upper(regexp_replace(coalesce(v_vehicle->>'plate', ''), '[^A-Za-z0-9]', '', 'g')) ~ '^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$'
         THEN right(upper(regexp_replace(v_vehicle->>'plate', '[^A-Za-z0-9]', '', 'g')), 4) END,
    nullif(btrim(v_vehicle->>'color'), ''),
    nullif(btrim(v_vehicle->>'fuel'), '')
  );

  -- Handoff: lead novo, ou reconversão de lead que ainda não foi passado.
  IF v_existing IS NULL OR v_existing_handoff IS NULL THEN
    BEGIN
      v_handoff := public.capture_handoff(v_lead_id);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[create_capture_lead] handoff falhou: %', SQLERRM;
      v_handoff := jsonb_build_object('assigned', false, 'reason', 'error', 'error', SQLERRM);
    END;
  END IF;

  RETURN jsonb_build_object(
    'lead_id', v_lead_id,
    'duplicate', v_existing IS NOT NULL,
    'score', v_score,
    'temperatura', v_temp,
    'handoff', v_handoff
  );
END;
$$;
