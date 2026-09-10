-- ============================================================================
-- Captação — Fase 4: HANDOFF promotora → especialista + retorno pra promotora.
--
-- Fluxo: CAPTURA → SCORE → ATRIBUIÇÃO (round-robin) → TAREFA + ALERTA →
--        1º CONTATO (detectado por WhatsApp enviado / tarefa concluída) →
--        SLA (cron re-avisa e escala) → RETORNO À PROMOTORA (capture_lead_events).
--
-- O que entra:
--   1) capture_handoff_config  — especialistas, SLA, canal (instância/grupo).
--   2) leads: handoff_at, handoff_member_id, handoff_status, first_contact_at.
--   3) capture_lead_events     — feed de retorno ("seu lead foi contatado…").
--   4) capture_pick_specialist / capture_handoff (tarefa + alerta via pg_net).
--   5) create_capture_lead passa a chamar capture_handoff.
--   6) Triggers de 1º contato (whatsapp_messages / company_activities) e de
--      feedback (mudança de etapa / vendedor) → eventos pra promotora.
--   7) list_my_capture_leads e capture_home_stats atualizadas.
--   8) Cron capture-sla (10 min) → edge function capture-handoff mode=sla.
-- ============================================================================

-- ─── 1) Configuração do handoff (por tenant) ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.capture_handoff_config (
  tenant_id               uuid PRIMARY KEY DEFAULT public.get_tenant_id(),
  enabled                 boolean NOT NULL DEFAULT true,
  -- Especialistas que recebem os leads (ordem = ordem do rodízio). Vazio =
  -- todos os membros ativos com role comercial/closer do tenant.
  specialist_member_ids   uuid[] NOT NULL DEFAULT '{}',
  last_assigned_member_id uuid,
  sla_minutes_quente      integer NOT NULL DEFAULT 30  CHECK (sla_minutes_quente BETWEEN 5 AND 1440),
  sla_minutes_morno       integer NOT NULL DEFAULT 240 CHECK (sla_minutes_morno BETWEEN 5 AND 4320),
  escalate_to_member_id   uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  notify_specialist       boolean NOT NULL DEFAULT true,
  notify_group            boolean NOT NULL DEFAULT true,
  -- Canal de aviso. NULL = usa o mesmo da Torre de Controle (operation_alert_config).
  whatsapp_instance_id    uuid REFERENCES public.whatsapp_instances(id) ON DELETE SET NULL,
  whatsapp_group_jid      text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  CREATE TRIGGER update_capture_handoff_config_updated_at BEFORE UPDATE ON public.capture_handoff_config
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.capture_handoff_config TO authenticated, service_role;
ALTER TABLE public.capture_handoff_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS capture_handoff_config_select ON public.capture_handoff_config;
CREATE POLICY capture_handoff_config_select ON public.capture_handoff_config
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_tenant_id() OR public.is_superadmin());
DROP POLICY IF EXISTS capture_handoff_config_write ON public.capture_handoff_config;
CREATE POLICY capture_handoff_config_write ON public.capture_handoff_config
  FOR ALL TO authenticated
  USING ((tenant_id = public.get_tenant_id() AND public.is_admin()) OR public.is_superadmin())
  WITH CHECK ((tenant_id = public.get_tenant_id() AND public.is_admin()) OR public.is_superadmin());

-- ─── 2) leads: estado do handoff ───────────────────────────────────────────
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS handoff_at        timestamptz,
  ADD COLUMN IF NOT EXISTS handoff_member_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS handoff_status    text,
  ADD COLUMN IF NOT EXISTS first_contact_at  timestamptz;

DO $$ BEGIN
  ALTER TABLE public.leads ADD CONSTRAINT leads_handoff_status_check
    CHECK (handoff_status IS NULL OR handoff_status IN
      ('pending', 'notified', 'contacted', 'sla_breached', 'escalated', 'unassigned', 'skipped'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS leads_handoff_status_idx ON public.leads(tenant_id, handoff_status)
  WHERE handoff_status IS NOT NULL;

COMMENT ON COLUMN public.leads.handoff_status IS
  'Captação: pending (atribuído, aviso a caminho) | notified | contacted (1º contato feito) | sla_breached | escalated | unassigned (sem especialista) | skipped (handoff desligado)';

-- ─── 3) Feed de retorno pra promotora ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.capture_lead_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  lead_id              uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  promotora_member_id  uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  event_type           text NOT NULL
                       CHECK (event_type IN ('handoff', 'contacted', 'stage', 'won', 'lost', 'reassigned', 'sla', 'info')),
  title                text NOT NULL,
  body                 text,
  actor_member_id      uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  read_at              timestamptz
);
CREATE INDEX IF NOT EXISTS capture_lead_events_promotora_idx ON public.capture_lead_events(promotora_member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS capture_lead_events_lead_idx ON public.capture_lead_events(lead_id);

GRANT SELECT ON public.capture_lead_events TO authenticated;
GRANT ALL ON public.capture_lead_events TO service_role;
ALTER TABLE public.capture_lead_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS capture_lead_events_select ON public.capture_lead_events;
CREATE POLICY capture_lead_events_select ON public.capture_lead_events
  FOR SELECT TO authenticated
  USING (
    (tenant_id = public.get_tenant_id() OR public.is_superadmin())
    AND (NOT public.is_promotora() OR promotora_member_id = public.current_member_id())
  );
-- escrita só via funções SECURITY DEFINER (sem policy de INSERT/UPDATE/DELETE)

-- Registra um evento pra promotora que captou o lead (no-op se não houver).
CREATE OR REPLACE FUNCTION public.capture_add_event(
  p_lead_id uuid, p_type text, p_title text, p_body text DEFAULT NULL, p_actor uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_lead record;
BEGIN
  SELECT id, tenant_id, captured_by_member_id INTO v_lead FROM leads WHERE id = p_lead_id;
  IF v_lead.captured_by_member_id IS NULL THEN RETURN; END IF;
  INSERT INTO capture_lead_events (tenant_id, lead_id, promotora_member_id, event_type, title, body, actor_member_id)
  VALUES (v_lead.tenant_id, v_lead.id, v_lead.captured_by_member_id, p_type, p_title, p_body, p_actor);
END;
$$;

-- Promotora marca os próprios retornos como lidos (todos ou por id).
CREATE OR REPLACE FUNCTION public.mark_capture_events_read(p_ids uuid[] DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_member uuid := public.current_member_id(); v_n integer;
BEGIN
  IF v_member IS NULL THEN RETURN 0; END IF;
  UPDATE capture_lead_events SET read_at = now()
  WHERE promotora_member_id = v_member AND read_at IS NULL
    AND (p_ids IS NULL OR id = ANY(p_ids));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
GRANT EXECUTE ON FUNCTION public.mark_capture_events_read(uuid[]) TO authenticated;

-- ─── 4) Escolha do especialista (rodízio) + handoff ────────────────────────
CREATE OR REPLACE FUNCTION public.capture_pick_specialist(p_tenant uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cfg capture_handoff_config%ROWTYPE;
  v_candidates uuid[];
  v_idx integer;
  v_next uuid;
BEGIN
  SELECT * INTO v_cfg FROM capture_handoff_config WHERE tenant_id = p_tenant;

  -- lista configurada (mantém a ordem do array, só ativos)
  IF v_cfg.tenant_id IS NOT NULL AND coalesce(array_length(v_cfg.specialist_member_ids, 1), 0) > 0 THEN
    SELECT array_agg(m.id ORDER BY o.ord) INTO v_candidates
    FROM unnest(v_cfg.specialist_member_ids) WITH ORDINALITY AS o(id, ord)
    JOIN team_members m ON m.id = o.id AND m.is_active AND m.tenant_id = p_tenant;
  END IF;

  -- fallback: todo vendedor ativo do tenant
  IF coalesce(array_length(v_candidates, 1), 0) = 0 THEN
    SELECT array_agg(id ORDER BY name) INTO v_candidates
    FROM team_members
    WHERE tenant_id = p_tenant AND is_active AND role IN ('comercial', 'closer');
  END IF;

  IF coalesce(array_length(v_candidates, 1), 0) = 0 THEN RETURN NULL; END IF;

  v_idx := coalesce(array_position(v_candidates, v_cfg.last_assigned_member_id), 0);
  v_next := v_candidates[(v_idx % array_length(v_candidates, 1)) + 1];

  INSERT INTO capture_handoff_config (tenant_id, last_assigned_member_id)
  VALUES (p_tenant, v_next)
  ON CONFLICT (tenant_id) DO UPDATE SET last_assigned_member_id = EXCLUDED.last_assigned_member_id;

  RETURN v_next;
END;
$$;

-- Handoff do lead captado: atribui especialista, cria tarefa, registra
-- retorno pra promotora e dispara o aviso (edge function via pg_net).
CREATE OR REPLACE FUNCTION public.capture_handoff(p_lead_id uuid, p_force boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lead leads%ROWTYPE;
  v_cfg capture_handoff_config%ROWTYPE;
  v_temp text;
  v_specialist uuid;
  v_spec_name text;
  v_promotora_name text;
  v_vehicle record;
  v_sla integer;
  v_task_id uuid;
  v_task_name text;
  v_priority text;
  v_due timestamptz;
  v_desc text;
  v_url text;
  v_q jsonb;
BEGIN
  SELECT * INTO v_lead FROM leads WHERE id = p_lead_id;
  IF v_lead.id IS NULL OR v_lead.captured_by_member_id IS NULL THEN
    RETURN jsonb_build_object('assigned', false, 'reason', 'not_capture_lead');
  END IF;
  IF v_lead.handoff_at IS NOT NULL AND NOT p_force THEN
    RETURN jsonb_build_object('assigned', v_lead.handoff_member_id IS NOT NULL,
                              'specialist_id', v_lead.handoff_member_id,
                              'status', v_lead.handoff_status, 'reason', 'already_done');
  END IF;

  SELECT * INTO v_cfg FROM capture_handoff_config WHERE tenant_id = v_lead.tenant_id;
  IF v_cfg.tenant_id IS NOT NULL AND NOT v_cfg.enabled THEN
    UPDATE leads SET handoff_status = 'skipped' WHERE id = p_lead_id;
    RETURN jsonb_build_object('assigned', false, 'reason', 'disabled');
  END IF;

  v_q := coalesce(v_lead.seller_qualification, '{}'::jsonb);
  v_temp := coalesce(v_q->>'temperatura', public.capture_temperature(coalesce(v_lead.sales_score, 0)));
  v_sla := CASE v_temp
             WHEN 'quente' THEN coalesce(v_cfg.sla_minutes_quente, 30)
             WHEN 'morno'  THEN coalesce(v_cfg.sla_minutes_morno, 240)
             ELSE 7 * 24 * 60 END;

  v_specialist := coalesce(v_lead.sales_rep_id, public.capture_pick_specialist(v_lead.tenant_id));
  IF v_specialist IS NULL THEN
    UPDATE leads SET handoff_at = now(), handoff_status = 'unassigned' WHERE id = p_lead_id;
    PERFORM public.capture_add_event(p_lead_id, 'info', 'Lead registrado — sem especialista disponível',
      'Nenhum vendedor ativo pra receber o lead. O gestor precisa configurar os especialistas em Configurações › Captação.');
    RETURN jsonb_build_object('assigned', false, 'reason', 'no_specialist', 'temperatura', v_temp);
  END IF;

  SELECT name INTO v_spec_name FROM team_members WHERE id = v_specialist;
  SELECT name INTO v_promotora_name FROM team_members WHERE id = v_lead.captured_by_member_id;
  SELECT * INTO v_vehicle FROM seller_vehicles WHERE lead_id = p_lead_id ORDER BY created_at DESC LIMIT 1;

  -- Tarefa pro especialista (aparece no sino/tarefas dele via realtime)
  v_task_name := CASE v_temp
    WHEN 'quente' THEN 'LIGAR AGORA — lead quente da captação: ' || v_lead.name
    WHEN 'morno'  THEN 'Contato hoje — captação: ' || v_lead.name
    ELSE 'Nutrição — captação: ' || v_lead.name END;
  v_priority := CASE v_temp WHEN 'quente' THEN 'high' WHEN 'morno' THEN 'medium' ELSE 'low' END;
  v_due := now() + make_interval(mins => v_sla);
  v_desc := concat_ws(E'\n',
    '🚗 ' || coalesce(v_vehicle.description, concat_ws(' ', v_vehicle.brand, v_vehicle.model), 'veículo não informado')
      || coalesce(' · ' || v_vehicle.year_model::text, '')
      || coalesce(' · ' || v_vehicle.km::text || ' km', ''),
    '🎯 Quer: ' || coalesce(v_q->>'intent', '—') || ' · Prazo: ' || coalesce(v_q->>'prazo_venda', '—')
      || coalesce(' · Motivo: ' || (v_q->>'motivo'), ''),
    '✅ Aceita avaliação: ' || coalesce(v_q->>'aceita_avaliacao', '—')
      || ' · Autorizou contato: ' || CASE WHEN v_q->>'autoriza_contato' = 'true' THEN 'sim' ELSE 'NÃO' END
      || ' · Proprietário: ' || CASE v_q->>'is_owner' WHEN 'true' THEN 'sim' WHEN 'false' THEN 'não' ELSE '—' END,
    CASE WHEN (v_q->>'expectativa_valor') ~ '^\d+(\.\d+)?$'
         THEN '💰 Valor em mente: R$ ' || to_char((v_q->>'expectativa_valor')::numeric, 'FM999G999G999') END,
    CASE WHEN nullif(v_q->>'observacao', '') IS NOT NULL THEN '📝 ' || (v_q->>'observacao') END,
    '👩 Captado por ' || coalesce(v_promotora_name, 'promotora') || ' (score ' || coalesce(v_lead.sales_score, 0) || ')'
  );

  INSERT INTO company_activities (
    tenant_id, name, description, task_type, priority, status, completed,
    due_datetime, scheduled_at, lead_id, responsavel_id, created_by_id, team,
    is_critical, source_type, source_id, metadata
  ) VALUES (
    v_lead.tenant_id, v_task_name, v_desc, 'call', v_priority, 'not_started', false,
    v_due, v_due, p_lead_id, v_specialist, v_lead.captured_by_member_id, 'sales',
    v_temp = 'quente', 'captacao', p_lead_id::text,
    jsonb_build_object('captacao', true, 'temperatura', v_temp, 'sla_minutes', v_sla,
                       'promotora_member_id', v_lead.captured_by_member_id)
  ) RETURNING id INTO v_task_id;

  UPDATE leads SET
    sales_rep_id      = v_specialist,
    handoff_at        = now(),
    handoff_member_id = v_specialist,
    handoff_status    = 'pending',
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('handoff', jsonb_build_object(
      'especialista', v_spec_name, 'especialista_id', v_specialist, 'em', now(),
      'temperatura', v_temp, 'sla_minutes', v_sla, 'task_id', v_task_id))
  WHERE id = p_lead_id;

  PERFORM public.capture_add_event(p_lead_id, 'handoff',
    'Lead passado pra ' || coalesce(split_part(v_spec_name, ' ', 1), 'especialista'),
    v_lead.name || ' (' || v_temp || ') está com ' || coalesce(v_spec_name, 'o especialista')
      || CASE WHEN v_temp IN ('quente', 'morno') THEN '. Contato previsto em até ' || v_sla || ' min.' ELSE '. Entrou em nutrição.' END,
    v_specialist);

  -- Aviso por WhatsApp (especialista + grupo) — só quente/morno, fire-and-forget.
  IF v_temp IN ('quente', 'morno') THEN
    BEGIN
      SELECT rtrim(value, '/') INTO v_url FROM config WHERE key = 'SUPABASE_PROJECT_URL';
      IF v_url IS NOT NULL AND v_url LIKE 'http%' THEN
        PERFORM net.http_post(
          url := v_url || '/functions/v1/capture-handoff',
          headers := '{"Content-Type":"application/json"}'::jsonb,
          body := jsonb_build_object('mode', 'notify', 'lead_id', p_lead_id)
        );
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[capture_handoff] aviso não disparado: %', SQLERRM;
    END;
  END IF;

  RETURN jsonb_build_object('assigned', true, 'specialist_id', v_specialist,
                            'specialist_name', v_spec_name, 'task_id', v_task_id,
                            'temperatura', v_temp, 'sla_minutes', v_sla, 'status', 'pending');
END;
$$;
GRANT EXECUTE ON FUNCTION public.capture_handoff(uuid, boolean) TO authenticated;

-- 1º contato: chamado pelos triggers de WhatsApp/tarefa. Fecha o SLA e avisa a promotora.
CREATE OR REPLACE FUNCTION public.capture_mark_first_contact(p_lead_id uuid, p_source text, p_actor uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_lead record; v_rep text;
BEGIN
  UPDATE leads SET first_contact_at = now(), handoff_status = 'contacted'
  WHERE id = p_lead_id AND captured_by_member_id IS NOT NULL AND first_contact_at IS NULL
  RETURNING id, name, sales_rep_id INTO v_lead;
  IF v_lead.id IS NULL THEN RETURN false; END IF;
  SELECT name INTO v_rep FROM team_members WHERE id = coalesce(p_actor, v_lead.sales_rep_id);
  PERFORM public.capture_add_event(p_lead_id, 'contacted',
    v_lead.name || ' foi contatado',
    coalesce(split_part(v_rep, ' ', 1), 'O especialista') || ' fez o 1º contato'
      || CASE p_source WHEN 'whatsapp' THEN ' pelo WhatsApp' WHEN 'tarefa' THEN ' (tarefa concluída)' ELSE '' END || '.',
    coalesce(p_actor, v_lead.sales_rep_id));
  RETURN true;
END;
$$;

-- ─── 5) create_capture_lead → chama o handoff ──────────────────────────────
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

-- ─── 6) Triggers: 1º contato e feedback de etapa ───────────────────────────
CREATE OR REPLACE FUNCTION public.trg_capture_first_contact_whatsapp() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM public.capture_mark_first_contact(NEW.lead_id, 'whatsapp');
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_capture_first_contact_whatsapp ON public.whatsapp_messages;
CREATE TRIGGER trg_capture_first_contact_whatsapp AFTER INSERT ON public.whatsapp_messages
  FOR EACH ROW WHEN (NEW.is_from_me = true AND NEW.lead_id IS NOT NULL)
  EXECUTE FUNCTION public.trg_capture_first_contact_whatsapp();

CREATE OR REPLACE FUNCTION public.trg_capture_first_contact_task() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM public.capture_mark_first_contact(NEW.lead_id, 'tarefa', NEW.responsavel_id);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_capture_first_contact_task ON public.company_activities;
CREATE TRIGGER trg_capture_first_contact_task AFTER UPDATE ON public.company_activities
  FOR EACH ROW WHEN (NEW.completed = true AND OLD.completed IS DISTINCT FROM true AND NEW.lead_id IS NOT NULL)
  EXECUTE FUNCTION public.trg_capture_first_contact_task();

-- Etapa mudou / vendedor mudou → retorno pra promotora
CREATE OR REPLACE FUNCTION public.trg_capture_lead_feedback() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_stage record; v_rep text;
BEGIN
  IF NEW.pipeline_stage_id IS DISTINCT FROM OLD.pipeline_stage_id AND NEW.pipeline_stage_id IS NOT NULL THEN
    SELECT name, is_won, is_lost INTO v_stage FROM sales_pipeline_stages WHERE id = NEW.pipeline_stage_id;
    IF v_stage.is_won THEN
      PERFORM public.capture_add_event(NEW.id, 'won', '🏆 ' || NEW.name || ' — carro captado!',
        'O veículo entrou pra Totex. Esse lead conta pro seu ranking.', NEW.sales_rep_id);
    ELSIF v_stage.is_lost THEN
      PERFORM public.capture_add_event(NEW.id, 'lost', NEW.name || ' — não avançou',
        'O lead foi marcado como perdido' || coalesce(' (' || v_stage.name || ')', '') || '.', NEW.sales_rep_id);
    ELSE
      PERFORM public.capture_add_event(NEW.id, 'stage', NEW.name || ' avançou: ' || v_stage.name,
        NULL, NEW.sales_rep_id);
    END IF;
  END IF;

  -- troca de vendedor DEPOIS do handoff (o handoff em si já registra o próprio evento)
  IF NEW.sales_rep_id IS DISTINCT FROM OLD.sales_rep_id AND OLD.sales_rep_id IS NOT NULL AND NEW.sales_rep_id IS NOT NULL THEN
    SELECT name INTO v_rep FROM team_members WHERE id = NEW.sales_rep_id;
    PERFORM public.capture_add_event(NEW.id, 'reassigned', NEW.name || ' agora está com ' || coalesce(split_part(v_rep, ' ', 1), 'outro especialista'),
      NULL, NEW.sales_rep_id);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_capture_lead_feedback ON public.leads;
CREATE TRIGGER trg_capture_lead_feedback AFTER UPDATE ON public.leads
  FOR EACH ROW WHEN (NEW.captured_by_member_id IS NOT NULL
                     AND (OLD.pipeline_stage_id IS DISTINCT FROM NEW.pipeline_stage_id
                          OR OLD.sales_rep_id IS DISTINCT FROM NEW.sales_rep_id))
  EXECUTE FUNCTION public.trg_capture_lead_feedback();

-- ─── 7) RPCs de leitura atualizadas ────────────────────────────────────────
DROP FUNCTION IF EXISTS public.list_my_capture_leads(text, text, integer, uuid);
CREATE FUNCTION public.list_my_capture_leads(
  p_search text DEFAULT NULL,
  p_temperatura text DEFAULT NULL,
  p_limit integer DEFAULT 200,
  p_member_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid, name text, phone text, email text,
  created_at timestamptz, captured_at timestamptz,
  lead_intent text, sales_score integer, temperatura text,
  seller_qualification jsonb,
  stage_name text, stage_position integer, stage_is_won boolean, stage_is_lost boolean,
  sales_rep_name text,
  handoff_status text, handoff_at timestamptz, first_contact_at timestamptz,
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
  v_target := CASE
    WHEN p_member_id IS NOT NULL AND (public.is_admin() OR public.is_superadmin()) THEN p_member_id
    ELSE v_member_id END;

  RETURN QUERY
  SELECT
    l.id, l.name, l.phone, l.email, l.created_at, l.captured_at, l.lead_intent,
    l.sales_score,
    coalesce(l.seller_qualification->>'temperatura', public.capture_temperature(coalesce(l.sales_score, 0))) AS temperatura,
    l.seller_qualification,
    s.name, s.position, coalesce(s.is_won, false), coalesce(s.is_lost, false),
    tm.name,
    l.handoff_status, l.handoff_at, l.first_contact_at,
    (SELECT to_jsonb(sv) FROM seller_vehicles sv
      WHERE sv.lead_id = l.id ORDER BY sv.created_at DESC LIMIT 1)
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
GRANT EXECUTE ON FUNCTION public.list_my_capture_leads(text, text, integer, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.capture_home_stats(p_member_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member_id uuid := public.current_member_id();
  v_target uuid;
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
    'hoje',           count(*) FILTER (WHERE captured_at >= v_today_start),
    'semana',         count(*) FILTER (WHERE captured_at >= v_week_start),
    'mes',            count(*) FILTER (WHERE captured_at >= v_month_start),
    'quentes_semana', count(*) FILTER (WHERE captured_at >= v_week_start
                                         AND seller_qualification->>'temperatura' = 'quente'),
    'qualificados_hoje', count(*) FILTER (WHERE captured_at >= v_today_start AND coalesce(sales_score, 0) >= 45),
    'pendentes_complemento', count(*) FILTER (WHERE captured_at >= v_week_start
                                                AND (seller_qualification->>'autoriza_contato' IS DISTINCT FROM 'true'
                                                     OR NOT EXISTS (SELECT 1 FROM seller_vehicles sv
                                                                    WHERE sv.lead_id = l.id AND sv.km IS NOT NULL))),
    -- quente/morno passado e ainda sem 1º contato
    'handoff_pendente', count(*) FILTER (WHERE first_contact_at IS NULL
                                           AND handoff_status IN ('pending', 'notified', 'sla_breached', 'escalated', 'unassigned')
                                           AND seller_qualification->>'temperatura' IN ('quente', 'morno')
                                           AND captured_at >= v_month_start),
    'contatados_semana', count(*) FILTER (WHERE first_contact_at >= v_week_start),
    'em_atendimento', count(*) FILTER (WHERE sales_rep_id IS NOT NULL AND captured_at >= v_month_start),
    'captados_mes', count(*) FILTER (WHERE captured_at >= v_month_start AND EXISTS (
                        SELECT 1 FROM sales_pipeline_stages s WHERE s.id = l.pipeline_stage_id AND s.is_won)),
    'retornos_nao_lidos', (SELECT count(*) FROM capture_lead_events e
                            WHERE e.promotora_member_id = v_target AND e.read_at IS NULL)
  ) INTO r
  FROM leads l
  WHERE l.captured_by_member_id = v_target;

  RETURN coalesce(r, '{}'::jsonb);
END;
$$;

-- ─── 8) Cron: SLA do handoff (a cada 10 min) ───────────────────────────────
CREATE OR REPLACE FUNCTION public.capture_handoff_setup_crons()
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_url text; v_job record; v_cmd text;
BEGIN
  SELECT value INTO v_url FROM public.config WHERE key = 'SUPABASE_PROJECT_URL';
  v_url := rtrim(coalesce(v_url, ''), '/');
  IF v_url = '' OR v_url NOT LIKE 'http%' THEN
    RAISE WARNING 'SUPABASE_PROJECT_URL ausente — cron capture-sla NAO agendado.';
    RETURN 'skipped: SUPABASE_PROJECT_URL ausente';
  END IF;
  FOR v_job IN SELECT jobname FROM cron.job WHERE jobname = 'capture-sla' LOOP
    PERFORM cron.unschedule(v_job.jobname);
  END LOOP;
  v_cmd := format(
    $f$SELECT net.http_post(url := %L, headers := '{"Content-Type":"application/json"}'::jsonb, body := '{"mode":"sla"}'::jsonb)$f$,
    v_url || '/functions/v1/capture-handoff');
  PERFORM cron.schedule('capture-sla', '*/10 * * * *', v_cmd);
  RETURN 'cron capture-sla agendado para ' || v_url;
END $$;

SELECT public.capture_handoff_setup_crons();
