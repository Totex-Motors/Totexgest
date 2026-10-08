-- ============================================================================
-- FRANQUEADOS — funil de recrutamento de lojista/franqueado (2026-10-09)
--
-- Substitui (e absorve) as migrations da sala de demo que nunca foram aplicadas:
--   20260928130000_pipeline_recrutamento_franqueados.sql  (pipeline + etapas no HQ)
--   20260928140000_leads_lead_kind.sql                     (lead_kind 'car'/'franchise' — superado
--                                                           por 20261008130000_lead_kind_real.sql)
--
-- Regra: lead com lead_kind='franchise' NUNCA entra no funil de venda de carro.
-- Ele cai no pipeline "Recrutamento de Franqueados" do tenant (no HQ, UUID fixo).
-- Hoje os dois triggers que criam deal automaticamente (_auto_create_deal_for_lead e
-- auto_create_deal_for_channel_lead) jogavam TODO lead novo no pipeline padrão da
-- loja — um lojista vindo da campanha de franquia aparecia no kanban de carro.
--
-- Etapas: Novo → Contato → Demo enviada → Demo assistida → Call agendada →
--         Call realizada → Proposta → Fechado (ganho) / Perdido.
-- Tudo idempotente (ON CONFLICT DO NOTHING + CREATE OR REPLACE).
-- Via MCP: INSERTs e CREATE FUNCTION funcionam (sem ALTER TABLE / CREATE TRIGGER).
-- ============================================================================

-- 1) Pipeline + etapas no HQ (Totex Motors) -----------------------------------
INSERT INTO public.sales_pipelines (id, tenant_id, name, description, position, is_default, is_active)
VALUES ('fdec0000-0000-4000-a000-000000000000', 'c13681e3-5db9-48d1-9c5c-856e6041d77f',
        'Recrutamento de Franqueados',
        'Funil de recrutamento de lojistas/franqueados (sala de demo, campanhas de franquia). Separado do funil de carro.',
        10, false, true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.sales_pipeline_stages (id, name, position, color, is_won, is_lost, pipeline_id, tenant_id)
VALUES
  ('fdec0000-0000-4000-a000-000000000001','Novo',           0, 'gray',   false, false, 'fdec0000-0000-4000-a000-000000000000', 'c13681e3-5db9-48d1-9c5c-856e6041d77f'),
  ('fdec0000-0000-4000-a000-000000000002','Contato',        1, 'blue',   false, false, 'fdec0000-0000-4000-a000-000000000000', 'c13681e3-5db9-48d1-9c5c-856e6041d77f'),
  ('fdec0000-0000-4000-a000-000000000003','Demo enviada',   2, 'indigo', false, false, 'fdec0000-0000-4000-a000-000000000000', 'c13681e3-5db9-48d1-9c5c-856e6041d77f'),
  ('fdec0000-0000-4000-a000-000000000004','Demo assistida', 3, 'cyan',   false, false, 'fdec0000-0000-4000-a000-000000000000', 'c13681e3-5db9-48d1-9c5c-856e6041d77f'),
  ('fdec0000-0000-4000-a000-000000000005','Call agendada',  4, 'amber',  false, false, 'fdec0000-0000-4000-a000-000000000000', 'c13681e3-5db9-48d1-9c5c-856e6041d77f'),
  ('fdec0000-0000-4000-a000-000000000006','Call realizada', 5, 'teal',   false, false, 'fdec0000-0000-4000-a000-000000000000', 'c13681e3-5db9-48d1-9c5c-856e6041d77f'),
  ('fdec0000-0000-4000-a000-000000000007','Proposta',       6, 'orange', false, false, 'fdec0000-0000-4000-a000-000000000000', 'c13681e3-5db9-48d1-9c5c-856e6041d77f'),
  ('fdec0000-0000-4000-a000-000000000008','Fechado',        7, 'green',  true,  false, 'fdec0000-0000-4000-a000-000000000000', 'c13681e3-5db9-48d1-9c5c-856e6041d77f'),
  ('fdec0000-0000-4000-a000-000000000009','Perdido',        8, 'red',    false, true,  'fdec0000-0000-4000-a000-000000000000', 'c13681e3-5db9-48d1-9c5c-856e6041d77f')
ON CONFLICT (id) DO NOTHING;

-- 2) Qual é o funil de recrutamento deste tenant? ------------------------------
-- No HQ é o UUID fixo; em outra loja, um pipeline ativo chamado
-- "Recrutamento de Franqueados". Devolve NULL se não houver.
CREATE OR REPLACE FUNCTION public.franchise_recruitment_pipeline(
  p_tenant uuid,
  OUT pipeline_id uuid,
  OUT first_stage_id uuid
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id, s.id
  FROM public.sales_pipelines p
  JOIN public.sales_pipeline_stages s ON s.pipeline_id = p.id
  WHERE p.tenant_id = p_tenant
    AND COALESCE(p.is_active, true)
    AND (p.id = 'fdec0000-0000-4000-a000-000000000000'
         OR lower(btrim(p.name)) = 'recrutamento de franqueados')
    AND COALESCE(s.is_won, false) = false
    AND COALESCE(s.is_lost, false) = false
  ORDER BY (p.id = 'fdec0000-0000-4000-a000-000000000000') DESC, s.position
  LIMIT 1;
$$;

-- 3) Garante o deal do franqueado no funil de recrutamento (idempotente) --------
-- Interna (sem checagem de auth) — usada pelo trigger e pela RPC pública.
CREATE OR REPLACE FUNCTION public._franchise_ensure_deal(p_lead_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_lead  public.leads%ROWTYPE;
  v_pipe  uuid;
  v_stage uuid;
  v_deal  uuid;
BEGIN
  SELECT * INTO v_lead FROM public.leads WHERE id = p_lead_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Lead não encontrado'; END IF;
  IF v_lead.lead_kind IS DISTINCT FROM 'franchise' THEN
    RAISE EXCEPTION 'Este lead não é franqueado (tipo: %)', COALESCE(v_lead.lead_kind, '?');
  END IF;

  SELECT f.pipeline_id, f.first_stage_id INTO v_pipe, v_stage
  FROM public.franchise_recruitment_pipeline(v_lead.tenant_id) f;
  IF v_pipe IS NULL THEN
    RAISE EXCEPTION 'Funil "Recrutamento de Franqueados" não existe nesta loja';
  END IF;

  SELECT id INTO v_deal
  FROM public.deals
  WHERE lead_id = p_lead_id AND pipeline_id = v_pipe
  ORDER BY created_at DESC
  LIMIT 1;
  IF v_deal IS NOT NULL THEN RETURN v_deal; END IF;

  INSERT INTO public.deals (lead_id, tenant_id, pipeline_id, pipeline_stage_id, title, status,
                            sales_rep_id, stage_changed_at, notes)
  VALUES (p_lead_id, v_lead.tenant_id, v_pipe, v_stage,
          COALESCE(v_lead.name, v_lead.phone, 'Franqueado'), 'negotiation',
          v_lead.sales_rep_id, now(), 'Recrutamento de franqueado')
  RETURNING id INTO v_deal;

  RETURN v_deal;
END;
$$;
REVOKE ALL ON FUNCTION public._franchise_ensure_deal(uuid) FROM PUBLIC, anon, authenticated;

-- Pública (UI "Colocar no funil"): autenticado, não-promotora, própria loja ou
-- superadmin da plataforma.
CREATE OR REPLACE FUNCTION public.franchise_ensure_deal(p_lead_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Não autenticado'; END IF;
  IF public.is_promotora() THEN RAISE EXCEPTION 'Sem permissão'; END IF;
  SELECT tenant_id INTO v_tenant FROM public.leads WHERE id = p_lead_id;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Lead não encontrado'; END IF;
  IF v_tenant <> public.get_tenant_id() AND NOT public.is_platform_superadmin() THEN
    RAISE EXCEPTION 'Lead de outra loja';
  END IF;
  RETURN public._franchise_ensure_deal(p_lead_id);
END;
$$;
REVOKE ALL ON FUNCTION public.franchise_ensure_deal(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.franchise_ensure_deal(uuid) TO authenticated;

-- 4) Triggers existentes: franqueado NÃO vai pro pipeline de carro ------------
-- (a) _auto_create_deal_for_lead — trigger trg_auto_create_deal (AFTER INSERT).
--     Corpo original preservado; só ganha o desvio do franqueado no início.
CREATE OR REPLACE FUNCTION public._auto_create_deal_for_lead()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
declare v_pipeline uuid; v_stage uuid;
begin
  if exists (select 1 from deals where lead_id = new.id) then return new; end if;

  -- FRANQUEADO: funil de recrutamento, nunca o de carro (2026-10-09).
  if new.lead_kind = 'franchise' then
    begin
      perform public._franchise_ensure_deal(new.id);
    exception when others then
      raise warning '[franchise] deal não criado para lead %: %', new.id, sqlerrm;
    end;
    return new;
  end if;

  if coalesce(new.source,'') in ('credere','stand','marketplace','captacao','totexcar-copilot') then
    return new;
  end if;
  if new.phone like 'pending%' then return new; end if;
  -- ignora GRUPOS/CANAIS (JID de grupo virando lead-fantasma)
  if new.phone ~ '@g\.us$' or new.phone ~ '@newsletter$'
     or new.phone ~ '^1203[0-9]{11,}$' or new.phone ~ '^[0-9]+-[0-9]+$' then
    return new;
  end if;

  select p.id, s.id into v_pipeline, v_stage
  from sales_pipelines p join sales_pipeline_stages s on s.pipeline_id = p.id
  where p.tenant_id = new.tenant_id and coalesce(p.is_default,false)
    and coalesce(s.is_won,false)=false and coalesce(s.is_lost,false)=false
  order by s.position limit 1;
  if v_pipeline is null then
    select p.id, s.id into v_pipeline, v_stage
    from sales_pipelines p join sales_pipeline_stages s on s.pipeline_id = p.id
    where p.tenant_id = new.tenant_id and coalesce(s.is_won,false)=false and coalesce(s.is_lost,false)=false
    order by p.created_at, s.position limit 1;
  end if;
  if v_pipeline is null then return new; end if;

  insert into deals (lead_id, tenant_id, pipeline_id, pipeline_stage_id, title, status, sales_rep_id, stage_changed_at)
  values (new.id, new.tenant_id, v_pipeline, v_stage, coalesce(new.name, new.phone, 'Lead'), 'open', new.sales_rep_id, now());
  return new;
exception when others then return new; end $$;

-- (b) auto_create_deal_for_channel_lead — triggers trg_auto_create_deal_for_channel_lead
--     (AFTER INSERT) e trg_auto_create_deal_on_source_update (AFTER UPDATE).
--     Marketplace LOJISTA chega com source='marketplace' + lead_kind='franchise':
--     sem este desvio virava deal no pipeline padrão da loja.
CREATE OR REPLACE FUNCTION public.auto_create_deal_for_channel_lead()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tid                  uuid := NEW.tenant_id;
  v_channel              text := lower(coalesce(NEW.source, NEW.utm_source, ''));
  v_pipeline_id          uuid;
  v_default_sales_rep_id uuid;
  v_stage_id             uuid;
  v_price                numeric := 0;
BEGIN
  -- FRANQUEADO: cuidado do _auto_create_deal_for_lead / franchise_ensure_deal (2026-10-09).
  IF NEW.lead_kind = 'franchise' THEN
    RETURN NEW;
  END IF;

  IF v_channel NOT IN ('credere', 'marketplace', 'stand', 'stand_totex') THEN
    RETURN NEW;
  END IF;

  IF v_tid IS NULL THEN
    RETURN NEW;
  END IF;

  v_price := COALESCE(
    (NEW.metadata -> 'vehicle' ->> 'price')::numeric,
    (NEW.metadata -> 'vehicle' ->> 'assets_value')::numeric,
    0
  );

  SELECT id, default_sales_rep_id INTO v_pipeline_id, v_default_sales_rep_id
  FROM sales_pipelines
  WHERE tenant_id = v_tid AND is_default = true AND is_active = true
  ORDER BY position
  LIMIT 1;

  IF v_pipeline_id IS NULL THEN
    SELECT id, default_sales_rep_id INTO v_pipeline_id, v_default_sales_rep_id
    FROM sales_pipelines
    WHERE tenant_id = v_tid AND is_active = true
    ORDER BY is_default DESC, position
    LIMIT 1;
  END IF;

  IF v_pipeline_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_stage_id
  FROM sales_pipeline_stages
  WHERE pipeline_id = v_pipeline_id AND tenant_id = v_tid
    AND is_won = false AND is_lost = false
  ORDER BY position
  LIMIT 1;

  IF v_stage_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (SELECT 1 FROM deals WHERE lead_id = NEW.id AND tenant_id = v_tid) THEN
    RETURN NEW;
  END IF;

  INSERT INTO deals (
    lead_id, pipeline_id, pipeline_stage_id, sales_rep_id,
    original_price, negotiated_price, status, notes, created_at, tenant_id
  ) VALUES (
    NEW.id, v_pipeline_id, v_stage_id, v_default_sales_rep_id,
    v_price, v_price, 'open',
    'Criado automaticamente a partir do canal: ' || v_channel,
    NOW(), v_tid
  );

  UPDATE leads
  SET pipeline_stage_id = v_stage_id,
      sales_rep_id      = COALESCE(sales_rep_id, v_default_sales_rep_id),
      updated_at        = NOW()
  WHERE id = NEW.id AND tenant_id = v_tid;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.franchise_ensure_deal(uuid) IS
  'Coloca um lead franqueado (lead_kind=franchise) no funil "Recrutamento de Franqueados" da loja. Idempotente.';
