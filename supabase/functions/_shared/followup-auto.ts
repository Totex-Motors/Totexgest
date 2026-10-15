/**
 * FOLLOW-UP AUTOMÁTICO DO AGENTE DE TEXTO (decisão do Marco, 2026-10-15).
 *
 * O prompt mandava o agente "agendar um lembrete" quando deixasse algo pendente — em 14 dias
 * ele nunca chamou a ferramenta (0 lembretes). Agora o SISTEMA agenda, depois de cada resposta
 * do agente no WhatsApp, a retomada caso o cliente suma:
 *   passo 1 → 3 h depois (dentro de 8h–20h; senão 9h30 do dia seguinte)
 *   passo 2 → 9h30 do dia seguinte
 *   passo 3 → 48 h depois: a mensagem de PAUSA com botões (Continuar / Me chama outro dia /
 *             Encerrar por agora), mandada direto, sem passar pelo modelo
 * Cliente respondeu → o agent-runner cancela os lembretes pendentes (já existia) e o ciclo
 * recomeça do passo 1 na próxima resposta do agente.
 * Não agenda se: lead pediu pra não ser contatado, já tem visita marcada, foi repassado pra
 * loja nesta sessão, ou o agente se despediu (ele responde NAO_ENVIAR na retomada).
 * Config: FOLLOWUP_AUTO_ENABLED (true), FOLLOWUP_1_HOURS (3), FOLLOWUP_PAUSA_ENABLED (true),
 * FOLLOWUP_PAUSA_HOURS (48).
 * Fora da janela de 24 h: templates `retomada_conversa` (passos 1–2) e `pausa_conversa`
 * (passo 3, com botões de resposta rápida).
 */
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "./config.ts";
import { assuntoDoLead } from "./nina-cadence.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const log = (...a: unknown[]) => console.log("[followup-auto]", ...a);

export const PAUSA_BOTOES = [
  { id: "pausa_continuar", title: "Continuar por aqui" },
  { id: "pausa_depois", title: "Me chama outro dia" },
  { id: "pausa_encerrar", title: "Encerrar por agora" },
];

async function cfgBool(sb: SupabaseClient, key: string, def: boolean): Promise<boolean> {
  const v = await getIntegrationKey(sb, key);
  return v === null || v === undefined || v === "" ? def : String(v).toLowerCase() === "true";
}
async function cfgNum(sb: SupabaseClient, key: string, def: number): Promise<number> {
  const v = Number(await getIntegrationKey(sb, key));
  return Number.isFinite(v) && v > 0 ? v : def;
}

/** Horário de Brasília sem DST (fixo -03:00). */
function brParts(d: Date): { h: number; m: number } {
  const br = new Date(d.getTime() - 3 * 3600_000);
  return { h: br.getUTCHours(), m: br.getUTCMinutes() };
}
function brAt(d: Date, h: number, m: number, addDays = 0): Date {
  const br = new Date(d.getTime() - 3 * 3600_000);
  const base = Date.UTC(br.getUTCFullYear(), br.getUTCMonth(), br.getUTCDate() + addDays, h, m, 0);
  return new Date(base + 3 * 3600_000);
}
/** +N horas se cair entre 8h e 20h; senão 9h30 do dia seguinte. */
export function proximoHorario(hours: number, now = new Date()): Date {
  const t = new Date(now.getTime() + hours * 3600_000);
  const { h } = brParts(t);
  if (h >= 8 && h < 20) return t;
  // antes das 8h → 9h30 de hoje; depois das 20h → 9h30 de amanhã
  return h < 8 ? brAt(t, 9, 30, 0) : brAt(t, 9, 30, 1);
}
export function amanha930(now = new Date()): Date { return brAt(now, 9, 30, 1); }

type Args = { db: SupabaseClient; tenantId: string | null; agentId: string; sessionId: string; leadId: string | null; channel: string; instanceId: string | null; recipient: string | null; stepHint?: number };

/** Chamado pelo agent-runner no fim de cada run no WhatsApp. */
export async function scheduleAutoFollowup(a: Args): Promise<string> {
  const { db } = a;
  if (a.channel !== "whatsapp" || !a.leadId || !a.recipient) return "fora do escopo";
  if (!(await cfgBool(db, "FOLLOWUP_AUTO_ENABLED", true))) return "desligado";

  const { data: lead } = await db.from("leads").select("id, metadata, handoff_status").eq("id", a.leadId).maybeSingle();
  const md = ((lead?.metadata as Record<string, any>) || {});
  if (md.nao_contatar === true) return "não contatar";
  if (md.pausa_encerrada_em && Date.now() - new Date(md.pausa_encerrada_em).getTime() < 30 * 86400_000) return "encerrou na pausa";
  const { count: visitas } = await db.from("company_activities").select("id", { count: "exact", head: true })
    .eq("lead_id", a.leadId).eq("task_type", "meeting").gte("scheduled_at", new Date().toISOString()).not("status", "in", "(cancelled,canceled)");
  if ((visitas || 0) > 0) return "já tem visita marcada";

  // última mensagem do CLIENTE nesta sessão → os follow-ups contam a partir dela
  const { data: lastUser } = await db.from("agents_messages").select("created_at").eq("session_id", a.sessionId).eq("role", "user")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  const desde = lastUser?.created_at || "1970-01-01";
  // repassou pra loja ou se despediu depois da última mensagem do cliente → sem follow-up
  const { data: recentes } = await db.from("agents_messages").select("content, tool_calls").eq("session_id", a.sessionId).eq("role", "assistant")
    .gte("created_at", desde).order("created_at", { ascending: false }).limit(6);
  for (const m of (recentes || []) as any[]) {
    const tc = JSON.stringify(m.tool_calls || "");
    if (/repassar_lead_loja/.test(tc)) return "repassado pra loja";
    if (String(m.content || "").trim() === "NAO_ENVIAR") return "agente decidiu não retomar";
  }
  const { count: enviados } = await db.from("agent_reminders").select("id", { count: "exact", head: true })
    .eq("session_id", a.sessionId).eq("status", "sent").gte("created_at", desde).contains("resume_context", { kind: "followup_auto" });
  const { count: pausas } = await db.from("agent_reminders").select("id", { count: "exact", head: true })
    .eq("session_id", a.sessionId).eq("status", "sent").gte("created_at", desde).contains("resume_context", { kind: "pausa" });
  const n = Math.max(Number(enviados || 0) + Number(pausas || 0), Number(a.stepHint || 0));

  let fireAt: Date; let kind: "followup_auto" | "pausa"; let step: number;
  if (n === 0) { fireAt = proximoHorario(await cfgNum(db, "FOLLOWUP_1_HOURS", 3)); kind = "followup_auto"; step = 1; }
  else if (n === 1) { fireAt = amanha930(); kind = "followup_auto"; step = 2; }
  else if (n === 2 && (await cfgBool(db, "FOLLOWUP_PAUSA_ENABLED", true))) { fireAt = proximoHorario(await cfgNum(db, "FOLLOWUP_PAUSA_HOURS", 48)); kind = "pausa"; step = 3; }
  else return "cadência completa";

  // 1 pendente por sessão: cancela o anterior e agenda o novo
  await db.from("agent_reminders").update({ status: "cancelled" }).eq("session_id", a.sessionId).eq("status", "pending").is("repeat_every_minutes", null);
  const { error } = await db.from("agent_reminders").insert({
    tenant_id: a.tenantId, agent_id: a.agentId, session_id: a.sessionId, channel: "whatsapp", fire_at: fireAt.toISOString(),
    message: kind === "pausa" ? "Mensagem de pausa com botões" : `Retomada automática (passo ${step}): cliente sem responder`,
    resume_context: { kind, step, lead_id: a.leadId, instance_id: a.instanceId, recipient: a.recipient, user_id: null },
    status: "pending",
  });
  if (error) { log("insert:", error.message); return `erro: ${error.message}`; }
  return `${kind} passo ${step} em ${fireAt.toISOString()}`;
}

/** Instrução que o poller manda pro agente escrever a retomada (passos 1 e 2). */
export function instrucaoRetomada(step: number): string {
  return [
    `[SISTEMA] O cliente não respondeu sua última mensagem (retomada automática, passo ${step} de 2). Escreva UMA mensagem curta pra retomar a conversa, na sua voz.`,
    "Regras: traga VALOR NOVO (uma unidade disponível, um dado do carro, a conta, um horário livre), nunca 'e aí?', 'ainda tem interesse?' ou 'quer conversar depois?'. Uma pergunta só, fácil de responder sim. No máximo 2 frases. Não chame ferramentas de agendamento.",
    "Se o cliente se despediu, recusou, disse que já comprou, pediu pra não falar mais, ou já foi repassado pra loja: responda EXATAMENTE a palavra NAO_ENVIAR e nada mais.",
  ].join("\n");
}

/** Passo 3: mensagem de pausa com botões, direto pelo número oficial (sem passar pelo modelo). */
export async function enviarPausa(db: SupabaseClient, ctx: { lead_id?: string | null; recipient?: string | null; tenant_id?: string | null }): Promise<string> {
  const phone = String(ctx.recipient || "").replace(/\D/g, "");
  if (!phone) return "sem telefone";
  const quem = (await getIntegrationKey(db, "REAQUECIMENTO_ASSINATURA")) || "Nina";
  const { nome } = await assuntoDoLead(db, ctx.lead_id || null);
  const texto = `${nome ? `Oi, ${nome}! ` : "Oi! "}Faz um tempinho que a gente não se fala por aqui, então vou deixar sua conversa em pausa pra não te encher. Quando quiser retomar, é só tocar numa opção abaixo. Fico por aqui pro que precisar 😊`;
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY };
  // janela de 24 h?
  const { data: lastIn } = await db.from("whatsapp_messages").select("created_at").eq("is_from_me", false).ilike("remote_jid", `%${phone.slice(-8)}%`).order("created_at", { ascending: false }).limit(1).maybeSingle();
  const aberta = !!lastIn?.created_at && Date.now() - new Date(lastIn.created_at).getTime() < 23 * 3600_000;
  const body = aberta
    ? { action: "send_buttons", phone, text: texto, buttons: PAUSA_BOTOES, lead_id: ctx.lead_id, tenant_id: ctx.tenant_id, sent_by: "followup_auto" }
    : { action: "send_template", phone, template_name: "pausa_conversa", template_params: [nome, quem], lead_id: ctx.lead_id, tenant_id: ctx.tenant_id, sent_by: "followup_auto" };
  const r = await fetch(`${SUPABASE_URL}/functions/v1/send-whatsapp-cloud`, { method: "POST", headers, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.error) { log("pausa falhou:", r.status, JSON.stringify(j).slice(0, 200)); return `erro: ${JSON.stringify(j).slice(0, 120)}`; }
  if (ctx.lead_id) {
    const { data: l } = await db.from("leads").select("metadata").eq("id", ctx.lead_id).maybeSingle();
    await db.from("leads").update({ metadata: { ...((l?.metadata as Record<string, unknown>) || {}), pausa_enviada_em: new Date().toISOString() } }).eq("id", ctx.lead_id);
  }
  return aberta ? "botões" : "template pausa_conversa";
}
