// instagram-crons — TODOS os crons do Instagram numa function só, roteados
// por action. Segue a recomendação da Supabase (poucas functions grandes) e o
// padrão da casa (ai-sales-agent faz o mesmo com process_queue/process_cadence).
// Economiza 3 slots do teto de 100 functions do plano free.
//
// POST { "action": "dispatch" | "agent_queue" | "nudge" | "refresh_token" }
//
// | action        | cron sugerido      | o que faz                            |
// |---------------|--------------------|--------------------------------------|
// | dispatch      | * * * * *          | puxa comentários + dispara DMs       |
// | agent_queue   | * * * * *          | agente responde DMs (debounce)       |
// | nudge         | */30 11-23 * * *   | cutuca quem recebeu DM e não voltou  |
// | refresh_token | 0 6 * * 0          | renova o token que MORRE em 60 dias  |
//
// verify_jwt: false (service-to-service via pg_cron)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { processIgAgentQueue, processCommentNudges } from "../instagram-webhook/meta-campaign.ts";
import { handleDispatch } from "./dispatch.ts";
import { handleRefreshToken } from "./refresh-token.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch { /* body vazio = ok, action obrigatória de qualquer forma */ }
  const action = String(body.action || "");

  // Handlers extraídos leem o body do próprio Request — repassa reconstruído.
  const fwd = () =>
    new Request(req.url, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(body),
    });

  try {
    switch (action) {
      case "dispatch":
        return await handleDispatch(fwd());
      case "refresh_token":
        return await handleRefreshToken(fwd());
      case "agent_queue": {
        const supabase = createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        );
        return json({ success: true, ...(await processIgAgentQueue(supabase)) });
      }
      case "nudge": {
        const supabase = createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        );
        return json({ success: true, ...(await processCommentNudges(supabase)) });
      }
      default:
        return json({ error: `action inválida: "${action}". Use dispatch | agent_queue | nudge | refresh_token` }, 400);
    }
  } catch (e) {
    return json({ success: false, action, error: (e as Error).message }, 500);
  }
});
