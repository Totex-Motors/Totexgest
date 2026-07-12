/**
 * wa-delivery — entrega de mensagens do agente no WhatsApp quando NÃO há
 * webhook inbound pra responder (lembretes/follow-ups disparados pelo poller
 * com context._system_resume).
 *
 * Regras:
 *  - Instância UAZAPI (não-oficial): sem janela — envia texto livre direto.
 *  - Instância Cloud API (oficial Meta): só permite texto livre DENTRO da
 *    janela de 24h (cliente falou nas últimas 24h). Fora dela, envia um
 *    TEMPLATE APROVADO (nutrição/follow-up):
 *      1. agent.settings.followup_template_name
 *      2. fallback: config WHATSAPP_FOLLOWUP_TEMPLATE (getIntegrationKey)
 *    Sem template configurado → não envia (loga o motivo) — a Meta rejeitaria
 *    a mensagem livre de qualquer forma.
 *
 * O texto entregue também é o que fica registrado no inbox (whatsapp_messages
 * é preenchido pelo send-whatsapp-cloud / fluxo UAZAPI normal).
 */
import { getIntegrationKey } from "../../_shared/config.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

interface DeliverOpts {
  db: any; // service-role client
  tenantId: string | null;
  agentSettings: Record<string, unknown> | null;
  texts: string[];
  recipient: string;
  instanceId?: string | null;
  leadId?: string | null;
}

export async function deliverFollowupWhatsApp(opts: DeliverOpts): Promise<void> {
  const { db, tenantId, agentSettings, recipient, instanceId, leadId } = opts;
  const text = opts.texts.map((t) => (t || "").trim()).filter(Boolean).join("\n\n");
  const digits = recipient.replace(/\D/g, "");
  if (!text || !digits) return;

  // Carrega a instância (credenciais só aqui no servidor)
  let instance: { id: string; api_url: string | null; api_key: string | null; metadata: Record<string, unknown> | null } | null = null;
  if (instanceId) {
    const { data } = await db
      .from("whatsapp_instances")
      .select("id, api_url, api_key, metadata")
      .eq("id", instanceId)
      .maybeSingle();
    instance = data;
  }

  const meta = (instance?.metadata ?? {}) as Record<string, unknown>;
  const isCloud = Boolean(meta.phone_number_id || meta.type === "cloud_api");

  // ─── UAZAPI: sem janela — texto livre direto ───
  if (instance && !isCloud && instance.api_url && instance.api_key) {
    try {
      const res = await fetch(`${String(instance.api_url).replace(/\/$/, "")}/send/text`, {
        method: "POST",
        headers: { "Content-Type": "application/json", token: instance.api_key },
        body: JSON.stringify({ number: digits, text }),
      });
      if (!res.ok) console.error(`[wa-delivery] UAZAPI ${res.status}: ${await res.text()}`);
    } catch (e) {
      console.error("[wa-delivery] UAZAPI err:", (e as Error).message);
    }
    return;
  }

  // ─── Cloud API: checa a janela de 24h ───
  // Janela aberta = existe mensagem RECEBIDA (is_from_me=false) do contato nas
  // últimas 24h nessa instância.
  let insideWindow = false;
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    let q = db
      .from("whatsapp_messages")
      .select("id", { count: "exact", head: true })
      .eq("is_from_me", false)
      .gte("created_at", since)
      .ilike("remote_jid", `%${digits}%`);
    if (instanceId) q = q.eq("instance_id", instanceId);
    const { count } = await q;
    insideWindow = (count ?? 0) > 0;
  } catch (e) {
    console.warn("[wa-delivery] window check falhou (assumindo fora):", (e as Error).message);
  }

  const invokeCloud = async (body: Record<string, unknown>) => {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-whatsapp-cloud`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SERVICE_KEY}`,
        apikey: SERVICE_KEY,
      },
      body: JSON.stringify({ phone: digits, lead_id: leadId ?? undefined, tenant_id: tenantId ?? undefined, ...body }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.error) {
      console.error(`[wa-delivery] send-whatsapp-cloud falhou:`, JSON.stringify(data).slice(0, 300));
    }
    return data;
  };

  if (insideWindow) {
    await invokeCloud({ action: "send_text", text });
    return;
  }

  // ─── Fora da janela: template aprovado ───
  const settings = agentSettings ?? {};
  let templateName = typeof settings.followup_template_name === "string" && settings.followup_template_name
    ? String(settings.followup_template_name)
    : null;
  if (!templateName) {
    templateName = await getIntegrationKey(db, "WHATSAPP_FOLLOWUP_TEMPLATE", tenantId);
  }
  if (!templateName) {
    console.error(
      `[wa-delivery] FORA da janela de 24h e SEM template de follow-up configurado ` +
      `(agent.settings.followup_template_name ou config WHATSAPP_FOLLOWUP_TEMPLATE). ` +
      `Mensagem NÃO enviada pra ${digits}.`,
    );
    return;
  }

  // Params do template: por padrão 1 variável = primeiro nome do lead.
  // settings.followup_template_params = 0 desliga (template sem variáveis).
  let templateParams: string[] | undefined;
  const paramCount = typeof settings.followup_template_params === "number"
    ? settings.followup_template_params
    : 1;
  if (paramCount > 0) {
    let nome = "tudo bem";
    if (leadId) {
      const { data: lead } = await db.from("leads").select("name").eq("id", leadId).maybeSingle();
      if (lead?.name) nome = String(lead.name).trim().split(/\s+/)[0];
    }
    templateParams = [nome];
  }

  console.log(`[wa-delivery] fora da janela 24h → template "${templateName}" pra ${digits}`);
  await invokeCloud({ action: "send_template", template_name: templateName, template_params: templateParams });
}
