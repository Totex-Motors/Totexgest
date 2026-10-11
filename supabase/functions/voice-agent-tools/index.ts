/**
 * voice-agent-tools — ferramentas que a "Nina" (agente de VOZ na ElevenLabs) chama
 * DURANTE a ligação do WhatsApp (Fase 2 — docs/NINA-VOZ.md).
 *
 * Caminho: cliente liga no WhatsApp oficial → Meta → WaVoIP (dispositivo OFFICIAL) →
 * SIP → ElevenLabs Agent → webhook tools (ESTA função) → Totexgest.
 *
 * Rota: POST /functions/v1/voice-agent-tools/<tool>
 *   identificar_cliente  { caller_phone }                                → quem está ligando (lead)
 *   consultar_estoque    { caller_phone, busca|marca|modelo, loja?, … }  → mesmo motor do agente de texto
 *   agendar_visita       { caller_phone, data_hora, loja, carro, tipo?, nome_cliente?, observacoes? }
 *   info_lojas           { }                                            → endereço/horário (config VOICE_LOJAS_INFO)
 *   horario_atual        { }                                            → data/hora em Brasília
 *
 * Segurança: função pública (verify_jwt=false) protegida pelo header `x-voice-token`,
 * comparado com config VOICE_AGENT_TOKEN (Configurações › Integrações). Sem token
 * configurado = tudo 401 (fail closed).
 *
 * Reuso: cria/acha uma sessão `agents_sessions` (channel 'voice') por telefone, do
 * mesmo agente do texto (config VOICE_AGENT_SLUG, padrão agente-stand), pra que
 * `agendar-visita` e `consultar-estoque` funcionem IGUAL ao WhatsApp de texto.
 *
 * Regras: nunca envia mensagem pra ninguém daqui; lead entra pela porta única
 * find_or_create_lead (lead_kind buyer, source 'ligacao_ia').
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "../_shared/config.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const HQ_TENANT = "c13681e3-5db9-48d1-9c5c-856e6041d77f";
const DEFAULT_AGENT_SLUG = "agente-stand";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-voice-token",
};

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

/** "+55 11 9…", "sip:5511…@…", "tel:…" → só dígitos com 55 na frente. */
function normalizePhone(raw: unknown): string {
  let d = String(raw ?? "").replace(/^(sip|sips|tel):/i, "").split("@")[0].replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("0")) d = d.replace(/^0+/, "");
  if (!d.startsWith("55") && (d.length === 10 || d.length === 11)) d = "55" + d;
  return d;
}

function firstName(n: string | null | undefined): string {
  return String(n || "").trim().split(/\s+/)[0] || "";
}

function nowBr(): { iso: string; texto: string; dia_semana: string } {
  const now = new Date();
  const texto = now.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long", day: "2-digit", month: "long", hour: "2-digit", minute: "2-digit" });
  const dia = now.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long" });
  // ISO com fuso -03:00 (sem DST no Brasil desde 2019)
  const br = new Date(now.getTime() - 3 * 3600_000).toISOString().replace("Z", "-03:00");
  return { iso: br, texto, dia_semana: dia };
}

async function resolveTenant(sb: any): Promise<string> {
  const cfg = await getIntegrationKey(sb, "VOICE_AGENT_TENANT_ID");
  if (cfg) return cfg;
  const { data: inst } = await sb.from("whatsapp_instances").select("tenant_id").eq("provider", "meta_cloud").limit(1).maybeSingle();
  return inst?.tenant_id || HQ_TENANT;
}

async function resolveAgent(sb: any, tenantId: string): Promise<{ id: string; slug: string } | null> {
  const slug = (await getIntegrationKey(sb, "VOICE_AGENT_SLUG")) || DEFAULT_AGENT_SLUG;
  const { data } = await sb.from("agents_registry").select("id, slug").eq("slug", slug).eq("tenant_id", tenantId).maybeSingle();
  if (data) return data;
  const { data: fallback } = await sb.from("agents_registry").select("id, slug").eq("slug", slug).limit(1).maybeSingle();
  return fallback || null;
}

/** Lead pela porta única + sessão de voz (1 por telefone + agente). */
async function ensureCallerContext(sb: any, phone: string, name?: string | null) {
  const tenantId = await resolveTenant(sb);
  const agent = await resolveAgent(sb, tenantId);

  let leadId: string | null = null;
  let created = false;
  if (phone) {
    const { data: r, error } = await sb.rpc("find_or_create_lead", {
      p_tenant: tenantId,
      p_phone: phone,
      p_name: name || null,
      p_source: "ligacao_ia",
      p_email: null,
      p_utm_source: "whatsapp_call",
      p_metadata: { origin: "nina-voz" },
      p_lead_kind: "buyer",
    });
    if (error) console.error("[voice-tools] find_or_create_lead:", error.message);
    leadId = r?.lead_id || null;
    created = !!r?.created;
  }

  let sessionId: string | null = null;
  if (agent && phone) {
    const key = `voice:${phone}`;
    const { data: existing } = await sb.from("agents_sessions").select("id")
      .eq("agent_id", agent.id).eq("channel", "voice")
      .contains("provider_state", { external_session_key: key })
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    sessionId = existing?.id || null;
    if (!sessionId) {
      const { data: ns, error } = await sb.from("agents_sessions").insert({
        tenant_id: tenantId,
        agent_id: agent.id,
        channel: "voice",
        title: `Ligação ${phone}`,
        provider_state: { external_session_key: key, whatsapp_phone: phone, source: "nina-voz" },
        working_memory: { customer_phone: phone, lead_id: leadId },
      }).select("id").single();
      if (error) console.error("[voice-tools] sessão:", error.message);
      sessionId = ns?.id || null;
    } else if (leadId) {
      // mantém o lead_id na memória da sessão (agendar-visita lê daqui)
      const { data: s } = await sb.from("agents_sessions").select("working_memory").eq("id", sessionId).maybeSingle();
      const wm = (s?.working_memory || {}) as Record<string, unknown>;
      if (wm.lead_id !== leadId) {
        await sb.from("agents_sessions").update({ working_memory: { ...wm, customer_phone: phone, lead_id: leadId } }).eq("id", sessionId);
      }
    }
  }

  return { tenantId, agent, leadId, created, sessionId };
}

async function callEdge(fn: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text, status: res.status }; }
}

/** Resposta enxuta pra ser FALADA: sem foto/link, no máximo 5 carros. */
function trimVehicles(result: any) {
  const list = Array.isArray(result?.veiculos) ? result.veiculos : [];
  const veiculos = list.slice(0, 5).map((v: any) => ({
    titulo: v.titulo, ano: v.ano, preco: v.preco, km: v.km, cor: v.cor, cambio: v.cambio,
    cidade: v.cidade, loja: v.loja, vehicle_id: v.vehicle_id,
  }));
  return {
    total: result?.total ?? veiculos.length,
    mostrando: veiculos.length,
    veiculos,
    dica: veiculos.length > 2 ? "Fale só 2 ou 3 opções por vez e pergunte qual interessa." : undefined,
    ...(result?.error ? { error: result.error } : {}),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  // ── auth (fail closed) ──
  const expected = await getIntegrationKey(sb, "VOICE_AGENT_TOKEN");
  const got = req.headers.get("x-voice-token") || "";
  if (!expected || !got || got.trim() !== expected.trim()) {
    return json({ error: "unauthorized" }, 401);
  }

  const tool = (new URL(req.url).pathname.split("/").filter(Boolean).pop() || "").toLowerCase();
  let body: Record<string, any> = {};
  try { body = req.method === "POST" ? await req.json() : {}; } catch { body = {}; }
  // ElevenLabs manda os parâmetros no corpo; aceita também { arguments: {...} }
  const args: Record<string, any> = { ...(body.arguments || {}), ...body };
  delete args.arguments;
  const phone = normalizePhone(args.caller_phone ?? args.phone ?? args.system__caller_id);

  console.log(`[voice-tools] ${tool} phone=${phone || "-"} args=${JSON.stringify(args).slice(0, 300)}`);

  try {
    switch (tool) {
      case "horario_atual": {
        return json(nowBr());
      }

      case "info_lojas": {
        const raw = await getIntegrationKey(sb, "VOICE_LOJAS_INFO");
        if (raw) {
          try { return json({ lojas: JSON.parse(raw) }); } catch { return json({ lojas: raw }); }
        }
        const { data: tenants } = await sb.from("tenants").select("name").eq("is_active", true);
        return json({
          lojas: (tenants || []).map((t: any) => ({ nome: t.name })),
          aviso: "Endereço e horário não cadastrados (config VOICE_LOJAS_INFO). Diga que vai confirmar com a loja.",
        });
      }

      case "identificar_cliente": {
        if (!phone) return json({ conhecido: false, erro: "sem telefone do chamador" });
        const ctx = await ensureCallerContext(sb, phone, args.nome || null);
        let lead: any = null;
        if (ctx.leadId) {
          const { data } = await sb.from("leads")
            .select("id, name, city_name, state, metadata, source, last_interaction_at, created_at")
            .eq("id", ctx.leadId).maybeSingle();
          lead = data;
        }
        const md = (lead?.metadata || {}) as Record<string, any>;
        const interesse = md.veiculo_interesse_texto || md.vehicle?.description || md.vehicle?.title || null;
        const lojaRef = md.marketplace_store_name || md.store?.name || md.credere_store_name || null;
        const nome = lead?.name && !/^lead sem nome|^\+?\d+$/i.test(lead.name) ? lead.name : null;
        return json({
          conhecido: !ctx.created && !!lead,
          lead_id: ctx.leadId,
          nome,
          primeiro_nome: firstName(nome),
          cidade: [lead?.city_name, lead?.state].filter(Boolean).join("/") || null,
          interesse,
          loja_referencia: lojaRef,
          ultima_interacao: lead?.last_interaction_at || null,
          orientacao: nome
            ? `Cliente já conhecido: cumprimente pelo primeiro nome (${firstName(nome)}).${interesse ? ` Já demonstrou interesse em: ${interesse}.` : ""}`
            : "Cliente novo: pergunte o nome de forma natural e use nas próximas falas.",
        });
      }

      case "consultar_estoque": {
        const ctx = phone ? await ensureCallerContext(sb, phone, args.nome_cliente || null) : null;
        const { caller_phone: _c, phone: _p, system__caller_id: _s, nome_cliente: _n, ...rest } = args;
        const result = await callEdge("consultar-estoque", { arguments: rest, session_id: ctx?.sessionId || null, user_id: null });
        return json(trimVehicles(result));
      }

      case "agendar_visita": {
        if (!phone) return json({ success: false, message: "Sem telefone do chamador — não dá pra agendar." });
        const ctx = await ensureCallerContext(sb, phone, args.nome_cliente || null);
        if (!ctx.sessionId) return json({ success: false, message: "Não consegui abrir a sessão do agente." });
        const { caller_phone: _c, phone: _p, system__caller_id: _s, ...rest } = args;
        if (!rest.nome_cliente && ctx.leadId) {
          const { data: l } = await sb.from("leads").select("name").eq("id", ctx.leadId).maybeSingle();
          if (l?.name) rest.nome_cliente = l.name;
        }
        rest.observacoes = [rest.observacoes, "Agendado por ligação (Nina voz)"].filter(Boolean).join(" — ");
        const result = await callEdge("agendar-visita", { arguments: rest, session_id: ctx.sessionId });
        return json(result);
      }

      default:
        return json({ error: `tool desconhecida: ${tool}`, tools: ["identificar_cliente", "consultar_estoque", "agendar_visita", "info_lojas", "horario_atual"] }, 404);
    }
  } catch (e) {
    console.error(`[voice-tools] ${tool} err:`, (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
