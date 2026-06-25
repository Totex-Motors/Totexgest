-- =====================================================================
-- DIAGNÓSTICO: por que os leads de Credere / Marketplace / Totem não
-- aparecem no Pipeline. Rode no SQL Editor do Supabase (account owner).
-- É 100% read-only — não altera nada.
-- =====================================================================

-- 1) Quantos leads existem por canal, e quantos já têm deal no pipeline.
--    Se 'com_deal' < 'total', tem lead órfão (não foi pro pipeline).
SELECT
  lower(coalesce(l.source, l.utm_source, '(vazio)')) AS canal,
  l.tenant_id,
  count(*)                                            AS total_leads,
  count(*) FILTER (WHERE EXISTS (
    SELECT 1 FROM deals d WHERE d.lead_id = l.id AND d.tenant_id = l.tenant_id
  ))                                                  AS com_deal,
  count(*) FILTER (WHERE NOT EXISTS (
    SELECT 1 FROM deals d WHERE d.lead_id = l.id AND d.tenant_id = l.tenant_id
  ))                                                  AS sem_deal
FROM leads l
WHERE lower(coalesce(l.source, l.utm_source, '')) IN ('credere','marketplace','stand')
   OR lower(coalesce(l.source, l.utm_source, '')) LIKE 'stand%'
GROUP BY 1, 2
ORDER BY 1, 2;

-- 2) Cada tenant que tem esses leads TEM pipeline padrão ativo + etapas?
--    Se 'stages_validas' = 0, o trigger não consegue criar deal nesse tenant.
SELECT
  t.tenant_id,
  count(DISTINCT p.id) FILTER (WHERE p.is_active)               AS pipelines_ativos,
  count(DISTINCT p.id) FILTER (WHERE p.is_active AND p.is_default) AS pipelines_default,
  count(s.id) FILTER (WHERE s.is_won = false AND s.is_lost = false) AS stages_validas
FROM (
  SELECT DISTINCT tenant_id
  FROM leads
  WHERE lower(coalesce(source, utm_source, '')) IN ('credere','marketplace','stand')
     OR lower(coalesce(source, utm_source, '')) LIKE 'stand%'
) t
LEFT JOIN sales_pipelines p ON p.tenant_id = t.tenant_id
LEFT JOIN sales_pipeline_stages s ON s.pipeline_id = p.id
GROUP BY t.tenant_id
ORDER BY t.tenant_id;

-- 3) O trigger está instalado e habilitado? (tgenabled = 'O' = ligado)
SELECT tgname, tgenabled
FROM pg_trigger
WHERE tgname = 'trg_auto_create_deal_for_channel_lead';
