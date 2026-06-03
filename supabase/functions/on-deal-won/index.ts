import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OS_API_URL = Deno.env.get("OS_API_URL") ?? "https://fbgtqiqovwxccinbzvmx.supabase.co/functions/v1";
const OS_WEBHOOK_SECRET = Deno.env.get("OS_WEBHOOK_SECRET")!;

const BATCH_SIZE = 20;
const MAX_ATTEMPTS = 3;

serve(async (_req: Request) => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: events, error } = await supabase
    .from("os_sync_events")
    .select("*")
    .eq("event_type", "deal_won")
    .eq("status", "pending")
    .lt("attempts", MAX_ATTEMPTS)
    .order("created_at")
    .limit(BATCH_SIZE);

  if (error) {
    console.error("[on-deal-won] Erro ao buscar eventos:", error);
    return json({ error: String(error) }, 500);
  }

  if (!events || events.length === 0) {
    return json({ ok: true, processed: 0 });
  }

  let sent = 0;
  let failed = 0;

  for (const event of events) {
    const { deal_id, tenant_id, lead_id, title, negotiated_price, won_at } = event.payload;

    // Busca external_dealership_id do tenant
    const { data: tenant } = await supabase
      .from("tenants")
      .select("external_dealership_id, name")
      .eq("id", tenant_id)
      .maybeSingle();

    if (!tenant?.external_dealership_id) {
      // Tenant não vinculado ao OS — marca como ignorado
      await supabase
        .from("os_sync_events")
        .update({ status: "sent", processed_at: new Date().toISOString(), last_error: "tenant_not_linked_to_os" })
        .eq("id", event.id);
      continue;
    }

    try {
      const res = await fetch(`${OS_API_URL}/log-crm-event`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-integration-secret": OS_WEBHOOK_SECRET,
        },
        body: JSON.stringify({
          event: "deal_won",
          dealership_id: tenant.external_dealership_id,
          external_event_id: event.external_event_id,
          deal_id,
          lead_id,
          title,
          value: negotiated_price,
          commission_value: null,
          closed_at: won_at,
          tenant_name: tenant.name,
        }),
      });

      if (res.ok) {
        await supabase
          .from("os_sync_events")
          .update({ status: "sent", processed_at: new Date().toISOString(), last_error: null })
          .eq("id", event.id);
        sent++;
      } else {
        const body = await res.text();
        throw new Error(`OS retornou ${res.status}: ${body}`);
      }
    } catch (err) {
      const newAttempts = event.attempts + 1;
      await supabase
        .from("os_sync_events")
        .update({
          attempts: newAttempts,
          last_error: String(err),
          status: newAttempts >= MAX_ATTEMPTS ? "failed" : "pending",
        })
        .eq("id", event.id);
      console.error(`[on-deal-won] Falha no evento ${event.id}:`, err);
      failed++;
    }
  }

  console.log(`[on-deal-won] sent=${sent} failed=${failed} total=${events.length}`);
  return json({ ok: true, processed: events.length, sent, failed });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
