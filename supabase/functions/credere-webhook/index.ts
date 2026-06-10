import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// IPs fixos da Credere (documentação oficial)
const CREDERE_IPS = new Set([
  "50.19.187.113",
  "54.232.123.189",
  "18.213.164.35",
  "18.213.78.197",
]);

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  try {
    // Validação de IP (log de aviso, não bloqueia — Credere pode adicionar IPs sem avisar)
    const forwarded = req.headers.get("x-forwarded-for");
    const clientIp = forwarded?.split(",")[0].trim();
    if (clientIp && !CREDERE_IPS.has(clientIp)) {
      console.warn(`[credere-webhook] IP não reconhecido: ${clientIp}`);
    }

    const body = await req.json();
    const { event, simulation } = body;

    // Só processa simulações concluídas com sucesso
    if (event !== "processed_simulation") {
      return json({ ok: true, skipped: `event_ignored:${event}` });
    }

    if (!simulation?.success) {
      return json({ ok: true, skipped: "simulation_not_successful" });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const credereStoreId = String(simulation.store?.id ?? "");

    // Idempotência: evita duplicar lead do mesmo UUID de simulação
    const simUuid = simulation.uuid;
    if (simUuid) {
      const { data: existing } = await supabase
        .from("leads")
        .select("id")
        .eq("metadata->>credere_simulation_uuid", simUuid)
        .maybeSingle();

      if (existing) {
        return json({ ok: true, duplicate: true, lead_id: existing.id });
      }
    }

    // Resolve o tenant_id pelo mapeamento de loja
    const { data: mapping } = await supabase
      .from("credere_store_mappings")
      .select("tenant_id, store_name")
      .eq("credere_store_id", credereStoreId)
      .eq("active", true)
      .maybeSingle();

    if (!mapping) {
      console.warn(
        `[credere-webhook] Loja sem mapeamento: credere_store_id="${credereStoreId}". ` +
        `Configure em /comercial/credere > aba Lojas.`
      );
      return json({
        ok: false,
        error: `Loja "${credereStoreId}" não mapeada no CRM.`,
      });
    }

    // Monta payload do lead
    const lead = simulation.lead ?? {};
    const vehicle = simulation.vehicle ?? {};
    const vehicleModel = vehicle.vehicle_model ?? {};
    const store = simulation.store ?? {};
    const conditions: any[] = simulation.conditions ?? [];

    const vehicleDesc = [
      vehicleModel.brand,
      vehicleModel.model_name,
      vehicle.manufacture_year,
      vehicle.model_year && vehicle.model_year !== vehicle.manufacture_year
        ? `/${vehicle.model_year}`
        : null,
    ]
      .filter(Boolean)
      .join(" ");

    // Melhor condição de financiamento disponível
    const bestCondition = conditions.find((c) => c.success) ?? conditions[0] ?? null;

    const phone = typeof lead.phone_number === "string"
      ? lead.phone_number.replace(/\D/g, "")
      : null;

    const { data: newLead, error: insertError } = await supabase
      .from("leads")
      .insert({
        tenant_id: mapping.tenant_id,
        name: lead.name || "Lead Credere",
        email: lead.email || null,
        phone: phone || null,
        cpf_cnpj: lead.cpf_cnpj || null,
        document: lead.cpf_cnpj || null,
        city_name: lead.address?.city || null,
        state: lead.address?.state || null,
        postal_code: lead.address?.zip_code || null,
        address: lead.address?.street || null,
        source: "credere",
        status: "new",
        sales_stage: "new",
        context: vehicleDesc ? `Interesse em financiamento: ${vehicleDesc}` : null,
        metadata: {
          credere_simulation_uuid: simUuid,
          credere_store_id: credereStoreId,
          credere_store_name: store.name || mapping.store_name,
          vehicle: {
            description: vehicleDesc || null,
            // Credere envia valores monetários em centavos — converter para reais
            assets_value: simulation.assets_value != null ? simulation.assets_value / 100 : null,
            manufacture_year: vehicle.manufacture_year ?? null,
            model_year: vehicle.model_year ?? null,
            brand: vehicleModel.brand ?? null,
            model: vehicleModel.model_name ?? null,
            category: vehicleModel.category?.label ?? null,
            fuel: vehicleModel.fuel_type?.label ?? null,
            licensing_uf: vehicle.licensing_uf ?? null,
          },
          financing: bestCondition
            ? {
                bank: bestCondition.bank?.name ?? null,
                installments: bestCondition.installments ?? null,
                interest_monthly: bestCondition.interest_monthly ?? null,
                // Credere envia em centavos — converter para reais
                down_payment: bestCondition.down_payment != null ? bestCondition.down_payment / 100 : null,
                financed_amount: bestCondition.financed_amount != null ? bestCondition.financed_amount / 100 : null,
              }
            : null,
          seller: simulation.seller
            ? { name: simulation.seller.name, id: simulation.seller.id }
            : null,
          simulation_created_at: simulation.created_at ?? null,
        },
      })
      .select("id")
      .single();

    if (insertError) {
      console.error("[credere-webhook] Erro ao inserir lead:", insertError);
      throw insertError;
    }

    console.log(`[credere-webhook] Lead criado: ${newLead.id} (loja: ${mapping.store_name})`);
    return json({ ok: true, lead_id: newLead.id });
  } catch (err) {
    console.error("[credere-webhook] Erro interno:", err);
    return json({ ok: false, error: String(err) }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
