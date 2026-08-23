-- Corrige leads de stand/QR que não apareciam em "Novo Lead".
--
-- Causa: o trigger auto_create_deal_for_channel_lead (que cria o deal e coloca o
-- lead na 1ª etapa do pipeline) só rodava on INSERT e só pros canais
-- credere/marketplace/stand. Dois fluxos escapavam e o lead ficava SEM etapa
-- (invisível no Kanban):
--   1) Captação no stand: o whatsapp-webhook cria o lead SEM source; o
--      source='stand' é setado depois, por UPDATE (agent-platform). Quando o
--      UPDATE acontece, o trigger de INSERT já passou -> lead sem etapa.
--   2) Repasse pra loja dona (stand-handoff): cria o lead com
--      utm_source='stand_totex', que não estava na lista de canais -> lead sem etapa.
--
-- Correção: (a) incluir 'stand_totex' na lista; (b) rodar também quando
-- source/utm_source é preenchido depois do insert; (c) backfill dos presos.
-- A função é idempotente (não cria deal se já existir), então rodar no UPDATE é seguro.

-- 1. Função: adiciona 'stand_totex' à lista de canais.
CREATE OR REPLACE FUNCTION public.auto_create_deal_for_channel_lead()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tid                  uuid := NEW.tenant_id;
  v_channel              text := lower(coalesce(NEW.source, NEW.utm_source, ''));
  v_pipeline_id          uuid;
  v_default_sales_rep_id uuid;
  v_stage_id             uuid;
  v_price                numeric := 0;
BEGIN
  -- Só canais externos que NÃO criam deal por conta própria.
  IF v_channel NOT IN ('credere', 'marketplace', 'stand', 'stand_totex') THEN
    RETURN NEW;
  END IF;

  IF v_tid IS NULL THEN
    RETURN NEW;
  END IF;

  -- Extrai valor do veículo do metadata (ambos os formatos de canal).
  v_price := COALESCE(
    (NEW.metadata -> 'vehicle' ->> 'price')::numeric,
    (NEW.metadata -> 'vehicle' ->> 'assets_value')::numeric,
    0
  );

  -- Pipeline padrão ativo do tenant (fallback: qualquer pipeline ativo).
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

  -- Primeira etapa do pipeline (ignora ganho/perdido).
  SELECT id INTO v_stage_id
  FROM sales_pipeline_stages
  WHERE pipeline_id = v_pipeline_id AND tenant_id = v_tid
    AND is_won = false AND is_lost = false
  ORDER BY position
  LIMIT 1;

  IF v_stage_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Idempotência: não cria se o lead já tem deal.
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

  -- Sincroniza etapa no lead + responsável padrão (se ainda não tiver).
  UPDATE leads
  SET pipeline_stage_id = v_stage_id,
      sales_rep_id      = COALESCE(sales_rep_id, v_default_sales_rep_id),
      updated_at        = NOW()
  WHERE id = NEW.id AND tenant_id = v_tid;

  RETURN NEW;
END;
$function$;

-- 2. Dispara também quando source/utm_source é preenchido DEPOIS do insert
--    (fluxo do stand: o source vira 'stand' num UPDATE posterior).
DROP TRIGGER IF EXISTS trg_auto_create_deal_on_source_update ON public.leads;
CREATE TRIGGER trg_auto_create_deal_on_source_update
AFTER UPDATE OF source, utm_source ON public.leads
FOR EACH ROW EXECUTE FUNCTION public.auto_create_deal_for_channel_lead();

-- 3. Backfill: leads que já entraram pelo stand e ficaram sem etapa.
--    Materializa o canal em source e força o trigger (idempotente).
UPDATE public.leads
SET source = lower(coalesce(source, utm_source))
WHERE pipeline_stage_id IS NULL
  AND tenant_id IS NOT NULL
  AND lower(coalesce(source, utm_source, '')) IN ('stand', 'stand_totex');
