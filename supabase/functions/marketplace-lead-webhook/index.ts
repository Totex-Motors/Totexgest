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

    // PONTE 1 — Negócio captado no marketplace (stand, marketing, site) → lead no tenant
    // do STAND ("porta única": o agente de IA qualifica e só depois repassa à loja dona).
    if (evento === "NEGOCIO_CAPTADO") {
      return await handleNegocioCaptado(supabase, body);
    }

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

// ─── PONTE 1: NEGOCIO_CAPTADO ────────────────────────────────────────────────
//
// Contrato (enviado pelo marketplace em POST /api/deals/intake → TotexgestBridgeService):
// {
//   evento: "NEGOCIO_CAPTADO", dealId, timestamp,
//   negocio: { origem, canal, tipo, intencao, etapa, revisaoHumana, campanha, observacoes },
//   unidade: { id, slug, nome },
//   cliente: { nome, telefone, email, papel: VENDEDOR|COMPRADOR|LOJISTA, consentimento },
//   veiculo: { id, marca, modelo, versao, ano, quilometragem, preco, precoFormatado, placa, propriedade } | null,
//   loja:    { id, nome } | null   // loja dona do carro de interesse (p/ handoff)
// }
//
// Regras:
//   • Idempotente por dealId (metadata.totex_deal_id).
//   • Dedup por telefone no tenant do Stand (janela 90 dias): mescla no lead existente.
//   • Vai SEMPRE pro tenant do Stand (config.stand_agent_config.stand_tenant_id →
//     fallback tenants.is_super_admin). A loja dona fica em metadata.owner_tenant_id.
//   • Abertura no WhatsApp (template Cloud) só se config.stand_agent_config.marketplace_auto_open = true.

const DEDUP_WINDOW_DAYS = 90;

interface StandCfg {
  enabled?: boolean;
  stand_tenant_id?: string | null;
  stand_agent_slug?: string | null;
  stand_template_name?: string | null;
  /** Ponte 1: abrir conversa automaticamente ao receber negócio do marketplace (default false). */
  marketplace_auto_open?: boolean;
}

function normalizePhone(raw: unknown): string {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (d && !d.startsWith("55") && d.length <= 11) d = "55" + d;
  return d;
}

const ORIGEM_LABEL: Record<string, string> = {
  ESTOQUE_LOJA: "estoque da loja",
  INTERMEDIACAO_TOTEX: "intermediação Totex",
  REPASSE_REDE: "repasse da rede",
};
const CANAL_LABEL: Record<string, string> = {
  STAND_SHOPPING: "stand no shopping",
  MARKETING: "marketing",
  SITE_MARKETPLACE: "site",
  INDICACAO: "indicação",
  LOJISTA_PARCEIRO: "lojista parceiro",
  PROSPECCAO_FRANQUEADO: "prospecção da unidade",
};

// deno-lint-ignore no-explicit-any
async function handleNegocioCaptado(supabase: any, body: any): Promise<Response> {
  const { dealId, negocio, unidade, cliente, veiculo, loja } = body ?? {};
  if (!dealId || !negocio || !cliente?.nome || !cliente?.telefone) {
    return json({ ok: false, error: "Payload NEGOCIO_CAPTADO incompleto (dealId, negocio, cliente)" }, 400);
  }

  // 1. Config do stand → tenant da porta única
  const { data: cfgRow } = await supabase.from("config").select("value").eq("key", "stand_agent_config").maybeSingle();
  let cfg: StandCfg = {};
  try { cfg = JSON.parse(cfgRow?.value ?? "{}"); } catch { /* vazio */ }

  let standTenantId: string | null = cfg.stand_tenant_id || null;
  if (!standTenantId) {
    const { data: superAdmin } = await supabase
      .from("tenants").select("id").eq("is_super_admin", true).limit(1).maybeSingle();
    standTenantId = superAdmin?.id ?? null;
  }
  if (!standTenantId) {
    console.error("[marketplace-lead-webhook] NEGOCIO_CAPTADO sem tenant do Stand (config.stand_agent_config.stand_tenant_id)");
    return json({ ok: false, error: "Tenant do Stand não configurado no CRM" }, 422);
  }

  // 2. Idempotência por dealId
  const { data: existingByDeal } = await supabase
    .from("leads").select("id, tenant_id")
    .eq("metadata->>totex_deal_id", String(dealId)).maybeSingle();
  if (existingByDeal) {
    return json({ ok: true, duplicate: true, lead_id: existingByDeal.id, tenant_id: existingByDeal.tenant_id });
  }

  const phone = normalizePhone(cliente.telefone);
  const canal = String(negocio.canal ?? "");
  const vehicleDesc = veiculo
    ? [veiculo.marca, veiculo.modelo, veiculo.versao, veiculo.ano].filter(Boolean).join(" ")
    : null;

  // 3. Loja dona do carro de interesse → tenant (p/ handoff futuro), se mapeada
  let ownerTenantId: string | null = null;
  let ownerStoreName: string | null = loja?.nome ?? null;
  if (loja?.id) {
    const { data: mapping } = await supabase
      .from("marketplace_store_mappings").select("tenant_id, store_name")
      .eq("marketplace_store_id", String(loja.id)).eq("active", true).maybeSingle();
    if (mapping) { ownerTenantId = mapping.tenant_id; ownerStoreName = mapping.store_name ?? ownerStoreName; }
  }

  const vehicleMeta = veiculo
    ? {
        id: veiculo.id ?? null,
        description: vehicleDesc || null,
        brand: veiculo.marca ?? null,
        model: veiculo.modelo ?? null,
        version: veiculo.versao ?? null,
        year: veiculo.ano ?? null,
        mileage: veiculo.quilometragem ?? null,
        price: veiculo.preco ?? null,
        price_formatted: veiculo.precoFormatado ?? null,
        plate: veiculo.placa ?? null,
        ownership: veiculo.propriedade ?? null,
      }
    : null;

  const totexMeta = {
    totex_deal_id: String(dealId),
    totex_origin: negocio.origem ?? null,
    totex_channel: canal || null,
    totex_kind: negocio.tipo ?? null,
    totex_intent: negocio.intencao ?? null,
    totex_stage: negocio.etapa ?? null,
    totex_needs_human: negocio.revisaoHumana === true,
    totex_campaign: negocio.campanha ?? null,
    totex_unit: unidade ? { id: unidade.id, slug: unidade.slug, name: unidade.nome } : null,
    totex_party_role: cliente.papel ?? null,
    marketplace_origin: "NEGOCIO_CAPTADO",
    marketplace_store_id: loja?.id ? String(loja.id) : null,
    marketplace_store_name: ownerStoreName,
    owner_tenant_id: ownerTenantId,
    vehicle: vehicleMeta,
    store: loja ? { name: ownerStoreName } : null,
  };

  // 4. Dedup por telefone no tenant do Stand (janela recente) → mescla
  if (phone) {
    const since = new Date(Date.now() - DEDUP_WINDOW_DAYS * 86400000).toISOString();
    const { data: existingByPhone } = await supabase
      .from("leads").select("id, metadata")
      .eq("tenant_id", standTenantId).eq("phone", phone).gte("created_at", since)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (existingByPhone) {
      const md = (existingByPhone.metadata && typeof existingByPhone.metadata === "object") ? existingByPhone.metadata : {};
      const deals: string[] = Array.isArray(md.totex_deals) ? md.totex_deals : (md.totex_deal_id ? [md.totex_deal_id] : []);
      if (!deals.includes(String(dealId))) deals.push(String(dealId));
      const merged = {
        ...md,
        ...totexMeta,
        // preserva o veículo já vinculado se o novo intake não trouxe carro
        vehicle: vehicleMeta ?? md.vehicle ?? null,
        totex_deals: deals,
      };
      const { error: upErr } = await supabase
        .from("leads")
        .update({ metadata: merged, last_interaction_at: new Date().toISOString() })
        .eq("id", existingByPhone.id);
      if (upErr) console.error("[marketplace-lead-webhook] merge err:", upErr.message);
      console.log(`[marketplace-lead-webhook] NEGOCIO_CAPTADO ${dealId} mesclado no lead ${existingByPhone.id} (mesmo telefone)`);
      return json({ ok: true, duplicate: true, merged: true, lead_id: existingByPhone.id, tenant_id: standTenantId });
    }
  }

  // 5. Cria o lead no tenant do STAND (porta única)
  const papel = cliente.papel === "COMPRADOR" ? "quer comprar" : cliente.papel === "LOJISTA" ? "lojista" : "quer vender";
  const contextNote = [
    `Negócio captado pela Totex (${CANAL_LABEL[canal] ?? (canal || "canal não informado")}) — cliente ${papel}.`,
    negocio.origem ? `Origem: ${ORIGEM_LABEL[negocio.origem] ?? negocio.origem}.` : null,
    vehicleDesc ? `Veículo: ${vehicleDesc}${veiculo?.precoFormatado ? ` (${veiculo.precoFormatado})` : ""}.` : null,
    ownerStoreName ? `Loja dona: ${ownerStoreName}.` : null,
    negocio.observacoes ? `Obs.: ${negocio.observacoes}` : null,
  ].filter(Boolean).join(" ");

  const { data: newLead, error: insertError } = await supabase
    .from("leads")
    .insert({
      tenant_id: standTenantId,
      name: cliente.nome,
      email: cliente.email || null,
      phone: phone || null,
      source: "marketplace",
      utm_source: canal ? canal.toLowerCase() : "marketplace",
      utm_campaign: negocio.campanha ?? null,
      status: "new",
      sales_stage: "new",
      context: contextNote,
      metadata: totexMeta,
    })
    .select("id")
    .single();

  if (insertError) {
    console.error("[marketplace-lead-webhook] NEGOCIO_CAPTADO insert err:", insertError);
    throw insertError;
  }

  // 6. Abertura automática no WhatsApp oficial (opt-in explícito na config do stand)
  let sessionId: string | null = null;
  let openingSent = false;
  if (cfg.enabled && cfg.marketplace_auto_open === true && cfg.stand_agent_slug && phone) {
    try {
      const { data: agent } = await supabase
        .from("agents_registry").select("id")
        .eq("tenant_id", standTenantId).eq("slug", cfg.stand_agent_slug).maybeSingle();
      if (agent) {
        const sessionKey = `whatsapp:${phone}`;
        const workingMemory = {
          source: "marketplace",
          totex_deal_id: String(dealId),
          customer_name: cliente.nome,
          customer_phone: phone,
          car_interest: vehicleDesc,
          intent: negocio.intencao ?? null,
          owner_tenant_id: ownerTenantId,
          owner_label: ownerStoreName,
          lead_id: newLead.id,
        };
        const { data: existingSession } = await supabase
          .from("agents_sessions").select("id")
          .eq("agent_id", agent.id).eq("channel", "whatsapp")
          .contains("provider_state", { external_session_key: sessionKey })
          .order("created_at", { ascending: false }).limit(1).maybeSingle();
        if (existingSession) {
          sessionId = existingSession.id;
          await supabase.from("agents_sessions")
            .update({ working_memory: workingMemory, updated_at: new Date().toISOString() })
            .eq("id", sessionId);
        } else {
          const { data: ns } = await supabase
            .from("agents_sessions").insert({
              tenant_id: standTenantId,
              agent_id: agent.id,
              channel: "whatsapp",
              title: `Marketplace — ${cliente.nome}`,
              working_memory: workingMemory,
              provider_state: { external_session_key: sessionKey, whatsapp_phone: phone },
            }).select("id").single();
          sessionId = ns?.id ?? null;
        }
        if (sessionId) {
          const res = await fetch(`${SUPABASE_URL}/functions/v1/send-whatsapp-cloud`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              "apikey": SUPABASE_SERVICE_ROLE_KEY,
            },
            body: JSON.stringify({
              action: "send_template",
              phone,
              tenant_id: standTenantId,
              lead_id: newLead.id,
              template_name: cfg.stand_template_name || "primeiro_contato_qualificacao",
              template_params: [cliente.nome],
              sent_by: "marketplace_intake",
            }),
          });
          openingSent = res.ok;
          if (!res.ok) console.error(`[marketplace-lead-webhook] abertura Cloud falhou ${res.status}`);
        }
      }
    } catch (e) {
      console.error("[marketplace-lead-webhook] auto_open err:", (e as Error).message);
    }
  }

  console.log(`[marketplace-lead-webhook] NEGOCIO_CAPTADO ${dealId} → lead ${newLead.id} no tenant do Stand${openingSent ? " (abertura enviada)" : ""}`);
  return json({ ok: true, lead_id: newLead.id, tenant_id: standTenantId, session_id: sessionId, opening_sent: openingSent });
}
