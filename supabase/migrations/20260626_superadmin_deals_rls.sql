-- Permite que superadmins vejam e movam deals de qualquer tenant.
-- Sem isso, ao arrastar um card de outra loja o Supabase retorna 406
-- porque o UPDATE afeta 0 linhas (bloqueado pela RLS).

-- Deals: SELECT + UPDATE + INSERT + DELETE
DROP POLICY IF EXISTS tenant_select_deals ON public.deals;
CREATE POLICY tenant_select_deals ON public.deals
  FOR SELECT TO authenticated
  USING (tenant_id = get_tenant_id() OR public.is_superadmin());

DROP POLICY IF EXISTS tenant_insert_deals ON public.deals;
CREATE POLICY tenant_insert_deals ON public.deals
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = get_tenant_id() OR public.is_superadmin());

DROP POLICY IF EXISTS tenant_update_deals ON public.deals;
CREATE POLICY tenant_update_deals ON public.deals
  FOR UPDATE TO authenticated
  USING  (tenant_id = get_tenant_id() OR public.is_superadmin())
  WITH CHECK (tenant_id = get_tenant_id() OR public.is_superadmin());

DROP POLICY IF EXISTS tenant_delete_deals ON public.deals;
CREATE POLICY tenant_delete_deals ON public.deals
  FOR DELETE TO authenticated
  USING (tenant_id = get_tenant_id() OR public.is_superadmin());

-- Pipelines e estágios: superadmin precisa ler para montar o Kanban
DROP POLICY IF EXISTS tenant_select_sales_pipelines ON public.sales_pipelines;
CREATE POLICY tenant_select_sales_pipelines ON public.sales_pipelines
  FOR SELECT TO authenticated
  USING (tenant_id = get_tenant_id() OR public.is_superadmin());

DROP POLICY IF EXISTS tenant_select_sales_pipeline_stages ON public.sales_pipeline_stages;
CREATE POLICY tenant_select_sales_pipeline_stages ON public.sales_pipeline_stages
  FOR SELECT TO authenticated
  USING (tenant_id = get_tenant_id() OR public.is_superadmin());

-- Leads: superadmin precisa ver leads de outros tenants no pipeline
DROP POLICY IF EXISTS tenant_select_leads ON public.leads;
CREATE POLICY tenant_select_leads ON public.leads
  FOR SELECT TO authenticated
  USING (tenant_id = get_tenant_id() OR public.is_superadmin());

DROP POLICY IF EXISTS tenant_update_leads ON public.leads;
CREATE POLICY tenant_update_leads ON public.leads
  FOR UPDATE TO authenticated
  USING  (tenant_id = get_tenant_id() OR public.is_superadmin())
  WITH CHECK (tenant_id = get_tenant_id() OR public.is_superadmin());
