// Edge Function do TotexMotors OS que recebe eventos do CRM e os processa
// (registra em financial_records, agent_logs, crm_events).
// Deploy no projeto OS (fbgtqiqovwxccinbzvmx).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INCOMING_CRM_SECRET = Deno.env.get("INCOMING_CRM_SECRET")!;

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (req.headers.get("x-integration-secret") !== INCOMING_CRM_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  const supa = createClient(SUPABASE_URL, SERVICE_ROLE);

  try {
    const payload = await req.json();
    const { event, dealership_id, external_event_id } = payload;

    if (!event || !dealership_id) {
      return json({ error: "event e dealership_id são obrigatórios" }, 400);
    }

    // Idempotência
    if (external_event_id) {
      const { data: existing } = await supa
        .from("crm_events")
        .select("id")
        .eq("external_event_id", external_event_id)
        .maybeSingle();

      if (existing) {
        return json({ ok: true, duplicate: true });
      }
    }

    // Registra evento
    await supa.from("crm_events").insert({
      event_type:        event,
      dealership_id,
      external_event_id: external_event_id ?? null,
      payload,
    });

    // Processa por tipo de evento
    if (event === "deal_won") {
      await handleDealWon(supa, payload, dealership_id);
    } else if (event === "lead_captured") {
      await handleLeadCaptured(supa, payload, dealership_id);
    } else if (event === "lead_sla_broken") {
      await handleLeadSlaBroken(supa, payload, dealership_id);
    }

    // Marca como processado
    await supa
      .from("crm_events")
      .update({ processed_at: new Date().toISOString() })
      .eq("external_event_id", external_event_id ?? "")
      .not("processed_at", "is", null);

    return json({ ok: true, event });
  } catch (err) {
    console.error("[os-log-crm-event] Erro:", err);
    return json({ error: String(err) }, 500);
  }
});

async function handleDealWon(supa: any, payload: any, dealershipId: string) {
  const { deal_id, title, value, commission_value, closed_at, tenant_name } = payload;

  await supa.from("financial_records").insert({
    dealership_id: dealershipId,
    type:          "revenue",
    category:      "Comissão CRM",
    description:   `Deal fechado: ${title ?? deal_id}${tenant_name ? ` — ${tenant_name}` : ""}`,
    amount:        commission_value ?? value ?? 0,
    due_date:      closed_at ? closed_at.split("T")[0] : new Date().toISOString().split("T")[0],
    reference_month: (closed_at ?? new Date().toISOString()).slice(0, 7),
    status:        "pending",
  });

  await supa.from("agent_logs").insert({
    agent_name:    "commercial",
    dealership_id: dealershipId,
    action:        "Deal fechado no CRM",
    result:        `R$ ${((commission_value ?? value ?? 0) / 100).toFixed(2)}`,
    metadata:      payload,
  });
}

async function handleLeadCaptured(supa: any, payload: any, dealershipId: string) {
  await supa.from("agent_logs").insert({
    agent_name:    "commercial",
    dealership_id: dealershipId,
    action:        "Lead capturado no CRM",
    result:        payload.source ?? "crm",
    metadata:      payload,
  });
}

async function handleLeadSlaBroken(supa: any, payload: any, dealershipId: string) {
  await supa.from("support_tickets").insert({
    dealership_id: dealershipId,
    title:         `Lead sem resposta > SLA — ${payload.lead_name ?? payload.lead_id}`,
    description:   `Lead parado há ${payload.hours_without_response}h sem resposta do vendedor.`,
    priority:      "high",
    status:        "open",
    assigned_agent: "commercial",
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
