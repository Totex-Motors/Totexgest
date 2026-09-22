import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "../_shared/config.ts";

// ============================================================================
// PONTE Co-pilot → Totexgest (Opção B).
//
// Lê os leads de "stand" do Supabase do Totexcar Co-pilot (outro projeto) e importa
// pro Totexgest ATRIBUÍDOS à promotora, via a função existente `repasse_track`
// (resolve pelo repasse_code, idempotente por telefone → entra na lista "Indique e
// ganhe" dela; se a pessoa comprar depois, a comissão do repasse dispara).
//
// O link do Co-pilot que a promotora compartilha embute `#stand totexmotors <code>`,
// onde <code> é o repasse_code dela. No Co-pilot isso vira whatsapp_events kind=stand_lead
// com parsed.promotor = <code>, exposto pela RPC stand_leads('totexmotors').
//
// Config (Totexgest > config): COPILOT_SUPABASE_KEY (service_role do projeto Co-pilot,
// obrigatória) e opcional COPILOT_SUPABASE_URL (default abaixo). Sem a chave, no-op.
//
// Rodar por cron (a cada ~15 min) ou manualmente. Sem JWT (verify_jwt=false); só
// funciona quem tiver a chave do Co-pilot configurada.
// ============================================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const DEFAULT_COPILOT_URL = "https://gkkjhnzkqhpgrwrmofev.supabase.co";
const LOG = "[import-copilot-leads]";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "Função sem configuração do Supabase" }, 500);

  const tg = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    const copilotUrl = (await getIntegrationKey(tg, "COPILOT_SUPABASE_URL")) || DEFAULT_COPILOT_URL;
    const copilotKey = await getIntegrationKey(tg, "COPILOT_SUPABASE_KEY");
    if (!copilotKey) {
      return json({ ok: false, motivo: "COPILOT_SUPABASE_KEY não configurada (Configurações > API Keys). Ponte inativa." });
    }

    const copilot = createClient(copilotUrl, copilotKey, { auth: { persistSession: false } });

    // Leads de stand da loja "totexmotors" (o <loja> do link que a promotora compartilha)
    const { data: rows, error } = await copilot.rpc("stand_leads", { p_loja: "totexmotors" });
    if (error) {
      console.error(LOG, "erro lendo stand_leads:", error.message);
      return json({ ok: false, motivo: `Não consegui ler os leads do Co-pilot: ${error.message}` }, 502);
    }

    let importados = 0, pulados = 0, erros = 0;
    for (const r of (rows ?? []) as any[]) {
      const code = String(r.promotor ?? "").trim();
      const phone = String(r.telefone ?? "").trim();
      const nome = r.nome ? String(r.nome) : null;
      // ignora sem promotor/código improvável (o repasse_code tem 6 chars)
      if (!phone || !code || code === "(sem promotor)" || !/^[a-z0-9]{4,16}$/.test(code)) { pulados++; continue; }
      const { error: trackErr } = await tg.rpc("repasse_track", { p_code: code, p_phone: phone, p_name: nome });
      if (trackErr) {
        // "Código inválido" = code não é de uma promotora nossa → pula silencioso
        if (/inv[aá]lid/i.test(trackErr.message)) pulados++;
        else { erros++; console.warn(LOG, "repasse_track falhou:", trackErr.message); }
      } else {
        importados++;
      }
    }

    console.log(LOG, `total=${(rows ?? []).length} importados=${importados} pulados=${pulados} erros=${erros}`);
    return json({ ok: true, total: (rows ?? []).length, importados, pulados, erros });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(LOG, "erro:", message);
    return json({ ok: false, error: message }, 500);
  }
});
