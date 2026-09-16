import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "../_shared/config.ts";

// INTELIGÊNCIA DO LEAD — junta os dados do lead (cadastro, mensagens, atividades,
// deals) e pede pra IA (Anthropic) montar um raio-x acionável (perfil, insights,
// recomendações, pré-contato, mensagem sugerida, proposta, BANT, score).
// Chamada pelo painel "Inteligência IA" do lead. Retorna { intelligence, data_sources }.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const MODEL = "claude-haiku-4-5-20251001";
const LOG = "[generate-lead-intelligence]";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function extractJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const first = t.indexOf("{"); const last = t.lastIndexOf("}");
  if (first === -1 || last === -1) return null;
  try { return JSON.parse(t.slice(first, last + 1)); } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { lead_id, contact_id } = await req.json().catch(() => ({}));
    const leadId = lead_id || contact_id;
    if (!leadId) return json({ error: "lead_id é obrigatório" }, 400);

    const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    const { data: lead, error: leadErr } = await sb.from("leads").select("*").eq("id", leadId).maybeSingle();
    if (leadErr || !lead) return json({ error: "Lead não encontrado" }, 404);

    const anthropicKey = await getIntegrationKey(sb, "ANTHROPIC_API_KEY", lead.tenant_id);
    if (!anthropicKey) return json({ error: "ANTHROPIC_API_KEY não configurada (Configurações → API Keys)" }, 400);

    const [{ data: msgs }, { data: acts }, { data: deals }, { data: igConvs }, { data: igEng }] = await Promise.all([
      sb.from("whatsapp_messages").select("content, is_from_me, created_at, sender_name").eq("lead_id", leadId).order("created_at", { ascending: false }).limit(40),
      sb.from("company_activities").select("name, task_type, status, due_datetime, date").eq("lead_id", leadId).order("date", { ascending: false }).limit(30),
      sb.from("deals").select("title, status, original_price, negotiated_price, payment_method, notes, created_at").eq("lead_id", leadId).order("created_at", { ascending: false }).limit(10),
      sb.from("instagram_conversations").select("id, participant_username, participant_name, qualification_tier, qualification_reason, total_messages, last_message_at").eq("lead_id", leadId).limit(5),
      sb.from("instagram_engagement").select("total_dms, total_comments, total_story_replies, engagement_score, last_interaction_at").eq("lead_id", leadId).maybeSingle(),
    ]);

    // Instagram: mensagens/comentários das conversas ligadas a este lead
    let igMsgs: Array<Record<string, unknown>> = [];
    if (igConvs && igConvs.length > 0) {
      const { data: m } = await sb.from("instagram_messages")
        .select("content, is_from_me, sent_at, reference_type, reference_url")
        .in("conversation_id", igConvs.map((c: Record<string, unknown>) => c.id))
        .order("sent_at", { ascending: false }).limit(40);
      igMsgs = m ?? [];
    }

    const dataSources: string[] = [];
    if ((msgs?.length ?? 0) > 0) dataSources.push(`${msgs!.length} mensagens de WhatsApp`);
    if ((igMsgs.length ?? 0) > 0) dataSources.push(`${igMsgs.length} interações de Instagram`);
    if ((acts?.length ?? 0) > 0) dataSources.push(`${acts!.length} atividades`);
    if ((deals?.length ?? 0) > 0) dataSources.push(`${deals!.length} deals`);
    dataSources.push("cadastro do lead");

    const conversa = (msgs ?? []).slice().reverse()
      .map((m: Record<string, unknown>) => `${m.is_from_me ? "NÓS" : (m.sender_name || "LEAD")}: ${String(m.content ?? "").slice(0, 500)}`)
      .join("\n").slice(0, 8000);

    const instagram = (igConvs && igConvs.length > 0)
      ? `Perfil IG: @${igConvs[0].participant_username || "?"} (${igConvs[0].participant_name || ""}). ` +
        `Qualificação IG: ${igConvs[0].qualification_tier || "n/d"}${igConvs[0].qualification_reason ? ` — ${igConvs[0].qualification_reason}` : ""}. ` +
        (igEng ? `Engajamento: ${igEng.total_dms ?? 0} DMs, ${igEng.total_comments ?? 0} comentários, score ${igEng.engagement_score ?? "n/d"}.\n` : "\n") +
        igMsgs.slice().reverse().map((m) => `${m.is_from_me ? "NÓS" : "LEAD"}${m.reference_type ? ` [${m.reference_type}]` : ""}: ${String(m.content ?? "").slice(0, 400)}`).join("\n").slice(0, 5000)
      : "(sem interações de Instagram vinculadas a este lead)";

    const system =
      "Você é um analista de vendas sênior de uma operação de veículos (TotexMotors). " +
      "Analise TODOS os dados do lead e produza uma inteligência acionável, em português do Brasil, realista e específica (nada genérico). " +
      "Baseie-se SOMENTE nos dados fornecidos; quando faltar informação, deixe o campo curto ou vazio, não invente fatos. " +
      "Responda SOMENTE com um objeto JSON válido nesta forma exata (todos os campos opcionais; use os que os dados sustentarem):\n" +
      `{"perfil":{"resumo":"","persona":"","momento_compra":"","temperatura":"frio|morno|quente"},` +
      `"insights":{"sentimento_geral":"","nivel_interesse":"","principais_dores":[],"motivadores":[],"bloqueios":[],"objecoes_identificadas":[]},` +
      `"recomendacoes":{"estrategia":"","proxima_acao":"","melhor_horario":"","canal_preferido":"","tom_comunicacao":""},` +
      `"precontato":{"pontos_conexao":[],"perguntas_chave":[],"argumentos":[],"objecoes_esperadas":[]},` +
      `"mensagem_sugerida":{"whatsapp":"","email_assunto":"","email_corpo":""},` +
      `"proposta":{"produtos_recomendados":[],"valor_estimado":"","desconto_sugerido":"","condicoes_especiais":""},` +
      `"bant_atualizado":{"budget":"","authority":"","need":"","timeline":""},` +
      `"score_sugerido":<0-100>,"probabilidade_fechamento":<0-100>}`;

    const userMsg =
      `LEAD (cadastro):\n${JSON.stringify(lead)}\n\n` +
      `ATIVIDADES:\n${JSON.stringify(acts ?? [])}\n\n` +
      `DEALS:\n${JSON.stringify(deals ?? [])}\n\n` +
      `INSTAGRAM (perfil, qualificação e conversa):\n${instagram}\n\n` +
      `CONVERSA DE WHATSAPP (mais antiga → mais recente):\n${conversa || "(sem mensagens)"}`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 2500, system, messages: [{ role: "user", content: userMsg }] }),
    });
    if (!res.ok) {
      const raw = await res.text();
      console.error(LOG, "anthropic", res.status, raw.slice(0, 300));
      return json({ error: "Erro ao gerar inteligência (IA)", details: raw.slice(0, 200) }, 502);
    }
    const data = await res.json();
    const intelligence = extractJson(String(data?.content?.[0]?.text ?? ""));
    if (!intelligence) return json({ error: "A IA não retornou um resultado válido. Tente de novo." }, 502);

    return json({ intelligence, data_sources: dataSources });
  } catch (e) {
    console.error(LOG, "erro", (e as Error)?.message);
    return json({ error: (e as Error)?.message || "Erro inesperado" }, 500);
  }
});
