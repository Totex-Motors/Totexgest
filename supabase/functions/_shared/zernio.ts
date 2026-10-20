// Cliente mínimo da Zernio (https://docs.zernio.com) — publicação multi-rede.
// Chave global ZERNIO_API_KEY (config). Nada hardcoded.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "./config.ts";

export const ZERNIO_BASE = "https://zernio.com/api/v1";

/** Redes que fazem sentido pro Studio hoje (carrossel de imagens). */
export const ZERNIO_PLATFORMS: Record<string, { label: string; aceitaImagem: boolean; nota?: string }> = {
  facebook: { label: "Facebook (página)", aceitaImagem: true },
  tiktok: { label: "TikTok", aceitaImagem: true, nota: "Publica como carrossel de fotos." },
  youtube: { label: "YouTube", aceitaImagem: false, nota: "Só aceita vídeo. O carrossel do Studio não entra aqui ainda." },
  threads: { label: "Threads", aceitaImagem: true },
  linkedin: { label: "LinkedIn", aceitaImagem: true },
  pinterest: { label: "Pinterest", aceitaImagem: true },
};

export class ZernioError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, msg?: string) {
    super(msg || `Zernio HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

export async function zernioKey(sb: SupabaseClient): Promise<string | null> {
  return await getIntegrationKey(sb, "ZERNIO_API_KEY");
}

export async function zernio<T = any>(
  apiKey: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const res = await fetch(`${ZERNIO_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...extraHeaders,
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.error?.message || data?.error || data?.message || `Zernio respondeu ${res.status}`;
    throw new ZernioError(res.status, data, typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return data as T;
}

/** Garante um profile da Zernio pro tenant (externalId = tenant_id). */
export async function ensureProfile(sb: SupabaseClient, apiKey: string, tenantId: string, nome: string): Promise<string> {
  const { data: row } = await sb.from("zernio_profiles").select("profile_id").eq("tenant_id", tenantId).maybeSingle();
  if (row?.profile_id) return row.profile_id;

  // Já existe lá (criado antes / em outro deploy)?
  try {
    const list = await zernio<any>(apiKey, "GET", `/profiles?externalId=${encodeURIComponent(tenantId)}&includeOverLimit=true&limit=10&skip=0`);
    const found = (list?.profiles || list?.data || []).find((p: any) => p?.externalId === tenantId) || (list?.profiles || [])[0];
    if (found?._id) {
      await sb.from("zernio_profiles").upsert({ tenant_id: tenantId, profile_id: found._id });
      return found._id;
    }
  } catch (e) { console.warn("[zernio] GET /profiles falhou:", (e as Error).message); }

  let profileId = "";
  try {
    const created = await zernio<any>(apiKey, "POST", "/profiles", { name: nome, externalId: tenantId, timezone: "America/Sao_Paulo" });
    profileId = created?.profile?._id || created?._id || "";
  } catch (e) {
    // 409 profile_external_id_conflict → details.existingProfileId traz o id existente
    const body: any = (e as ZernioError).body;
    profileId = body?.details?.existingProfileId || body?.error?.details?.existingProfileId || body?.existingProfileId || body?.profileId || body?.profile?._id || "";
    if (!profileId) throw e;
  }
  if (!profileId) throw new Error("Zernio não devolveu o id do profile.");
  await sb.from("zernio_profiles").upsert({ tenant_id: tenantId, profile_id: profileId });
  return profileId;
}

export interface ZernioAccount {
  _id: string;
  platform: string;
  username?: string;
  displayName?: string;
  profilePicture?: string;
  profileUrl?: string;
  isActive?: boolean;
  needsReconnection?: boolean;
}

export async function listAccounts(apiKey: string, profileId: string): Promise<ZernioAccount[]> {
  // page e limit têm que ir juntos ("page and limit must be provided together")
  const r = await zernio<any>(apiKey, "GET", `/accounts?profileId=${encodeURIComponent(profileId)}&category=social&page=1&limit=100`);
  return (r?.accounts || []) as ZernioAccount[];
}

/**
 * Contas que a loja pode usar: as do profile dela e, se ela é a dona da conta Zernio
 * (config ZERNIO_DEFAULT_PROFILE_TENANT_ID), também as conectadas pelo painel da Zernio,
 * que caem no profile "Default".
 */
export async function listTenantAccounts(sb: SupabaseClient, apiKey: string, tenantId: string, profileId: string): Promise<ZernioAccount[]> {
  const own = await listAccounts(apiKey, profileId);
  const donoId = await getIntegrationKey(sb, "ZERNIO_DEFAULT_PROFILE_TENANT_ID");
  if (!donoId || donoId !== tenantId) return own;
  try {
    const list = await zernio<any>(apiKey, "GET", `/profiles?includeOverLimit=true&limit=50&skip=0`);
    const def = (list?.profiles || []).find((p: any) => p?.isDefault && p?._id !== profileId);
    if (!def?._id) return own;
    const extra = await listAccounts(apiKey, def._id);
    const ids = new Set(own.map((a) => a._id));
    return [...own, ...extra.filter((a) => !ids.has(a._id))];
  } catch (e) {
    console.warn("[zernio] contas do profile Default:", (e as Error).message);
    return own;
  }
}

/** HMAC-SHA256 hex do corpo cru, comparado com X-Zernio-Signature. */
export async function verifyZernioSignature(secret: string, rawBody: string, header: string | null): Promise<boolean> {
  if (!secret || !header) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  const given = header.trim().toLowerCase().replace(/^sha256=/, "");
  if (given.length !== hex.length) return false;
  let r = 0;
  for (let i = 0; i < hex.length; i++) r |= hex.charCodeAt(i) ^ given.charCodeAt(i);
  return r === 0;
}
