-- ============================================================================
-- SLA HUMANO — Fase 2 (2026-10-08). Base: auditoria da jornada do lead (Renan).
-- Dois problemas reais:
--  (A5) o prazo do 1º contato era "agora + SLA" sem horário comercial → lead
--       captado 20:56 com SLA de 240 min virava "ligar às 00:56";
--  (A4) o 1º contato só era marcado por conversa 1:1 no WhatsApp ou tarefa
--       concluída → "Chamei" no grupo e ligação pelo WaVoIP não contavam, e o
--       SLA escalava pro gestor mesmo com o vendedor tendo ligado.
-- Aqui: horário comercial configurável, prazo/escalada já dentro do expediente,
-- ligação atendida marca contato, e uma RPC segura pro botão no CRM. O "Chamei"
-- no grupo fica na edge function capture-contact-confirm (chamada pelo webhook).
-- ============================================================================

-- ─── 1) Horário comercial (config; editável sem deploy) ──────────────────────
INSERT INTO public.config (key, value) SELECT 'SLA_HORARIO_INICIO', '9'
  WHERE NOT EXISTS (SELECT 1 FROM public.config WHERE key = 'SLA_HORARIO_INICIO');
INSERT INTO public.config (key, value) SELECT 'SLA_HORARIO_FIM', '19'
  WHERE NOT EXISTS (SELECT 1 FROM public.config WHERE key = 'SLA_HORARIO_FIM');
-- dias da semana em que se liga pra cliente: 0=dom, 1=seg … 6=sáb
INSERT INTO public.config (key, value) SELECT 'SLA_DIAS_SEMANA', '1,2,3,4,5,6'
  WHERE NOT EXISTS (SELECT 1 FROM public.config WHERE key = 'SLA_DIAS_SEMANA');

-- ─── 2) next_business_time: joga um horário pra dentro do expediente ─────────
-- Dentro do expediente → devolve igual. Antes de abrir → hoje na abertura.
-- Depois de fechar / fim de semana → próximo dia útil na abertura. Fuso BRT.
CREATE OR REPLACE FUNCTION public.next_business_time(p_ts timestamptz)
RETURNS timestamptz LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  v_ini   int   := coalesce((SELECT value::int FROM public.config WHERE key = 'SLA_HORARIO_INICIO'), 9);
  v_fim   int   := coalesce((SELECT value::int FROM public.config WHERE key = 'SLA_HORARIO_FIM'), 19);
  v_dias  int[] := coalesce((SELECT string_to_array(value, ',')::int[] FROM public.config WHERE key = 'SLA_DIAS_SEMANA'), ARRAY[1,2,3,4,5,6]);
  v_local timestamp := (p_ts AT TIME ZONE 'America/Sao_Paulo');
  v_day   date := v_local::date;
  v_hour  numeric := extract(hour from v_local) + extract(minute from v_local) / 60.0;
  i       int := 0;
BEGIN
  IF extract(dow from v_day)::int = ANY(v_dias) AND v_hour >= v_ini AND v_hour < v_fim THEN
    RETURN p_ts;
  END IF;
  -- antes de abrir num dia útil → fica no mesmo dia; senão, vai pro dia seguinte
  IF NOT (extract(dow from v_day)::int = ANY(v_dias) AND v_hour < v_ini) THEN
    v_day := v_day + 1;
  END IF;
  WHILE NOT (extract(dow from v_day)::int = ANY(v_dias)) AND i < 8 LOOP
    v_day := v_day + 1; i := i + 1;
  END LOOP;
  RETURN (v_day + make_interval(hours => v_ini)) AT TIME ZONE 'America/Sao_Paulo';
END;
$$;
COMMENT ON FUNCTION public.next_business_time(timestamptz) IS
  'Prazo dentro do horário comercial (config SLA_HORARIO_INICIO/FIM, SLA_DIAS_SEMANA; fuso America/Sao_Paulo).';

-- ─── 3) capture_handoff: prazo e escalada em horário comercial ───────────────
-- Igual à versão vigente (20260910180000) + v_escalate, prazos clampados e
-- metadata.handoff.due_at / escalate_at (o runner da SLA usa esses campos).
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
  v_escalate timestamptz;
  v_desc text;
  v_url text;
  v_q jsonb;
  v_stage uuid;
  v_pipeline uuid;
  v_deal_id uuid;
  v_veic text;
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
  v_veic := coalesce(v_vehicle.description, nullif(concat_ws(' ', v_vehicle.brand, v_vehicle.model), ''), 'veículo')
            || coalesce(' ' || v_vehicle.year_model::text, '');

  v_task_name := CASE v_temp
    WHEN 'quente' THEN 'LIGAR AGORA — lead quente da captação: ' || v_lead.name
    WHEN 'morno'  THEN 'Contato hoje — captação: ' || v_lead.name
    ELSE 'Nutrição — captação: ' || v_lead.name END;
  v_priority := CASE v_temp WHEN 'quente' THEN 'high' WHEN 'morno' THEN 'medium' ELSE 'low' END;
  -- Fase 2: prazo e escalada SEMPRE dentro do horário comercial (nada de ligar de madrugada)
  v_due      := public.next_business_time(now() + make_interval(mins => v_sla));
  v_escalate := public.next_business_time(v_due + make_interval(mins => v_sla));
  v_desc := concat_ws(E'\n',
    '🚗 ' || v_veic || coalesce(' · ' || v_vehicle.km::text || ' km', ''),
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

  -- Tarefa ANTES do deal: o trigger auto_move_deal_on_task não deve mover nada aqui.
  INSERT INTO company_activities (
    tenant_id, name, description, task_type, priority, status, completed,
    due_datetime, scheduled_at, lead_id, responsavel_id, created_by_id, team,
    is_critical, source_type, source_id, metadata
  ) VALUES (
    v_lead.tenant_id, v_task_name, v_desc, 'call', v_priority, 'not_started', false,
    v_due, v_due, p_lead_id, v_specialist, v_lead.captured_by_member_id, 'sales',
    v_temp = 'quente', 'captacao', p_lead_id,
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
      'temperatura', v_temp, 'sla_minutes', v_sla, 'task_id', v_task_id,
      'due_at', v_due, 'escalate_at', v_escalate))
  WHERE id = p_lead_id;

  -- Deal no funil de captação (o Kanban é por deals). Um por lead.
  v_stage := coalesce(v_lead.pipeline_stage_id, public.capture_pipeline_first_stage(v_lead.tenant_id));
  SELECT pipeline_id INTO v_pipeline FROM sales_pipeline_stages WHERE id = v_stage;
  SELECT id INTO v_deal_id FROM deals WHERE lead_id = p_lead_id AND status = 'negotiation' LIMIT 1;
  IF v_deal_id IS NULL AND v_stage IS NOT NULL THEN
    INSERT INTO deals (tenant_id, lead_id, pipeline_id, pipeline_stage_id, sales_rep_id, title, status, stage_changed_at, metadata)
    VALUES (v_lead.tenant_id, p_lead_id, v_pipeline, v_stage, v_specialist,
            'Captação — ' || v_veic || ' — ' || v_lead.name, 'negotiation', now(),
            jsonb_build_object('captacao', true, 'temperatura', v_temp, 'promotora_member_id', v_lead.captured_by_member_id))
    RETURNING id INTO v_deal_id;
  END IF;

  PERFORM public.capture_add_event(p_lead_id, 'handoff',
    'Lead passado pra ' || coalesce(split_part(v_spec_name, ' ', 1), 'especialista'),
    v_lead.name || ' (' || v_temp || ') está com ' || coalesce(v_spec_name, 'o especialista')
      || CASE WHEN v_temp IN ('quente', 'morno')
              THEN '. Contato previsto até ' || to_char(v_due AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') || '.'
              ELSE '. Entrou em nutrição.' END,
    v_specialist);

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
                            'specialist_name', v_spec_name, 'task_id', v_task_id, 'deal_id', v_deal_id,
                            'temperatura', v_temp, 'sla_minutes', v_sla, 'due_at', v_due, 'status', 'pending');
END;
$$;

-- ─── 4) capture_mark_first_contact: textos pros canais novos ─────────────────
CREATE OR REPLACE FUNCTION public.capture_mark_first_contact(p_lead_id uuid, p_source text, p_actor uuid DEFAULT NULL::uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_lead record; v_rep text; v_int uuid;
BEGIN
  UPDATE leads SET first_contact_at = now(), handoff_status = 'contacted'
  WHERE id = p_lead_id AND captured_by_member_id IS NOT NULL AND first_contact_at IS NULL
  RETURNING id, name, sales_rep_id INTO v_lead;
  IF v_lead.id IS NULL THEN RETURN false; END IF;
  SELECT name INTO v_rep FROM team_members WHERE id = coalesce(p_actor, v_lead.sales_rep_id);
  PERFORM public.capture_add_event(p_lead_id, 'contacted', v_lead.name || ' foi contatado',
    coalesce(split_part(v_rep, ' ', 1), 'O especialista') || ' fez o 1º contato'
      || CASE p_source WHEN 'whatsapp' THEN ' pelo WhatsApp' WHEN 'tarefa' THEN ' (tarefa concluída)'
                       WHEN 'ligacao' THEN ' por ligação' WHEN 'grupo' THEN ' (confirmou no grupo)'
                       WHEN 'manual' THEN ' (marcado no CRM)' ELSE '' END || '.',
    coalesce(p_actor, v_lead.sales_rep_id));
  SELECT id INTO v_int FROM intermediations WHERE owner_lead_id = p_lead_id;
  IF v_int IS NOT NULL THEN PERFORM intermediation_log(v_int, 'intermediation_qualified', jsonb_build_object('source', p_source)); END IF;
  RETURN true;
END;
$$;
GRANT EXECUTE ON FUNCTION public.capture_mark_first_contact(uuid, text, uuid) TO service_role;

-- ─── 5) Ligação atendida (WaVoIP / call_history) marca o 1º contato ──────────
CREATE OR REPLACE FUNCTION public.trg_capture_first_contact_call()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.lead_id IS NOT NULL
     AND (coalesce(NEW.duration_seconds, 0) > 0
          OR upper(coalesce(NEW.status, '')) IN ('ACCEPTED', 'ANSWERED', 'COMPLETED', 'ENDED', 'FINISHED')) THEN
    PERFORM public.capture_mark_first_contact(NEW.lead_id, 'ligacao', NEW.team_member_id);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_capture_first_contact_call ON public.call_history;
CREATE TRIGGER trg_capture_first_contact_call
  AFTER INSERT OR UPDATE OF status, duration_seconds, ended_at ON public.call_history
  FOR EACH ROW EXECUTE FUNCTION public.trg_capture_first_contact_call();

-- ─── 6) Botão no CRM: "Marquei o 1º contato" (logado; só na própria loja) ────
CREATE OR REPLACE FUNCTION public.capture_mark_contact_manual(p_lead_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid; v_member uuid := public.current_member_id();
BEGIN
  IF v_member IS NULL THEN RAISE EXCEPTION 'Sem membro vinculado à sua conta'; END IF;
  IF public.is_promotora() THEN RAISE EXCEPTION 'A promotora não marca o contato do especialista'; END IF;
  SELECT tenant_id INTO v_tenant FROM leads WHERE id = p_lead_id;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Lead não encontrado'; END IF;
  IF v_tenant <> public.get_tenant_id() AND NOT public.is_platform_superadmin() THEN
    RAISE EXCEPTION 'Lead de outra loja';
  END IF;
  RETURN public.capture_mark_first_contact(p_lead_id, 'manual', v_member);
END;
$$;
REVOKE ALL ON FUNCTION public.capture_mark_contact_manual(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.capture_mark_contact_manual(uuid) TO authenticated;
