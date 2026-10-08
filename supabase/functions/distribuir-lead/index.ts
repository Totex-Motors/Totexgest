/**
 * distribuir-lead — distribui um lead do master pra loja dona (tenant) e avisa o
 * grupo de handoff da loja. É a primitiva do modelo "IA central + número oficial
 * único → lead cai na loja certa".
 *
 * POST { lead_id, target_tenant_id?, motivo? }
 *  - target_tenant_id: se não vier, usa leads.metadata.owner_tenant_id (casado pela IA).
 *
 * O que faz:
 *  1. Acha/cria o lead no tenant da loja (por telefone) — assim o roteamento de
 *     entrada (whatsapp-cloud-webhook) passa a jogar as respostas do cliente pra
 *     loja. A ORIGEM fica gravada (royalty/atribuição) nos dois lados.
 *  2. Avisa o grupo de handoff da loja (tenant_lead_destinations, destino grupo)
 *     via wa_send_group_text — UAZAPI SÓ EM GRUPO (regra dura), com o guarda de
 *     política dentro da rpc.
 *
 * Service-to-service (verify_jwt=false), chamada por tool do agente / automação.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const digits = (s: unknown) => String(s ?? "").replace(/\D/g, "");

Deno.serve(async (req) => {
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const body = await req.json().catch(() => ({}));
    const leadId = body.lead_id as string | undefined;
    const motivo = (body.motivo as string | undefined) || null;
    if (!leadId) return json({ success: false, error: "lead_id obrigatório" }, 400);

    // 1. Lead de origem (master)
    const { data: src } = await sb.from("leads")
      .select("id, tenant_id, name, phone, email, metadata")
      .eq("id", leadId).maybeSingle();
    if (!src) return json({ success: false, error: "lead não encontrado" }, 404);

    const meta = (src.metadata || {}) as Record<string, any>;
    const targetTenantId: string | null = body.target_tenant_id || meta.owner_tenant_id || null;
    if (!targetTenantId) {
      return json({ success: false, message: "Sem loja dona definida (target_tenant_id / metadata.owner_tenant_id)." });
    }
    if (targetTenantId === src.tenant_id) {
      return json({ success: true, message: "Lead já está no tenant da loja.", target_lead_id: src.id, notified: false });
    }

    const phone = digits(src.phone);
    const last8 = phone.slice(-8);

    // 2. Acha/cria o lead na loja pela porta única (passo 2 — docs/ENTRADAS-DE-LEADS.md):
    //    dedupe por telefone DENTRO da loja, determinístico, com trava anti-corrida.
    //    "Primeira porta vence": se o lead já existe na loja, o metadata DELE é preservado
    //    (antes era SOBRESCRITO pelo do master) e `origin` só entra se ainda não havia
    //    atribuição.
    const origin = {
      origin_tenant_id: src.tenant_id, origin_lead_id: src.id,
      distributed_at: new Date().toISOString(), motivo,
    };
    if (!last8 || phone.length < 10) {
      return json({ success: false, error: "lead sem telefone válido pra distribuir" }, 400);
    }
    const { data: foc, error: cErr } = await sb.rpc("find_or_create_lead", {
      p_tenant: targetTenantId,
      p_phone: phone,
      p_name: src.name || null,
      p_source: "distribuicao",
      p_email: src.email || null,
      p_lead_kind: "buyer",
      p_metadata: { ...(meta || {}), origin },
    });
    if (cErr || !foc?.lead_id) {
      return json({ success: false, error: `falha ao achar/criar lead na loja: ${cErr?.message ?? "sem id"}` }, 500);
    }
    const targetLeadId: string = foc.lead_id;

    // grava no lead de origem pra onde foi (atribuição)
    await sb.from("leads").update({
      metadata: { ...(meta || {}), distributed_to: { tenant_id: targetTenantId, lead_id: targetLeadId, at: origin.distributed_at } },
    }).eq("id", src.id);

    // 3. Avisa o grupo de handoff da loja (se houver destino ativo)
    let notified = false;
    const { data: dest } = await sb.from("tenant_lead_destinations")
      .select("whatsapp_target, destination_type, label")
      .eq("tenant_id", targetTenantId).eq("active", true)
      .order("created_at", { ascending: true }).limit(1).maybeSingle();

    if (dest?.whatsapp_target && (dest.destination_type === "group" || String(dest.whatsapp_target).includes("@g.us"))) {
      const { data: inst } = await sb.from("whatsapp_instances")
        .select("id").eq("provider", "uazapi").eq("status", "connected").limit(1).maybeSingle();
      if (inst?.id) {
        const carro = meta?.vehicle?.title || meta?.vehicle?.titulo || meta?.veiculo_interesse?.titulo || null;
        const preco = meta?.vehicle?.price || meta?.vehicle?.preco || meta?.veiculo_interesse?.preco || null;
        const texto =
          `🚗 *Novo lead pra vocês!*\n\n` +
          `👤 ${src.name || phone}\n` +
          (phone ? `📱 ${phone}\n` : "") +
          (carro ? `🚙 ${carro}${preco ? ` — ${preco}` : ""}\n` : "") +
          (motivo ? `📝 ${motivo}\n` : "") +
          `\nO cliente já está falando com a gente no WhatsApp oficial. Bora fechar! 💪`;
        const { data: ok } = await sb.rpc("wa_send_group_text", {
          p_instance_id: inst.id, p_group_jid: dest.whatsapp_target, p_text: texto, p_mentions: null,
        });
        notified = ok === true;
      }
    }

    return json({ success: true, target_lead_id: targetLeadId, target_tenant_id: targetTenantId, notified });
  } catch (e) {
    console.error("[distribuir-lead]", (e as Error).message);
    return json({ success: false, error: (e as Error).message }, 500);
  }
});
