import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "../_shared/config.ts";

// Fase 2 da Torre de Controle: alertas da operação de leads pro time.
// Disparada por cron. Dois modos (via ?mode= ou body.mode):
//   - realtime : lead sem 1º contato que estourou o SLA + reconversão sem
//                resposta. Anti-spam via operation_alert_log (1x por lead/tipo).
//   - summary  : resumo da operação 2x/dia (+ plano do copiloto IA opcional).
// Canais: Telegram (principal) e WhatsApp/UAZAPI (opcional). Multi-tenant:
// varre todos os tenants com operation_alert_config.enabled = true.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const ANTHROPIC_MODEL = "claude-3-5-haiku-20241022";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function waitLabel(min: number): string {
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h${m}` : `${h}h`;
}

// ---- Envio ----
async function sendTelegram(botToken: string, chatId: string, html: string): Promise<boolean> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    if (res.ok) return true;
    const plain = html.replace(/<[^>]+>/g, "");
    const res2 = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: plain }),
    });
    return res2.ok;
  } catch (e) {
    console.error("[operation-alerts] telegram err:", (e as Error).message);
    return false;
  }
}

async function sendWhatsAppGroup(apiUrl: string, apiKey: string, groupJid: string, text: string): Promise<boolean> {
  try {
    const res = await fetch(`${apiUrl}/send/text`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json", "token": apiKey },
      body: JSON.stringify({ number: groupJid, text }),
    });
    return res.ok;
  } catch (e) {
    console.error("[operation-alerts] whatsapp err:", (e as Error).message);
    return false;
  }
}

// Telegram usa HTML (<b>); WhatsApp usa markdown (*bold*). Geramos as duas.
function stripHtmlToWhats(html: string): string {
  return html
    .replace(/<b>(.*?)<\/b>/g, "*$1*")
    .replace(/<i>(.*?)<\/i>/g, "_$1_")
    .replace(/<[^>]+>/g, "");
}

// ---- Cálculo da fila (server-side, espelha useOperationTower) ----
// deno-lint-ignore no-explicit-any
async function computeTower(supabase: any, tenantId: string) {
  const now = Date.now();
  const since = new Date(now - 24 * 60 * 60 * 1000).toISOString();

  const { data: conversions } = await supabase
    .from("lead_conversions")
    .select("id, lead_id, conversion_type, source, utm_campaign, created_at, sales_rep_id, lead:leads(id, name, phone), sales_rep:team_members(id, name)")
    .eq("tenant_id", tenantId)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(300);

  const rows = (conversions || []) as Row[];
  const leadIds = [...new Set(rows.map((r) => r.lead_id).filter(Boolean))];

  const [wpp, calls, acts, notes] = leadIds.length
    ? await Promise.all([
        supabase.from("whatsapp_messages").select("lead_id, sent_at").in("lead_id", leadIds).eq("is_from_me", true).gte("sent_at", since).limit(1000),
        supabase.from("call_history").select("lead_id, started_at").in("lead_id", leadIds).gte("started_at", since).limit(500),
        supabase.from("company_activities").select("lead_id, updated_at, created_at, completed, metadata").in("lead_id", leadIds).eq("completed", true).gte("created_at", since).limit(500),
        supabase.from("company_activities").select("lead_id, name, created_at, metadata").in("lead_id", leadIds).eq("task_type", "note").gte("created_at", since).order("created_at", { ascending: false }).limit(500),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }];

  const signals = new Map<string, number[]>();
  const push = (lid: string | null, ts: string | null) => {
    if (!lid || !ts) return;
    const arr = signals.get(lid) || [];
    arr.push(new Date(ts).getTime());
    signals.set(lid, arr);
  };
  for (const m of (wpp.data || []) as Row[]) push(m.lead_id, m.sent_at);
  for (const c of (calls.data || []) as Row[]) push(c.lead_id, c.started_at);
  for (const a of (acts.data || []) as Row[]) {
    const src = a.metadata?.source;
    if (src === "focus_auto" || src === "receive-lead" || src === "franchise_distribution") continue;
    push(a.lead_id, a.updated_at || a.created_at);
  }

  const noteByLead = new Map<string, string>();
  for (const n of (notes.data || []) as Row[]) {
    if (n.metadata?.inbound_note && n.lead_id && !noteByLead.has(n.lead_id)) noteByLead.set(n.lead_id, n.name);
  }

  const entries = rows.map((r) => {
    const entryTime = new Date(r.created_at).getTime();
    const sig = (signals.get(r.lead_id) || []).sort((a, b) => a - b);
    const first = sig.find((ts) => ts > entryTime) || null;
    return {
      conversion_id: r.id,
      lead_id: r.lead_id,
      lead_name: r.lead?.name || "Lead",
      conversion_type: r.conversion_type === "reconversion" ? "reconversion" : "new",
      source: r.source,
      utm_campaign: r.utm_campaign,
      sales_rep_name: r.sales_rep?.name || null,
      note_subject: noteByLead.get(r.lead_id) || null,
      attended: !!first,
      minutes_to_contact: first ? Math.round((first - entryTime) / 60000) : null,
      minutes_waiting: Math.round((now - entryTime) / 60000),
    };
  });

  const unattended = entries.filter((e) => !e.attended).sort((a, b) => b.minutes_waiting - a.minutes_waiting);

  // Follow-ups vencidos por vendedor
  const { data: overdue } = await supabase
    .from("company_activities")
    .select("responsavel_id, scheduled_at, responsavel:team_members!company_activities_responsavel_id_fkey(name)")
    .eq("tenant_id", tenantId)
    .eq("completed", false)
    .lt("scheduled_at", new Date(now).toISOString())
    .not("scheduled_at", "is", null)
    .limit(300);

  const byRep = new Map<string, { name: string; count: number }>();
  for (const o of (overdue || []) as Row[]) {
    const key = o.responsavel_id || "__sem__";
    const cur = byRep.get(key) || { name: o.responsavel?.name || "Sem responsável", count: 0 };
    cur.count++;
    byRep.set(key, cur);
  }
  const overdueByRep = [...byRep.values()].sort((a, b) => b.count - a.count);

  const attended = entries.filter((e) => e.attended);
  const within15 = attended.filter((e) => (e.minutes_to_contact ?? Infinity) <= 15);

  return {
    entries,
    unattended,
    overdueByRep,
    overdueCount: (overdue || []).length,
    stats: {
      entries24h: entries.length,
      newCount: entries.filter((e) => e.conversion_type === "new").length,
      reconversionCount: entries.filter((e) => e.conversion_type === "reconversion").length,
      unattendedCount: unattended.length,
      slaPct15min: attended.length ? Math.round((within15.length / attended.length) * 100) : null,
    },
  };
}

// ---- Modo REALTIME ----
// deno-lint-ignore no-explicit-any
async function runRealtime(supabase: any, cfg: Row): Promise<number> {
  const tenantId = cfg.tenant_id;
  const tower = await computeTower(supabase, tenantId);
  const threshold = cfg.sla_alert_minutes || 60;

  // Candidatos: não atendidos que estouraram o SLA
  const breached = tower.unattended.filter((e) => e.minutes_waiting >= threshold && e.lead_id);
  if (!breached.length) return 0;

  // Filtra os que já foram alertados (anti-spam)
  const leadIds = breached.map((e) => e.lead_id);
  const { data: already } = await supabase
    .from("operation_alert_log")
    .select("lead_id, alert_type")
    .eq("tenant_id", tenantId)
    .in("lead_id", leadIds);
  const alertedKeys = new Set((already || []).map((a: Row) => `${a.lead_id}:${a.alert_type}`));

  let sent = 0;
  for (const e of breached) {
    const alertType = e.conversion_type === "reconversion" ? "reconversion_unattended" : "sla_breach";
    if (alertedKeys.has(`${e.lead_id}:${alertType}`)) continue;

    const emoji = e.conversion_type === "reconversion" ? "🔁" : "⚠️";
    const tipo = e.conversion_type === "reconversion" ? "RECONVERSÃO sem resposta" : "Lead sem 1º contato";
    const linhaSub = e.note_subject || e.source || "sem tratativa";
    const resp = e.sales_rep_name ? `Resp.: ${e.sales_rep_name}` : "⚠️ SEM vendedor";
    const html =
      `${emoji} <b>${tipo}</b>\n` +
      `<b>${e.lead_name}</b> — esperando há <b>${waitLabel(e.minutes_waiting)}</b>\n` +
      `${linhaSub}\n${resp}`;

    const okAny = await deliver(supabase, cfg, html);
    if (okAny) {
      await supabase.from("operation_alert_log").insert({
        tenant_id: tenantId,
        lead_id: e.lead_id,
        alert_type: alertType,
        channel: cfg.telegram_enabled ? "telegram" : "whatsapp",
      }).then(() => {}).catch(() => {});
      sent++;
    }
  }
  return sent;
}

// ---- Modo SUMMARY ----
// deno-lint-ignore no-explicit-any
async function runSummary(supabase: any, cfg: Row): Promise<boolean> {
  const tenantId = cfg.tenant_id;
  const tower = await computeTower(supabase, tenantId);
  const s = tower.stats;
  const now = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });

  const criticos = tower.unattended.filter((e) => e.minutes_waiting >= (cfg.sla_alert_minutes || 60)).length;
  const overdueTop = tower.overdueByRep.slice(0, 5).map((r) => `${r.name}: ${r.count}`).join(" · ") || "nenhum";

  let html =
    `📊 <b>Resumo da Operação — ${now}</b>\n\n` +
    `📥 Entradas (24h): <b>${s.entries24h}</b> (${s.newCount} novos · ${s.reconversionCount} reconv.)\n` +
    `🚨 Sem atendimento: <b>${s.unattendedCount}</b>${criticos ? ` (<b>${criticos} críticos</b>)` : ""}\n` +
    `⏱️ SLA ≤15min: <b>${s.slaPct15min != null ? s.slaPct15min + "%" : "—"}</b>\n` +
    `📌 Follow-ups vencidos: ${overdueTop}`;

  // Plano do copiloto IA (opcional)
  if (cfg.include_ai_plan) {
    const plano = await generateAiPlan(supabase, tenantId, tower);
    if (plano) html += `\n\n🤖 <b>Plano de ação:</b>\n${plano}`;
  }

  return await deliver(supabase, cfg, html);
}

// deno-lint-ignore no-explicit-any
async function generateAiPlan(supabase: any, tenantId: string, tower: any): Promise<string | null> {
  const anthropicKey = await getIntegrationKey(supabase, "ANTHROPIC_API_KEY", tenantId);
  if (!anthropicKey) return null;
  const payload = {
    stats: tower.stats,
    unattended: tower.unattended.slice(0, 20).map((e: Row) => ({
      nome: e.lead_name, tipo: e.conversion_type, canal: e.source,
      assunto: e.note_subject, esperando_min: e.minutes_waiting, vendedor: e.sales_rep_name,
    })),
    overdueByRep: tower.overdueByRep,
  };
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 700,
        system: "Você é o copiloto de um supervisor de vendas de uma revenda de carros. Analise a operação e liste, em pt-BR, de 3 a 5 ações objetivas e no imperativo pro supervisor fazer agora (priorize leads sem 1º contato há mais tempo, reconversões e vendedores com muitos follow-ups vencidos). Seja curto e direto, sem introdução. Formato: itens numerados.",
        messages: [{ role: "user", content: JSON.stringify(payload) }],
      }),
    });
    const result = await resp.json();
    if (!resp.ok) return null;
    return result.content?.[0]?.text || null;
  } catch {
    return null;
  }
}

// Envia pra todos os canais habilitados; retorna true se algum deu certo.
// deno-lint-ignore no-explicit-any
async function deliver(supabase: any, cfg: Row, html: string): Promise<boolean> {
  let ok = false;
  if (cfg.telegram_enabled && cfg.telegram_bot_token && cfg.telegram_chat_id) {
    ok = (await sendTelegram(cfg.telegram_bot_token, cfg.telegram_chat_id, html)) || ok;
  }
  if (cfg.whatsapp_enabled && cfg.whatsapp_instance_id && cfg.whatsapp_group_jid) {
    const { data: inst } = await supabase
      .from("whatsapp_instances")
      .select("api_url, api_key, status")
      .eq("id", cfg.whatsapp_instance_id)
      .maybeSingle();
    if (inst?.api_url && inst?.api_key) {
      ok = (await sendWhatsAppGroup(inst.api_url, inst.api_key, cfg.whatsapp_group_jid, stripHtmlToWhats(html))) || ok;
    }
  }
  return ok;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  let mode = url.searchParams.get("mode") || "";
  let onlyTenant: string | null = url.searchParams.get("tenant_id");
  if (!mode && req.method === "POST") {
    const body = await req.json().catch(() => ({} as Row));
    mode = body.mode || "";
    onlyTenant = onlyTenant || body.tenant_id || null;
  }
  if (mode !== "realtime" && mode !== "summary") {
    return jsonRes({ error: "mode inválido (realtime|summary)" }, 400);
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Segurança: se veio JWT de usuário (teste pelo frontend), escopa ao tenant
    // dele — assim ninguém dispara alerta no grupo de outra loja. Cron (service
    // role) resolve user=null e cai no loop normal de todos os tenants.
    const authHeader = req.headers.get("Authorization") || "";
    if (authHeader) {
      try {
        const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
          global: { headers: { Authorization: authHeader } },
        });
        const { data: { user } } = await userClient.auth.getUser();
        const tid = (user?.app_metadata as Row)?.tenant_id;
        if (tid) onlyTenant = tid;
      } catch { /* service role / sem user → segue no loop */ }
    }

    let q = supabase.from("operation_alert_config").select("*").eq("enabled", true);
    if (onlyTenant) q = q.eq("tenant_id", onlyTenant);
    const { data: configs } = await q;

    const results: Row[] = [];
    for (const cfg of (configs || []) as Row[]) {
      // Respeita toggles por modo
      if (mode === "realtime" && !cfg.realtime_enabled) continue;
      if (mode === "summary" && !cfg.summary_enabled) continue;

      // No modo summary, só dispara se a hora atual (BRT) está em summary_hours
      if (mode === "summary" && !onlyTenant) {
        const hourBrt = Number(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false }));
        const hours: number[] = Array.isArray(cfg.summary_hours) ? cfg.summary_hours : [9, 14];
        if (!hours.includes(hourBrt)) continue;
      }

      try {
        if (mode === "realtime") {
          const sent = await runRealtime(supabase, cfg);
          results.push({ tenant_id: cfg.tenant_id, sent });
        } else {
          const ok = await runSummary(supabase, cfg);
          results.push({ tenant_id: cfg.tenant_id, summary_sent: ok });
        }
      } catch (e) {
        console.error("[operation-alerts] tenant erro:", cfg.tenant_id, (e as Error).message);
        results.push({ tenant_id: cfg.tenant_id, error: (e as Error).message });
      }
    }

    return jsonRes({ mode, processed: results.length, results });
  } catch (err) {
    console.error("[operation-alerts] fatal:", err);
    return jsonRes({ error: String((err as Error)?.message || err) }, 500);
  }
});
