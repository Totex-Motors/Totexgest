// Edge Function do TotexMotors OS que lê dados do lojista e provisiona tenant no CRM.
// Deploy no projeto OS (fbgtqiqovwxccinbzvmx).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRM_API_URL = Deno.env.get("CRM_API_URL") ?? "https://mztfyavuclqzivywkaeu.supabase.co/functions/v1";
const CRM_WEBHOOK_SECRET = Deno.env.get("CRM_WEBHOOK_SECRET")!;

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });

  const supa = createClient(SUPABASE_URL, SERVICE_ROLE);

  try {
    const { dealership_id } = await req.json();
    if (!dealership_id) return json({ error: "dealership_id é obrigatório" }, 400);

    // Carrega dados completos do lojista
    const { data: dealer, error: dealerErr } = await supa
      .from("dealerships")
      .select(`
        id, trade_name, legal_name, cnpj, whatsapp, logo_url,
        dealership_services ( price, status, services ( name, kind ) ),
        dealership_contacts ( name, email, phone, contact_type, is_primary )
      `)
      .eq("id", dealership_id)
      .single();

    if (dealerErr || !dealer) return json({ error: "Lojista não encontrado" }, 404);

    // Monta plano
    const services = (dealer.dealership_services ?? []) as any[];
    const plan = {
      totem_30:    services.some((s) => s.services?.kind === "totem_30"    && s.status === "active"),
      totem_60:    services.some((s) => s.services?.kind === "totem_60"    && s.status === "active"),
      marketplace: services.some((s) => s.services?.kind === "marketplace" && s.status === "active"),
      credere:     services.some((s) => s.services?.kind === "credere"     && s.status === "active"),
    };

    // Contato primário do tipo "leads"
    const contacts = (dealer.dealership_contacts ?? []) as any[];
    const primaryContact = contacts.find((c) => c.is_primary && c.contact_type === "leads")
      ?? contacts.find((c) => c.is_primary)
      ?? contacts[0]
      ?? null;

    const crmPayload = {
      external_dealership_id: dealer.id,
      trade_name:  dealer.trade_name,
      legal_name:  dealer.legal_name,
      cnpj:        dealer.cnpj,
      whatsapp:    dealer.whatsapp,
      logo_url:    dealer.logo_url,
      plan,
      primary_contact: primaryContact ? {
        name:  primaryContact.name,
        email: primaryContact.email,
        phone: primaryContact.phone,
      } : null,
    };

    const res = await fetch(`${CRM_API_URL}/provision-tenant`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-integration-secret": CRM_WEBHOOK_SECRET,
      },
      body: JSON.stringify(crmPayload),
    });

    const body = await res.json();

    if (!res.ok && res.status !== 409) {
      throw new Error(`CRM retornou ${res.status}: ${JSON.stringify(body)}`);
    }

    // Guarda referência no OS
    await supa.from("crm_tenants").upsert(
      {
        dealership_id: dealer.id,
        crm_tenant_id: body.tenant_id,
        crm_user_id:   body.user_id ?? null,
        invite_url:    body.invite_url ?? null,
        is_active:     true,
        last_synced_at: new Date().toISOString(),
      },
      { onConflict: "dealership_id" }
    );

    await supa.from("agent_logs").insert({
      agent_name:    "onboarding",
      dealership_id: dealer.id,
      action:        res.status === 409 ? "Tenant CRM já existia" : "Tenant CRM provisionado",
      result:        `tenant_id=${body.tenant_id}`,
      metadata:      { invite_url: body.invite_url, conflict: body.conflict ?? false },
    });

    console.log(`[os-provision-tenant] OK dealership=${dealer.id} tenant=${body.tenant_id}`);
    return json({ ...body, conflict: body.conflict ?? false });
  } catch (err) {
    console.error("[os-provision-tenant] Erro:", err);
    return json({ error: String(err) }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
