import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// INDIQUE E GANHE — porta pública do programa de indicação (verify_jwt = false).
//
//   POST { action: "cadastrar", nome, telefone, email? }  → { ok, code, nome, link, share_text, painel_url }
//   GET  ?code=ABC123                                      → painel do indicador (totais + lista mascarada)
//
// Sem segredos aqui: a regra (código único, um telefone = um indicador, teto, valores)
// mora nas RPCs indique_* (SECURITY DEFINER), chamadas com o service role.
// O link é SEMPRE o WhatsApp OFICIAL (Cloud API) da loja — nunca UAZAPI (regra inviolável).

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const LOG = "[indique]";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
const normCode = (raw: unknown) => String(raw ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);

/** Texto pronto que o indicado manda pra Nina (o código é o que amarra a indicação). */
export function textoIndicado(code: string): string {
  return `Oi Nina! Vim pela indicação ${code} e quero ver os carros da Totex.`;
}

function montarLinks(code: string, whatsapp: string | null, appUrl: string) {
  const link = whatsapp ? `https://wa.me/${whatsapp}?text=${encodeURIComponent(textoIndicado(code))}` : null;
  const painel = `${appUrl}/indique/${code}`;
  const share = link
    ? `Tô indicando a Totex Motors pra quem quer trocar de carro 🚗 Fala com a Nina por aqui que ela te mostra os carros, faz a simulação e marca a visita no Shopping Tamboré: ${link}`
    : null;
  return { link, painel_url: painel, share_text: share };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data: appRow } = await supabase.from("config").select("value").eq("key", "app_url").maybeSingle();
  const appUrl = String(appRow?.value || "https://totexgest.vercel.app").replace(/\/$/, "");

  try {
    if (req.method === "GET") {
      const code = normCode(new URL(req.url).searchParams.get("code"));
      if (!code) return json({ ok: false, error: "Código ausente" }, 400);
      const { data, error } = await supabase.rpc("indique_painel", { p_code: code });
      if (error) { console.error(LOG, "painel", error.message); return json({ ok: false, error: "Falha na consulta" }, 500); }
      if (!data?.ok) return json({ ok: false, error: "Código inválido" }, 404);
      return json({ ...data, ...montarLinks(data.code, data.whatsapp || null, appUrl), texto_indicado: textoIndicado(data.code) });
    }
    if (req.method !== "POST") return json({ ok: false, error: "Método não suportado" }, 405);

    const body = await req.json().catch(() => ({}));
    if (body?.action === "cadastrar") {
      const nome = String(body?.nome ?? "").trim().slice(0, 120);
      const telefone = String(body?.telefone ?? "").trim();
      const email = body?.email ? String(body.email).trim().slice(0, 160) : null;
      if (nome.length < 2) return json({ ok: false, error: "Diga seu nome" }, 400);
      if (!telefone) return json({ ok: false, error: "Informe seu WhatsApp" }, 400);
      const { data, error } = await supabase.rpc("indique_cadastrar", { p_nome: nome, p_telefone: telefone, p_email: email });
      if (error) {
        const msg = error.message || "";
        const known = /WhatsApp inválido|Diga seu nome/.test(msg);
        console.error(LOG, "cadastrar", msg);
        return json({ ok: false, error: known ? msg : "Não consegui fazer seu cadastro agora" }, known ? 400 : 500);
      }
      if (data?.status === "bloqueado") return json({ ok: false, error: "Cadastro bloqueado. Fale com a Totex." }, 403);
      return json({ ...data, ...montarLinks(data.code, data.whatsapp || null, appUrl), texto_indicado: textoIndicado(data.code) });
    }
    if (body?.action === "painel") {
      const code = normCode(body?.code);
      const { data, error } = await supabase.rpc("indique_painel", { p_code: code });
      if (error || !data?.ok) return json({ ok: false, error: "Código inválido" }, 404);
      return json({ ...data, ...montarLinks(data.code, data.whatsapp || null, appUrl), texto_indicado: textoIndicado(data.code) });
    }
    return json({ ok: false, error: "Ação inválida" }, 400);
  } catch (e) {
    console.error(LOG, "unexpected", (e as Error)?.message);
    return json({ ok: false, error: "Erro inesperado" }, 500);
  }
});
