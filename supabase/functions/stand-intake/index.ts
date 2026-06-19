/**
 * stand-intake — captura de lead do STAND via menção em grupo de WhatsApp.
 *
 * Disparado pelo whatsapp-webhook quando há menção num grupo. Self-check: só age
 * se a menção for num grupo configurado em config.stand_agent_config.
 *
 * Fluxo: extrai {nome, telefone, carro, loja} via Claude → casa a loja dona
 * (tenant_lead_destinations) → cria lead no tenant do STAND → cria agents_session
 * pro telefone do cliente (working_memory com carro/loja/destino) → manda 1ª DM
 * (via agent-runner, instância do stand) → confirma no grupo.
 *
 * NUNCA hardcode de tenant/instance/URL — tudo vem de config + whatsapp_instances.
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { requireIntegrationKey } from "../_shared/config.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

interface StandConfig {
  enabled?: boolean;
  stand_tenant_id?: string;
  stand_instance_id?: string;
  stand_group_jids?: string[];
  stand_agent_slug?: string;
  /** Nome do template aprovado na Meta p/ a abertura ao cliente (default primeiro_contato_qualificacao). */
  stand_template_name?: string;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function onlyDigits(s: string): string { return String(s || "").replace(/\D/g, ""); }

function normalizePhone(raw: string): string {
  let d = onlyDigits(raw);
  if (!d) return "";
  if (!d.startsWith("55") && d.length <= 11) d = "55" + d;
  return d;
}

async function sendUazapi(apiUrl: string, apiKey: string, number: string, text: string): Promise<void> {
  const base = (apiUrl || "").replace(/\/$/, "");
  if (!base) { console.error("[stand-intake] sendUazapi: api_url vazio"); return; }
  try {
    await fetch(`${base}/send/text`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "token": apiKey || "" },
      body: JSON.stringify({ number, text }),
    });
  } catch (e) { console.error("[stand-intake] sendUazapi err:", (e as Error).message); }
}

/**
 * Abertura ao CLIENTE via WhatsApp Cloud API (oficial). Abertura fria → exige template
 * aprovado (janela de 24h ainda fechada). Quando o cliente responder, o
 * whatsapp-cloud-webhook roteia pro agente V2 (mesma sessão) e a conversa segue livre.
 */
async function sendCloudTemplate(args: {
  tenantId: string; phone: string; leadId: string | null;
  templateName: string; params: string[];
}): Promise<boolean> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-whatsapp-cloud`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}`, "apikey": SERVICE_KEY },
      body: JSON.stringify({
        action: "send_template",
        phone: args.phone,
        tenant_id: args.tenantId,
        lead_id: args.leadId,
        template_name: args.templateName,
        template_params: args.params,
        sent_by: "stand_intake",
      }),
    });
    if (!res.ok) {
      console.error(`[stand-intake] send-whatsapp-cloud ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (e) { console.error("[stand-intake] sendCloudTemplate err:", (e as Error).message); return false; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    const body = await req.json();
    const messageData = body.data || body;
    const metadata = messageData.metadata || messageData;

    // 1. Config do stand
    const { data: cfgRow } = await supabase
      .from("config").select("value").eq("key", "stand_agent_config").maybeSingle();
    let cfg: StandConfig = {};
    try { cfg = JSON.parse(cfgRow?.value ?? "{}"); } catch { /* vazio */ }
    if (!cfg.enabled) return json({ ignored: true, reason: "stand_disabled" });
    if (!cfg.stand_tenant_id || !cfg.stand_instance_id || !cfg.stand_agent_slug) {
      return json({ ignored: true, reason: "stand_config_incomplete" });
    }

    // 2. É um grupo de stand?
    const groupJid = metadata?.chatid || messageData.remote_jid || "";
    const isGroup = metadata?.isGroup || String(groupJid).includes("@g.us");
    const standGroups = Array.isArray(cfg.stand_group_jids) ? cfg.stand_group_jids : [];
    if (!isGroup || !standGroups.includes(groupJid)) {
      return json({ ignored: true, reason: "not_stand_group" });
    }

    const triggerText = metadata?.text || metadata?.content?.text || messageData.content || "";
    if (!triggerText.trim()) return json({ ignored: true, reason: "empty" });

    // 3. Resolve instância do stand (host + token + valida tenant)
    const { data: instance } = await supabase
      .from("whatsapp_instances")
      .select("id, api_url, api_key, tenant_id")
      .eq("id", cfg.stand_instance_id)
      .maybeSingle();
    if (!instance?.api_url || !instance?.api_key) {
      return json({ error: "Instância do stand sem api_url/api_key" }, 400);
    }

    // 4. Lojas candidatas (só as com destino configurado)
    const { data: dests } = await supabase
      .from("tenant_lead_destinations")
      .select("tenant_id, whatsapp_target, label, active, destination_type")
      .eq("active", true);
    const { data: tenants } = await supabase
      .from("tenants").select("id, name");
    const tenantName: Record<string, string> = {};
    for (const t of tenants ?? []) tenantName[t.id] = t.name;
    const candidates = (dests ?? []).map((d) => ({
      tenant_id: d.tenant_id,
      name: tenantName[d.tenant_id] || "(sem nome)",
      target: d.whatsapp_target,
      label: d.label,
      type: d.destination_type,
    }));

    // 5. Extração + matching via Claude
    const ANTHROPIC_API_KEY = await requireIntegrationKey(supabase, "ANTHROPIC_API_KEY", cfg.stand_tenant_id);
    const storeList = candidates.map((c, i) => `${i + 1}. ${c.name} (tenant_id: ${c.tenant_id})`).join("\n") || "(nenhuma loja cadastrada)";

    const extractPrompt = `Você extrai dados de um repasse de lead feito por uma atendente de stand de carros num grupo de WhatsApp.

MENSAGEM DA ATENDENTE:
"${triggerText}"

LOJAS CADASTRADAS (escolha a dona do carro citado, se houver match claro):
${storeList}

Retorne APENAS um JSON válido:
{
  "name": "nome do cliente ou null",
  "phone": "telefone do cliente só com dígitos ou null",
  "car_interest": "carro/modelo de interesse ou null",
  "matched_tenant_id": "tenant_id da loja dona escolhida da lista, ou null se nenhum match claro",
  "store_mentioned": "nome da loja como citado na mensagem, ou null",
  "confidence": "high|medium|low"
}

Regras: só preencha matched_tenant_id se houver correspondência clara com uma loja da lista. Não invente tenant_id.`;

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        messages: [{ role: "user", content: extractPrompt }],
      }),
    });
    if (!aiRes.ok) {
      console.error("[stand-intake] Claude error:", await aiRes.text());
      return json({ error: "Falha na extração" }, 500);
    }
    const aiData = await aiRes.json();
    const aiText = aiData.content?.[0]?.text || "";
    const jsonMatch = aiText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return json({ error: "Extração sem JSON" }, 500);
    const extracted = JSON.parse(jsonMatch[0]);

    const customerName = (extracted.name || "").trim() || "Lead do Stand";
    const customerPhone = normalizePhone(extracted.phone || "");
    const carInterest = (extracted.car_interest || "").trim() || null;
    const matchedTenantId: string | null = extracted.matched_tenant_id || null;

    // 6. Sem telefone → pede no grupo e para
    if (!customerPhone || customerPhone.length < 12) {
      await sendUazapi(instance.api_url, instance.api_key, groupJid,
        "🤖 Não consegui identificar o telefone do cliente. Pode mandar de novo com nome e número? Ex: \"Raphael (11969827881), interesse na BMW Z4, loja Quest\".");
      return json({ ignored: true, reason: "no_phone" });
    }

    // Destino da loja dona (se casou)
    const ownerDest = matchedTenantId ? candidates.find((c) => c.tenant_id === matchedTenantId) : null;

    // 7. Cria lead no tenant do STAND (tenant_id explícito — service_role sem JWT)
    const contextNote = [
      "Lead captado no stand.",
      carInterest ? `Interesse: ${carInterest}.` : null,
      ownerDest ? `Loja dona: ${ownerDest.name}.` : (extracted.store_mentioned ? `Loja citada: ${extracted.store_mentioned} (sem destino cadastrado).` : null),
    ].filter(Boolean).join(" ");

    const { data: lead, error: leadErr } = await supabase
      .from("leads")
      .insert({
        tenant_id: cfg.stand_tenant_id,
        name: customerName,
        phone: customerPhone,
        sales_stage: "new",
        utm_source: "stand",
        context: contextNote,
      })
      .select("id")
      .single();
    if (leadErr) console.error("[stand-intake] lead insert err:", leadErr.message);
    const leadId = lead?.id || null;

    // 8. Resolve agente do stand
    const { data: agent } = await supabase
      .from("agents_registry")
      .select("id, slug")
      .eq("tenant_id", cfg.stand_tenant_id)
      .eq("slug", cfg.stand_agent_slug)
      .maybeSingle();
    if (!agent) {
      await sendUazapi(instance.api_url, instance.api_key, groupJid,
        "🤖 Lead registrado, mas o agente do stand não está configurado. Avise o suporte.");
      return json({ error: "agente do stand não encontrado" }, 400);
    }

    // 9. Cria sessão pro telefone do cliente (continuidade com o fluxo inbound V2)
    const sessionKey = `whatsapp:${customerPhone}`;
    const workingMemory = {
      source: "stand",
      customer_name: customerName,
      customer_phone: customerPhone,
      car_interest: carInterest,
      owner_tenant_id: ownerDest?.tenant_id || null,
      owner_destination: ownerDest?.target || null,
      owner_label: ownerDest?.name || extracted.store_mentioned || null,
      stand_group_jid: groupJid,
      stand_instance_id: cfg.stand_instance_id,
      lead_id: leadId,
    };

    let sessionId: string | undefined;
    const { data: existing } = await supabase
      .from("agents_sessions").select("id")
      .eq("agent_id", agent.id).eq("channel", "whatsapp")
      .contains("provider_state", { external_session_key: sessionKey })
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    sessionId = existing?.id;
    if (sessionId) {
      await supabase.from("agents_sessions")
        .update({ working_memory: workingMemory, updated_at: new Date().toISOString() })
        .eq("id", sessionId);
    } else {
      const { data: ns } = await supabase
        .from("agents_sessions").insert({
          tenant_id: cfg.stand_tenant_id,
          agent_id: agent.id, channel: "whatsapp",
          title: `Stand — ${customerName}`,
          working_memory: workingMemory,
          provider_state: { external_session_key: sessionKey, whatsapp_phone: customerPhone },
        }).select("id").single();
      sessionId = ns?.id;
    }

    // 10. 1ª mensagem ao cliente via Cloud API (abertura fria → template aprovado).
    // Quando o cliente responder, o whatsapp-cloud-webhook roteia pro agente V2 (mesma
    // sessão criada acima) e a conversa segue livre dentro da janela de 24h.
    let openingSent = false;
    if (sessionId) {
      const templateName = cfg.stand_template_name || "primeiro_contato_qualificacao";
      // param[0] = nome do cliente (send-whatsapp-cloud normaliza/extrai o primeiro nome).
      // O template deve conter {{1}} no corpo. Variáveis extras (ex: carro) só se o
      // template aprovado tiver os placeholders correspondentes.
      openingSent = await sendCloudTemplate({
        tenantId: cfg.stand_tenant_id, phone: customerPhone, leadId,
        templateName, params: [customerName],
      });
    }

    // 11. Confirma no grupo (via UAZAPI — canal interno do stand)
    const statusLine = openingSent
      ? `✅ Iniciei o atendimento com *${customerName}* (${customerPhone}).`
      : `⚠️ Lead *${customerName}* (${customerPhone}) registrado, mas a abertura via WhatsApp oficial falhou — confira o template/credenciais Cloud.`;
    const confirm = statusLine +
      (carInterest ? `\n🚗 Interesse: ${carInterest}` : "") +
      (ownerDest ? `\n🏠 Loja dona: ${ownerDest.name}` : (extracted.store_mentioned ? `\n⚠️ Loja "${extracted.store_mentioned}" sem destino cadastrado — vou qualificar mesmo assim.` : ""));
    await sendUazapi(instance.api_url, instance.api_key, groupJid, confirm);

    return json({ success: true, lead_id: leadId, session_id: sessionId, matched_tenant_id: matchedTenantId });
  } catch (err) {
    console.error("[stand-intake] error:", (err as Error).message);
    return json({ error: (err as Error).message }, 500);
  }
});
