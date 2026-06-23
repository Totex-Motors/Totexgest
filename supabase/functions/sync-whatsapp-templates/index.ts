import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * sync-whatsapp-templates — puxa templates da Meta Cloud API e faz upsert local.
 *
 * MULTI-TENANT: pega instância Cloud API do tenant atual (resolvido via JWT do
 * usuário chamador). Cada tenant tem sua própria WABA + token, e seus próprios
 * `whatsapp_cloud_templates`.
 *
 * POST {} (sem body necessário, mas requer Authorization header)
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const GRAPH_API_VERSION = "v22.0";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // MULTI-TENANT (categoria a — chamada do frontend com JWT)
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    const tenantId = (user?.app_metadata as any)?.tenant_id;
    if (!tenantId) return jsonRes({ error: "missing tenant" }, 401);

    // MULTI-TENANT: filtra instâncias do tenant
    const { data: instance } = await supabase
      .from("whatsapp_instances")
      .select("id, business_account_id, api_key, status")
      .eq("tenant_id", tenantId)
      .eq("provider", "meta_cloud")
      .in("status", ["connected", "active"])
      .limit(1)
      .maybeSingle();

    if (!instance?.business_account_id || !instance?.api_key) {
      return jsonRes({ error: "Instância Cloud API não configurada para este tenant" }, 404);
    }

    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${instance.business_account_id}/message_templates?fields=id,name,language,category,status,components,quality_score,rejected_reason&limit=100`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${instance.api_key}` },
    });
    const data = await res.json();

    if (data.error) {
      return jsonRes({ error: "Meta API error", details: data.error }, 502);
    }

    const templates = data.data || [];
    let upserted = 0;

    for (const t of templates) {
      const body = (t.components || []).find((c: any) => c.type === "BODY");
      const variables = countVariables(body?.text || "");

      // MULTI-TENANT: insert/upsert com tenant_id. onConflict precisa de unique
      // composite (tenant_id, name, language) na tabela.
      const { error } = await supabase
        .from("whatsapp_cloud_templates")
        .upsert(
          {
            tenant_id: tenantId,
            meta_template_id: t.id,
            meta_waba_id: instance.business_account_id,
            name: t.name,
            language: t.language,
            category: t.category,
            status: t.status,
            rejection_reason: t.rejected_reason || null,
            components: t.components || [],
            variables_count: variables,
          },
          { onConflict: "tenant_id,name,language" }
        );

      if (!error) upserted++;
    }

    return jsonRes({ success: true, total: templates.length, upserted });
  } catch (err: any) {
    console.error("[sync-whatsapp-templates]", err);
    return jsonRes({ error: err.message }, 500);
  }
});

function countVariables(text: string): number {
  const matches = text.match(/\{\{\s*(\d+)\s*\}\}/g) || [];
  return new Set(matches).size;
}

function jsonRes(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
