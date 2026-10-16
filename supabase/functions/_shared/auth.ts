/**
 * QUEM ESTÁ CHAMANDO a edge function (pente fino de 2026-10-16).
 *
 * Muitas funções rodam com `verify_jwt = false` (webhooks, crons, tools do agente). Sem
 * checagem própria, qualquer um com a URL (e a anon key, que é pública no front) podia
 * disparar envio pelo WhatsApp oficial, rodar o agente, criar tarefas... Esta é a porta única:
 *
 *   service  → Authorization: Bearer <SERVICE_ROLE_KEY>   (função → função, poller, webhooks)
 *   internal → x-internal-token = config INTERNAL_CRON_TOKEN (crons do pg_cron)
 *              ou x-voice-token = config VOICE_AGENT_TOKEN  (ferramentas da Nina)
 *   user     → Authorization: Bearer <JWT do usuário>     (tela do CRM) — tenant do app_metadata
 *
 * A anon key sozinha NÃO é credencial: passa no gateway, mas aqui é recusada.
 * Uso: `const denied = await requireCaller(req, { allowUser: true }); if (denied) return denied;`
 * ou `const caller = await getCaller(req)` quando precisar do tenant do usuário.
 */
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "./config.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";

export type Caller = {
  service: boolean;
  internal: boolean;
  user: { id: string; email: string | null; tenantId: string | null; superadmin: boolean } | null;
  /** true quando é service, internal ou user válido */
  ok: boolean;
};

let sbCache: SupabaseClient | null = null;
function sb(): SupabaseClient {
  if (!sbCache) sbCache = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  return sbCache;
}

function safeEq(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function getCaller(req: Request): Promise<Caller> {
  const auth = String(req.headers.get("authorization") || "").trim();
  const bearer = auth.replace(/^Bearer\s+/i, "").trim();
  const out: Caller = { service: false, internal: false, user: null, ok: false };

  if (bearer && SERVICE_KEY && safeEq(bearer, SERVICE_KEY)) { out.service = true; out.ok = true; return out; }

  const internalHdr = String(req.headers.get("x-internal-token") || "").trim();
  const voiceHdr = String(req.headers.get("x-voice-token") || "").trim();
  if (internalHdr || voiceHdr) {
    const [internalCfg, voiceCfg] = await Promise.all([getIntegrationKey(sb(), "INTERNAL_CRON_TOKEN"), getIntegrationKey(sb(), "VOICE_AGENT_TOKEN")]);
    if ((internalHdr && internalCfg && safeEq(internalHdr, internalCfg)) || (voiceHdr && voiceCfg && safeEq(voiceHdr, voiceCfg)) || (internalHdr && voiceCfg && safeEq(internalHdr, voiceCfg))) {
      out.internal = true; out.ok = true; return out;
    }
  }

  // JWT de usuário (a anon key também é um JWT — getUser devolve erro pra ela)
  if (bearer && bearer !== ANON_KEY && bearer.split(".").length === 3) {
    try {
      const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${bearer}` } }, auth: { persistSession: false } });
      const { data, error } = await userClient.auth.getUser(bearer);
      if (!error && data?.user) {
        const meta = (data.user.app_metadata || {}) as Record<string, unknown>;
        let superadmin = meta.is_platform_superadmin === true || meta.role === "superadmin" || meta.platform_role === "superadmin";
        if (!superadmin) {
          try { const { data: sa } = await userClient.rpc("is_platform_superadmin"); superadmin = sa === true; } catch { /* sem rpc */ }
        }
        out.user = { id: data.user.id, email: data.user.email || null, tenantId: (meta.tenant_id as string) || null, superadmin };
        out.ok = true;
      }
    } catch { /* inválido */ }
  }
  return out;
}

export function deny(msg = "unauthorized", status = 401): Response {
  return new Response(JSON.stringify({ error: msg }), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-token, x-voice-token" } });
}

/**
 * Barreira padrão. allowUser=false → só service/internal (crons, função→função).
 * Devolve a Response 401 pra devolver, ou null pra seguir.
 */
export async function requireCaller(req: Request, opts: { allowUser?: boolean } = {}): Promise<Response | null> {
  if (req.method === "OPTIONS") return null;
  const c = await getCaller(req);
  if (c.service || c.internal) return null;
  if (opts.allowUser !== false && c.user) return null;
  console.warn(`[auth] recusado ${req.method} ${new URL(req.url).pathname} (sem credencial válida)`);
  return deny();
}

/** Lead pertence ao tenant do chamador (service/internal passam; superadmin passa). */
export async function callerCanTouchLead(caller: Caller, leadId: string | null | undefined): Promise<boolean> {
  if (caller.service || caller.internal) return true;
  if (!caller.user) return false;
  if (caller.user.superadmin) return true;
  if (!leadId) return true; // sem lead não há o que checar aqui (a função decide)
  const { data } = await sb().from("leads").select("tenant_id").eq("id", leadId).maybeSingle();
  return !!data && data.tenant_id === caller.user.tenantId;
}
