/**
 * lead-rewarm — REAQUECIMENTO de leads (decisão do Marco, 14/10/2026).
 *
 * Lead que entrou pelo stand/totem/promotora e esfriou NÃO recebia mensagem nenhuma
 * (104 leads em 45 dias sem uma mensagem). Aqui o CRM abre a conversa com uma CONTA
 * pronta (Simulador da Cardoso) e marca o lead como "em reaquecimento"; quando ele
 * responde, o agente do número oficial (Nina, agente-stand) entra no MODO REAQUECIMENTO
 * (bloco injetado pelo auto-context do agent-runner): desperta desejo, mostra o plano,
 * gera o cupom de R$ na parcela (48 h, Grazi) e avisa a Grazi quando houver intenção.
 *
 * Três momentos (config REAQUECIMENTO_*):
 *  A. saiu do stand sem agendar  — 30 min a 2 h depois (ainda no shopping)
 *  B. nunca recebeu mensagem     — depois de 24 h
 *  C. conversou e esfriou        — 3 dias sem resposta, sem agendamento
 * Canal: número OFICIAL (Cloud API). Janela de 24 h aberta → texto livre; fechada →
 * template aprovado pela Meta (reaquecimento_viu_carro / _trocar / _vender).
 *
 * Ações (POST):
 *  - { action: "run" }                      cron a cada 15 min (sem auth, como os outros crons)
 *  - { action: "avisar_grazi", lead_id }    tool do agente (chamar_grazi): resumo + cupom pro grupo
 *  - { action: "status" }                   contagem por momento (tela)
 * Regra inviolável respeitada: UAZAPI só em grupo (uazapiTargetAllowed).
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "../_shared/config.ts";
import { buildLeadBrief } from "../_shared/lead-brief.ts";
import { spokenCarName } from "../_shared/nina-store.ts";
import { uazapiTargetAllowed } from "../_shared/wa-policy.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const HQ_TENANT = "c13681e3-5db9-48d1-9c5c-856e6041d77f";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const log = (...a: unknown[]) => console.log("[lead-rewarm]", ...a);

type Momento = "A_saiu_do_stand" | "B_nunca_falou" | "C_esfriou";

async function cfgNum(sb: any, key: string, def: number) { const v = Number(await getIntegrationKey(sb, key)); return Number.isFinite(v) ? v : def; }

async function callEdge(fn: string, body: Record<string, unknown>) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY }, body: JSON.stringify(body) });
  const t = await r.text(); try { return { ok: r.ok, data: JSON.parse(t) }; } catch { return { ok: r.ok, data: { raw: t } }; }
}

const fala = (n: number) => `${Math.round(Number(n) || 0).toLocaleString("pt-BR")} reais`;
const horaBr = () => Number(new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "numeric", hour12: false }));

/** Template aprovado? (confere na Meta se o banco ainda diz PENDING — a aprovação chega sozinha) */
async function templateAprovado(sb: any, name: string): Promise<boolean> {
  const { data: tpl } = await sb.from("whatsapp_cloud_templates").select("id, status, meta_waba_id").eq("tenant_id", HQ_TENANT).eq("name", name).maybeSingle();
  if (!tpl) return false;
  if (String(tpl.status).toUpperCase() === "APPROVED") return true;
  if (!tpl.meta_waba_id) return false;
  const { data: inst } = await sb.from("whatsapp_instances").select("api_key").eq("provider", "meta_cloud").eq("tenant_id", HQ_TENANT).limit(1).maybeSingle();
  if (!inst?.api_key) return false;
  try {
    const r = await fetch(`https://graph.facebook.com/v22.0/${tpl.meta_waba_id}/message_templates?name=${encodeURIComponent(name)}&fields=status`, { headers: { Authorization: `Bearer ${inst.api_key}` } });
    const j = await r.json().catch(() => ({}));
    const live = j?.data?.[0]?.status;
    if (live && live !== tpl.status) await sb.from("whatsapp_cloud_templates").update({ status: live, updated_at: new Date().toISOString() }).eq("id", tpl.id);
    return String(live || "").toUpperCase() === "APPROVED";
  } catch { return false; }
}

/** Candidatos por momento. Só HQ (dono do número oficial), com telefone, sem agendamento,
 *  sem "não contatar", sem reaquecimento nos últimos 7 dias, nunca franquia. */
async function candidatos(sb: any, momento: Momento, limite: number) {
  const { data } = await sb.rpc("reaquecimento_candidatos", { p_tenant: HQ_TENANT, p_momento: momento, p_limite: limite });
  return (data || []) as Array<{ lead_id: string; phone: string; name: string | null; janela_aberta: boolean; created_at: string }>;
}

async function abrir(sb: any, lead: { lead_id: string; phone: string; name: string | null; janela_aberta: boolean }, momento: Momento) {
  const brief = await buildLeadBrief(sb, lead.lead_id).catch(() => null);
  // nome só se for nome mesmo: perfil "😎" virou "Oi, 😎!" na 1ª rodada (14/10)
  const nomeBruto = String(brief?.primeiro_nome || "").trim();
  const nome = /\p{L}{2,}/u.test(nomeBruto) && !/\d/.test(nomeBruto) ? nomeBruto : "";
  const playbook = brief?.playbook || "descobrir";
  let carroInteresse = brief?.carro_interesse_fala || brief?.carro_interesse || null;
  const carroCliente = brief?.carro_do_cliente?.fala || brief?.carro_do_cliente?.descricao || null;

  // plano pelo simulador (só quando tem carro de interesse com preço). Se o pátio só tem um
  // parecido (match aproximado), a mensagem cita o carro que foi CONTADO, não o que o lead viu.
  let plano: any = null;
  if (playbook === "comprar" && carroInteresse) {
    const r = await callEdge("simulador-cardoso", { action: "plano", carro: brief?.carro_interesse || carroInteresse });
    if (r.ok && r.data?.success) {
      plano = r.data;
      if (plano.match_exato === false && plano.carro) carroInteresse = spokenCarName(plano.carro) || carroInteresse;
    }
  }

  // escolhe modelo/texto
  let template: string | null = null; let params: string[] = []; let texto = "";
  const quem = (await getIntegrationKey(sb, "REAQUECIMENTO_ASSINATURA")) || "Nina";
  if (playbook === "comprar" && carroInteresse && plano?.plano?.parcela) {
    template = "reaquecimento_viu_carro"; params = [nome || "tudo bem", quem, carroInteresse, fala(plano.plano.parcela)];
    texto = `Oi, ${nome ? nome : "tudo bem"}! Aqui é a ${quem}, da Totex Motors. Fiz uma conta rápida no ${carroInteresse} que você viu: dá pra ficar em ${fala(plano.plano.parcela)} por mês, e tem um jeito de derrubar as últimas parcelas com o décimo terceiro. Quer que eu te mostre como?`;
  } else if (playbook === "trocar" && carroCliente) {
    template = "reaquecimento_trocar"; params = [nome || "tudo bem", quem, carroCliente];
    texto = `Oi, ${nome ? nome : "tudo bem"}! Aqui é a ${quem}, da Totex Motors. O seu ${carroCliente} entra na troca valendo mais do que numa loja comum, e vi uma opção que encaixa no que você procura. Posso te mandar a conta?`;
  } else if (playbook === "vender" && carroCliente) {
    template = "reaquecimento_vender"; params = [nome || "tudo bem", quem, carroCliente];
    texto = `Oi, ${nome ? nome : "tudo bem"}! Aqui é a ${quem}, da Totex Motors. Já tenho uma referência de valor pro seu ${carroCliente}, bem acima do que loja costuma pagar. Quer que eu te passe?`;
  } else {
    return { skipped: "sem carro nem intenção pra abrir com uma conta" };
  }

  let sent: { ok: boolean; via: string; detail?: string };
  if (lead.janela_aberta) {
    const r = await callEdge("send-whatsapp-cloud", { action: "send_text", phone: lead.phone, text: texto, lead_id: lead.lead_id, tenant_id: HQ_TENANT, sent_by: "lead_rewarm" });
    sent = { ok: r.ok && !r.data?.error, via: "texto", detail: r.data?.error };
  } else {
    if (!(await templateAprovado(sb, template))) return { skipped: `template ${template} ainda não aprovado` };
    const r = await callEdge("send-whatsapp-cloud", { action: "send_template", phone: lead.phone, template_name: template, template_params: params, lead_id: lead.lead_id, tenant_id: HQ_TENANT, sent_by: "lead_rewarm" });
    sent = { ok: r.ok && !r.data?.error, via: `template:${template}`, detail: r.data?.error };
  }
  if (!sent.ok) return { error: sent.detail || "envio falhou", via: sent.via };

  // marca o lead: o agente entra em MODO REAQUECIMENTO quando ele responder
  const { data: l } = await sb.from("leads").select("metadata").eq("id", lead.lead_id).maybeSingle();
  const md = (l?.metadata || {}) as Record<string, unknown>;
  const hist = Array.isArray((md.reaquecimento as any)?.historico) ? (md.reaquecimento as any).historico : [];
  await sb.from("leads").update({
    metadata: {
      ...md,
      reaquecimento: {
        ativo: true, momento, playbook, iniciado_em: new Date().toISOString(), via: sent.via,
        carro: carroInteresse || carroCliente || null, plano: plano ? { prazo: plano.plano.prazo, parcela: plano.plano.parcela, antecipacao: plano.antecipacao, cupom_campanha: plano.cupom_campanha } : null,
        historico: [...hist, { em: new Date().toISOString(), momento, via: sent.via }].slice(-10),
      },
    },
    last_interaction_at: new Date().toISOString(),
  }).eq("id", lead.lead_id);
  await sb.from("company_activities").insert({
    tenant_id: HQ_TENANT, lead_id: lead.lead_id, name: `Reaquecimento (${momento.replace(/_/g, " ")})`, description: texto, task_type: "note", team: "sales",
    status: "completed", completed: true, priority: "medium", scheduled_at: new Date().toISOString(), ai_generated: true, source_type: "agent", metadata: { source: "lead-rewarm", momento, via: sent.via },
  });
  return { ok: true, via: sent.via, momento };
}

async function avisarGrazi(sb: any, leadId: string, motivo: string | null) {
  const { data: lead } = await sb.from("leads").select("id, name, phone, metadata").eq("id", leadId).maybeSingle();
  if (!lead) return { success: false, message: "lead não encontrado" };
  const { data: cupom } = await sb.from("reaquecimento_cupons").select("codigo, desconto_parcela_cents, valido_ate, carro, parcela_base_cents, prazo").eq("lead_id", leadId).eq("status", "ativo").order("created_at", { ascending: false }).limit(1).maybeSingle();
  const brief = await buildLeadBrief(sb, leadId).catch(() => null);
  const md = (lead.metadata || {}) as Record<string, any>;
  const re = md.reaquecimento || {};
  const fone = String(lead.phone || "").replace(/\D/g, "");
  const linhas = [
    `💰 *Lead pra Grazi* — ${lead.name || "cliente"}`,
    `📱 ${fone}`,
    re.carro || brief?.carro_interesse_fala ? `🚗 ${re.carro || brief?.carro_interesse_fala}` : null,
    brief?.carro_do_cliente?.fala ? `🔁 Na troca: ${brief.carro_do_cliente.fala}` : null,
    re.plano?.parcela ? `📊 Plano: ${re.plano.prazo}x de ${fala(re.plano.parcela)}` : null,
    cupom ? `🎟️ Cupom *${cupom.codigo}*: ${fala(cupom.desconto_parcela_cents / 100)} a menos na parcela, vale até ${new Date(cupom.valido_ate).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}` : null,
    motivo ? `📝 ${motivo}` : null,
    `\nCliente respondeu e mostrou intenção. Pode entrar em contato.`,
  ].filter(Boolean).join("\n");

  // canal: grupo da Grazi (config) ou grupo da operação — UAZAPI só em grupo (regra inviolável)
  const groupJid = (await getIntegrationKey(sb, "REAQUECIMENTO_GRAZI_GROUP_JID")) || null;
  const { data: op } = await sb.from("operation_alert_config").select("whatsapp_instance_id, whatsapp_group_jid").eq("tenant_id", HQ_TENANT).maybeSingle();
  const jid = groupJid || op?.whatsapp_group_jid;
  const instId = op?.whatsapp_instance_id;
  if (!jid || !instId) return { success: false, message: "sem grupo configurado pra avisar a Grazi (REAQUECIMENTO_GRAZI_GROUP_JID ou alertas da operação)" };
  const { data: inst } = await sb.from("whatsapp_instances").select("id, api_url, api_key").eq("id", instId).maybeSingle();
  if (!inst?.api_url || !inst?.api_key) return { success: false, message: "instância do grupo sem credenciais" };
  if (!(await uazapiTargetAllowed(sb, inst.id, jid, "lead-rewarm", linhas))) return { success: false, message: "destino bloqueado pela política (só grupo/canal)" };
  const grazi = String((await getIntegrationKey(sb, "REAQUECIMENTO_GRAZI_PHONE")) || "").replace(/\D/g, "");
  const r = await fetch(`${inst.api_url.replace(/\/+$/, "")}/send/text`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", token: inst.api_key }, body: JSON.stringify({ number: jid, text: linhas, ...(grazi ? { mentions: grazi } : {}) }) });
  if (!r.ok) return { success: false, message: `envio ao grupo falhou (${r.status})` };
  if (cupom) await sb.from("reaquecimento_cupons").update({ grazi_avisada_em: new Date().toISOString() }).eq("codigo", cupom.codigo);
  await sb.from("leads").update({ metadata: { ...md, reaquecimento: { ...re, grazi_avisada_em: new Date().toISOString() } } }).eq("id", leadId);
  return { success: true, message: `Grazi avisada no grupo${cupom ? ` com o cupom ${cupom.codigo}` : ""}. Diga ao cliente que a Grazi vai falar com ele pra fechar a condição.` };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const raw = await req.json().catch(() => ({})) as Record<string, any>;
  const body = raw.arguments && typeof raw.arguments === "object" ? { action: "avisar_grazi", ...raw.arguments, _session: raw.session_id } : raw;
  const action = String(body.action || "run");

  try {
    if (action === "avisar_grazi") {
      let leadId = String(body.lead_id || "");
      if (!leadId && body._session) {
        const { data: s } = await sb.from("agents_sessions").select("working_memory").eq("id", body._session).maybeSingle();
        leadId = String((s?.working_memory as any)?.lead_id || "");
      }
      if (!leadId) return json({ success: false, message: "sem lead_id" });
      return json(await avisarGrazi(sb, leadId, body.motivo ? String(body.motivo) : null));
    }

    if (action === "status") {
      const out: Record<string, number> = {};
      for (const m of ["A_saiu_do_stand", "B_nunca_falou", "C_esfriou"] as Momento[]) out[m] = (await candidatos(sb, m, 500)).length;
      return json({ ok: true, candidatos: out, enabled: (await getIntegrationKey(sb, "REAQUECIMENTO_ENABLED")) === "true" });
    }

    // run (cron)
    if ((await getIntegrationKey(sb, "REAQUECIMENTO_ENABLED")) !== "true") return json({ skipped: "REAQUECIMENTO_ENABLED != true" });
    const h = horaBr();
    const ini = await cfgNum(sb, "REAQUECIMENTO_HORA_INICIO", 9), fim = await cfgNum(sb, "REAQUECIMENTO_HORA_FIM", 21);
    if (h < ini || h >= fim) return json({ skipped: `fora do horário (${h}h; ${ini}–${fim})` });
    const limite = await cfgNum(sb, "REAQUECIMENTO_MAX_POR_RODADA", 10);
    const resultado: Record<string, unknown[]> = {};
    let total = 0;
    for (const m of ["A_saiu_do_stand", "B_nunca_falou", "C_esfriou"] as Momento[]) {
      resultado[m] = [];
      for (const c of await candidatos(sb, m, limite)) {
        if (total >= limite) break;
        const r = await abrir(sb, c, m).catch((e) => ({ error: (e as Error).message }));
        resultado[m].push({ lead: c.lead_id, ...r });
        if ((r as any).ok) total++;
        log(m, c.lead_id, JSON.stringify(r));
      }
    }
    return json({ ok: true, enviados: total, resultado });
  } catch (e) {
    console.error("[lead-rewarm]", (e as Error).message);
    return json({ ok: false, error: (e as Error).message }, 500);
  }
});
