// INTERMEDIAÇÃO — Fase 3: fábrica do provedor de assinatura por tenant.
//
//   const provider = await getSignatureProvider(sb, tenantId);
//
// Lê CLICKSIGN_API_KEY / CLICKSIGN_ENV via getIntegrationKey (tenant_integration_keys → config → env).
// Sem chave → SignatureConfigError com mensagem pronta pra UI.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "../config.ts";
import { ClicksignProvider } from "./clicksign.ts";
import { SignatureConfigError, type SignatureProvider } from "./provider.ts";

export type {
  CreateEnvelopeInput, CreateEnvelopeResult, EnvelopeSignerInput, EnvelopeSignerStatus, EnvelopeStatusResult,
  ParsedWebhook, ProviderEventType, SignatureProvider, SignerAuth, SignerChannel, WebhookRegistration,
} from "./provider.ts";
export { SignatureConfigError, SignatureProviderError } from "./provider.ts";

export const PROVIDER_NAME = "clicksign";
export const KEY_API = "CLICKSIGN_API_KEY";
export const KEY_ENV = "CLICKSIGN_ENV";
export const KEY_WEBHOOK_SECRET = "CLICKSIGN_WEBHOOK_SECRET";
export const MISSING_KEY_MESSAGE = "Chave da Clicksign não configurada (Configurações > Integrações)";

export function parseClicksignEnv(v: string | null | undefined): "sandbox" | "production" {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "production" || s === "prod" || s === "producao" || s === "produção" ? "production" : "sandbox";
}

export async function getSignatureProvider(sb: SupabaseClient, tenantId: string | null | undefined): Promise<SignatureProvider> {
  const token = await getIntegrationKey(sb, KEY_API, tenantId);
  if (!token) throw new SignatureConfigError(MISSING_KEY_MESSAGE);
  const env = parseClicksignEnv(await getIntegrationKey(sb, KEY_ENV, tenantId));
  return new ClicksignProvider(token, env);
}

/**
 * Secret do webhook do tenant — lido DIRETO do banco, sem cache (acabou de ser gravado
 * pelo register_webhook). Fallback: tabela config (global). Nunca logar o valor.
 */
export async function getWebhookSecret(sb: SupabaseClient, tenantId: string): Promise<string | null> {
  const { data, error } = await sb.from("tenant_integration_keys").select("value")
    .eq("tenant_id", tenantId).eq("key", KEY_WEBHOOK_SECRET).maybeSingle();
  if (error) console.warn("[signature] tenant_integration_keys:", error.message);
  const v = typeof data?.value === "string" ? data.value.trim() : "";
  if (v) return v;
  const { data: g, error: gErr } = await sb.from("config").select("value").eq("key", KEY_WEBHOOK_SECRET).maybeSingle();
  if (gErr) console.warn("[signature] config:", gErr.message);
  const gv = typeof g?.value === "string" ? g.value.trim() : "";
  return gv || null;
}

/** Grava o secret do webhook do tenant (service_role; upsert on (tenant_id, key)). */
export async function saveWebhookSecret(sb: SupabaseClient, tenantId: string, secret: string): Promise<void> {
  const { error } = await sb.from("tenant_integration_keys")
    .upsert({ tenant_id: tenantId, key: KEY_WEBHOOK_SECRET, value: secret, updated_at: new Date().toISOString() }, { onConflict: "tenant_id,key" });
  if (error) throw new Error(`Não consegui salvar o secret do webhook: ${error.message}`);
}
