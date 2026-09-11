import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "../_shared/config.ts";

// Captação — ROLEPLAY com IA pra promotora treinar a abordagem no shopping.
//
// Chamada pelo app (JWT do usuário). Ações (body.action):
//   start    { scenario_id }              → cria sessão, devolve a fala inicial do cliente
//   reply    { session_id, message }      → promotora fala; a IA responde como o cliente
//   finish   { session_id }               → avalia a conversa (rubrica) e devolve o feedback
//   abandon  { session_id }
// A IA é SÓ o cliente (nunca sai do personagem). A avaliação usa um modelo
// mais forte e devolve JSON. Nada de dinheiro/meta aqui — é treino.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const CHAT_MODEL = "claude-haiku-4-5-20251001";
const EVAL_MODEL = "claude-sonnet-4-6";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
type Msg = { role: "cliente" | "promotora"; text: string; at: string };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function claude(apiKey: string, model: string, system: string, messages: { role: "user" | "assistant"; content: string }[], maxTokens = 400): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Anthropic HTTP ${res.status}`);
  return (data.content || []).map((c: Row) => c.text || "").join("").trim();
}

function personaSystem(sc: Row): string {
  return [
    "Você está num ROLEPLAY de treinamento pra promotoras de captação de veículos da Totex Motors (loja de seminovos com stand no Shopping Tamboré).",
    "Você interpreta o CLIENTE — um proprietário de carro abordado no corredor do shopping. A pessoa que fala com você é a PROMOTORA em treinamento.",
    "REGRAS: responda SEMPRE em português do Brasil, como fala de verdade (1 a 3 frases, coloquial, sem listas, sem emojis em excesso). NUNCA saia do personagem, nunca dê dicas, nunca avalie a promotora, nunca diga que é uma IA.",
    "Só revele os FATOS OCULTOS abaixo se a promotora perguntar de forma natural (carro, ano, km, prazo, motivo, telefone). Se ela pedir o WhatsApp antes de gerar confiança, resista de leve.",
    "Quando a promotora conduzir bem (explicou avaliação gratuita, foi objetiva, tratou sua objeção, pediu autorização pra o especialista chamar), aceite: diga que pode chamar no WhatsApp e passe o telefone dos fatos ocultos. Se ela for ruim ou insistente demais, encerre educadamente dizendo que precisa ir.",
    "Se decidir encerrar a conversa (aceitando ou recusando de vez), termine sua fala com a tag [FIM].",
    "",
    `PERSONAGEM: ${sc.persona}`,
    `FATOS OCULTOS: ${JSON.stringify(sc.hidden_facts || {})}`,
  ].join("\n");
}

function transcript(msgs: Msg[]): string {
  return msgs.map((m) => `${m.role === "cliente" ? "CLIENTE" : "PROMOTORA"}: ${m.text}`).join("\n");
}

const EVAL_SYSTEM = `Você é o treinador de promotoras de captação de veículos da Totex Motors. Avalie a conversa (roleplay no shopping) em que a PROMOTORA aborda um CLIENTE proprietário de carro.
Rubrica (total 100):
- abordagem (20): apresentação rápida, simpática, com o nome da Totex e o gancho da avaliação gratuita.
- descoberta (25): descobriu carro/ano/km e prazo pra vender; entendeu o motivo.
- objecao (20): tratou a objeção do cliente com empatia e argumento concreto, sem prometer preço.
- consentimento (20): pediu o WhatsApp e a autorização explícita pra o especialista chamar.
- fechamento (15): passou o bastão ("nosso especialista continua com você pelo WhatsApp"), combinou expectativa, encerrou bem.
Seja justo e prático: fale em pt-BR, direto pra promotora ("você…"). Responda SOMENTE com JSON válido, sem markdown, no formato:
{"score":0-100,"criteria":[{"key":"abordagem","label":"Abordagem","score":n,"max":20,"feedback":"…"},{"key":"descoberta","label":"Descoberta","score":n,"max":25,"feedback":"…"},{"key":"objecao","label":"Objeção","score":n,"max":20,"feedback":"…"},{"key":"consentimento","label":"Consentimento","score":n,"max":20,"feedback":"…"},{"key":"fechamento","label":"Fechamento","score":n,"max":15,"feedback":"…"}],"strengths":["…","…"],"improvements":["…","…"],"best_line":"a melhor frase que a promotora disse (ou vazio)","next_drill":"um exercício curto pra próxima vez","summary":"1 frase de resumo motivadora"}`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const auth = req.headers.get("Authorization") || "";
    if (!auth.startsWith("Bearer ")) return json({ error: "sem autenticação" }, 401);
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "sessão inválida" }, 401);

    const sb = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: member } = await sb.from("team_members").select("id, tenant_id, name, role")
      .eq("auth_user_id", user.id).eq("is_active", true).order("created_at").limit(1).maybeSingle();
    if (!member) return json({ error: "membro não encontrado" }, 403);

    const body: Row = await req.json().catch(() => ({}));
    const action = body.action;
    const apiKey = await getIntegrationKey(sb, "ANTHROPIC_API_KEY", member.tenant_id);
    if (!apiKey) return json({ error: "ANTHROPIC_API_KEY não configurada (Configurações › API Keys)" }, 400);

    // ── start ──
    if (action === "start") {
      const { data: sc } = await sb.from("capture_roleplay_scenarios").select("*").eq("id", body.scenario_id).eq("is_active", true).maybeSingle();
      if (!sc || (sc.tenant_id && sc.tenant_id !== member.tenant_id)) return json({ error: "cenário não encontrado" }, 404);
      // abandona sessões ativas antigas da mesma pessoa
      await sb.from("capture_roleplay_sessions").update({ status: "abandoned", ended_at: new Date().toISOString() })
        .eq("member_id", member.id).eq("status", "active");
      const first: Msg = { role: "cliente", text: sc.opening_line, at: new Date().toISOString() };
      const { data: session, error } = await sb.from("capture_roleplay_sessions").insert({
        tenant_id: member.tenant_id, member_id: member.id, scenario_id: sc.id, scenario_key: sc.key, messages: [first], turns: 0,
      }).select("id").single();
      if (error) throw error;
      return json({ session_id: session.id, messages: [first], max_turns: sc.max_turns, scenario: { title: sc.title, emoji: sc.emoji, objective: sc.objective } });
    }

    // sessão da própria promotora
    const { data: s } = await sb.from("capture_roleplay_sessions").select("*").eq("id", body.session_id).eq("member_id", member.id).maybeSingle();
    if (!s) return json({ error: "sessão não encontrada" }, 404);
    const { data: sc } = await sb.from("capture_roleplay_scenarios").select("*").eq("id", s.scenario_id).maybeSingle();
    const msgs: Msg[] = (s.messages || []) as Msg[];

    // ── reply ──
    if (action === "reply") {
      if (s.status !== "active") return json({ error: "sessão encerrada" }, 400);
      const text = String(body.message || "").trim().slice(0, 600);
      if (!text) return json({ error: "mensagem vazia" }, 400);
      msgs.push({ role: "promotora", text, at: new Date().toISOString() });
      const turns = (s.turns || 0) + 1;
      const maxTurns = sc?.max_turns || 8;
      const history = msgs.map((m) => ({ role: m.role === "cliente" ? "assistant" as const : "user" as const, content: m.text }));
      let reply = await claude(apiKey, CHAT_MODEL, personaSystem(sc || {}) + (turns >= maxTurns ? "\n\nEsta é a ÚLTIMA troca: decida agora (aceitar ou recusar) e termine com [FIM]." : ""), history, 300);
      let ended = /\[FIM\]/i.test(reply) || turns >= maxTurns;
      reply = reply.replace(/\s*\[FIM\]\s*/gi, "").trim() || "Tá bom… preciso ir.";
      msgs.push({ role: "cliente", text: reply, at: new Date().toISOString() });
      await sb.from("capture_roleplay_sessions").update({ messages: msgs, turns, status: ended ? "ended" : "active", ended_at: ended ? new Date().toISOString() : null, updated_at: new Date().toISOString() }).eq("id", s.id);
      return json({ reply, ended, turns, max_turns: maxTurns });
    }

    // ── finish (avaliar) ──
    if (action === "finish") {
      if (s.status === "evaluated") return json({ score: s.score, evaluation: s.evaluation, messages: msgs });
      if (msgs.filter((m) => m.role === "promotora").length === 0) return json({ error: "converse antes de avaliar" }, 400);
      const raw = await claude(apiKey, EVAL_MODEL, EVAL_SYSTEM,
        [{ role: "user", content: `CENÁRIO: ${sc?.title} — ${sc?.summary}\nOBJETIVO: ${sc?.objective}\nFATOS DO CLIENTE: ${JSON.stringify(sc?.hidden_facts || {})}\n\nCONVERSA:\n${transcript(msgs)}` }], 1200);
      let evaluation: Row;
      try { evaluation = JSON.parse(raw.replace(/^```(json)?/i, "").replace(/```$/, "").trim()); }
      catch { evaluation = { score: 50, criteria: [], strengths: [], improvements: ["Não consegui estruturar a avaliação — tente de novo."], summary: raw.slice(0, 300) }; }
      const score = Math.max(0, Math.min(100, Number(evaluation.score) || 0));
      await sb.from("capture_roleplay_sessions").update({ status: "evaluated", score, evaluation, ended_at: s.ended_at || new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", s.id);
      return json({ score, evaluation, messages: msgs });
    }

    if (action === "abandon") {
      await sb.from("capture_roleplay_sessions").update({ status: "abandoned", ended_at: new Date().toISOString() }).eq("id", s.id).eq("status", "active");
      return json({ ok: true });
    }
    return json({ error: `action inválida: ${action}` }, 400);
  } catch (e) {
    console.error("[capture-roleplay]", e);
    return json({ error: (e as Error).message }, 500);
  }
});
