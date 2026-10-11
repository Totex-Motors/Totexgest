-- ============================================================================
-- RESPONSÁVEL PADRÃO POR LOJA para leads distribuídos (2026-10-11)
--
-- Lead captado no totem/stand da Totex é DISTRIBUÍDO pra loja dona do carro
-- (source='distribuicao') e caía no funil da loja "Sem responsável" — 24 na
-- Cardoso, 8 na PG, 5 na Quest, 2 na Julio. Ninguém era acionado.
--
-- Mecanismo: sales_pipelines.default_sales_rep_id (já existia, usado só pelos
-- canais credere/marketplace/stand). Agora o trigger genérico
-- _auto_create_deal_for_lead também usa: lead sem dono ganha o vendedor padrão
-- do funil da loja (deal + leads.sales_rep_id).
--
-- Decisão do Marco (2026-10-11): Cardoso → Glauter; PG Motors → Julia Gonçalves;
-- Quest → Geovanna Muniz; Julio Multimarcas → Julio; First Line → Denise.
-- Membros criados (Glauter com a conta dele; os demais com e-mail "pendente."
-- até o cadastro real em Configurações › Equipe). Backfill dos leads parados.
-- JÁ APLICADO EM PRODUÇÃO via MCP (função + updates); este arquivo registra.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._auto_create_deal_for_lead()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
declare v_pipeline uuid; v_stage uuid; v_rep uuid;
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

  select p.id, s.id, p.default_sales_rep_id into v_pipeline, v_stage, v_rep
  from sales_pipelines p join sales_pipeline_stages s on s.pipeline_id = p.id
  where p.tenant_id = new.tenant_id and coalesce(p.is_default,false)
    and coalesce(s.is_won,false)=false and coalesce(s.is_lost,false)=false
  order by s.position limit 1;
  if v_pipeline is null then
    select p.id, s.id, p.default_sales_rep_id into v_pipeline, v_stage, v_rep
    from sales_pipelines p join sales_pipeline_stages s on s.pipeline_id = p.id
    where p.tenant_id = new.tenant_id and coalesce(s.is_won,false)=false and coalesce(s.is_lost,false)=false
    order by p.created_at, s.position limit 1;
  end if;
  if v_pipeline is null then return new; end if;

  -- RESPONSÁVEL PADRÃO da loja (sales_pipelines.default_sales_rep_id) quando o lead chega
  -- sem dono — ex.: lead do totem DISTRIBUÍDO pra loja (2026-10-11).
  v_rep := coalesce(new.sales_rep_id, v_rep);

  insert into deals (lead_id, tenant_id, pipeline_id, pipeline_stage_id, title, status, sales_rep_id, stage_changed_at)
  values (new.id, new.tenant_id, v_pipeline, v_stage, coalesce(new.name, new.phone, 'Lead'), 'open', v_rep, now());
  if new.sales_rep_id is null and v_rep is not null then
    update leads set sales_rep_id = v_rep where id = new.id and sales_rep_id is null;
  end if;
  return new;
exception when others then return new; end $$;

-- Responsável padrão por loja (ids de produção; em outro ambiente, ajustar pela UI
-- Configurações › Comercial › Pipeline ou por SQL).
UPDATE public.sales_pipelines p SET default_sales_rep_id = v.rep
FROM (VALUES
  ('d5f70e01-45f6-43e7-9c71-aa2f2b832919'::uuid, '1ff18688-7c9d-4d19-8924-4c588e6e7c95'::uuid), -- Cardoso → Glauter
  ('d210f271-b955-4f65-b8aa-678671078637'::uuid, '1c2aa312-0cf9-4923-ab4c-2cadd7b99279'::uuid), -- PG Motors → Julia
  ('6bfbd3d8-4841-4600-ace0-46de23f07f8c'::uuid, '539427bd-2d40-43bf-bdf2-4fe5481d5a16'::uuid), -- Quest → Geovanna Muniz
  ('bba0f9f4-c037-446d-9df7-8ff028bdda67'::uuid, '6e54d5d7-5921-4020-92de-92aa425be50a'::uuid)  -- Julio Multimarcas → Julio
) AS v(pid, rep)
WHERE p.id = v.pid AND EXISTS (SELECT 1 FROM public.team_members m WHERE m.id = v.rep);
