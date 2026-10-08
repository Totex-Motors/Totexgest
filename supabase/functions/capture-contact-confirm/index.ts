import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================================
// CONFIRMAÇÃO DE 1º CONTATO PELO GRUPO — Fase 2 (SLA humano)
// O especialista responde "Chamei" / "Liguei" / "Falei" no grupo de handoff da
// captação — de preferência CITANDO o card do lead — e isso marca o 1º contato
// (fecha o SLA, para a cobrança e a escalada). Antes, só conversa 1:1 ou tarefa
// concluída marcavam; o "Chamei" no grupo era ignorado e o sistema escalava.
//
// Chamada pelo whatsapp-webhook (service-to-service, fire-and-forget).
// Regra anti-ban: a resposta ao grupo vai pela RPC wa_send_group_text (só grupo).
// POST { tenant_id, instance_id, group_jid, sender_phone, sender_name, text, quoted_message_id }
// ============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const LOG = "[capture-contact-confirm]";

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const digits = (s: unknown) => String(s ?? "").replace(/\D/g, "");
const firstName = (n?: string | null) => (n || "").trim().split(/\s+/)[0] || "";

/** "Chamei", "já liguei", "falei com ele", "fiz contato", "mandei msg"… no começo da mensagem. */
export const CONFIRM_RE =
  /^\s*(?:j[aá]\s+)?(?:chamei|liguei|falei|contatei|atendi|respondi|fiz\s+contato|entrei\s+em\s+contato|mandei\s+(?:msg|mensagem|whats))\b/i;

/** Acha um telefone BR dentro do texto do card ("(11) 99560-5557", "5511995605557"…). */
function extractPhone(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.match(/(?:\+?55\s?)?\(?\d{2}\)?\s?9?\s?\d{4}[-\s]?\d{4}/);
  if (!m) return null;
  const d = digits(m[0]);
  return d.length >= 10 ? d : null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "Função sem configuração do Supabase" }, 500);
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const tenantId = String(body.tenant_id ?? "").trim();
    const groupJid = String(body.group_jid ?? "").trim();
    const text = String(body.text ?? "");
    const senderPhone = digits(body.sender_phone);
    const quotedId = body.quoted_message_id ? String(body.quoted_message_id) : null;
    if (!tenantId || !groupJid || !text) return json({ ignored: true, reason: "payload_incompleto" });
    if (!CONFIRM_RE.test(text)) return json({ ignored: true, reason: "nao_parece_confirmacao" });

    // 1. Só age no grupo de handoff da captação (ou no grupo de alertas da operação) do tenant.
    const [{ data: cfg }, { data: op }] = await Promise.all([
      sb.from("capture_handoff_config").select("whatsapp_group_jid, whatsapp_instance_id").eq("tenant_id", tenantId).maybeSingle(),
      sb.from("operation_alert_config").select("whatsapp_group_jid, whatsapp_instance_id").eq("tenant_id", tenantId).maybeSingle(),
    ]);
    const groups = [cfg?.whatsapp_group_jid, op?.whatsapp_group_jid].filter(Boolean) as string[];
    if (!groups.includes(groupJid)) return json({ ignored: true, reason: "nao_e_grupo_de_handoff" });

    // 2. Quem respondeu (membro do time, pelos últimos 8 dígitos do telefone).
    let member: { id: string; name: string } | null = null;
    if (senderPhone.length >= 8) {
      const { data: members } = await sb.from("team_members").select("id, name, phone")
        .eq("tenant_id", tenantId).eq("is_active", true).ilike("phone", `%${senderPhone.slice(-8)}`).limit(1);
      member = (members?.[0] as { id: string; name: string } | undefined) ?? null;
    }

    // 3. Qual lead? (a) citou o card → telefone do card; (b) senão, o lead pendente mais
    //    recente desse especialista.
    let leadId: string | null = null;
    let how = "";
    if (quotedId) {
      const { data: qm } = await sb.from("whatsapp_messages").select("content").eq("message_id", quotedId).limit(1).maybeSingle();
      const phoneInCard = extractPhone(qm?.content as string | undefined);
      if (phoneInCard) {
        const { data: found } = await sb.rpc("find_lead_by_phone", { p_tenant: tenantId, p_phone: phoneInCard });
        const cand = found?.[0] as { id: string; captured_by_member_id: string | null } | undefined;
        if (cand?.captured_by_member_id) { leadId = cand.id; how = "citou_o_card"; }
      }
    }
    if (!leadId && member) {
      const { data: pend } = await sb.from("leads").select("id")
        .eq("tenant_id", tenantId).eq("handoff_member_id", member.id)
        .not("captured_by_member_id", "is", null).not("handoff_at", "is", null).is("first_contact_at", null)
        .order("handoff_at", { ascending: false }).limit(1);
      if (pend?.[0]) { leadId = (pend[0] as { id: string }).id; how = "pendente_do_especialista"; }
    }
    if (!leadId) return json({ ok: false, reason: "lead_nao_identificado", member: member?.name ?? null });

    // 4. Marca o 1º contato (no-op se já estava marcado).
    const { data: marked, error } = await sb.rpc("capture_mark_first_contact", {
      p_lead_id: leadId, p_source: "grupo", p_actor: member?.id ?? null,
    });
    if (error) { console.error(LOG, "mark err:", error.message); return json({ ok: false, error: error.message }, 500); }
    const { data: lead } = await sb.from("leads").select("name").eq("id", leadId).maybeSingle();

    // 5. Confirma no grupo (só grupo — a guarda de política fica dentro da RPC).
    const instId = String(body.instance_id ?? "") || cfg?.whatsapp_instance_id || op?.whatsapp_instance_id || null;
    let replied = false;
    if (instId) {
      const who = firstName(member?.name) || "especialista";
      const txt = marked
        ? `✅ 1º contato registrado — *${lead?.name ?? "lead"}* (${who}). SLA encerrado.`
        : `ℹ️ *${lead?.name ?? "lead"}* já estava marcado como contatado.`;
      const { data: ok } = await sb.rpc("wa_send_group_text", { p_instance_id: instId, p_group_jid: groupJid, p_text: txt, p_mentions: null });
      replied = ok === true;
    }

    console.log(LOG, `lead=${leadId} marked=${!!marked} how=${how} by=${member?.name ?? senderPhone}`);
    return json({ ok: true, lead_id: leadId, marked: !!marked, how, replied });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(LOG, "erro:", message);
    return json({ error: message }, 500);
  }
});
