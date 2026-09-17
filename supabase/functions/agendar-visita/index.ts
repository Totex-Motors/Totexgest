/**
 * agendar-visita — tool do agente (Ronaldo). Registra o AGENDAMENTO no CRM e avisa a equipe.
 * Chamada pelo agent-runner com body { arguments, session_id }.
 *
 * arguments: { data_hora (ISO com fuso, ex 2026-09-18T15:00:00-03:00), loja, carro,
 *              vehicle_id?, nome_cliente?, tipo? (visita|test_drive|avaliacao), observacoes? }
 *
 * - grava em company_activities (metadata.tipo = 'agendamento') no tenant do agente
 *   e, se a loja dona for outra e o lead existir lá, também no tenant da loja
 * - avisa o grupo interno de operação (operation_alert_config) — só grupo autorizado
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendTemplateViaCloud } from "../_shared/cloud-template.ts";

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const digits = (s: unknown) => String(s ?? "").replace(/\D/g, "");
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

Deno.serve(async (req) => {
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const body = await req.json();
    const a = (body.arguments || {}) as Record<string, unknown>;
    const sessionId = body.session_id as string | undefined;
    if (!sessionId) return json({ error: "session_id obrigatório" }, 400);

    const inicio = new Date(String(a.data_hora || ""));
    if (isNaN(inicio.getTime())) {
      return json({ success: false, message: "data_hora inválida. Use ISO com fuso de Brasília, ex: 2026-09-18T15:00:00-03:00 (use current_time_br)." });
    }
    if (inicio.getTime() < Date.now() - 5 * 60_000) {
      return json({ success: false, message: "Esse horário já passou. Confirme a data com o cliente e use current_time_br." });
    }
    const fim = new Date(inicio.getTime() + 60 * 60_000);
    const tipo = ["visita", "test_drive", "avaliacao"].includes(String(a.tipo)) ? String(a.tipo) : "visita";
    const tipoLabel: Record<string, string> = { visita: "Visita", test_drive: "Test drive", avaliacao: "Avaliação do carro" };
    const loja = String(a.loja || "").trim();
    const carro = String(a.carro || "").trim();
    const obs = String(a.observacoes || "").trim();

    const { data: session } = await sb.from("agents_sessions")
      .select("id, tenant_id, agent_id, working_memory, provider_state").eq("id", sessionId).maybeSingle();
    if (!session) return json({ error: "sessão não encontrada" }, 404);
    const wm = (session.working_memory || {}) as Record<string, any>;
    const ps = (session.provider_state || {}) as Record<string, any>;
    const phone = digits(wm.customer_phone || ps.whatsapp_phone);
    const nome = String(a.nome_cliente || wm.customer_name || "Cliente").trim();

    // lead no tenant do agente
    let leadId: string | null = wm.lead_id || null;
    if (!leadId && phone) {
      const { data } = await sb.from("leads").select("id").eq("tenant_id", session.tenant_id)
        .eq("phone", phone).order("created_at", { ascending: false }).limit(1).maybeSingle();
      leadId = data?.id || null;
    }

    // loja dona (pré-casada pelo intake ou pelo nome)
    let ownerTenantId: string | null = wm.owner_tenant_id || null;
    let ownerName: string | null = wm.owner_label || null;
    if (!ownerTenantId && loja) {
      const { data: tenants } = await sb.from("tenants").select("id, name");
      const hit = (tenants || []).find((t: any) => norm(t.name).includes(norm(loja)) || norm(loja).includes(norm(t.name)));
      if (hit) { ownerTenantId = hit.id; ownerName = hit.name; }
    }
    ownerName = ownerName || loja || null;

    const hora = inicio.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    const titulo = `Agendamento: ${tipoLabel[tipo]} — ${nome}${carro ? ` (${carro})` : ""}`;
    const metadata = {
      tipo: "agendamento", modalidade: tipo, loja: ownerName, carro: carro || null,
      vehicle_id: a.vehicle_id || null, cliente_telefone: phone || null,
      origem: "agente", session_id: sessionId,
    };
    const base = {
      name: titulo,
      description: [`Cliente: ${nome}${phone ? ` (${phone})` : ""}`, carro && `Carro: ${carro}`, ownerName && `Loja: ${ownerName}`, obs && `Obs: ${obs}`].filter(Boolean).join("\n"),
      task_type: "meeting", team: "sales", status: "not_started", priority: "high",
      scheduled_at: inicio.toISOString(), due_datetime: inicio.toISOString(), end_datetime: fim.toISOString(),
      reminder_at: new Date(inicio.getTime() - 2 * 60 * 60_000).toISOString(),
      client_contact_method: "whatsapp", ai_generated: true, source_type: "agent", metadata,
    };

    const ids: string[] = [];
    const ins = await sb.from("company_activities")
      .insert({ ...base, tenant_id: session.tenant_id, lead_id: leadId }).select("id").single();
    if (ins.error) return json({ success: false, message: `Não consegui registrar: ${ins.error.message}` });
    ids.push(ins.data.id);

    if (ownerTenantId && ownerTenantId !== session.tenant_id && phone) {
      const { data: ol } = await sb.from("leads").select("id").eq("tenant_id", ownerTenantId)
        .eq("phone", phone).limit(1).maybeSingle();
      const r = await sb.from("company_activities")
        .insert({ ...base, tenant_id: ownerTenantId, lead_id: ol?.id || null }).select("id").single();
      if (!r.error) ids.push(r.data.id);
    }

    // aviso no grupo interno autorizado (nunca número particular)
    let avisado = false;
    const { data: cfg } = await sb.from("operation_alert_config")
      .select("whatsapp_group_jid, whatsapp_instance_id").eq("tenant_id", session.tenant_id).maybeSingle();
    if (cfg?.whatsapp_group_jid && cfg?.whatsapp_instance_id) {
      const texto = `📅 *Novo agendamento*\n\n👤 ${nome}${phone ? `\n📱 ${phone}` : ""}\n🗓️ ${hora}\n🎯 ${tipoLabel[tipo]}${carro ? `\n🚗 ${carro}` : ""}${ownerName ? `\n🏬 ${ownerName}` : ""}${obs ? `\n📝 ${obs}` : ""}\n\nConfirme o horário com a loja 👍`;
      const { data: ok } = await sb.rpc("wa_send_group_text", {
        p_instance_id: cfg.whatsapp_instance_id, p_group_jid: cfg.whatsapp_group_jid, p_text: texto, p_mentions: null,
      });
      avisado = ok === true;
    }

    // Confirma o agendamento pro CLIENTE via template oficial (Cloud API). Fora da
    // janela de 24h só template — e cliente 1:1 NUNCA via UAZAPI. Se o template
    // ainda não estiver aprovado na Meta, retorna false e o fluxo segue normal.
    let cliente_confirmado = false;
    if (phone) {
      cliente_confirmado = await sendTemplateViaCloud({
        phone,
        templateName: "confirmacao_agendamento",
        params: [nome, ownerName || "nossa loja", hora],
        leadId,
        tenantId: session.tenant_id,
      });
    }

    await sb.from("ai_critical_decisions").insert({
      tenant_id: session.tenant_id, lead_id: leadId, agent_id: session.agent_id,
      decision_type: "agendamento", decision: `${tipoLabel[tipo]} agendada ${hora}${ownerName ? ` — ${ownerName}` : ""}`,
      reason: obs || null, severity: "high", snapshot_data: { ids, metadata, avisado, cliente_confirmado },
    });

    return json({
      success: true, agendamento_ids: ids, equipe_avisada: avisado, cliente_confirmado,
      message: `Agendamento registrado: ${tipoLabel[tipo]} em ${hora}${ownerName ? ` na ${ownerName}` : ""}. Confirme com o cliente de forma natural e diga que a loja vai confirmar. Não repita este texto.`,
    });
  } catch (e) {
    console.error("[agendar-visita]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
