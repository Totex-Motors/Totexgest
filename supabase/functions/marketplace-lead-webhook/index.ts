import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "../_shared/config.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return json(null, 204);
  }

  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Valida Bearer token — configurado em /configuracoes > API Keys
    const secret = await getIntegrationKey(supabase, "MARKETPLACE_WEBHOOK_SECRET");
    if (!secret) {
      console.error("[marketplace-lead-webhook] MARKETPLACE_WEBHOOK_SECRET não configurado");
      return json({ ok: false, error: "Webhook não configurado" }, 500);
    }

    const authHeader = req.headers.get("authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (token !== secret) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }

    const body = await req.json();
    const { evento, origem, leadId, cliente, veiculo, loja } = body;

    if (evento !== "INTERESSE_VEICULO") {
      return json({ ok: true, skipped: `evento_ignorado:${evento}` });
    }

    if (!leadId || !cliente || !veiculo || !loja) {
      return json({ ok: false, error: "Payload incompleto" }, 400);
    }

    // Idempotência: evita duplicar lead com o mesmo leadId do marketplace
    const { data: existing } = await supabase
      .from("leads")
      .select("id")
      .eq("metadata->>marketplace_lead_id", leadId)
      .maybeSingle();

    if (existing) {
      return json({ ok: true, duplicate: true, lead_id: existing.id });
    }

    // Resolve tenant_id pelo ID da loja no marketplace
    const { data: mapping } = await supabase
      .from("marketplace_store_mappings")
      .select("tenant_id, store_name")
      .eq("marketplace_store_id", String(loja.id))
      .eq("active", true)
      .maybeSingle();

    if (!mapping) {
      console.warn(
        `[marketplace-lead-webhook] Loja sem mapeamento: marketplace_store_id="${loja.id}". ` +
        `Configure em /comercial/marketplace > aba Lojas.`
      );
      return json({
        ok: false,
        error: `Loja "${loja.id}" não mapeada no CRM.`,
      }, 422);
    }

    const phone = typeof cliente.telefone === "string"
      ? cliente.telefone.replace(/\D/g, "")
      : null;

    const vehicleDesc = [veiculo.marca, veiculo.modelo, veiculo.versao, veiculo.ano]
      .filter(Boolean)
      .join(" ");

    const { data: newLead, error: insertError } = await supabase
      .from("leads")
      .insert({
        tenant_id: mapping.tenant_id,
        name: cliente.nome || "Lead Marketplace",
        email: cliente.email || null,
        phone: phone || null,
        city_name: loja.cidade || null,
        state: loja.estado || null,
        source: "marketplace",
        status: "new",
        sales_stage: "new",
        context: cliente.mensagem || null,
        metadata: {
          marketplace_lead_id: leadId,
          marketplace_store_id: String(loja.id),
          marketplace_store_name: loja.nome || mapping.store_name,
          marketplace_origin: origem || "FORM_INTERESSE",
          vehicle: {
            id: veiculo.id || null,
            description: vehicleDesc || null,
            brand: veiculo.marca || null,
            model: veiculo.modelo || null,
            version: veiculo.versao || null,
            year: veiculo.ano || null,
            mileage: veiculo.quilometragem || null,
            price: veiculo.preco || null,
            price_formatted: veiculo.precoFormatado || null,
          },
          store: {
            name: loja.nome || null,
            email: loja.email || null,
            phone: loja.telefone || null,
            city: loja.cidade || null,
            state: loja.estado || null,
            address: loja.endereco || null,
          },
        },
      })
      .select("id")
      .single();

    if (insertError) {
      console.error("[marketplace-lead-webhook] Erro ao inserir lead:", insertError);
      throw insertError;
    }

    console.log(`[marketplace-lead-webhook] Lead criado: ${newLead.id} (loja: ${mapping.store_name})`);
    return json({ ok: true, lead_id: newLead.id });
  } catch (err) {
    console.error("[marketplace-lead-webhook] Erro interno:", err);
    return json({ ok: false, error: String(err) }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
