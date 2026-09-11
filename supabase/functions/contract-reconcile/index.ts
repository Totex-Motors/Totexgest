import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getSignatureProvider, type SignatureProvider } from "../_shared/signature/index.ts";
import { type ContractDocumentRow, reconcileDocument } from "../_shared/signature/reconcile.ts";

// INTERMEDIAÇÃO — Fase 3: reconciliação periódica com o provedor (cron pg_cron */30, sem JWT).
//
//   POST { mode: "reconcile", stale_minutes?: number }
//     → { checked, finalized, applied, errors, skipped, details:[...] }
//
// Pega os documentos de contract_documents_to_reconcile(): completed (aguardando o PDF
// assinado), sent/partial parados há > N min sem webhook, ou com prazo vencido. Agrupa por
// tenant (chave da Clicksign é por tenant) e roda reconcileDocument() em cada um. Erro em
// um documento não para o lote. last_reconciled_at é atualizado mesmo sem mudança.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const LOG = "[contract-reconcile]";
const DEFAULT_STALE_MINUTES = 120;

interface Detail { document_id: string; tenant_id: string; version: number; before: string; after?: string; provider_status?: string; applied?: number; finalized?: boolean; error?: string }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "GET") return json({ ok: true, service: "contract-reconcile" });
  if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error(LOG, "variáveis SUPABASE_* ausentes");
    return json({ error: "Função sem configuração do Supabase" }, 500);
  }

  const body = await req.json().catch(() => ({})) as { mode?: unknown; stale_minutes?: unknown };
  const mode = typeof body.mode === "string" ? body.mode : "reconcile";
  if (mode !== "reconcile") return json({ error: `mode desconhecido: ${mode}` }, 400);
  const staleRaw = Number(body.stale_minutes);
  const stale = Number.isFinite(staleRaw) && staleRaw >= 1 ? Math.min(Math.round(staleRaw), 24 * 60) : DEFAULT_STALE_MINUTES;

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const t0 = Date.now();
  const { data, error } = await sb.rpc("contract_documents_to_reconcile", { p_stale_minutes: stale });
  if (error) {
    console.error(LOG, "contract_documents_to_reconcile:", error.message);
    return json({ error: `contract_documents_to_reconcile: ${error.message}` }, 500);
  }
  const docs = (Array.isArray(data) ? data : []) as ContractDocumentRow[];
  if (!docs.length) {
    console.log(LOG, "nada a reconciliar");
    return json({ checked: 0, finalized: 0, applied: 0, errors: 0, skipped: 0, details: [] });
  }

  const byTenant = new Map<string, ContractDocumentRow[]>();
  for (const d of docs) byTenant.set(d.tenant_id, [...(byTenant.get(d.tenant_id) ?? []), d]);

  const details: Detail[] = [];
  let finalized = 0, applied = 0, errors = 0, skipped = 0;
  const touch = async (id: string) => {
    const { error: tErr } = await sb.from("contract_documents").update({ last_reconciled_at: new Date().toISOString() }).eq("id", id);
    if (tErr) console.warn(LOG, "last_reconciled_at:", tErr.message);
  };

  for (const [tenantId, list] of byTenant) {
    let provider: SignatureProvider;
    try {
      provider = await getSignatureProvider(sb, tenantId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(LOG, `tenant ${tenantId}: ${msg} — ${list.length} doc(s) pulados`);
      for (const d of list) {
        errors++;
        details.push({ document_id: d.id, tenant_id: tenantId, version: d.version, before: d.status, error: msg });
        await touch(d.id);
      }
      continue;
    }
    for (const d of list) {
      try {
        const r = await reconcileDocument(sb, provider, d);
        if (r.finalized) finalized++;
        if (r.skipped) skipped++;
        applied += r.applied;
        details.push({ document_id: d.id, tenant_id: tenantId, version: d.version, before: d.status, after: r.document?.status, provider_status: r.providerStatus, applied: r.applied, finalized: r.finalized });
      } catch (err) {
        errors++;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(LOG, `doc ${d.id} v${d.version} (${d.status}):`, msg);
        details.push({ document_id: d.id, tenant_id: tenantId, version: d.version, before: d.status, error: msg.slice(0, 300) });
        await touch(d.id);
      }
    }
  }

  console.log(LOG, `checked=${docs.length} finalized=${finalized} applied=${applied} errors=${errors} skipped=${skipped} em ${Date.now() - t0}ms (stale ${stale}min)`);
  return json({ checked: docs.length, finalized, applied, errors, skipped, stale_minutes: stale, details });
});
