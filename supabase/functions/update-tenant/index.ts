import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INCOMING_OS_SECRET = Deno.env.get("INCOMING_OS_SECRET")!;

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (req.headers.get("x-integration-secret") !== INCOMING_OS_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { external_dealership_id, action } = await req.json();

    if (!external_dealership_id || !action) {
      return json({ error: "external_dealership_id e action são obrigatórios" }, 400);
    }

    if (!["suspend", "cancel", "reactivate"].includes(action)) {
      return json({ error: `action inválida: ${action}` }, 400);
    }

    const { data: tenant, error: findErr } = await supabase
      .from("tenants")
      .select("id, name, is_active")
      .eq("external_dealership_id", external_dealership_id)
      .maybeSingle();

    if (findErr) throw findErr;
    if (!tenant) {
      return json({ error: `Tenant não encontrado para dealership ${external_dealership_id}` }, 404);
    }

    const isActive = action === "reactivate";

    const { error: updateErr } = await supabase
      .from("tenants")
      .update({ is_active: isActive, updated_at: new Date().toISOString() })
      .eq("id", tenant.id);

    if (updateErr) throw updateErr;

    console.log(`[update-tenant] Tenant ${tenant.id} (${tenant.name}): action=${action}`);
    return json({ ok: true, tenant_id: tenant.id, action, is_active: isActive });
  } catch (err) {
    console.error("[update-tenant] Erro:", err);
    return json({ error: String(err) }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
