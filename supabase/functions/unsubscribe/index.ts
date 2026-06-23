import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    const token = url.searchParams.get("token") || (await req.json().catch(() => ({}))).token;
    if (!token) {
      return new Response(JSON.stringify({ error: "token missing" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // MULTI-TENANT (categoria e — endpoint público): tenant resolvido via token único.
    // unsubscribe_token é UUID/random → globally unique, traz o tenant de quebra.
    const { data: subscriber } = await supabase
      .from("email_subscribers")
      .select("id, tenant_id, email")
      .eq("unsubscribe_token", token)
      .maybeSingle();

    if (!subscriber) {
      return new Response(JSON.stringify({ error: "token inválido" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const tenantId = subscriber.tenant_id;
    const now = new Date().toISOString();

    // MULTI-TENANT: update já filtrado por tenant_id (defesa em profundidade)
    await supabase
      .from("email_subscribers")
      .update({ status: "unsubscribed", unsubscribed_at: now })
      .eq("id", subscriber.id)
      .eq("tenant_id", tenantId);

    // Opcional: registra em email_unsubscribes (se tabela existir).
    // MULTI-TENANT: tenant_id explícito.
    try {
      await supabase.from("email_unsubscribes").insert({
        tenant_id: tenantId,
        email: subscriber.email,
        unsubscribed_at: now,
        source: "one_click",
      });
    } catch (_e) {
      // tabela opcional — ignora se não existir / colidir unique
    }

    return new Response(
      JSON.stringify({ success: true, email: subscriber.email }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
