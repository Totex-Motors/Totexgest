// Testes das partes críticas de billing das API keys por-tenant (#5):
//   1. getIntegrationKey resolve a chave DO tenant, com fallback global → env.
//   2. O cache é isolado por tenant — a chave de um tenant NUNCA é servida
//      pra outro (vazamento = custo na conta errada).
//   3. getTenantIdFromRequest decodifica o tenant_id do JWT (e null no resto).
//
// Rodar: deno test supabase/functions/_shared/config_tenant.test.ts --allow-env

import { assertEquals } from "jsr:@std/assert@1";
import {
  getIntegrationKey,
  invalidateIntegrationKeyCache,
} from "./config.ts";
import { getTenantIdFromRequest } from "./tenant.ts";

// ---- Mock mínimo do SupabaseClient (duck-typed) -----------------------------
// Simula `from(table).select(col).eq(...).eq(...).maybeSingle()`.
// `rows` = linhas por tabela; a query filtra por igualdade nos eq() acumulados.
function makeMockClient(rows: Record<string, Record<string, string>[]>) {
  let queryCount = 0;
  const client = {
    get queryCount() {
      return queryCount;
    },
    from(table: string) {
      const filters: Record<string, string> = {};
      const builder = {
        select() {
          return builder;
        },
        eq(col: string, val: string) {
          filters[col] = val;
          return builder;
        },
        maybeSingle() {
          queryCount++;
          const tableRows = rows[table] ?? [];
          const match = tableRows.find((r) =>
            Object.entries(filters).every(([k, v]) => r[k] === v)
          );
          return Promise.resolve({ data: match ?? null, error: null });
        },
      };
      return builder;
    },
  };
  // deno-lint-ignore no-explicit-any
  return client as any;
}

Deno.test("getIntegrationKey: usa a chave DO tenant quando existe", async () => {
  invalidateIntegrationKeyCache();
  const supabase = makeMockClient({
    tenant_integration_keys: [
      { tenant_id: "A", key: "ANTHROPIC_API_KEY", value: "key-A" },
      { tenant_id: "B", key: "ANTHROPIC_API_KEY", value: "key-B" },
    ],
    config: [{ key: "ANTHROPIC_API_KEY", value: "key-GLOBAL" }],
  });

  assertEquals(await getIntegrationKey(supabase, "ANTHROPIC_API_KEY", "A"), "key-A");
  assertEquals(await getIntegrationKey(supabase, "ANTHROPIC_API_KEY", "B"), "key-B");
});

Deno.test("getIntegrationKey: cai no global quando o tenant não tem a chave", async () => {
  invalidateIntegrationKeyCache();
  const supabase = makeMockClient({
    tenant_integration_keys: [
      { tenant_id: "A", key: "ANTHROPIC_API_KEY", value: "key-A" },
    ],
    config: [{ key: "ANTHROPIC_API_KEY", value: "key-GLOBAL" }],
  });

  // Tenant C não tem chave própria → global.
  assertEquals(await getIntegrationKey(supabase, "ANTHROPIC_API_KEY", "C"), "key-GLOBAL");
  // Sem tenantId → comportamento antigo (global).
  assertEquals(await getIntegrationKey(supabase, "ANTHROPIC_API_KEY"), "key-GLOBAL");
});

Deno.test("getIntegrationKey: cache é isolado por tenant (anti-vazamento)", async () => {
  invalidateIntegrationKeyCache();
  const supabase = makeMockClient({
    tenant_integration_keys: [
      { tenant_id: "A", key: "OPENAI_API_KEY", value: "openai-A" },
      { tenant_id: "B", key: "OPENAI_API_KEY", value: "openai-B" },
    ],
    config: [{ key: "OPENAI_API_KEY", value: "openai-GLOBAL" }],
  });

  // Popula o cache pro tenant A.
  assertEquals(await getIntegrationKey(supabase, "OPENAI_API_KEY", "A"), "openai-A");
  // Logo em seguida o tenant B NÃO pode receber a chave cacheada do A.
  assertEquals(await getIntegrationKey(supabase, "OPENAI_API_KEY", "B"), "openai-B");
  // E sem tenant, o global.
  assertEquals(await getIntegrationKey(supabase, "OPENAI_API_KEY"), "openai-GLOBAL");

  // Segunda leitura do A vem do cache (sem nova query): contagem não muda.
  const before = supabase.queryCount;
  assertEquals(await getIntegrationKey(supabase, "OPENAI_API_KEY", "A"), "openai-A");
  assertEquals(supabase.queryCount, before);
});

Deno.test("getIntegrationKey: env como último fallback", async () => {
  invalidateIntegrationKeyCache();
  Deno.env.set("RESEND_API_KEY", "env-resend");
  const supabase = makeMockClient({ tenant_integration_keys: [], config: [] });
  assertEquals(await getIntegrationKey(supabase, "RESEND_API_KEY", "A"), "env-resend");
  Deno.env.delete("RESEND_API_KEY");
});

// ---- getTenantIdFromRequest -------------------------------------------------
function jwtWith(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.sig`;
}

Deno.test("getTenantIdFromRequest: lê app_metadata.tenant_id", () => {
  const token = jwtWith({ app_metadata: { tenant_id: "tenant-123" }, sub: "u1" });
  const req = new Request("https://x", { headers: { Authorization: `Bearer ${token}` } });
  assertEquals(getTenantIdFromRequest(req), "tenant-123");
});

Deno.test("getTenantIdFromRequest: null sem header / sem claim / token inválido", () => {
  assertEquals(getTenantIdFromRequest(new Request("https://x")), null);

  const noClaim = jwtWith({ sub: "u1" });
  const req2 = new Request("https://x", { headers: { Authorization: `Bearer ${noClaim}` } });
  assertEquals(getTenantIdFromRequest(req2), null);

  const req3 = new Request("https://x", { headers: { Authorization: "Bearer garbage" } });
  assertEquals(getTenantIdFromRequest(req3), null);
});
