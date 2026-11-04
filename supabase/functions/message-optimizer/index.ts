// message-optimizer — AGENTE OTIMIZADOR DE CONVERSAS (Marco, 2026-11-02).
//
// Mede cada ponto de contato do WhatsApp oficial (templates, primeiro contato, pedido de
// permissão, respostas do agente), roda as variantes (A/B por amostragem de Thompson, em
// _shared/message-variants.ts) e, uma vez por dia, pensa: diagnóstico, hipóteses, pausa
// variantes perdedoras (com amostra mínima) e PROPÕE novas variantes (templates da Meta) e
// ajustes de prompt. Propostas viram template na Meta só com aprovação humana (tela
// Configurações › IA & Bots › Otimizador), e entram na rotação quando a Meta aprovar.
//
// POST { action }:
//   run          (cron/x-internal-token ou usuário) → roda a análise do tenant e grava o relatório
//   stats        → funil + por touchpoint + variantes + último relatório (tela)
//   approve      { proposal_index, run_id } → cria o template na Meta e registra a variante (submitted)
//   set_status   { variant_id, status }   → active | paused
//   add_variant  { touchpoint, name, body, buttons[], params_hint, create_in_meta? }
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getCaller, deny } from "../_shared/auth.ts";
import { getIntegrationKey } from "../_shared/config.ts";
import { askClaudeJson } from "../_shared/claude-json.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const HQ_TENANT = "c13681e3-5db9-48d1-9c5c-856e6041d77f";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-token" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const TOUCHPOINTS: Record<string, string> = {
  nina_primeiro_contato: "Primeiro contato da Nina (template com botões, janela fechada)",
  call_permission_request: "Pedido de permissão de ligação",
  nina_curiosidade_1: "Curiosidade 1 (não atendeu)",
  nina_curiosidade_2: "Curiosidade 2 (não atendeu)",
  reaquecimento_trocar: "Reaquecimento — troca",
  reaquecimento_vender: "Reaquecimento — venda",
  reaquecimento_viu_carro: "Reaquecimento — viu carro",
  retomada_conversa: "Follow-up (retomada)",
  pausa_conversa: "Pausa com botões",
  confirmacao_agendamento: "Confirmação de agendamento",
  Conversation: "Mensagens de texto do agente (janela aberta)",
};

async function coletar(sb: any, tenantId: string, days: number) {
  const [{ data: funil }, { data: tps }, { data: vars }] = await Promise.all([
    sb.rpc("whatsapp_conversation_funnel", { p_tenant: tenantId, p_days: days }),
    sb.rpc("whatsapp_touchpoint_stats", { p_tenant: tenantId, p_days: days }),
    sb.rpc("message_variant_stats", { p_tenant: tenantId, p_days: days }),
  ]);
  // amostras: primeiras mensagens nossas que ficaram sem resposta vs. que tiveram resposta
  const { data: amostras } = await sb.from("whatsapp_messages")
    .select("remote_jid, content, sent_at, status, metadata")
    .eq("tenant_id", tenantId).eq("is_from_me", true).gte("sent_at", new Date(Date.now() - days * 86400_000).toISOString())
    .not("remote_jid", "like", "%@g.us").order("sent_at", { ascending: false }).limit(400);
  const porJid = new Map<string, any>();
  for (const m of (amostras || []).reverse()) if (!porJid.has(m.remote_jid)) porJid.set(m.remote_jid, m);
  const primeiras = [...porJid.values()].slice(0, 60);
  const comResposta: any[] = [], semResposta: any[] = [];
  for (const m of primeiras) {
    const { count } = await sb.from("whatsapp_messages").select("id", { count: "exact", head: true }).eq("remote_jid", m.remote_jid).eq("is_from_me", false).gt("sent_at", m.sent_at).lt("sent_at", new Date(new Date(m.sent_at).getTime() + 48 * 3600_000).toISOString());
    const item = { tipo: m.metadata?.template_name || "texto", status: m.status, texto: String(m.content || "").slice(0, 220) };
    (count ? comResposta : semResposta).push(item);
  }
  // variantes cadastradas (corpo) pra IA saber o que já existe
  const { data: variantes } = await sb.from("message_variants").select("touchpoint, name, kind, body, buttons, status").eq("tenant_id", tenantId);
  return { funil: funil?.[0] || null, touchpoints: tps || [], variantes_stats: vars || [], variantes: variantes || [], amostras: { com_resposta: comResposta.slice(0, 12), sem_resposta: semResposta.slice(0, 20) } };
}

async function analisar(sb: any, tenantId: string, dados: any, days: number) {
  const model = (await getIntegrationKey(sb, "OPTIMIZER_MODEL")) || "claude-sonnet-4-5-20250929";
  // regras extras editáveis sem deploy (config OPTIMIZER_REGRAS_EXTRA, uma por linha)
  const extraRules = String((await getIntegrationKey(sb, "OPTIMIZER_REGRAS_EXTRA")) || "").trim().split("\n").filter(Boolean).map((r) => `- ${r.trim()}`).join("\n");
  const system = `Você é o OTIMIZADOR DE CONVERSAS de uma loja de carros (Totex Motors). Recebe métricas do WhatsApp oficial (número da loja) e amostras de mensagens, e devolve um diagnóstico honesto e propostas TESTÁVEIS pra aumentar a taxa de resposta e a continuidade da conversa.
REGRAS DAS PROPOSTAS (templates da Meta, pt_BR):
- Body até 500 caracteres, sem começar nem terminar com variável, variáveis {{1}} (nome) e {{2}} (motivo/assunto); nunca prometa preço, taxa ou aprovação; nunca fale em taxa de juros.
- Botões QUICK_REPLY: até 2, até 20 caracteres, SEM emoji.
- Tom: pessoa real da loja, direto, curto, 1 pergunta no fim. Nada de "promoção imperdível".
- Cada proposta testa UMA hipótese clara (ângulo, tamanho, pergunta, prova social, ajuda concreta…).
- PROIBIDO escrever números de exemplo ou placeholders no body ("R$ xxx", "xx vezes", "[modelo]"): tudo que varia vai numa variável {{n}}. Cada variável recebe UMA chave deste vocabulário: nome (primeiro nome), assinatura (quem assina, ex.: Nina), carro (modelo do carro em questão, sem artigo), assunto ("o Nivus que você viu"), motivo (frase curta do porquê do contato), parcela ("1.819 reais por mês"). Devolva a lista em "params" na mesma ordem das variáveis.
REGRAS DO MARCO (dono) — valem acima de tudo:
- FOLLOW-UP / RETOMADA é pra quem ainda está pensando: NUNCA pedir compromisso, reserva, "segurar condição", prazo de 48 h ou decisão. Oferecer ajuda ou uma informação útil e fazer UMA pergunta leve (ex.: "quer que eu te mande mais fotos?", "ficou alguma dúvida que eu possa tirar?"). Urgência só se for real e vinda do cliente.
- Primeiro contato: explicar o motivo em uma frase e dar a saída fácil ("se preferir, por aqui mesmo").
- Nunca inventar escassez, nunca "última unidade", nunca promessa de valor do carro do cliente na troca.
- Vocabulário: ao falar do cálculo da negociação com o carro do cliente, a palavra é "simulação" (ou "proposta"). NUNCA "conta" ("fiz uma conta", "manda a conta", "a conta pronta" são proibidos; "me conta" no sentido de "me diga" pode).
${extraRules}
Responda SÓ com JSON.`;
  const user = `PERÍODO: últimos ${days} dias.
FUNIL: ${JSON.stringify(dados.funil)}
POR PONTO DE CONTATO (enviadas/entregues/lidas/falhas/respondidas_48h/taxa%): ${JSON.stringify(dados.touchpoints)}
VARIANTES EM TESTE: ${JSON.stringify(dados.variantes_stats)}
VARIANTES CADASTRADAS (corpo): ${JSON.stringify(dados.variantes)}
AMOSTRAS COM RESPOSTA: ${JSON.stringify(dados.amostras.com_resposta)}
AMOSTRAS SEM RESPOSTA: ${JSON.stringify(dados.amostras.sem_resposta)}

Devolva JSON compacto (sem markdown, sem texto fora do JSON):
{
 "diagnostico": "3-5 frases: onde a conversa morre e por quê (use os números)",
 "hipoteses": ["hipótese 1", "hipótese 2", "hipótese 3"],
 "acoes": ["ação concreta e imediata (não depende de IA)", "..."],
 "propostas": [
   {"touchpoint": "nina_primeiro_contato | nina_curiosidade_1 | reaquecimento_trocar | reaquecimento_viu_carro | retomada_conversa",
    "name": "nome_do_template_em_snake_case_curto", "hipotese": "o que esta variante testa",
    "body": "texto com {{1}} e {{2}}", "buttons": ["Pode ligar", "Prefiro por aqui"], "params": ["nome", "motivo"], "params_hint": "{{1}} nome; {{2}} motivo"}
 ] (2 a 4 propostas),
 "prompt_sugestoes": ["ajuste curto no prompt do agente de texto, se os dados mostrarem problema nas respostas"],
 "proximo_passo": "1 frase"
}`;
  const out = await askClaudeJson(sb, tenantId, system, user, { model, maxTokens: 6000, tag: "optimizer" });
  if (!out) console.warn("[message-optimizer] IA sem JSON válido (modelo", model, ")");
  return { report: out, model };
}

/** Pausa automática: variante com ≥30 envios e taxa < metade da melhor do mesmo touchpoint. */
async function autoPausar(sb: any, tenantId: string, vars: any[]): Promise<string[]> {
  const acoes: string[] = [];
  const auto = ((await getIntegrationKey(sb, "OPTIMIZER_AUTO_PAUSE")) || "true") !== "false";
  if (!auto) return acoes;
  const byTp = new Map<string, any[]>();
  for (const v of vars) { if (v.status !== "active") continue; (byTp.get(v.touchpoint) || byTp.set(v.touchpoint, []).get(v.touchpoint)!).push(v); }
  for (const [tp, list] of byTp) {
    if (list.length < 2) continue;
    const best = Math.max(...list.map((v) => Number(v.taxa || 0)));
    for (const v of list) {
      if (Number(v.enviadas) >= 30 && Number(v.taxa || 0) < best / 2) {
        await sb.from("message_variants").update({ status: "paused", updated_at: new Date().toISOString(), rationale: `pausada pelo otimizador: ${v.taxa}% vs melhor ${best}% (${v.enviadas} envios)` }).eq("id", v.variant_id);
        acoes.push(`pausou ${tp}/${v.name} (${v.taxa}% vs ${best}%)`);
      }
    }
  }
  return acoes;
}

/** Deduz o vocabulário dos params a partir do hint ("{{1}} nome; {{2}} modelo do carro"). */
function inferParams(body: string, hint?: string | null): string[] {
  const n = (String(body || "").match(/\{\{\d+\}\}/g) || []).length;
  const partes = String(hint || "").split(/;|\n/).map((x) => x.toLowerCase());
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const h = partes[i] || "";
    out.push(/assinatura|quem assina/.test(h) ? "assinatura" : /assunto/.test(h) ? "assunto" : /motivo|porqu|contexto/.test(h) ? "motivo" : /parcela/.test(h) ? "parcela" : /modelo|carro/.test(h) ? "carro" : /nome/.test(h) ? "nome" : i === 0 ? "nome" : "carro");
  }
  return out;
}

async function criarTemplateNaMeta(sb: any, tenantId: string, p: { name: string; body: string; buttons: string[]; example: string[] }): Promise<{ ok: boolean; id?: string; status?: string; error?: string }> {
  const { data: inst } = await sb.from("whatsapp_instances").select("id, api_key, business_account_id").eq("tenant_id", tenantId).eq("provider", "meta_cloud").not("api_key", "is", null).limit(1).maybeSingle();
  if (!inst?.api_key || !inst.business_account_id) return { ok: false, error: "Loja sem WhatsApp oficial (token/WABA)." };
  const name = p.name.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 60);
  // Regras da Meta: body não pode começar nem terminar com variável; variáveis em ordem {{1}},{{2}}…
  let bodyTxt = String(p.body || "").trim();
  if (/^\{\{\d+\}\}/.test(bodyTxt)) bodyTxt = "Oi, " + bodyTxt;
  if (/\{\{\d+\}\}[.!?]?$/.test(bodyTxt)) bodyTxt = bodyTxt.replace(/[.!?]?$/, "") + ". Me responde por aqui?";
  const nVars = (bodyTxt.match(/\{\{\d+\}\}/g) || []).length;
  const example = p.example.slice(0, nVars).concat(Array(Math.max(0, nVars - p.example.length)).fill("exemplo"));
  const components: any[] = [{ type: "BODY", text: bodyTxt, ...(nVars ? { example: { body_text: [example] } } : {}) }];
  const btns = (p.buttons || []).filter(Boolean).slice(0, 3).map((t) => ({ type: "QUICK_REPLY", text: String(t).replace(/[^\p{L}\p{N} ,.!?-]/gu, "").trim().slice(0, 20) }));
  if (btns.length) components.push({ type: "BUTTONS", buttons: btns });
  const r = await fetch(`https://graph.facebook.com/v22.0/${inst.business_account_id}/message_templates`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${inst.api_key}` },
    body: JSON.stringify({ name, category: "MARKETING", language: "pt_BR", components }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d?.error) return { ok: false, error: d?.error?.error_user_msg || d?.error?.message || `Meta ${r.status}` };
  await sb.from("whatsapp_cloud_templates").upsert({
    tenant_id: tenantId, meta_template_id: d.id, meta_waba_id: inst.business_account_id, name, language: "pt_BR", category: d.category || "MARKETING", status: d.status || "PENDING",
    components, variables_count: nVars, updated_at: new Date().toISOString(),
  }, { onConflict: "tenant_id,name,language" });
  return { ok: true, id: d.id, status: d.status || "PENDING" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "método" }, 405);
  const caller = await getCaller(req);
  if (!caller.ok) return deny();
  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  let body: any = {};
  try { body = await req.json(); } catch { body = {}; }
  const action = String(body.action || "run");
  const tenantId: string = caller.user ? (caller.user.superadmin && body.tenant_id ? body.tenant_id : caller.user.tenantId || HQ_TENANT) : (body.tenant_id || HQ_TENANT);
  if (caller.user && !caller.user.superadmin) {
    const { data: m } = await sb.from("team_members").select("is_active, role").eq("tenant_id", tenantId).eq("auth_user_id", caller.user.id).maybeSingle();
    if (!m?.is_active) return json({ error: "Acesso não autorizado." }, 403);
  }
  const days = Math.min(90, Math.max(3, Number(body.days) || 30));

  try {
    if (action === "stats") {
      const dados = await coletar(sb, tenantId, days);
      const { data: runs } = await sb.from("message_optimizer_runs").select("id, run_at, period_days, report, actions_taken, model").eq("tenant_id", tenantId).order("run_at", { ascending: false }).limit(5);
      const { data: variantes } = await sb.from("message_variants").select("*").eq("tenant_id", tenantId).order("touchpoint").order("name");
      return json({ funil: dados.funil, touchpoints: dados.touchpoints.map((t: any) => ({ ...t, rotulo: TOUCHPOINTS[t.tipo] || t.tipo })), variantes, variantes_stats: dados.variantes_stats, runs: runs || [], touchpoint_labels: TOUCHPOINTS });
    }

    if (action === "run") {
      const dados = await coletar(sb, tenantId, days);
      const acoes = await autoPausar(sb, tenantId, dados.variantes_stats);
      const { report, model } = await analisar(sb, tenantId, dados, days);
      const { data: run } = await sb.from("message_optimizer_runs").insert({ tenant_id: tenantId, period_days: days, stats: { funil: dados.funil, touchpoints: dados.touchpoints, variantes: dados.variantes_stats }, report: report || { erro: "IA não respondeu" }, actions_taken: acoes, model }).select("id, run_at").single();
      return json({ ok: true, run_id: run?.id, acoes, report });
    }

    if (action === "approve") {
      const { data: run } = await sb.from("message_optimizer_runs").select("id, report").eq("id", String(body.run_id || "")).eq("tenant_id", tenantId).maybeSingle();
      const prop = run?.report?.propostas?.[Number(body.proposal_index)];
      if (!prop) return json({ error: "Proposta não encontrada." }, 404);
      const example = [body.example_nome || "Adriano", body.example_motivo || "Vi que você se interessou pelo Renault Kardian no totem."];
      const r = await criarTemplateNaMeta(sb, tenantId, { name: prop.name, body: prop.body, buttons: prop.buttons || [], example });
      if (!r.ok) return json({ error: r.error }, 502);
      const name = String(prop.name).toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 60);
      const paramsSpec: string[] = Array.isArray(body.params) && body.params.length ? body.params.map(String) : Array.isArray(prop.params) && prop.params.length ? prop.params.map(String) : inferParams(prop.body, prop.params_hint);
      const { data: v } = await sb.from("message_variants").upsert({
        tenant_id: tenantId, touchpoint: prop.touchpoint, name, kind: "template", body: prop.body, buttons: (prop.buttons || []).map((t: string) => ({ text: t })),
        params_spec: paramsSpec,
        params_hint: prop.params_hint || null, status: "submitted", origem: "otimizador", rationale: prop.hipotese || null, meta_template_id: r.id || null, created_by: caller.user?.id || null, updated_at: new Date().toISOString(),
      }, { onConflict: "tenant_id,touchpoint,name" }).select("*").single();
      return json({ ok: true, variant: v, meta_status: r.status });
    }

    if (action === "add_variant") {
      const touchpoint = String(body.touchpoint || ""); const name = String(body.name || "").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 60);
      if (!touchpoint || !name) return json({ error: "Informe touchpoint e name." }, 400);
      let meta: any = null;
      if (body.create_in_meta && body.body) {
        meta = await criarTemplateNaMeta(sb, tenantId, { name, body: String(body.body), buttons: body.buttons || [], example: body.example || ["Adriano", "Vi que você se interessou pelo Renault Kardian no totem."] });
        if (!meta.ok) return json({ error: meta.error }, 502);
      }
      const { data: v, error } = await sb.from("message_variants").upsert({
        tenant_id: tenantId, touchpoint, name, kind: body.kind === "text" ? "text" : "template", body: body.body || null, buttons: (body.buttons || []).map((t: string) => ({ text: t })),
        params_spec: Array.isArray(body.params) ? body.params.map(String) : inferParams(String(body.body || ""), body.params_hint),
        params_hint: body.params_hint || null, status: body.status || (meta ? "submitted" : "active"), origem: "manual", rationale: body.rationale || null, meta_template_id: meta?.id || null, created_by: caller.user?.id || null, updated_at: new Date().toISOString(),
      }, { onConflict: "tenant_id,touchpoint,name" }).select("*").single();
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, variant: v });
    }

    if (action === "set_status") {
      const status = ["active", "paused", "rejected"].includes(body.status) ? body.status : null;
      if (!status) return json({ error: "status inválido" }, 400);
      const { data: v } = await sb.from("message_variants").update({ status, updated_at: new Date().toISOString() }).eq("id", String(body.variant_id || "")).eq("tenant_id", tenantId).select("*").maybeSingle();
      if (!v) return json({ error: "Variante não encontrada." }, 404);
      return json({ ok: true, variant: v });
    }

    return json({ error: "Ação inválida." }, 400);
  } catch (e) {
    console.error("[message-optimizer]", action, (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
