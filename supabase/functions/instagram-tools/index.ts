// instagram-tools — utilitários do Instagram numa function só, roteados por
// action (mesmo racional do instagram-crons: menos slots, menos cold start).
//
// POST { "action": "media_understand" | "icp_score" | "auto_campanha", ...params }
//
// | action           | quem chama                    | o que faz                          |
// |------------------|-------------------------------|------------------------------------|
// | media_understand | instagram-webhook (interno)   | áudio→texto, imagem/story→contexto |
// | icp_score        | manual/cron opcional          | nota A/B/C + gancho por lead       |
// | auto_campanha    | agente de conteúdo/cron       | post agendado → cria campanha      |
//
// verify_jwt: false (service-to-service)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleMediaUnderstand } from "./media-understand.ts";
import { handleIcpScore } from "./icp-score.ts";
import { handleAutoCampanha } from "./auto-campanha.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch { /* action obrigatória de qualquer forma */ }
  const action = String(body.action || "");

  const fwd = () =>
    new Request(req.url, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(body),
    });

  try {
    switch (action) {
      case "media_understand":
        return await handleMediaUnderstand(fwd());
      case "icp_score":
        return await handleIcpScore(fwd());
      case "auto_campanha":
        return await handleAutoCampanha(fwd());
      default:
        return new Response(
          JSON.stringify({ error: `action inválida: "${action}". Use media_understand | icp_score | auto_campanha` }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } },
        );
    }
  } catch (e) {
    return new Response(
      JSON.stringify({ success: false, action, error: (e as Error).message }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }
});
