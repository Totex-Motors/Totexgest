// ============================================================================
// COMUNIDADE — Janela de Oportunidades (soft) + captura de demanda
//
// - sendGroupText / reactMessage: envio no grupo via UAZAPI (group-only, ok).
// - maybeCaptureDemand: no webhook, mensagem de membro na comunidade DURANTE uma
//   janela aberta vira demanda estruturada (Claude) e é gravada + reagida.
// - matchDemand: quando um carro do repasse é postado, marca as demandas que
//   casam (pra o time abordar pelo número oficial).
// - runWindowScheduler: abre/fecha janelas conforme a agenda (usado pelo cron).
// ============================================================================

import { getIntegrationKey } from "./config.ts";

// deno-lint-ignore no-explicit-any
type Sb = any;

const ANTHROPIC_VERSION = "2023-06-01";
const MIN_TEXT_LEN = 6;

interface Instance {
  id: string;
  api_url: string | null;
  api_key: string | null;
  provider: string | null;
  tenant_id: string | null;
}

const normJid = (j: string | null | undefined) => String(j || "").trim().toLowerCase();

async function getInstance(sb: Sb, instanceId: string): Promise<Instance | null> {
  const { data } = await sb.from("whatsapp_instances")
    .select("id, api_url, api_key, provider, tenant_id").eq("id", instanceId).single();
  return data ?? null;
}

export async function sendGroupText(inst: Instance, groupJid: string, text: string): Promise<boolean> {
  const apiUrl = String(inst.api_url || "").replace(/\/$/, "");
  if (!apiUrl || !inst.api_key) return false;
  try {
    const res = await fetch(`${apiUrl}/send/text`, {
      method: "POST",
      headers: { "Content-Type": "application/json", token: inst.api_key },
      body: JSON.stringify({ number: groupJid, text }),
    });
    return res.ok;
  } catch { return false; }
}

async function reactMessage(inst: Instance, messageId: string, emoji: string): Promise<void> {
  const apiUrl = String(inst.api_url || "").replace(/\/$/, "");
  if (!apiUrl || !inst.api_key || !emoji || !messageId) return;
  try {
    await fetch(`${apiUrl}/message/react`, {
      method: "POST",
      headers: { "Content-Type": "application/json", token: inst.api_key },
      body: JSON.stringify({ id: messageId, text: emoji }),
    });
  } catch { /* reação é best-effort */ }
}

// ─── Captura de demanda (webhook) ────────────────────────────────────────────

export interface DemandInput {
  instanceId: string;
  tenantId: string | null;
  groupJid: string;
  messageId: string;
  text: string;
  senderName?: string;
  senderPhone?: string;
}

/**
 * Retorna true se a mensagem foi tratada como demanda (comunidade + janela aberta),
 * pra o webhook parar e não virar ticket.
 */
export async function maybeCaptureDemand(sb: Sb, input: DemandInput): Promise<boolean> {
  const jid = normJid(input.groupJid);
  if (!jid.endsWith("@g.us")) return false;

  const { data: configs } = await sb.from("community_engagement")
    .select("*").eq("instance_id", input.instanceId).eq("active", true);
  const config = (configs as any[] | null)?.find((c) => normJid(c.community_group_jid) === jid);
  if (!config) return false; // não é a comunidade monitorada

  // Tem janela aberta agora?
  const { data: win } = await sb.from("community_windows")
    .select("id, demand_count")
    .eq("config_id", config.id).eq("status", "open")
    .gt("closes_at", new Date().toISOString())
    .order("opened_at", { ascending: false }).limit(1).maybeSingle();
  if (!win) return false; // fora de janela: deixa o fluxo normal seguir

  const text = (input.text || "").trim();
  if (text.length < MIN_TEXT_LEN) return true; // dentro da janela mas ruído: engole

  // Idempotência
  const { data: exists } = await sb.from("community_demand")
    .select("id").eq("source_message_id", input.messageId).maybeSingle();
  if (exists) return true;

  try {
    const inst = await getInstance(sb, config.instance_id);
    const anthropicKey = await getIntegrationKey(sb, "ANTHROPIC_API_KEY", config.tenant_id ?? input.tenantId);
    const parsed = anthropicKey ? await parseDemand(anthropicKey, config.model, text) : null;

    if (parsed && parsed.isDemand === false) {
      return true; // não é pedido de carro (ex: "boa tarde") — engole sem gravar
    }

    await sb.from("community_demand").insert({
      tenant_id: config.tenant_id ?? input.tenantId ?? null,
      config_id: config.id,
      window_id: win.id,
      source_message_id: input.messageId,
      member_phone: input.senderPhone ?? null,
      member_name: input.senderName ?? null,
      raw_text: text.slice(0, 2000),
      modelo: parsed?.modelo ?? null,
      ano: parsed?.ano ?? null,
      faixa_min: parsed?.faixaMin ?? null,
      faixa_max: parsed?.faixaMax ?? null,
      observacao: parsed?.observacao ?? null,
      status: "new",
    });
    await sb.from("community_windows").update({ demand_count: (win.demand_count ?? 0) + 1 }).eq("id", win.id);

    if (inst && config.ack_reaction) await reactMessage(inst, input.messageId, config.ack_reaction);
  } catch (e) {
    console.error("[community] captura falhou:", (e as Error).message);
  }
  return true;
}

interface ParsedDemand {
  isDemand: boolean;
  modelo: string | null;
  ano: string | null;
  faixaMin: number | null;
  faixaMax: number | null;
  observacao: string | null;
}

async function parseDemand(apiKey: string, model: string, text: string): Promise<ParsedDemand | null> {
  const system =
    `Você extrai a demanda de carro de mensagens num grupo de compra e venda. Dado o texto de um membro, ` +
    `diga se é um PEDIDO de carro (a pessoa procurando algo pra comprar) e extraia os dados.\n` +
    `Responda SOMENTE com JSON: {"isDemand":true|false,"modelo":"marca modelo ou null","ano":"ano/faixa ou null","faixaMin":numero ou null,"faixaMax":numero ou null,"observacao":"detalhes relevantes ou null"}.\n` +
    `Preços em reais (só dígitos). Se for saudação/off-topic/venda, isDemand=false.`;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
      body: JSON.stringify({
        model: model || "claude-sonnet-4-6",
        max_tokens: 400,
        system,
        messages: [{ role: "user", content: text }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.content?.[0]?.text ?? "";
    const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    const p = JSON.parse(raw.slice(start, end + 1));
    return {
      isDemand: p.isDemand !== false,
      modelo: typeof p.modelo === "string" ? p.modelo : null,
      ano: p.ano != null ? String(p.ano) : null,
      faixaMin: typeof p.faixaMin === "number" ? p.faixaMin : null,
      faixaMax: typeof p.faixaMax === "number" ? p.faixaMax : null,
      observacao: typeof p.observacao === "string" ? p.observacao : null,
    };
  } catch { return null; }
}

// ─── Match: carro do repasse × demanda ───────────────────────────────────────

/** Marca as demandas 'new' do tenant que casam com o carro postado. Retorna quantas. */
export async function matchDemand(
  sb: Sb,
  tenantId: string | null,
  car: { modelo: string | null; precoFinal: number | null },
): Promise<number> {
  if (!tenantId || !car.modelo) return 0;
  try {
    const { data: demands } = await sb.from("community_demand")
      .select("id, modelo, faixa_min, faixa_max")
      .eq("tenant_id", tenantId).eq("status", "new").limit(200);
    if (!demands?.length) return 0;

    const carWords = tokens(car.modelo);
    let matched = 0;
    for (const d of demands as any[]) {
      if (!d.modelo) continue;
      const dWords = tokens(d.modelo);
      const overlap = dWords.some((w: string) => w.length >= 3 && carWords.includes(w));
      if (!overlap) continue;
      if (car.precoFinal != null) {
        if (d.faixa_min != null && car.precoFinal < Number(d.faixa_min)) continue;
        if (d.faixa_max != null && car.precoFinal > Number(d.faixa_max)) continue;
      }
      await sb.from("community_demand").update({
        status: "matched",
        matched_car: { modelo: car.modelo, preco_final: car.precoFinal, at: new Date().toISOString() },
      }).eq("id", d.id);
      matched++;
    }
    return matched;
  } catch (e) {
    console.error("[community] match falhou:", (e as Error).message);
    return 0;
  }
}

function tokens(s: string): string[] {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
}

// ─── Agendador de janelas (cron) ─────────────────────────────────────────────

interface WindowSlot { dow: number; time: string; duration_min?: number }

/** Abre/fecha janelas conforme a agenda. Chamado a cada minuto pelo cron. */
export async function runWindowScheduler(sb: Sb): Promise<{ opened: number; closed: number }> {
  let opened = 0, closed = 0;
  const nowIso = new Date().toISOString();

  // 1) Fecha janelas vencidas (posta o resumo)
  const { data: expired } = await sb.from("community_windows")
    .select("id, config_id, demand_count")
    .eq("status", "open").lt("closes_at", nowIso).limit(50);
  for (const w of (expired as any[] | null) ?? []) {
    const { data: cfg } = await sb.from("community_engagement").select("*").eq("id", w.config_id).single();
    if (cfg) {
      const inst = await getInstance(sb, cfg.instance_id);
      const msg = String(cfg.close_template || "").replace(/\{QTD\}/g, String(w.demand_count ?? 0));
      if (inst && msg) await sendGroupText(inst, cfg.community_group_jid, msg);
    }
    await sb.from("community_windows").update({ status: "closed", closed_at: nowIso }).eq("id", w.id);
    closed++;
  }

  // 2) Abre janelas agendadas pra agora
  const { data: configs } = await sb.from("community_engagement").select("*").eq("active", true);
  for (const cfg of (configs as any[] | null) ?? []) {
    const slot = dueSlot(cfg.windows as WindowSlot[], cfg.timezone || "America/Sao_Paulo");
    if (!slot) continue;
    // Já abriu esse slot? (unique impede duplicar, mas evitamos o insert à toa)
    const { data: existing } = await sb.from("community_windows")
      .select("id").eq("config_id", cfg.id).eq("slot_key", slot.key).maybeSingle();
    if (existing) continue;

    const dur = Number(slot.duration || cfg.duration_default || 30);
    const closesAt = new Date(Date.now() + dur * 60000).toISOString();
    const { error } = await sb.from("community_windows").insert({
      tenant_id: cfg.tenant_id, config_id: cfg.id, slot_key: slot.key,
      closes_at: closesAt, status: "open", opened_by: "schedule",
    });
    if (error) continue; // corrida: outro tick abriu
    const inst = await getInstance(sb, cfg.instance_id);
    const msg = String(cfg.open_template || "").replace(/\{DURACAO\}/g, String(dur));
    if (inst && msg) await sendGroupText(inst, cfg.community_group_jid, msg);
    opened++;
  }
  return { opened, closed };
}

/** Abre uma janela AGORA (botão "abrir agora" do painel). */
export async function openWindowNow(sb: Sb, configId: string, durationMin?: number): Promise<{ ok: boolean; error?: string }> {
  const { data: cfg } = await sb.from("community_engagement").select("*").eq("id", configId).single();
  if (!cfg) return { ok: false, error: "config não encontrada" };
  // Já tem janela aberta?
  const { data: open } = await sb.from("community_windows")
    .select("id").eq("config_id", configId).eq("status", "open").gt("closes_at", new Date().toISOString()).maybeSingle();
  if (open) return { ok: false, error: "já existe uma janela aberta" };
  const dur = Number(durationMin || cfg.duration_default || 30);
  const closesAt = new Date(Date.now() + dur * 60000).toISOString();
  const slotKey = "manual-" + Date.now();
  const { error } = await sb.from("community_windows").insert({
    tenant_id: cfg.tenant_id, config_id: configId, slot_key: slotKey,
    closes_at: closesAt, status: "open", opened_by: "manual",
  });
  if (error) return { ok: false, error: error.message };
  const inst = await getInstance(sb, cfg.instance_id);
  const msg = String(cfg.open_template || "").replace(/\{DURACAO\}/g, String(dur));
  if (inst && msg) await sendGroupText(inst, cfg.community_group_jid, msg);
  return { ok: true };
}

/** Fecha a janela aberta AGORA (botão "fechar agora"). */
export async function closeWindowNow(sb: Sb, configId: string): Promise<{ ok: boolean; error?: string }> {
  const { data: win } = await sb.from("community_windows")
    .select("id, demand_count, config_id").eq("config_id", configId).eq("status", "open")
    .order("opened_at", { ascending: false }).limit(1).maybeSingle();
  if (!win) return { ok: false, error: "nenhuma janela aberta" };
  const { data: cfg } = await sb.from("community_engagement").select("*").eq("id", configId).single();
  if (cfg) {
    const inst = await getInstance(sb, cfg.instance_id);
    const msg = String(cfg.close_template || "").replace(/\{QTD\}/g, String(win.demand_count ?? 0));
    if (inst && msg) await sendGroupText(inst, cfg.community_group_jid, msg);
  }
  await sb.from("community_windows").update({ status: "closed", closed_at: new Date().toISOString() }).eq("id", win.id);
  return { ok: true };
}

// Retorna o slot agendado que está "vencendo agora" (dentro do minuto atual), com sua chave única.
function dueSlot(windows: WindowSlot[], tz: string): { key: string; duration?: number } | null {
  if (!Array.isArray(windows) || !windows.length) return null;
  const now = new Date();
  // Hora local no tz do tenant
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = wdMap[get("weekday")] ?? -1;
  const hh = get("hour"), mm = get("minute");
  const dateKey = `${get("year")}-${get("month")}-${get("day")}`;
  for (const w of windows) {
    if (Number(w.dow) !== dow) continue;
    const [th, tm] = String(w.time || "").split(":");
    if (th === hh && tm === mm) {
      return { key: `${dateKey}T${w.time}`, duration: w.duration_min };
    }
  }
  return null;
}
