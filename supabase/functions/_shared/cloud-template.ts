// Envia um TEMPLATE aprovado pro CLIENTE via API oficial (WhatsApp Cloud).
// Cliente 1:1 fora da janela de 24h SÓ pode receber template aprovado — e NUNCA
// via UAZAPI (regra dura do banimento). Delega pra edge function send-whatsapp-cloud
// (action send_template), que lê as credenciais oficiais (globais) e envia.
//
// Uso:
//   import { sendTemplateViaCloud } from "../_shared/cloud-template.ts";
//   await sendTemplateViaCloud({ phone, templateName: "lembrete_agendamento",
//     params: [nome, loja, quando], leadId, tenantId });

export async function sendTemplateViaCloud(opts: {
  phone: string;
  templateName: string;
  params?: string[];
  leadId?: string | null;
  tenantId?: string | null;
  language?: string;
}): Promise<boolean> {
  const base = Deno.env.get("SUPABASE_URL");
  const phone = String(opts.phone || "").replace(/\D/g, "");
  if (!base || !phone || !opts.templateName) return false;
  try {
    const res = await fetch(`${base}/functions/v1/send-whatsapp-cloud`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "send_template",
        phone,
        lead_id: opts.leadId ?? null,
        tenant_id: opts.tenantId ?? null,
        template_name: opts.templateName,
        template_language: opts.language ?? "pt_BR",
        template_params: (opts.params ?? []).map((p) => String(p ?? "")),
      }),
    });
    if (!res.ok) {
      console.error("[cloud-template] send-whatsapp-cloud", res.status, (await res.text().catch(() => "")).slice(0, 200));
    }
    return res.ok;
  } catch (e) {
    console.error("[cloud-template]", (e as Error).message);
    return false;
  }
}
