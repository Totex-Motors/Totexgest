/**
 * stand-handoff — repassa o lead qualificado pela loja dona.
 *
 * Tool do agente do stand (action_type=edge_function, name=stand-handoff).
 * Chamada pelo agent-runner com body { arguments, user_id, session_id }.
 *
 * Lê o working_memory da sessão (carro, loja dona, destino, grupo do stand) e:
 *   1. manda o resumo no grupo do stand
 *   2. manda o resumo no WhatsApp da loja dona (número individual)
 *   3. cria o lead no pipeline do tenant da loja dona (insert cross-tenant)
 *   4. loga em ai_critical_decisions
 *
 * arguments esperados (preenchidos pelo agente):
 *   { resumo: string, score?: number, orcamento?: string, prazo?: string,
 *     forma_pagamento?: string }
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "../_shared/config.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function onlyDigits(s: string): string { return String(s || "").replace(/\D/g, ""); }

/** Mescla um patch no metadata do lead (preserva o resto do jsonb) + sales_score opcional. */
async function saveLeadMeta(
  supabase: any, leadId: string, metaPatch: Record<string, unknown>, salesScore: number | null,
): Promise<void> {
  try {
    const { data: l } = await supabase.from("leads").select("metadata").eq("id", leadId).maybeSingle();
    const md = (l?.metadata && typeof l.metadata === "object") ? { ...l.metadata, ...metaPatch } : { ...metaPatch };
    const update: Record<string, unknown> = { metadata: md };
    if (typeof salesScore === "number") update.sales_score = salesScore;
    const { error } = await supabase.from("leads").update(update).eq("id", leadId);
    if (error) console.error("[stand-handoff] saveLeadMeta err:", error.message);
  } catch (e) { console.error("[stand-handoff] saveLeadMeta err:", (e as Error).message); }
}

/** Busca o veículo no marketplace e monta o metadata.vehicle (formato do VehicleOfInterestCard). */
async function fetchVehicleMeta(
  supabase: any, vehicleId: string,
): Promise<{ vehicle: Record<string, unknown>; storeName: string | null } | null> {
  try {
    const cfgUrl = await getIntegrationKey(supabase, "TOTEX_MARKETPLACE_API_URL");
    const base = (cfgUrl || "https://totexmotors.com").replace(/\/$/, "");
    const res = await fetch(`${base}/api/vehicles/${vehicleId}`, { headers: { Accept: "application/json" } });
    if (!res.ok) { console.error(`[stand-handoff] fetchVehicle ${res.status}`); return null; }
    const v = await res.json();
    const price = Number(v.price);
    const vehicle = {
      id: v.id ?? vehicleId,
      description: [v.brand, v.model, v.version].filter(Boolean).join(" ") || null,
      brand: v.brand ?? null,
      model: v.model ?? null,
      version: v.version ?? null,
      year: v.year ?? null,
      mileage: Number.isFinite(Number(v.mileage)) ? Number(v.mileage) : null,
      price: Number.isFinite(price) ? price : null,
      price_formatted: Number.isFinite(price) && price > 0
        ? price.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 })
        : null,
    };
    return { vehicle, storeName: v.dealership?.name ?? null };
  } catch (e) { console.error("[stand-handoff] fetchVehicleMeta err:", (e as Error).message); return null; }
}

/** Extrai um ano (19xx/20xx) do texto livre e separa o resto como modelo. */
function parseTradeInText(raw: string): { modelo: string | null; ano: number | null } {
  const text = String(raw || "").trim();
  if (!text) return { modelo: null, ano: null };
  const m = text.match(/\b(19|20)\d{2}\b/);
  const ano = m ? parseInt(m[0], 10) : null;
  const modelo = (m ? text.replace(m[0], "") : text).replace(/\s{2,}/g, " ").trim();
  return { modelo: modelo || text, ano };
}

/**
 * Grava/atualiza o veículo de troca DECLARADO pelo cliente na trade_in_vehicles (alimenta o
 * card "Veículo na Troca"). Só o que o cliente menciona — km/condição/valores ficam pra loja
 * avaliar. Upsert por lead (atualiza o mais recente; senão insere). tenant_id explícito (RLS).
 */
async function upsertTradeIn(
  supabase: any, tenantId: string, leadId: string, trocaText: string,
): Promise<void> {
  const { modelo, ano } = parseTradeInText(trocaText);
  if (!modelo && !ano) return;
  const fields = {
    modelo, ano,
    observacoes: `Informado pelo cliente via agente do stand: "${trocaText}". Avaliar km/condição/valores na loja.`,
  };
  try {
    const { data: existing } = await supabase
      .from("trade_in_vehicles").select("id")
      .eq("lead_id", leadId).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (existing) {
      await supabase.from("trade_in_vehicles")
        .update({ ...fields, updated_at: new Date().toISOString() }).eq("id", existing.id);
    } else {
      await supabase.from("trade_in_vehicles").insert({ tenant_id: tenantId, lead_id: leadId, ...fields });
    }
  } catch (e) { console.error("[stand-handoff] upsertTradeIn err:", (e as Error).message); }
}

async function sendUazapi(apiUrl: string, apiKey: string, target: string, text: string): Promise<boolean> {
  const base = (apiUrl || "").replace(/\/$/, "");
  if (!base) { console.error("[stand-handoff] api_url vazio"); return false; }
  try {
    const res = await fetch(`${base}/send/text`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "token": apiKey || "" },
      body: JSON.stringify({ number: target, text }),
    });
    return res.ok;
  } catch (e) { console.error("[stand-handoff] sendUazapi err:", (e as Error).message); return false; }
}

/**
 * Casa o nome de loja citado pelo cliente contra as lojas com destino cadastrado
 * (tenant_lead_destinations). Usa Claude pra tolerar variações ("Quest", "loja Quest
 * Motors"). Retorna null se não houver match claro.
 */
async function matchLojaByName(
  supabase: any, standTenantId: string, lojaCitada: string,
): Promise<{ tenant_id: string; name: string; target: string } | null> {
  const { data: dests } = await supabase
    .from("tenant_lead_destinations")
    .select("tenant_id, whatsapp_target, label")
    .eq("active", true);
  if (!dests || dests.length === 0) return null;

  const { data: tenants } = await supabase.from("tenants").select("id, name");
  const tenantName: Record<string, string> = {};
  for (const t of tenants ?? []) tenantName[t.id] = t.name;
  const candidates = dests.map((d: any) => ({
    tenant_id: d.tenant_id,
    name: tenantName[d.tenant_id] || d.label || "(sem nome)",
    target: d.whatsapp_target,
  }));

  // Match direto por substring antes de gastar uma chamada de IA.
  const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  const lc = norm(lojaCitada);
  const direct = candidates.find((c: any) => lc && (norm(c.name).includes(lc) || lc.includes(norm(c.name))));
  if (direct) return direct;

  const ANTHROPIC_API_KEY = await getIntegrationKey(supabase, "ANTHROPIC_API_KEY", standTenantId);
  if (!ANTHROPIC_API_KEY) return null;

  const list = candidates.map((c: any, i: number) => `${i + 1}. ${c.name} (tenant_id: ${c.tenant_id})`).join("\n");
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 256,
        messages: [{
          role: "user",
          content: `Loja citada pelo cliente: "${lojaCitada}".\n\nLOJAS CADASTRADAS:\n${list}\n\nRetorne APENAS um JSON: {"matched_tenant_id": "<tenant_id da lista ou null>"}. Só preencha se houver correspondência clara. Não invente.`,
        }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const txt = data.content?.[0]?.text || "";
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    const tid = parsed.matched_tenant_id;
    return tid ? candidates.find((c: any) => c.tenant_id === tid) || null : null;
  } catch (e) {
    console.error("[stand-handoff] matchLojaByName err:", (e as Error).message);
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    const body = await req.json();
    const args = (body.arguments || {}) as Record<string, unknown>;
    const sessionId = body.session_id as string | undefined;
    if (!sessionId) return json({ error: "session_id obrigatório" }, 400);

    // 1. Sessão + working_memory + provider_state
    const { data: session } = await supabase
      .from("agents_sessions")
      .select("id, tenant_id, agent_id, working_memory, provider_state")
      .eq("id", sessionId)
      .maybeSingle();
    if (!session) return json({ error: "sessão não encontrada" }, 404);

    const wm = (session.working_memory || {}) as Record<string, any>;
    const ps = (session.provider_state || {}) as Record<string, any>;

    // Fluxo A (stand-intake): wm vem pré-preenchido (nome/carro/loja dona).
    // Fluxo B (cliente inicia direto): wm vazio → usa os argumentos da tool + a sessão.
    const customerName = wm.customer_name || String(args.nome_cliente || "").trim() || "Lead do Stand";
    const customerPhone = onlyDigits(wm.customer_phone || ps.whatsapp_phone || "");
    const carInterest = wm.car_interest || String(args.carro || "").trim() || null;
    const standGroupJid = wm.stand_group_jid || null;
    const standInstanceId = wm.stand_instance_id || ps.whatsapp_instance_id || null;

    const resumo = String(args.resumo || "").trim();

    // Classificação por intenção de compra (vinda do agente).
    const categoria = String(args.categoria || "").trim() || null;
    let temperatura = String(args.temperatura || "").trim() || null;
    // Deriva a temperatura da categoria se o agente não mandar.
    if (!temperatura && categoria) {
      const map: Record<string, string> = {
        curioso: "frio", sonhador: "frio", pesquisador: "morno",
        comprador_planejado: "quente", comprador_ativo: "muito_quente", comprador_oculto: "quente",
      };
      temperatura = map[categoria] || null;
    }
    const probabilidade = typeof args.probabilidade === "number" ? args.probabilidade
      : (typeof args.score === "number" ? args.score : null);
    const score = probabilidade;

    const qualificacao = {
      categoria,
      temperatura,
      probabilidade,
      prazo_compra: String(args.prazo_compra || "").trim() || null,
      orcamento: String(args.orcamento || "").trim() || null,
      forma_pagamento: String(args.forma_pagamento || "").trim() || null,
      tem_troca: typeof args.tem_troca === "boolean" ? args.tem_troca : null,
      interesse_financiamento: !!args.interesse_financiamento,
      interesse_proposta: !!args.interesse_proposta,
      interesse_test_drive: !!args.interesse_test_drive,
      interesse_visita: !!args.interesse_visita,
      observacoes: resumo || null,
      qualificado_em: new Date().toISOString(),
      origem: "agente-stand",
    };

    // Veículo de troca declarado pelo cliente (texto livre, ex: "Honda Civic 2016").
    const trocaVeiculo = String(args.troca_veiculo || "").trim();

    // Regra de encaminhamento: Morno/Quente/Muito Quente vão pro CRM da loja.
    // Só os Frios (curioso/sonhador) ficam de fora — registrados pra nutrição/descarte.
    const shouldForward = temperatura === "morno" || temperatura === "quente" || temperatura === "muito_quente";

    // Veículo de interesse escolhido (busca no marketplace pelo vehicle_id, se houver).
    const vehicleId = String(args.vehicle_id || "").trim();
    const vehMeta = vehicleId ? await fetchVehicleMeta(supabase, vehicleId) : null;

    // Patch de metadata gravado nos leads (qualificação + veículo de interesse).
    const metaPatch: Record<string, unknown> = { qualificacao };
    if (vehMeta) {
      metaPatch.vehicle = vehMeta.vehicle;
      if (vehMeta.storeName) metaPatch.marketplace_store_name = vehMeta.storeName;
    }

    // Loja dona: pré-casada pelo intake (wm) OU casada agora pela loja que o cliente citou.
    let ownerTenantId: string | null = wm.owner_tenant_id || null;
    let ownerDestination = onlyDigits(wm.owner_destination || "");
    let ownerLabel: string | null = wm.owner_label || null;
    const lojaCitada = String(args.loja || "").trim();
    if (!ownerTenantId && lojaCitada) {
      const matched = await matchLojaByName(supabase, session.tenant_id, lojaCitada);
      if (matched) {
        ownerTenantId = matched.tenant_id;
        ownerLabel = matched.name;
      } else {
        ownerLabel = ownerLabel || lojaCitada; // cita no resumo mesmo sem destino cadastrado
      }
    }

    // Registra no metadata qual loja recebeu o repasse (alimenta a coluna "Loja" do Totem Físico).
    // encaminhado = vai virar lead no CRM da loja (quente/muito_quente E loja casada).
    if (shouldForward) {
      metaPatch.handoff = {
        encaminhado: !!(ownerTenantId && customerPhone),
        loja: ownerLabel || lojaCitada || null,
        em: new Date().toISOString(),
      };
    }

    // 2. Instância do stand (host + token p/ enviar)
    let apiUrl = "", apiKey = "";
    if (standInstanceId) {
      const { data: inst } = await supabase
        .from("whatsapp_instances").select("api_url, api_key").eq("id", standInstanceId).maybeSingle();
      apiUrl = inst?.api_url || ""; apiKey = inst?.api_key || "";
    }

    // 3. Monta o resumo formatado
    const tempLabel: Record<string, string> = { frio: "Frio", morno: "Morno", quente: "Quente", muito_quente: "Muito Quente" };
    const detalhes = [
      `👤 *${customerName}*`,
      customerPhone ? `📱 ${customerPhone}` : null,
      carInterest ? `🚗 ${carInterest}` : null,
      temperatura ? `🌡️ ${tempLabel[temperatura] || temperatura}${categoria ? ` (${categoria.replace(/_/g, " ")})` : ""}` : null,
      qualificacao.orcamento ? `💰 Orçamento: ${qualificacao.orcamento}` : null,
      qualificacao.prazo_compra ? `📅 Prazo: ${qualificacao.prazo_compra.replace(/_/g, " ")}` : null,
      qualificacao.forma_pagamento ? `💳 Pagamento: ${qualificacao.forma_pagamento}` : null,
      probabilidade !== null ? `📊 Probabilidade: ${probabilidade}%` : null,
    ].filter(Boolean).join("\n");
    const summaryText = `${detalhes}\n\n📝 ${resumo || "Lead qualificado pelo agente do stand."}`;

    const result: Record<string, unknown> = {
      sent_to_group: false, lead_created: false, encaminhado: shouldForward,
      categoria, temperatura,
    };

    // 3b. Grava a qualificação no lead DO STAND (sempre — mesmo sem encaminhar).
    //  Flow A: wm.lead_id. Flow B (cliente inicia): acha por telefone no tenant do stand.
    let standLeadId: string | null = wm.lead_id || null;
    if (!standLeadId && customerPhone) {
      const { data: sl } = await supabase
        .from("leads").select("id")
        .eq("tenant_id", session.tenant_id).eq("phone", customerPhone)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      standLeadId = sl?.id || null;
    }
    if (standLeadId) {
      await saveLeadMeta(supabase, standLeadId, metaPatch, score);
      // Veículo de troca → card "Veículo na Troca" do lead do stand.
      if (trocaVeiculo) await upsertTradeIn(supabase, session.tenant_id, standLeadId, trocaVeiculo);
    }

    // 4. Resumo no grupo do stand (canal interno; só no fluxo com grupo configurado)
    if (standGroupJid && apiUrl) {
      const header = shouldForward
        ? `✅ *Lead qualificado — repassado${ownerLabel ? ` p/ ${ownerLabel}` : ""}*`
        : `🌱 *Lead qualificado — em nutrição (${tempLabel[temperatura || ""] || "frio"}), não repassado*`;
      result.sent_to_group = await sendUazapi(apiUrl, apiKey, standGroupJid, `${header}\n\n${summaryText}`);
    }

    // 5. (removido) Não avisamos a loja por WhatsApp — o lead chega direto no CRM dela (passo 6).

    // 6. Cria lead no CRM da loja dona — SÓ se o lead estiver Quente/Muito Quente.
    let ownerLeadId: string | null = null;
    if (shouldForward && ownerTenantId && customerPhone) {
      // dedup por telefone dentro do tenant da loja
      const { data: dup } = await supabase
        .from("leads").select("id, metadata")
        .eq("tenant_id", ownerTenantId).eq("phone", customerPhone)
        .limit(1).maybeSingle();
      if (dup) {
        ownerLeadId = dup.id;
        await saveLeadMeta(supabase, ownerLeadId, metaPatch, score);
      } else {
        const { data: newLead, error: leadErr } = await supabase
          .from("leads")
          .insert({
            tenant_id: ownerTenantId,
            name: customerName,
            phone: customerPhone,
            sales_stage: "new",
            sales_score: score ?? 0,
            utm_source: "stand_totex",
            context: `Lead do stand Totex. ${carInterest ? `Interesse: ${carInterest}. ` : ""}${resumo}`,
            metadata: metaPatch,
          })
          .select("id")
          .single();
        if (leadErr) console.error("[stand-handoff] owner lead insert err:", leadErr.message);
        ownerLeadId = newLead?.id || null;
      }
      result.lead_created = !!ownerLeadId;
      result.owner_lead_id = ownerLeadId;
      // Veículo de troca tb no lead da loja (CRM dela vê o card preenchido).
      if (ownerLeadId && trocaVeiculo) await upsertTradeIn(supabase, ownerTenantId, ownerLeadId, trocaVeiculo);
    }

    // 7. Log de decisão crítica
    const decisionText = shouldForward
      ? (ownerLeadId ? `Repassado p/ ${ownerLabel || "loja"}` : `Quente, mas loja não casada (${ownerLabel || lojaCitada || "?"})`)
      : `Não repassado — ${tempLabel[temperatura || ""] || "frio"} (nutrição)`;
    await supabase.from("ai_critical_decisions").insert({
      tenant_id: session.tenant_id,
      lead_id: standLeadId,
      agent_id: session.agent_id,
      decision_type: "stand_handoff",
      decision: decisionText,
      reason: resumo || null,
      severity: shouldForward ? "high" : "low",
      snapshot_data: { ...result, owner_tenant_id: ownerTenantId, car_interest: carInterest, qualificacao },
    });

    // Mensagem de retorno pro agente (ele NÃO deve repetir isso literalmente ao cliente).
    let message: string;
    if (!shouldForward) {
      message = `Lead classificado como ${categoria || "—"} (${tempLabel[temperatura || ""] || "frio"}). Não encaminhado à loja (perfil de nutrição). Qualificação registrada.`;
    } else if (ownerLeadId) {
      message = `Lead quente encaminhado para ${ownerLabel}. Qualificação registrada.`;
    } else {
      message = `Lead quente, mas não encontrei a loja "${lojaCitada || ownerLabel || ""}" cadastrada. Qualificação registrada no stand; repasse manual necessário.`;
    }
    return json({ success: true, ...result, message });
  } catch (err) {
    console.error("[stand-handoff] error:", (err as Error).message);
    return json({ error: (err as Error).message }, 500);
  }
});
