import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// REPASSE POR INDICAÇÃO — landing pública do cartão NFC.
//
// Fluxo: a promotora entrega um cartão NFC que abre /r/<code> no app. A telinha
// pede o WhatsApp da pessoa e confirma ("você foi convidado por <promotora>").
// Aqui registramos a indicação (rastreio exato por telefone) e devolvemos o link
// do grupo de repasses. Quem entra pelo cartão fica atrelado àquela promotora;
// se essa pessoa comprar um carro pela intermediação, a promotora ganha R$ 150.
//
// Público (verify_jwt = false): é acessado por estranhos antes de qualquer login.
//   • GET  ?code=abc123   -> { ok, promoter_name }               (só resolve o nome)
//   • POST { code, phone, name } -> { ok, group_link, ... }       (registra a indicação)
//
// Sem segredos aqui. A regra de negócio (dedupe, validação, "primeira vence")
// mora na RPC repasse_track (SECURITY DEFINER), chamada com o service role.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const LOG = "[repasse-track]";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function normalizeCode(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  try {
    // GET: resolve só o nome da promotora pelo código (para a telinha exibir o convite)
    if (req.method === "GET") {
      const code = normalizeCode(new URL(req.url).searchParams.get("code"));
      if (!code) return json({ ok: false, error: "Código ausente" }, 400);
      const { data, error } = await supabase
        .from("team_members")
        .select("name")
        .eq("repasse_code", code)
        .eq("is_active", true)
        .maybeSingle();
      if (error) { console.error(LOG, "lookup", error.message); return json({ ok: false, error: "Falha na consulta" }, 500); }
      if (!data) return json({ ok: false, error: "Código inválido" }, 404);
      return json({ ok: true, promoter_name: data.name });
    }

    if (req.method !== "POST") return json({ ok: false, error: "Método não suportado" }, 405);

    const payload = await req.json().catch(() => ({}));
    const code = normalizeCode(payload?.code);
    const phone = String(payload?.phone ?? "").trim();
    const name = payload?.name != null ? String(payload.name).trim().slice(0, 120) : null;
    if (!code) return json({ ok: false, error: "Código ausente" }, 400);
    if (!phone) return json({ ok: false, error: "Informe seu WhatsApp" }, 400);

    const { data, error } = await supabase.rpc("repasse_track", { p_code: code, p_phone: phone, p_name: name });
    if (error) {
      // Erros de negócio da RPC (código/WhatsApp inválido) voltam como mensagem amigável
      const msg = error.message || "Não foi possível registrar";
      const known = /Código inválido|WhatsApp inválido/.test(msg);
      console.error(LOG, "track", msg);
      return json({ ok: false, error: known ? msg : "Não foi possível registrar sua indicação" }, known ? 400 : 500);
    }
    return json(data ?? { ok: true });
  } catch (e) {
    console.error(LOG, "unexpected", (e as Error)?.message);
    return json({ ok: false, error: "Erro inesperado" }, 500);
  }
});
