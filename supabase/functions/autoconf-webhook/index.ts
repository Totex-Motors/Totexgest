import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "../_shared/config.ts";

// AUTOCONF → TOTEX — webhook de ativação do app "Totex Motors" no marketplace do Autoconf.
//
// O Autoconf (ERP das lojas) manda um evento quando o lojista ativa/desativa o app, com os
// dados da loja, o link do feed de estoque e o contato de quem ativou. Aqui:
//   1. valida o segredo compartilhado (header x-autoconf-secret = config AUTOCONF_WEBHOOK_SECRET);
//   2. registra o evento (autoconf_events, idempotente por event_id);
//   3. cria/atualiza a loja (autoconf_stores) e provisiona o tenant no CRM (provision-tenant,
//      a mesma porta usada pelo TotexMotors OS) — idempotente por store.id;
//   4. abre uma tarefa crítica na matriz pra cadastrar o feed no marketplace e dar boas-vindas.
//
// GET  /autoconf-webhook            → contrato (JSON) — pra o dev do Autoconf conferir o formato.
// POST /autoconf-webhook            → evento (ver `CONTRATO` abaixo). Sempre responde JSON.
// Público (verify_jwt = false): a autenticação é o segredo compartilhado. Sem segredo no código.
// Especificação completa: docs/INTEGRACAO-AUTOCONF.md

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const INCOMING_OS_SECRET = Deno.env.get("INCOMING_OS_SECRET") || "";
const LOG = "[autoconf-webhook]";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-autoconf-secret, x-autoconf-event-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

export const CONTRATO = {
  versao: "1.0",
  endpoint: "POST /functions/v1/autoconf-webhook",
  autenticacao: "header x-autoconf-secret: <segredo compartilhado, enviado em canal privado>",
  eventos: ["app.activated", "app.deactivated", "store.updated", "feed.updated"],
  payload: {
    event: "app.activated",
    event_id: "uuid único do evento (idempotência; reenvio com o mesmo id não duplica)",
    sent_at: "ISO 8601",
    store: {
      id: "id da loja no Autoconf (obrigatório, estável)",
      name: "nome fantasia (obrigatório)",
      legal_name: "razão social", cnpj: "só dígitos", phone: "DDI+DDD+número", whatsapp: "DDI+DDD+número",
      email: "e-mail da loja", website: "url", logo_url: "url",
      address: { street: "", number: "", district: "", city: "", state: "UF", zip: "" },
    },
    feed: { url: "URL pública e estável do feed de estoque (obrigatório em app.activated)", format: "autoconf_xml | json" },
    activated_by: { name: "quem ativou (obrigatório)", email: "", phone: "DDI+DDD+número" },
  },
  resposta: { ok: true, status: "created | updated | ignored", store_id: "…", tenant_id: "uuid no Totexgest" },
  erros: { 401: "segredo inválido", 400: "payload inválido (campo obrigatório ausente)", 500: "erro interno — reenviar com o mesmo event_id" },
  retries: "Reenvie em caso de 5xx ou timeout, com o mesmo event_id, com backoff (1 min, 5 min, 30 min).",
};

const digits = (v: unknown) => String(v ?? "").replace(/\D/g, "");
const str = (v: unknown, max = 200) => (v === null || v === undefined ? null : String(v).trim().slice(0, max) || null);
const pick = (o: Record<string, unknown> | null | undefined, ...keys: string[]) => {
  for (const k of keys) if (o && o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k];
  return undefined;
};

/** Aceita variações de nome de campo (store/loja/dealership, feed/feed_url, activated_by/contact/contato). */
function normalizar(body: Record<string, unknown>) {
  const store = (pick(body, "store", "loja", "dealership", "empresa") ?? {}) as Record<string, unknown>;
  const feedRaw = pick(body, "feed", "feed_url", "feedUrl", "site_feed", "feed_site");
  const feed = typeof feedRaw === "string" ? { url: feedRaw } : ((feedRaw ?? {}) as Record<string, unknown>);
  const who = (pick(body, "activated_by", "activatedBy", "contact", "contato", "user", "usuario") ?? {}) as Record<string, unknown>;
  const addr = (pick(store, "address", "endereco") ?? {}) as Record<string, unknown>;
  return {
    event: String(pick(body, "event", "evento", "type", "tipo") ?? "app.activated").toLowerCase(),
    event_id: str(pick(body, "event_id", "eventId", "id")),
    sent_at: str(pick(body, "sent_at", "sentAt", "timestamp")),
    store: {
      id: str(pick(store, "id", "store_id", "external_id", "codigo")),
      name: str(pick(store, "name", "nome", "trade_name", "nome_fantasia")),
      legal_name: str(pick(store, "legal_name", "razao_social", "razaoSocial")),
      cnpj: digits(pick(store, "cnpj", "document")) || null,
      phone: digits(pick(store, "phone", "telefone")) || null,
      whatsapp: digits(pick(store, "whatsapp")) || digits(pick(store, "phone", "telefone")) || null,
      email: str(pick(store, "email")),
      website: str(pick(store, "website", "site", "url")),
      logo_url: str(pick(store, "logo_url", "logo", "logoUrl"), 500),
      address: {
        street: str(pick(addr, "street", "logradouro", "rua")), number: str(pick(addr, "number", "numero"), 20),
        district: str(pick(addr, "district", "bairro")), city: str(pick(addr, "city", "cidade")),
        state: str(pick(addr, "state", "uf", "estado"), 2), zip: digits(pick(addr, "zip", "cep", "postal_code")) || null,
      },
    },
    feed: { url: str(pick(feed, "url", "link", "href"), 1000), format: str(pick(feed, "format", "formato"), 40) },
    activated_by: {
      name: str(pick(who, "name", "nome")), email: str(pick(who, "email")), phone: digits(pick(who, "phone", "telefone", "whatsapp", "celular")) || null,
    },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method === "GET") return json({ ok: true, servico: "Totex Motors — webhook Autoconf", contrato: CONTRATO });
  if (req.method !== "POST") return json({ ok: false, error: "Método não suportado" }, 405);

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const secret = await getIntegrationKey(supabase, "AUTOCONF_WEBHOOK_SECRET");
  const given = String(req.headers.get("x-autoconf-secret") || req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "").trim();
  if (!secret) { console.error(LOG, "AUTOCONF_WEBHOOK_SECRET não configurado"); return json({ ok: false, error: "Webhook não configurado" }, 500); }
  if (!given || given !== secret) return json({ ok: false, error: "Segredo inválido" }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ ok: false, error: "JSON inválido" }, 400); }
  const ev = normalizar(body);
  if (!ev.store.id || !ev.store.name) return json({ ok: false, error: "store.id e store.name são obrigatórios" }, 400);
  if (ev.event === "app.activated" && !ev.feed.url) return json({ ok: false, error: "feed.url é obrigatório em app.activated" }, 400);
  if (ev.event === "app.activated" && !ev.activated_by.name) return json({ ok: false, error: "activated_by.name é obrigatório em app.activated" }, 400);

  // Idempotência por event_id (reenvio da Autoconf não duplica nada)
  const eventId = ev.event_id || req.headers.get("x-autoconf-event-id") || null;
  if (eventId) {
    const { data: dup } = await supabase.from("autoconf_events").select("id, result").eq("event_id", eventId).maybeSingle();
    if (dup) return json({ ok: true, duplicate: true, ...(dup.result as Record<string, unknown> || {}) });
  }

  const { data: evRow } = await supabase.from("autoconf_events")
    .insert({ event_id: eventId, event: ev.event, store_id: ev.store.id, payload: body, normalized: ev })
    .select("id").single();

  try {
    const { data: existing } = await supabase.from("autoconf_stores").select("*").eq("store_id", ev.store.id).maybeSingle();
    let tenantId: string | null = existing?.tenant_id ?? null;
    let status: "created" | "updated" | "ignored" = existing ? "updated" : "created";

    if (ev.event === "app.deactivated") {
      if (!existing) status = "ignored";
      else await supabase.from("autoconf_stores").update({ status: "inativo", deactivated_at: new Date().toISOString(), raw: body, updated_at: new Date().toISOString() }).eq("id", existing.id);
    } else {
      // Provisiona o tenant no CRM (mesma porta do TotexMotors OS) na primeira ativação
      if (!tenantId) {
        const { data: t } = await supabase.from("tenants").select("id").eq("external_dealership_id", `autoconf:${ev.store.id}`).maybeSingle();
        tenantId = t?.id ?? null;
      }
      if (!tenantId && ev.event === "app.activated") {
        if (!INCOMING_OS_SECRET) throw new Error("INCOMING_OS_SECRET ausente — não dá pra provisionar o tenant");
        const r = await fetch(`${SUPABASE_URL}/functions/v1/provision-tenant`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-integration-secret": INCOMING_OS_SECRET, Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY },
          body: JSON.stringify({
            external_dealership_id: `autoconf:${ev.store.id}`,
            trade_name: ev.store.name, legal_name: ev.store.legal_name, cnpj: ev.store.cnpj,
            whatsapp: ev.store.whatsapp, logo_url: ev.store.logo_url,
            plan: { marketplace: true },
            primary_contact: ev.activated_by.email ? { name: ev.activated_by.name, email: ev.activated_by.email, phone: ev.activated_by.phone } : null,
          }),
        });
        const pj = await r.json().catch(() => ({}));
        if (!r.ok && r.status !== 409) throw new Error(`provision-tenant ${r.status}: ${JSON.stringify(pj).slice(0, 300)}`);
        tenantId = pj.tenant_id ?? null;
        if (tenantId) {
          await supabase.from("tenants").update({
            external_source: "autoconf",
            metadata: { legal_name: ev.store.legal_name, cnpj: ev.store.cnpj, logo_url: ev.store.logo_url, whatsapp: ev.store.whatsapp,
              autoconf: { store_id: ev.store.id, feed_url: ev.feed.url, website: ev.store.website, address: ev.store.address, activated_by: ev.activated_by } },
          }).eq("id", tenantId);
        }
      }
      const row = {
        store_id: ev.store.id, tenant_id: tenantId, name: ev.store.name, legal_name: ev.store.legal_name, cnpj: ev.store.cnpj,
        phone: ev.store.phone, whatsapp: ev.store.whatsapp, email: ev.store.email, website: ev.store.website, logo_url: ev.store.logo_url,
        address: ev.store.address, feed_url: ev.feed.url ?? existing?.feed_url ?? null, feed_format: ev.feed.format ?? existing?.feed_format ?? null,
        activated_by: ev.activated_by.name ? ev.activated_by : existing?.activated_by ?? null,
        status: "ativo", activated_at: existing?.activated_at ?? new Date().toISOString(), deactivated_at: null, raw: body, updated_at: new Date().toISOString(),
      };
      if (existing) await supabase.from("autoconf_stores").update(row).eq("id", existing.id);
      else await supabase.from("autoconf_stores").insert(row);

      // Tarefa crítica na matriz: cadastrar o feed no marketplace + boas-vindas (só na 1ª ativação)
      if (!existing && ev.event === "app.activated") {
        const hq = await getIntegrationKey(supabase, "INDIQUE_TENANT_ID");
        if (hq) {
          await supabase.from("company_activities").insert({
            tenant_id: hq, name: `Autoconf: ${ev.store.name} ativou o app Totex — cadastrar feed no marketplace e dar boas-vindas`,
            description: `Loja ${ev.store.name} (Autoconf id ${ev.store.id})\nFeed: ${ev.feed.url}\nAtivou: ${ev.activated_by.name} · ${ev.activated_by.email || ""} · ${ev.activated_by.phone || ""}\nTenant no Totexgest: ${tenantId || "não criado"}`,
            task_type: "internal", priority: "high", is_critical: true, status: "pending",
            due_datetime: new Date(Date.now() + 24 * 3600_000).toISOString(), source_type: "autoconf", source_id: evRow?.id ?? null,
          });
        }
      }
    }

    const result = { ok: true, status, store_id: ev.store.id, tenant_id: tenantId };
    if (evRow?.id) await supabase.from("autoconf_events").update({ result, processed_at: new Date().toISOString() }).eq("id", evRow.id);
    console.log(LOG, JSON.stringify(result));
    return json(result);
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    console.error(LOG, msg);
    if (evRow?.id) await supabase.from("autoconf_events").update({ result: { ok: false, error: msg }, processed_at: new Date().toISOString() }).eq("id", evRow.id);
    return json({ ok: false, error: "Erro interno — reenviar com o mesmo event_id" }, 500);
  }
});
