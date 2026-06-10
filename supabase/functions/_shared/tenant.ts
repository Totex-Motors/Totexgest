// Extrai o tenant_id do JWT do usuário que invocou a edge function
// (header Authorization: Bearer <jwt>). Usado pelas funções chamadas pelo
// FRONTEND pra ler a chave de integração DO tenant (e cair no global como
// fallback). Em webhooks/crons (sem JWT de usuário) retorna null — aí o
// getIntegrationKey usa o fallback global, então nada quebra.
//
// IMPORTANTE: só confie nessa claim em funções com verify_jwt LIGADO (o gateway
// do Supabase já validou a assinatura). Em webhooks (--no-verify-jwt) resolva o
// tenant pela entidade (lead/instância), NUNCA por este helper.

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
