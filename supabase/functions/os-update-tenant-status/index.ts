// Edge Function do TotexMotors OS que notifica o CRM quando um lojista muda de status.
// Deploy no projeto OS (fbgtqiqovwxccinbzvmx).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRM_API_URL = Deno.env.get("CRM_API_URL") ?? "https://mztfyavuclqzivywkaeu.supabase.co/functions/v1";
const CRM_WEBHOOK_SECRET = Deno.env.get("CRM_WEBHOOK_SECRET")!;

const SUSPENDED_STATUSES = new Set(["suspended", "cancelled", "overdue"]);
const ACTIVE_STATUSES     = new Set(["active_shopping", "active_marketplace"]);

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });

  const supa = createClient(SUPABASE_URL, SERVICE_ROLE);

  try {
    const { dealership_id, new_status } = await req.json();
    if (!dealership_id || !new_status) {
      return json({ error: "dealership_id e new_status são obrigatórios" }, 400);
    }

    let action: string | null = null;
    if (SUSPENDED_STATUSES.has(new_status)) action = new_status === "cancelled" ? "cancel" : "suspend";
    if (ACTIVE_STATUSES.has(new_status))    action = "reactivate";

    if (!action) {
      // Status intermediário (onboarding, etc.) — sem ação no CRM
      return json({ ok: true, skipped: `status_sem_acao:${new_status}` });
    }

    const res = await fetch(`${CRM_API_URL}/update-tenant`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-integration-secret": CRM_WEBHOOK_SECRET,
      },
      body: JSON.stringify({ external_dealership_id: dealership_id, action }),
    });

    const body = await res.json();

    if (!res.ok && res.status !== 404) {
      throw new Error(`CRM retornou ${res.status}: ${JSON.stringify(body)}`);
    }

    await supa.from("agent_logs").insert({
      agent_name:    "onboarding",
      dealership_id,
      action:        `Tenant CRM atualizado: ${action}`,
      result:        res.status === 404 ? "tenant_not_found_in_crm" : "ok",
      metadata:      { new_status, action, crm_response: body },
    });

    console.log(`[os-update-tenant-status] dealership=${dealership_id} action=${action} crm_status=${res.status}`);
    return json({ ok: true, action, crm_status: res.status });
  } catch (err) {
    console.error("[os-update-tenant-status] Erro:", err);
    return json({ error: String(err) }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
