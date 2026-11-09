import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// INDIQUE E GANHE — porta pública do programa de indicação (verify_jwt = false).
//
//   POST { action: "cadastrar", nome, telefone, email? }
//        → novo:  { ok, novo:true, code, link, share_text, painel_url (com token privado) }
//        → já cadastrado: { ok, ja_cadastrado:true, recuperar } — NÃO devolve código nem painel
//          e NÃO altera nada (recuperação só pelo WhatsApp cadastrado: "meu painel").
//   GET  ?token=<painel_token>  → painel do indicador (totais + lista mascarada)
//
// Privacidade: o CÓDIGO (6 chars) é público e serve só pro link de indicação. O PAINEL só
// abre com o token privado (64 hex), mostrado uma vez no cadastro e reenviado pelo WhatsApp
// do próprio dono (prova de posse do telefone, no webhook do número oficial).
// Sem segredos aqui: as RPCs indique_* (SECURITY DEFINER) são chamadas com o service role.
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
const normToken = (raw: unknown) => String(raw ?? "").trim().toLowerCase().replace(/[^a-f0-9]/g, "").slice(0, 64);

/** Texto pronto que o indicado manda pra Nina (o código é o que amarra a indicação). */
export function textoIndicado(code: string): string {
  return `Oi Nina! Vim pela indicação ${code} e quero ver os carros da Totex.`;
}

export function montarLinks(code: string, token: string, whatsapp: string | null, appUrl: string) {
  const link = whatsapp ? `https://wa.me/${whatsapp}?text=${encodeURIComponent(textoIndicado(code))}` : null;
  const painel = `${appUrl}/indique/painel/${token}`;
  const share = link
    ? `Tô indicando a Totex Motors pra quem quer trocar de carro 🚗 Fala com a Nina por aqui que ela te mostra os carros, faz a simulação e marca a visita no Shopping Tamboré: ${link}`
    : null;
  return { link, painel_url: painel, share_text: share, texto_indicado: textoIndicado(code) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data: appRow } = await supabase.from("config").select("value").eq("key", "app_url").maybeSingle();
  const appUrl = String(appRow?.value || "https://totexgest.vercel.app").replace(/\/$/, "");

  try {
    if (req.method === "GET") {
      const token = normToken(new URL(req.url).searchParams.get("token"));
      if (token.length < 32) return json({ ok: false, error: "Link inválido" }, 400);
      const { data, error } = await supabase.rpc("indique_painel_token", { p_token: token });
      if (error) { console.error(LOG, "painel", error.message); return json({ ok: false, error: "Falha na consulta" }, 500); }
      if (!data?.ok) return json({ ok: false, error: "Link inválido" }, 404);
      const { painel_token: _t, ...rest } = data;
      return json({ ...rest, ...montarLinks(data.code, token, data.whatsapp || null, appUrl) });
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
      if (data?.ja_cadastrado) {
        // Não revela nada: quem tem o telefone recupera o painel pelo próprio WhatsApp
        const wa = data.whatsapp ? `https://wa.me/${data.whatsapp}?text=${encodeURIComponent("meu painel")}` : null;
        return json({ ok: true, ja_cadastrado: true, recuperar_link: wa, recuperar: "Esse WhatsApp já tem cadastro. Pra receber o link do seu painel, mande \"meu painel\" pro WhatsApp da Totex a partir desse número." });
      }
      if (data?.status === "bloqueado") return json({ ok: false, error: "Cadastro bloqueado. Fale com a Totex." }, 403);
      const { painel_token, ...rest } = data;
      return json({ ...rest, ...montarLinks(data.code, painel_token, data.whatsapp || null, appUrl) });
    }
    return json({ ok: false, error: "Ação inválida" }, 400);
  } catch (e) {
    console.error(LOG, "unexpected", (e as Error)?.message);
    return json({ ok: false, error: "Erro inesperado" }, 500);
  }
});
