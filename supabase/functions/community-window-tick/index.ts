// community-window-tick — agendador das Janelas de Oportunidade.
//
// - Sem corpo (cron a cada 1 min): varre as configs e abre/fecha janelas conforme
//   a agenda, postando os avisos no grupo.
// - Com { action: "open" | "close", config_id, duration_min? } (painel): abre/fecha
//   na hora. Como a função é verify_jwt=false (pro cron), a ação manual valida o
//   acesso do usuário via RLS antes de agir.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { runWindowScheduler, openWindowNow, closeWindowNow } from "../_shared/community.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const action = (body as any)?.action as string | undefined;

    // ── Cron: varredura ──
    if (!action) {
      const r = await runWindowScheduler(serviceClient);
      return json({ ok: true, ...r });
    }

    // ── Ação manual do painel (abrir/fechar agora) ──
    const configId = (body as any)?.config_id as string | undefined;
    if (!configId) return json({ ok: false, error: "config_id obrigatório" }, 400);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ ok: false, error: "Não autenticado" }, 401);
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: visible } = await userClient.from("community_engagement").select("id").eq("id", configId).maybeSingle();
    if (!visible) return json({ ok: false, error: "Config não encontrada ou sem acesso" }, 403);

    if (action === "open") {
      const r = await openWindowNow(serviceClient, configId, Number((body as any)?.duration_min) || undefined);
      return json(r.ok ? { ok: true } : { ok: false, error: r.error }, r.ok ? 200 : 200);
    }
    if (action === "close") {
      const r = await closeWindowNow(serviceClient, configId);
      return json(r.ok ? { ok: true } : { ok: false, error: r.error }, 200);
    }
    return json({ ok: false, error: `Ação inválida: ${action}` }, 400);
  } catch (err) {
    console.error("[community-window-tick] Erro:", err);
    return json({ ok: false, error: (err as Error)?.message || "Erro interno" }, 500);
  }
});
