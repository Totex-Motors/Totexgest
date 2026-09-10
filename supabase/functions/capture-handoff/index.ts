import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Captação (promotoras) — Fase 4: avisos do handoff e SLA.
//
// Modos (body.mode):
//   - notify : avisa o especialista (WhatsApp direto) + grupo da operação que
//              um lead captado quente/morno chegou pra ele. Disparado pelo
//              banco (capture_handoff → pg_net). Idempotente por lead.
//   - sla    : cron 10 min. Lead passado e ainda sem 1º contato: estourou o
//              SLA → re-avisa o especialista; 2× SLA → escala (gestor + grupo).
//   - summary: cron de hora em hora. "Resumo da Captação" no grupo da
//              operação nas horas de capture_handoff_config.summary_hours.
//
// Canal: capture_handoff_config.whatsapp_instance_id / whatsapp_group_jid; se
// vazio, usa o mesmo canal da Torre de Controle (operation_alert_config).
// Só UAZAPI (texto livre) — o número oficial Cloud API exige template.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function onlyDigits(s: string | null | undefined): string {
  return (s || "").replace(/\D/g, "");
}

function toWaNumber(phone: string | null | undefined): string | null {
  let d = onlyDigits(phone);
  if (!d) return null;
  if (d.length <= 11) d = "55" + d;
  return d;
}

function fmtPhone(phone: string | null | undefined): string {
  const d = onlyDigits(phone).replace(/^55/, "");
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return phone || "—";
}

function firstName(name: string | null | undefined): string {
  return (name || "").trim().split(/\s+/)[0] || "";
}

const TEMP_EMOJI: Record<string, string> = { quente: "🔥", morno: "🌤️", frio: "❄️" };
const PRAZO_LABEL: Record<string, string> = {
  agora: "agora", ate_30_dias: "até 30 dias", ate_90_dias: "até 90 dias", sem_prazo: "sem prazo",
};
const INTENT_LABEL: Record<string, string> = { vender: "vender", trocar: "trocar", entender: "entender quanto vale" };

async function sendUazapi(apiUrl: string, apiKey: string, number: string, text: string): Promise<boolean> {
  try {
    const base = apiUrl.replace(/\/+$/, "");
    const res = await fetch(`${base}/send/text`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json", "token": apiKey },
      body: JSON.stringify({ number, text }),
    });
    if (!res.ok) console.error("[capture-handoff] uazapi", res.status, await res.text().catch(() => ""));
    return res.ok;
  } catch (e) {
    console.error("[capture-handoff] uazapi err:", (e as Error).message);
    return false;
  }
}

interface Channel {
  apiUrl: string | null;
  apiKey: string | null;
  groupJid: string | null;
  notifySpecialist: boolean;
  notifyGroup: boolean;
  slaQuente: number;
  slaMorno: number;
  escalateTo: string | null;
}

// deno-lint-ignore no-explicit-any
async function loadChannel(sb: any, tenantId: string): Promise<Channel> {
  const [{ data: cfg }, { data: op }] = await Promise.all([
    sb.from("capture_handoff_config").select("*").eq("tenant_id", tenantId).maybeSingle(),
    sb.from("operation_alert_config").select("whatsapp_instance_id, whatsapp_group_jid, whatsapp_enabled").eq("tenant_id", tenantId).maybeSingle(),
  ]);
  const instanceId = cfg?.whatsapp_instance_id || op?.whatsapp_instance_id || null;
  let apiUrl: string | null = null, apiKey: string | null = null;
  if (instanceId) {
    const { data: inst } = await sb.from("whatsapp_instances").select("api_url, api_key, provider").eq("id", instanceId).maybeSingle();
    if (inst && inst.provider !== "meta_cloud") { apiUrl = inst.api_url; apiKey = inst.api_key; }
  }
  return {
    apiUrl, apiKey,
    groupJid: cfg?.whatsapp_group_jid || op?.whatsapp_group_jid || null,
    notifySpecialist: cfg?.notify_specialist ?? true,
    notifyGroup: cfg?.notify_group ?? (op?.whatsapp_enabled ?? true),
    slaQuente: cfg?.sla_minutes_quente ?? 30,
    slaMorno: cfg?.sla_minutes_morno ?? 240,
    escalateTo: cfg?.escalate_to_member_id || null,
  };
}

function leadSummary(lead: Row, vehicle: Row | null, promotora: Row | null): string {
  const q = lead.seller_qualification || {};
  const temp = q.temperatura || "frio";
  const veic = [
    vehicle?.description || [vehicle?.brand, vehicle?.model].filter(Boolean).join(" ") || "veículo não informado",
    vehicle?.year_model, vehicle?.km ? `${Number(vehicle.km).toLocaleString("pt-BR")} km` : null,
  ].filter(Boolean).join(" · ");
  const lines = [
    `${TEMP_EMOJI[temp] || ""} *${lead.name}* — ${fmtPhone(lead.phone)}`,
    `🚗 ${veic}`,
    `🎯 Quer ${INTENT_LABEL[q.intent] || q.intent || "vender"} · prazo: ${PRAZO_LABEL[q.prazo_venda] || "—"}${q.motivo ? ` · motivo: ${q.motivo}` : ""}`,
    `✅ Avaliação: ${q.aceita_avaliacao || "—"} · Autorizou contato: ${q.autoriza_contato === true ? "sim" : "NÃO"}${q.is_owner === true ? " · proprietário" : ""}`,
  ];
  if (q.expectativa_valor && /^\d+(\.\d+)?$/.test(String(q.expectativa_valor))) {
    lines.push(`💰 Valor em mente: R$ ${Number(q.expectativa_valor).toLocaleString("pt-BR")}`);
  }
  if (q.observacao) lines.push(`📝 ${q.observacao}`);
  lines.push(`👩 Captado por ${promotora?.name || "promotora"} · score ${lead.sales_score ?? 0}`);
  return lines.join("\n");
}

// ─── notify ──────────────────────────────────────────────────────────────────
// deno-lint-ignore no-explicit-any
async function notify(sb: any, leadId: string, force = false) {
  const { data: lead } = await sb.from("leads")
    .select("id, tenant_id, name, phone, sales_score, seller_qualification, captured_by_member_id, handoff_member_id, handoff_status, metadata")
    .eq("id", leadId).maybeSingle();
  if (!lead) return { ok: false, reason: "lead_not_found" };
  if (!lead.handoff_member_id) return { ok: false, reason: "no_specialist" };
  const handoff = (lead.metadata?.handoff || {}) as Row;
  if (handoff.notified_at && !force) return { ok: true, reason: "already_notified" };

  const [{ data: spec }, { data: promo }, { data: vehicle }] = await Promise.all([
    sb.from("team_members").select("id, name, phone").eq("id", lead.handoff_member_id).maybeSingle(),
    lead.captured_by_member_id
      ? sb.from("team_members").select("id, name").eq("id", lead.captured_by_member_id).maybeSingle()
      : Promise.resolve({ data: null }),
    sb.from("seller_vehicles").select("*").eq("lead_id", leadId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const ch = await loadChannel(sb, lead.tenant_id);
  const temp = lead.seller_qualification?.temperatura || "frio";
  const sla = temp === "quente" ? ch.slaQuente : ch.slaMorno;
  const summary = leadSummary(lead, vehicle, promo);

  let sentSpecialist = false, sentGroup = false;
  if (ch.apiUrl && ch.apiKey) {
    const specNumber = toWaNumber(spec?.phone);
    if (ch.notifySpecialist && specNumber) {
      const txt = `${temp === "quente" ? "🔥 *LEAD QUENTE DA CAPTAÇÃO*" : "🌤️ *Lead da captação*"} — ${firstName(spec?.name)}, é seu!\n\n${summary}\n\n⏱️ Contato em até *${sla} min*. A tarefa já está no seu CRM.`;
      sentSpecialist = await sendUazapi(ch.apiUrl, ch.apiKey, specNumber, txt);
    }
    if (ch.notifyGroup && ch.groupJid) {
      const txt = `📥 *Captação → ${spec?.name || "especialista"}*\n\n${summary}`;
      sentGroup = await sendUazapi(ch.apiUrl, ch.apiKey, ch.groupJid, txt);
    }
  }

  await sb.from("leads").update({
    handoff_status: (sentSpecialist || sentGroup) ? "notified" : lead.handoff_status,
    metadata: {
      ...(lead.metadata || {}),
      handoff: { ...handoff, notified_at: new Date().toISOString(), sent_specialist: sentSpecialist, sent_group: sentGroup,
                 channel_ok: !!(ch.apiUrl && ch.apiKey) },
    },
  }).eq("id", leadId);

  return { ok: true, sentSpecialist, sentGroup, channel: !!(ch.apiUrl && ch.apiKey) };
}

// ─── sla ─────────────────────────────────────────────────────────────────────
// deno-lint-ignore no-explicit-any
async function runSla(sb: any) {
  const { data: leads } = await sb.from("leads")
    .select("id, tenant_id, name, phone, sales_score, seller_qualification, captured_by_member_id, handoff_member_id, handoff_status, handoff_at, metadata")
    .not("captured_by_member_id", "is", null)
    .not("handoff_at", "is", null)
    .is("first_contact_at", null)
    .in("handoff_status", ["pending", "notified", "sla_breached"])
    .gte("handoff_at", new Date(Date.now() - 7 * 86_400_000).toISOString())
    .limit(500);

  const out: Row[] = [];
  const channels = new Map<string, Channel>();
  for (const lead of (leads || []) as Row[]) {
    const temp = lead.seller_qualification?.temperatura || "frio";
    if (temp !== "quente" && temp !== "morno") continue;
    if (!channels.has(lead.tenant_id)) channels.set(lead.tenant_id, await loadChannel(sb, lead.tenant_id));
    const ch = channels.get(lead.tenant_id)!;
    const sla = temp === "quente" ? ch.slaQuente : ch.slaMorno;
    const waiting = Math.floor((Date.now() - new Date(lead.handoff_at).getTime()) / 60_000);
    const handoff = (lead.metadata?.handoff || {}) as Row;

    if (waiting >= sla && (lead.handoff_status === "pending" || lead.handoff_status === "notified")) {
      // 1ª quebra: re-avisa o especialista
      let sent = false;
      if (ch.apiUrl && ch.apiKey) {
        const { data: spec } = await sb.from("team_members").select("name, phone").eq("id", lead.handoff_member_id).maybeSingle();
        const n = toWaNumber(spec?.phone);
        const txt = `⏰ *SLA estourado* — ${firstName(spec?.name)}, o lead *${lead.name}* (${fmtPhone(lead.phone)}) da captação está há *${waiting} min* sem 1º contato. Chama ele agora?`;
        if (ch.notifySpecialist && n) sent = await sendUazapi(ch.apiUrl, ch.apiKey, n, txt);
        if (ch.notifyGroup && ch.groupJid) await sendUazapi(ch.apiUrl, ch.apiKey, ch.groupJid, txt);
      }
      await sb.from("leads").update({
        handoff_status: "sla_breached",
        metadata: { ...(lead.metadata || {}), handoff: { ...handoff, sla_alert_at: new Date().toISOString(), sla_alert_sent: sent } },
      }).eq("id", lead.id);
      out.push({ lead: lead.id, action: "sla_breached", waiting });
    } else if (waiting >= 2 * sla && lead.handoff_status === "sla_breached") {
      // 2ª quebra: escala pro gestor (ou admins com telefone) + grupo
      let targets: string[] = [];
      if (ch.escalateTo) {
        const { data: m } = await sb.from("team_members").select("phone").eq("id", ch.escalateTo).maybeSingle();
        const n = toWaNumber(m?.phone); if (n) targets.push(n);
      }
      if (!targets.length) {
        const { data: admins } = await sb.from("team_members").select("phone").eq("tenant_id", lead.tenant_id).eq("role", "admin").eq("is_active", true);
        targets = ((admins || []) as Row[]).map((a) => toWaNumber(a.phone)).filter(Boolean) as string[];
      }
      const { data: spec } = await sb.from("team_members").select("name").eq("id", lead.handoff_member_id).maybeSingle();
      const txt = `🚨 *ESCALADO* — lead da captação *${lead.name}* (${fmtPhone(lead.phone)}) está há *${waiting} min* sem contato. Responsável: ${spec?.name || "—"}. Alguém precisa assumir.`;
      let sent = 0;
      if (ch.apiUrl && ch.apiKey) {
        for (const t of targets) if (await sendUazapi(ch.apiUrl, ch.apiKey, t, txt)) sent++;
        if (ch.groupJid) await sendUazapi(ch.apiUrl, ch.apiKey, ch.groupJid, txt);
      }
      await sb.from("leads").update({
        handoff_status: "escalated",
        metadata: { ...(lead.metadata || {}), handoff: { ...handoff, escalated_at: new Date().toISOString(), escalated_sent: sent } },
      }).eq("id", lead.id);
      out.push({ lead: lead.id, action: "escalated", waiting, sent });
    }
  }
  // Follow-ups: 3 dias em "Contato feito" sem avaliação agendada → tarefa + aviso no grupo
  const { data: stale } = await sb.rpc("capture_stale_followups", { p_days: 3 });
  const staleList = (stale || []) as Row[];
  if (staleList.length) {
    const byTenant = new Map<string, Row[]>();
    for (const s of staleList) byTenant.set(s.tenant_id, [...(byTenant.get(s.tenant_id) || []), s]);
    for (const [tenantId, items] of byTenant) {
      if (!channels.has(tenantId)) channels.set(tenantId, await loadChannel(sb, tenantId));
      const ch = channels.get(tenantId)!;
      if (ch.apiUrl && ch.apiKey && ch.groupJid && ch.notifyGroup) {
        const txt = `📌 *Follow-up da captação* — sem avaliação agendada:\n` +
          items.map((s) => `• ${s.lead} — ${s.rep} · ${s.dias} dias em "Contato feito"`).join("\n") +
          `\n\nTarefa criada pra cada um. Agenda a avaliação ou move pra Nutrição/Perdido.`;
        await sendUazapi(ch.apiUrl, ch.apiKey, ch.groupJid, txt);
      }
      out.push({ tenant: tenantId, action: "stale_followups", count: items.length });
    }
  }

  return { checked: (leads || []).length, actions: out };
}

// ─── summary ─────────────────────────────────────────────────────────────────
// Resumo da captação no grupo da operação. Cron de hora em hora; posta só nas
// horas (BRT) de capture_handoff_config.summary_hours e no máximo 1x por hora.
const TEMP_LABEL: Record<string, string> = { quente: "🔥", morno: "🌤️", frio: "❄️" };

function brtHour(): number {
  return Number(new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false }).format(new Date()));
}

function formatSummary(d: Row, hour: number): string {
  const h = d.hoje || {};
  const lines: string[] = [];
  lines.push(`📣 *Resumo da Captação — ${String(hour).padStart(2, "0")}:00*`);
  lines.push("");
  lines.push(`👥 Hoje: *${h.total ?? 0}* captados (🔥 ${h.quentes ?? 0} · 🌤️ ${h.mornos ?? 0} · ❄️ ${h.frios ?? 0}) · contatados: *${h.contatados ?? 0}*`);

  const promos = (d.promotoras || []) as Row[];
  if (promos.length) {
    lines.push("");
    lines.push("*Por promotora (hoje · semana):*");
    const weeklyReward = ((d.premios || []) as Row[]).find((p) => p.goal_type === "leads_semana");
    for (const p of promos) {
      let meta = "";
      if (weeklyReward) {
        const falta = Math.max(0, Number(weeklyReward.goal_value) - Number(p.semana));
        meta = falta === 0 ? ` · 🏆 bateu a meta do *${weeklyReward.name}*!` : ` · faltam ${falta} p/ ${weeklyReward.name}`;
      }
      lines.push(`• ${firstName(p.name)}: ${p.hoje}${p.hoje_quentes ? ` (${p.hoje_quentes}🔥)` : ""} · ${p.semana} na semana${meta}`);
    }
  } else {
    lines.push("");
    lines.push("Nenhuma captação nesta semana ainda.");
  }

  const wait = (d.aguardando || []) as Row[];
  lines.push("");
  if (wait.length) {
    lines.push(`⏱️ *Sem 1º contato (${wait.length}):*`);
    for (const w of wait.slice(0, 8)) {
      const flag = w.status === "sla_breached" || w.status === "escalated" ? " ⚠️" : "";
      lines.push(`• ${TEMP_LABEL[w.temperatura] || ""} ${w.lead} — ${w.especialista} · ${waitLabel(Number(w.minutos))}${flag}`);
    }
    if (wait.length > 8) lines.push(`• …e mais ${wait.length - 8}`);
  } else {
    lines.push("✅ Nenhum lead quente/morno esperando contato.");
  }

  lines.push("");
  lines.push(`🚗 Carros captados no mês: *${d.captados_mes ?? 0}*`);
  return lines.join("\n");
}

function waitLabel(min: number): string {
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}h${m}` : `${h}h`;
}

// deno-lint-ignore no-explicit-any
async function runSummary(sb: any, force = false) {
  const hour = brtHour();
  const { data: cfgs } = await sb.from("capture_handoff_config").select("tenant_id, enabled, summary_enabled, summary_hours, last_summary_at");
  const out: Row[] = [];
  for (const cfg of (cfgs || []) as Row[]) {
    if (!cfg.enabled || !cfg.summary_enabled) continue;
    const hours = (cfg.summary_hours || []) as number[];
    if (!force && !hours.includes(hour)) continue;
    // anti-duplicidade: 1 por hora
    if (!force && cfg.last_summary_at && Date.now() - new Date(cfg.last_summary_at).getTime() < 50 * 60_000) continue;

    const ch = await loadChannel(sb, cfg.tenant_id);
    if (!ch.apiUrl || !ch.apiKey || !ch.groupJid) { out.push({ tenant: cfg.tenant_id, skipped: "sem canal/grupo" }); continue; }
    const { data, error } = await sb.rpc("capture_daily_summary", { p_tenant: cfg.tenant_id });
    if (error) { out.push({ tenant: cfg.tenant_id, error: error.message }); continue; }
    const text = formatSummary(data as Row, hour);
    const sent = await sendUazapi(ch.apiUrl, ch.apiKey, ch.groupJid, text);
    if (sent) await sb.from("capture_handoff_config").update({ last_summary_at: new Date().toISOString() }).eq("tenant_id", cfg.tenant_id);
    out.push({ tenant: cfg.tenant_id, sent });
  }
  return { hour, results: out };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  let body: Row = {};
  try { body = await req.json(); } catch { /* sem body */ }
  const url = new URL(req.url);
  const mode = body.mode || url.searchParams.get("mode") || "notify";

  try {
    if (mode === "sla") return jsonRes(await runSla(sb));
    if (mode === "summary") return jsonRes(await runSummary(sb, body.force === true));
    if (mode === "notify") {
      const leadId = body.lead_id || url.searchParams.get("lead_id");
      if (!leadId) return jsonRes({ error: "lead_id obrigatório" }, 400);
      return jsonRes(await notify(sb, leadId, body.force === true));
    }
    return jsonRes({ error: `mode inválido: ${mode}` }, 400);
  } catch (e) {
    console.error("[capture-handoff]", e);
    return jsonRes({ error: (e as Error).message }, 500);
  }
});
