import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "../_shared/config.ts";

// Copiloto do supervisor da Torre de Controle: recebe o estado atual da operação
// (KPIs, fila de não atendidos, follow-ups vencidos por vendedor) e gera um plano
// de ação priorizado em pt-BR via Anthropic. É READ-ONLY / consultivo — não age
// sozinho, só orienta o humano (Isaías). tenant_id vem do JWT do usuário logado.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const ANTHROPIC_MODEL = "claude-3-5-haiku-20241022";

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonRes({ error: "Method not allowed" }, 405);

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Resolve tenant via JWT do usuário logado
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    const tenantId = (user?.app_metadata as any)?.tenant_id;
    if (!tenantId) return jsonRes({ error: "missing tenant" }, 401);

    // deno-lint-ignore no-explicit-any
    const body = (await req.json().catch(() => ({}))) as any;
    const stats = body.stats || {};
    const unattended = Array.isArray(body.unattended) ? body.unattended.slice(0, 25) : [];
    const overdueByRep = Array.isArray(body.overdueByRep) ? body.overdueByRep.slice(0, 25) : [];

    const anthropicKey = await getIntegrationKey(supabase, "ANTHROPIC_API_KEY", tenantId);
    if (!anthropicKey) {
      return jsonRes({ error: "ANTHROPIC_API_KEY não configurada", plano: null }, 200);
    }

    const nowStr = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

    const systemPrompt = `Você é o copiloto de um SUPERVISOR de vendas de uma revenda de carros (papel: coordenar a operação de leads em tempo real).
Seu trabalho é olhar o estado atual da operação e dizer ao supervisor, de forma DIRETA e ACIONÁVEL, o que fazer AGORA para ninguém se perder.

Regras:
- Português brasileiro, tom próximo e objetivo. Nada de floreio.
- Priorize: leads sem primeiro contato (quanto mais tempo esperando, mais urgente), reconversões (cliente que já é da base e voltou — não pode ser ignorado) e vendedores com muitos follow-ups vencidos.
- Seja específico: cite nomes de leads e de vendedores quando fizer diferença.
- Formato: comece com 1 linha de diagnóstico (a foto do momento). Depois "AÇÕES AGORA:" com 3 a 6 itens numerados, cada um curto e no imperativo (ex: "1. Cobrar o João — 3 leads dele esperando +1h").
- Se estiver tudo sob controle, diga isso claramente e sugira 1 ação preventiva.
- Você NÃO executa nada — apenas orienta o supervisor humano.`;

    const userContent = `Horário: ${nowStr}

RESUMO DA OPERAÇÃO (últimas 24h):
${JSON.stringify(stats, null, 2)}

LEADS AGUARDANDO PRIMEIRO CONTATO (ordenados do que espera há mais tempo):
${unattended.length ? JSON.stringify(unattended, null, 2) : "(nenhum — todos atendidos)"}

FOLLOW-UPS VENCIDOS POR VENDEDOR:
${overdueByRep.length ? JSON.stringify(overdueByRep, null, 2) : "(nenhum vencido)"}

Gere o plano de ação para o supervisor agora.`;

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
      }),
    });

    const result = await resp.json();
    if (!resp.ok) {
      console.error("[supervisor-briefing] Anthropic error:", result);
      return jsonRes({ error: "Erro ao gerar plano", plano: null }, 200);
    }

    const plano = result.content?.[0]?.text || null;
    return jsonRes({ plano, raw: plano });
  } catch (err) {
    console.error("[supervisor-briefing] Unexpected error:", err);
    return jsonRes({ error: String((err as Error)?.message || err), plano: null }, 200);
  }
});
