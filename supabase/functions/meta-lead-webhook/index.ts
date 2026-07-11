import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "../_shared/config.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Credenciais do app Meta + verify token — via env vars (NUNCA hardcoded).
// Configurar como secrets da função: META_APP_ID, META_APP_SECRET, META_WEBHOOK_VERIFY_TOKEN
const META_APP_ID = Deno.env.get('META_APP_ID') || '';
const META_APP_SECRET = Deno.env.get('META_APP_SECRET') || '';
const VERIFY_TOKEN = Deno.env.get('META_WEBHOOK_VERIFY_TOKEN') || 'crm_meta_verify_token';
const RECEIVE_LEAD_URL = `${SUPABASE_URL}/functions/v1/receive-lead`;
// SEM tenant/api_key hardcoded: cada lead é roteado pela página → tenant dono → regras do tenant.

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // GET = Webhook verification
  if (req.method === 'GET') {
    const url = new URL(req.url);
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      return new Response(challenge, { status: 200 });
    }
    return new Response('Forbidden', { status: 403 });
  }

  // POST = Lead notification
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const body = await req.json();
    console.log('[meta-lead-webhook] Received:', JSON.stringify(body).slice(0, 300));

    const entries = body.entry || [];
    let processed = 0;

    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        if (change.field !== 'leadgen') continue;

        const leadgenId = change.value?.leadgen_id;
        const formId = change.value?.form_id;
        const pageId = change.value?.page_id || entry.id;
        const adId = change.value?.ad_id;

        if (!leadgenId) continue;
        console.log(`[meta-lead-webhook] Lead ${leadgenId} from form ${formId} page ${pageId}`);

        // Resolve a EMPRESA (tenant) pela página de origem — SEM default hardcoded.
        const { data: pageConfig } = await supabase
          .from('meta_lead_ads_pages')
          .select('page_access_token, is_active, tenant_id')
          .eq('page_id', pageId)
          .eq('is_active', true)
          .maybeSingle();

        const resolvedTenant = pageConfig?.tenant_id || null;

        // Página não cadastrada → não sabemos de qual empresa é. Loga e NÃO processa
        // (nunca joga no tenant errado por padrão).
        if (!resolvedTenant) {
          console.error(`[meta-lead-webhook] Página ${pageId} não cadastrada — lead ${leadgenId} ignorado`);
          await supabase.from('meta_lead_ads_logs').insert({
            tenant_id: null, page_id: pageId, form_id: formId, leadgen_id: leadgenId,
            status: 'error', error_message: 'Página não cadastrada em meta_lead_ads_pages (tenant desconhecido)',
          });
          continue;
        }

        // Resolve qual distribuicao recebe esse lead: form_id (especifico) > page_id (pagina) > catch-all.
        // A RPC match_distribution_config_for_meta_lead aplica essa prioridade. Se nenhuma regra Meta
        // cadastrada, cai no catch-all (regra mais antiga sem match Meta) — comportamento legado preservado.
        const { data: matched, error: matchErr } = await supabase
          .rpc('match_distribution_config_for_meta_lead', {
            p_tenant_id: resolvedTenant,
            p_form_id: formId,
            p_page_id: pageId,
          });

        const tenantCfg = (Array.isArray(matched) ? matched[0] : matched) || null;

        if (matchErr) {
          console.error(`[meta-lead-webhook] Erro ao resolver distribuicao:`, matchErr);
        }

        if (!tenantCfg?.api_key) {
          console.error(`[meta-lead-webhook] Tenant ${resolvedTenant} sem fila de distribuição ativa — lead ${leadgenId} ignorado`);
          await supabase.from('meta_lead_ads_logs').insert({
            tenant_id: resolvedTenant, page_id: pageId, form_id: formId, leadgen_id: leadgenId,
            status: 'error', error_message: 'Tenant sem fila de distribuição ativa',
          });
          continue;
        }
        const apiKey = tenantCfg.api_key;
        console.log(`[meta-lead-webhook] Distribuicao escolhida: ${tenantCfg.name} (form=${formId}, page=${pageId})`);

        // Check if form is enabled (escopado pelo tenant da página — form_id pode repetir entre tenants)
        const { data: formConfig } = await supabase
          .from('meta_lead_ads_forms')
          .select('is_enabled, form_name, leads_count')
          .eq('form_id', formId)
          .eq('tenant_id', resolvedTenant)
          .maybeSingle();

        const formName = formConfig?.form_name || formId;

        if (formConfig && !formConfig.is_enabled) {
          console.log(`[meta-lead-webhook] Form ${formId} is disabled, skipping`);
          await supabase.from('meta_lead_ads_logs').insert({
            tenant_id: resolvedTenant, page_id: pageId, form_id: formId,
            form_name: formName, leadgen_id: leadgenId, status: 'skipped_disabled',
          });
          continue;
        }

        let accessToken = pageConfig?.page_access_token;
        if (!accessToken) {
          // Fallback: app token — resolve por tenant (override) → config global → env var
          const appId = (await getIntegrationKey(supabase, 'META_APP_ID', resolvedTenant)) || META_APP_ID;
          const appSecret = (await getIntegrationKey(supabase, 'META_APP_SECRET', resolvedTenant)) || META_APP_SECRET;
          accessToken = `${appId}|${appSecret}`;
        }

        // Fetch lead data from Meta
        const leadResp = await fetch(`https://graph.facebook.com/v19.0/${leadgenId}?access_token=${accessToken}`);
        const leadData = await leadResp.json();

        if (leadData.error) {
          console.error(`[meta-lead-webhook] Meta API error:`, leadData.error);
          await supabase.from('meta_lead_ads_logs').insert({
            tenant_id: resolvedTenant, page_id: pageId, form_id: formId,
            form_name: formName, leadgen_id: leadgenId, status: 'error',
            error_message: leadData.error.message,
          });
          continue;
        }

        // Parse fields — normalizar chave: lowercase + espaços/hífens → underscore
        // Meta envia "full name" (espaço) em forms novos e "full_name" em antigos
        const fields: Record<string, string> = {};
        for (const fd of (leadData.field_data || [])) {
          const key = (fd.name || '').toLowerCase().replace(/[\s-]+/g, '_');
          const val = Array.isArray(fd.values) ? fd.values[0] : '';
          fields[key] = val;
        }
        console.log(`[meta-lead-webhook] Fields:`, JSON.stringify(fields));

        // Get form name from Meta
        let resolvedFormName = formName;
        try {
          const formResp = await fetch(`https://graph.facebook.com/v19.0/${formId}?fields=name&access_token=${accessToken}`);
          const formData = await formResp.json();
          if (formData.name) resolvedFormName = formData.name;
        } catch {}

        // Get campaign/ad info
        let campaignName = '', adsetName = '', adName = '';
        if (adId) {
          try {
            const adResp = await fetch(`https://graph.facebook.com/v19.0/${adId}?fields=name,campaign{name},adset{name}&access_token=${accessToken}`);
            const adData = await adResp.json();
            adName = adData.name || '';
            campaignName = adData.campaign?.name || '';
            adsetName = adData.adset?.name || '';
          } catch {}
        }

        // Build payload
        const name = fields.full_name || fields.nome || fields.name || '';
        const email = fields.email || fields.e_mail || '';
        const phone = fields.phone_number || fields.telefone || fields.celular || fields.whatsapp || '';

        const payload = {
          name, email, phone,
          source: `Meta Lead Ads | ${resolvedFormName}`,
          utm_source: 'facebook',
          utm_medium: adsetName || 'lead_ads',
          utm_campaign: campaignName,
          utm_content: adName,
          city_name: fields.city || fields.cidade || '',
          state: fields.state || fields.estado || '',
          capital_disponivel: fields.capital_disponivel || fields.capital || fields.investimento || '',
          melhor_horario_contato: fields.horario || fields.melhor_horario || '',
        };

        // Call receive-lead — chave do PRÓPRIO tenant da página (resolve as regras do tenant)
        const rlResp = await fetch(`${RECEIVE_LEAD_URL}?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const rlResult = await rlResp.json();
        console.log(`[meta-lead-webhook] receive-lead:`, JSON.stringify(rlResult).slice(0, 200));

        const success = rlResult.success || rlResult.lead_id;

        // Log
        await supabase.from('meta_lead_ads_logs').insert({
          tenant_id: resolvedTenant,
          page_id: pageId,
          form_id: formId,
          form_name: resolvedFormName,
          leadgen_id: leadgenId,
          lead_name: name,
          lead_email: email,
          lead_phone: phone,
          status: success ? 'success' : 'error',
          error_message: success ? null : (rlResult.error || 'Unknown'),
          lead_id: rlResult.lead_id || null,
          deal_id: rlResult.deal_id || null,
          assigned_to_name: rlResult.assigned_to?.name || null,
          raw_data: { fields, payload, result: rlResult },
        });

        // Update form stats
        if (success) {
          try {
            await supabase.from('meta_lead_ads_forms')
              .update({ leads_count: (formConfig?.leads_count || 0) + 1, last_lead_at: new Date().toISOString() })
              .eq('form_id', formId)
              .eq('tenant_id', resolvedTenant);
          } catch {}

          try {
            await supabase.from('meta_lead_ads_pages')
              .update({ last_lead_at: new Date().toISOString() })
              .eq('page_id', pageId)
              .eq('tenant_id', resolvedTenant);
          } catch {}

          processed++;
        }
      }
    }

    return new Response(JSON.stringify({ success: true, processed }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[meta-lead-webhook] Error:', msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 200, // Meta requires 200
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
