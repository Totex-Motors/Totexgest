/**
 * CADÊNCIA DA NINA QUANDO O CLIENTE NÃO ATENDE (decisão do Marco, 2026-10-15):
 *   1ª ligação não atendida  → liga de novo em 15 min
 *   2ª não atendida          → manda no WhatsApp uma mensagem que desperte curiosidade
 *                              e liga de novo em 1 h
 *   3ª não atendida          → 3 h depois manda a 2ª mensagem e encerra (no_answer)
 * O reaquecimento (lead-rewarm) e o agente de texto continuam dali.
 *
 * Horário: tudo cai dentro do horário da Nina (nina_business_time). Mensagens pelo número
 * OFICIAL (Cloud API): janela de 24 h aberta → texto livre; fechada → template aprovado
 * (nina_curiosidade_1 / nina_curiosidade_2). Template ainda pendente → pula a mensagem,
 * mas a cadência de ligações segue.
 * Config: NINA_RETRY_1_MIN (15), NINA_RETRY_2_MIN (60), NINA_MSG2_HOURS (3).
 *
 * Fila: nina_call_queue. A 2ª mensagem usa status 'queued' + metadata.step = 'msg2'
 * (o discador manda a mensagem em vez de discar).
 */
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "./config.ts";
import { buildLeadBrief } from "./lead-brief.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const HQ_TENANT = "c13681e3-5db9-48d1-9c5c-856e6041d77f";
const log = (...a: unknown[]) => console.log("[nina-cadence]", ...a);

type QueueRow = { id: string; tenant_id: string | null; lead_id: string | null; phone: string; attempts: number | null; max_attempts: number | null; metadata: Record<string, any> | null; playbook: string | null };

async function cfgNum(sb: SupabaseClient, key: string, def: number): Promise<number> {
  const v = Number(await getIntegrationKey(sb, key));
  return Number.isFinite(v) && v > 0 ? v : def;
}

async function businessTime(sb: SupabaseClient, ms: number): Promise<string> {
  const target = new Date(Date.now() + ms).toISOString();
  const { data } = await sb.rpc("nina_business_time", { p_ts: target });
  return (data as string) || target;
}

/** "o Nivus que você viu" / "o seu Onix" / "o carro que você procura" — vai no {{3}} do template. */
export async function assuntoDoLead(sb: SupabaseClient, leadId: string | null): Promise<{ nome: string; assunto: string }> {
  return assunto(sb, leadId);
}
async function assunto(sb: SupabaseClient, leadId: string | null): Promise<{ nome: string; assunto: string }> {
  const brief = leadId ? await buildLeadBrief(sb, leadId).catch(() => null) : null;
  const nome = /\p{L}{2,}/u.test(brief?.primeiro_nome || "") ? String(brief!.primeiro_nome) : "";
  const interesse = brief?.carro_interesse_fala || brief?.carro_interesse || null;
  const doCliente = brief?.carro_do_cliente?.fala || brief?.carro_do_cliente?.descricao || null;
  const pb = brief?.playbook || "descobrir";
  const a = (pb === "vender" || pb === "trocar") && doCliente ? `o seu ${doCliente}` : interesse ? `o ${interesse} que você viu` : doCliente ? `o seu ${doCliente}` : "o carro que você procura";
  return { nome, assunto: a };
}

async function templateAprovado(sb: SupabaseClient, name: string): Promise<boolean> {
  const { data: tpl } = await sb.from("whatsapp_cloud_templates").select("id, status, meta_waba_id").eq("name", name).limit(1).maybeSingle();
  if (!tpl) return false;
  if (String(tpl.status).toUpperCase() === "APPROVED") return true;
  // status pode ter mudado na Meta desde o último sync
  try {
    const { data: inst } = await sb.from("whatsapp_instances").select("api_key").eq("provider", "meta_cloud").limit(1).maybeSingle();
    if (!inst?.api_key || !tpl.meta_waba_id) return false;
    const r = await fetch(`https://graph.facebook.com/v22.0/${tpl.meta_waba_id}/message_templates?name=${encodeURIComponent(name)}&fields=status`, { headers: { Authorization: `Bearer ${inst.api_key}` } });
    const j = await r.json().catch(() => ({}));
    const live = j?.data?.[0]?.status;
    if (live && live !== tpl.status) await sb.from("whatsapp_cloud_templates").update({ status: live, updated_at: new Date().toISOString() }).eq("id", tpl.id);
    return String(live || "").toUpperCase() === "APPROVED";
  } catch { return false; }
}

async function janelaAberta(sb: SupabaseClient, leadId: string | null, phone: string): Promise<boolean> {
  let q = sb.from("whatsapp_messages").select("created_at").eq("is_from_me", false).order("created_at", { ascending: false }).limit(1);
  q = leadId ? q.eq("lead_id", leadId) : q.ilike("phone", `%${phone.slice(-8)}`);
  const { data } = await q.maybeSingle();
  return !!data?.created_at && Date.now() - new Date(data.created_at).getTime() < 23 * 3600_000;
}

/** Manda a mensagem de curiosidade (1 ou 2). Devolve como foi (ou por que não foi). */
export async function enviarCuriosidade(sb: SupabaseClient, row: QueueRow, step: 1 | 2): Promise<string> {
  const quem = (await getIntegrationKey(sb, "REAQUECIMENTO_ASSINATURA")) || "Nina";
  const { nome, assunto: a } = await assunto(sb, row.lead_id);
  const texto = step === 1
    ? `${nome ? `Oi, ${nome}! ` : "Oi! "}Aqui é a ${quem}, da Totex Motors. Tentei te ligar sobre ${a} e não consegui. Descobri um detalhe que muda a conta e acho que você vai querer saber antes de decidir. Posso te contar por aqui?`
    : `Oi de novo${nome ? `, ${nome}` : ""}! É a ${quem}, da Totex Motors. Separei o número sobre ${a} que mais surpreende quem vê: a parcela com o décimo terceiro derrubando as últimas. Te mando em uma linha?`;
  const tenantId = row.tenant_id || HQ_TENANT;
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY };
  const aberta = await janelaAberta(sb, row.lead_id, row.phone);
  let body: Record<string, unknown>;
  let via: string;
  if (aberta) {
    body = { action: "send_text", phone: row.phone, text: texto, lead_id: row.lead_id, tenant_id: tenantId, sent_by: "nina_dialer" };
    via = "texto";
  } else {
    const tpl = step === 1 ? "nina_curiosidade_1" : "nina_curiosidade_2";
    if (!(await templateAprovado(sb, tpl))) { log(`template ${tpl} ainda não aprovado — mensagem ${step} pulada (${row.phone})`); return `template ${tpl} pendente`; }
    body = { action: "send_template", phone: row.phone, template_name: tpl, template_params: [nome || "tudo bem", quem, a], lead_id: row.lead_id, tenant_id: tenantId, sent_by: "nina_dialer" };
    via = `template:${tpl}`;
  }
  const r = await fetch(`${SUPABASE_URL}/functions/v1/send-whatsapp-cloud`, { method: "POST", headers, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.error) { log(`mensagem ${step} falhou:`, r.status, JSON.stringify(j).slice(0, 200)); return `erro: ${JSON.stringify(j).slice(0, 120)}`; }
  return via;
}

/**
 * Ligação NÃO atendida: aplica a cadência. `attempts` = tentativas já feitas (incluindo esta).
 * Chamada pelo voice-agent-postcall (webhook) e pelo nina-dialer (ligação travada/falha).
 */
export async function settleNoAnswer(sb: SupabaseClient, row: QueueRow): Promise<string> {
  const attempts = Number(row.attempts || 0);
  const maxA = Math.max(3, Number(row.max_attempts || 3));
  const md = { ...(row.metadata || {}) };
  const now = new Date().toISOString();
  (md.nao_atendeu = Array.isArray(md.nao_atendeu) ? md.nao_atendeu : []).push(now);

  if (attempts <= 1) {
    const min = await cfgNum(sb, "NINA_RETRY_1_MIN", 15);
    const next = await businessTime(sb, min * 60_000);
    await sb.from("nina_call_queue").update({ status: "queued", outcome: "nao_atendeu", scheduled_for: next, metadata: md, last_error: `não atendeu (1ª); liga de novo em ${min} min` }).eq("id", row.id);
    return `retenta em ${min} min`;
  }
  if (attempts === 2) {
    const via = await enviarCuriosidade(sb, row, 1);
    md.msg1 = { em: now, via };
    const min = await cfgNum(sb, "NINA_RETRY_2_MIN", 60);
    const next = await businessTime(sb, min * 60_000);
    await sb.from("nina_call_queue").update({ status: "queued", outcome: "nao_atendeu", scheduled_for: next, metadata: md, max_attempts: maxA, last_error: `não atendeu (2ª); msg 1 ${via}; liga de novo em ${min} min` }).eq("id", row.id);
    return `msg 1 (${via}) + retenta em ${min} min`;
  }
  // 3ª (ou mais): a 2ª mensagem vai daqui a N horas e encerra
  const h = await cfgNum(sb, "NINA_MSG2_HOURS", 3);
  const next = await businessTime(sb, h * 3600_000);
  await sb.from("nina_call_queue").update({ status: "queued", outcome: "nao_atendeu", scheduled_for: next, metadata: { ...md, step: "msg2" }, last_error: `não atendeu (${attempts}ª); msg 2 em ${h} h e encerra` }).eq("id", row.id);
  return `msg 2 em ${h} h`;
}

/** Linhas 'queued' com metadata.step = 'msg2' que venceram: manda a 2ª mensagem e encerra. */
export async function processarMensagensPendentes(sb: SupabaseClient): Promise<number> {
  const { data } = await sb.from("nina_call_queue").select("id, tenant_id, lead_id, phone, attempts, max_attempts, metadata, playbook")
    .eq("status", "queued").contains("metadata", { step: "msg2" }).lte("scheduled_for", new Date().toISOString()).limit(5);
  let n = 0;
  for (const row of (data || []) as QueueRow[]) {
    const via = await enviarCuriosidade(sb, row, 2);
    const { step: _s, ...rest } = row.metadata || {};
    await sb.from("nina_call_queue").update({ status: "no_answer", outcome: "nao_atendeu", metadata: { ...rest, msg2: { em: new Date().toISOString(), via } }, last_error: `encerrado: não atendeu 3x; msg 2 ${via}` }).eq("id", row.id);
    n++;
  }
  return n;
}
