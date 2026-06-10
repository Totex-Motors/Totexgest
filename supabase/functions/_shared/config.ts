// Helper para ler chaves de integração. Hierarquia de busca:
//   1. tenant_integration_keys (chave DO tenant — lojista paga as próprias) *
//   2. config (chave GLOBAL — fallback central da Totex)
//   3. Deno.env (fallback pra dev/deploy manual)
//
// * Passo 1 só acontece quando `tenantId` é informado. Sem ele, o comportamento
//   é IDÊNTICO ao antigo (config → env), então nenhuma edge function quebra.
//
// Uso:
//   import { getIntegrationKey } from "../_shared/config.ts";
//   const anthropicKey = await getIntegrationKey(supabase, "ANTHROPIC_API_KEY");        // global
//   const anthropicKey = await getIntegrationKey(supabase, "ANTHROPIC_API_KEY", tid);   // do tenant + fallback

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

// Cache em memória (por processo) pra evitar query a cada chamada da função.
// TTL curto pra refletir mudanças do admin sem reiniciar a função.
const TTL_MS = 60_000; // 60 segundos
const cache = new Map<string, { value: string | null; expiresAt: number }>();

// A chave do cache PRECISA incluir o tenant — senão a chave de um tenant
// vazaria pro request de outro (mesmo processo). Risco de billing/segurança.
function cacheKeyFor(key: string, tenantId?: string | null): string {
  return `${tenantId ?? "__global__"}:${key}`;
}

export async function getIntegrationKey(
  supabase: SupabaseClient,
  key: string,
  tenantId?: string | null
): Promise<string | null> {
  const ck = cacheKeyFor(key, tenantId);

  // 0. Cache
  const cached = cache.get(ck);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  // 1. Chave DO tenant (só quando tenantId é informado)
  if (tenantId) {
    try {
      const { data } = await supabase
        .from("tenant_integration_keys")
        .select("value")
        .eq("tenant_id", tenantId)
        .eq("key", key)
        .maybeSingle();

      if (data?.value && String(data.value).trim().length > 0) {
        const value = String(data.value).trim();
        cache.set(ck, { value, expiresAt: Date.now() + TTL_MS });
        return value;
      }
    } catch (err) {
      console.warn(
        `[getIntegrationKey] Erro lendo tenant_integration_keys.${key} (tenant ${tenantId}):`,
        err
      );
    }
  }

  // 2. Tabela config (global — fallback central da Totex)
  try {
    const { data } = await supabase
      .from("config")
      .select("value")
      .eq("key", key)
      .maybeSingle();

    if (data?.value && String(data.value).trim().length > 0) {
      const value = String(data.value).trim();
      cache.set(ck, { value, expiresAt: Date.now() + TTL_MS });
      return value;
    }
  } catch (err) {
    console.warn(`[getIntegrationKey] Erro lendo config.${key}:`, err);
  }

  // 3. Env var (fallback pra dev/deploy manual)
  const envValue = Deno.env.get(key);
  if (envValue && envValue.trim().length > 0) {
    const value = envValue.trim();
    cache.set(ck, { value, expiresAt: Date.now() + TTL_MS });
    return value;
  }

  // Não encontrado
  cache.set(ck, { value: null, expiresAt: Date.now() + TTL_MS });
  return null;
}

// Invalida o cache para uma chave específica (todos os tenants) ou tudo se omitido.
export function invalidateIntegrationKeyCache(key?: string) {
  if (!key) {
    cache.clear();
    return;
  }
  // Remove a entrada da chave em todos os tenants (sufixo `:${key}`).
  const suffix = `:${key}`;
  for (const ck of cache.keys()) {
    if (ck.endsWith(suffix)) cache.delete(ck);
  }
}

// Helper que exige a chave (lança erro se não tiver) — usar quando a função
// não consegue operar sem ela.
export async function requireIntegrationKey(
  supabase: SupabaseClient,
  key: string,
  tenantId?: string | null
): Promise<string> {
  const value = await getIntegrationKey(supabase, key, tenantId);
  if (!value) {
    throw new Error(
      `Integração "${key}" não configurada. Peça ao administrador ` +
      `preencher em /configuracoes > Integrações > API Keys.`
    );
  }
  return value;
}
