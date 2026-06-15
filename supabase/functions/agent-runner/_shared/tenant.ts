// Extrai o tenant_id do JWT do usuário que invocou a edge function
// (header Authorization: Bearer <jwt>). Usado pelo canal chat_web (frontend manda
// o JWT do usuário logado). Webhooks/cron passam tenant_id no body — então quando
// não há JWT, retorna null e o caller usa o tenant_id explícito do payload.
//
// Espelha supabase/functions/_shared/tenant.ts do CRM. NÃO confie nessa claim em
// webhooks (--no-verify-jwt) sem validação: o agent-runner roda com verify_jwt=false,
// mas o gateway do Supabase ainda repassa o JWT do usuário no chat_web; para canais
// externos a fonte de verdade é o tenant_id resolvido pela entidade (instância/lead).

function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4;
  const full = pad ? padded + "=".repeat(4 - pad) : padded;
  return atob(full);
}

export function getTenantIdFromRequest(req: Request): string | null {
  try {
    const auth =
      req.headers.get("Authorization") || req.headers.get("authorization");
    if (!auth) return null;

    const token = auth.replace(/^Bearer\s+/i, "").trim();
    const parts = token.split(".");
    if (parts.length < 2) return null;

    const payload = JSON.parse(base64UrlDecode(parts[1]));
    const tid =
      payload?.app_metadata?.tenant_id ?? payload?.tenant_id ?? null;

    return typeof tid === "string" && tid.length > 0 ? tid : null;
  } catch {
    return null;
  }
}
