import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { renderMarkdownLiteToPdf, sha256Hex, type Variables } from "./render.ts";

// INTERMEDIAÇÃO — Fase 2: gera o PDF do Contrato de Intermediação (server-side).
//
// Chamada pelo app com o JWT do usuário (verify_jwt = true). O frontend NUNCA
// manda texto do contrato: o template vem de contract_templates (publicado,
// imutável) e as variáveis do RPC intermediation_contract_snapshot().
//
//   POST { intermediation_id, document_type?, reason? }
//     → 200 { ok, document, signed_url }   (PDF gravado no bucket + contract_documents)
//     → 422 { error, missing }             (faltam dados / sem template publicado)
//   POST { intermediation_id, preview: true }
//     → 200 application/pdf inline (não grava nada; header X-Missing-Count)
//
// Só admin/comercial/closer. Promotora → 403 (nem lê contrato).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers": "Content-Disposition, X-Missing-Count",
};
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const BUCKET = "intermediation-contracts";
const SIGNED_URL_TTL = 600;
const ALLOWED_ROLES = new Set(["admin", "comercial", "closer"]);
const DOCUMENT_TYPES = new Set([
  "INTERMEDIATION_CONTRACT", "PRICE_AUTHORIZATION", "CUSTODY_TERM", "TEST_DRIVE_TERM",
  "BUYER_PROPOSAL", "SALE_CONTRACT", "DELIVERY_TERM", "CANCELLATION_TERM",
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOG = "[contract-render]";

interface Member { id: string; tenant_id: string; role: string; name: string | null }
interface RequestBody { intermediation_id?: unknown; document_type?: unknown; reason?: unknown; preview?: unknown }
interface MissingItem { key: string; label: string; source: string }
interface Snapshot {
  variables: Variables;
  missing: MissingItem[];
  ready: boolean;
  template: { id: string; name: string; version: number; document_type: string; global: boolean } | null;
  next_version: number;
  legal_entity_id: string | null;
}
interface TemplateRow { id: string; name: string; version: number; document_type: string; body: string; status: string }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) { super(message); }
}

/** Resolve o membro do time a partir do JWT (email; fallback auth_user_id). */
async function resolveMember(sb: SupabaseClient, user: { id: string; email?: string }): Promise<Member | null> {
  const cols = "id, tenant_id, role, name";
  if (user.email) {
    const { data, error } = await sb.from("team_members").select(cols)
      .eq("email", user.email).eq("is_active", true).order("created_at").limit(1).maybeSingle();
    if (error) console.error(LOG, "team_members por email:", error.message);
    if (data) return data as Member;
  }
  const { data, error } = await sb.from("team_members").select(cols)
    .eq("auth_user_id", user.id).eq("is_active", true).order("created_at").limit(1).maybeSingle();
  if (error) console.error(LOG, "team_members por auth_user_id:", error.message);
  return (data as Member | null) ?? null;
}

function safeFilePart(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "contrato";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
    console.error(LOG, "variáveis SUPABASE_* ausentes");
    return json({ error: "Função sem configuração do Supabase" }, 500);
  }

  try {
    // ── 1) Auth + membro ──
    const auth = req.headers.get("Authorization") || "";
    if (!auth.startsWith("Bearer ")) return json({ error: "Sem autenticação" }, 401);
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Sessão inválida ou expirada" }, 401);

    const sb = createClient(SUPABASE_URL, SERVICE_KEY);
    const member = await resolveMember(sb, user);
    if (!member) return json({ error: "Membro do time não encontrado" }, 403);
    if (!ALLOWED_ROLES.has(member.role)) {
      console.warn(LOG, `membro ${member.id} (${member.role}) tentou gerar contrato`);
      return json({ error: "Seu perfil não pode gerar contratos" }, 403);
    }

    // ── 2) Body ──
    const body: RequestBody = await req.json().catch(() => ({}));
    const intermediationId = typeof body.intermediation_id === "string" ? body.intermediation_id.trim() : "";
    if (!UUID_RE.test(intermediationId)) return json({ error: "intermediation_id inválido" }, 400);
    const documentType = typeof body.document_type === "string" && body.document_type.trim() ? body.document_type.trim() : "INTERMEDIATION_CONTRACT";
    if (!DOCUMENT_TYPES.has(documentType)) return json({ error: `Tipo de documento desconhecido: ${documentType}` }, 400);
    const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 500) : null;
    const preview = body.preview === true;

    const { data: inter, error: interErr } = await sb.from("intermediations").select("id, tenant_id, code").eq("id", intermediationId).maybeSingle();
    if (interErr) throw new HttpError(500, `Erro ao buscar intermediação: ${interErr.message}`);
    if (!inter || inter.tenant_id !== member.tenant_id) return json({ error: "Intermediação não encontrada" }, 404);

    // ── 3) Snapshot das variáveis ──
    const { data: snapRaw, error: snapErr } = await sb.rpc("intermediation_contract_snapshot", { p_id: intermediationId, p_document_type: documentType });
    if (snapErr) throw new HttpError(500, `Erro ao montar as variáveis do contrato: ${snapErr.message}`);
    const snapshot = snapRaw as Snapshot | null;
    if (!snapshot || typeof snapshot !== "object") throw new HttpError(500, "Snapshot do contrato veio vazio");
    const missing = Array.isArray(snapshot.missing) ? snapshot.missing : [];
    if (!snapshot.template) return json({ error: "Nenhum template publicado para este tipo de documento", document_type: documentType }, 422);
    if (!preview && !snapshot.ready) return json({ error: "Faltam dados pro contrato", missing }, 422);

    // ── 4) Template ──
    const { data: tpl, error: tplErr } = await sb.from("contract_templates").select("id, name, version, document_type, body, status").eq("id", snapshot.template.id).maybeSingle();
    if (tplErr) throw new HttpError(500, `Erro ao carregar o template: ${tplErr.message}`);
    const template = tpl as TemplateRow | null;
    if (!template || !template.body) return json({ error: "Template do contrato não encontrado" }, 422);
    if (template.status !== "published") return json({ error: `Template v${template.version} não está publicado (${template.status})` }, 422);

    // ── 5) PDF ──
    const variables: Variables = snapshot.variables ?? {};
    const contractCode = String(variables["contract.code"] ?? inter.code ?? intermediationId.slice(0, 8));
    const nextVersion = Number(snapshot.next_version) || 1;
    const t0 = Date.now();
    const pdfBytes = await renderMarkdownLiteToPdf(template.body, variables, {
      contractCode, contractVersion: nextVersion, templateVersion: template.version,
      title: `${template.name} — ${contractCode}`,
    });
    const sha256 = await sha256Hex(pdfBytes);
    console.log(LOG, `${preview ? "preview" : "render"} ${contractCode} v${nextVersion} tpl v${template.version} — ${pdfBytes.byteLength} bytes em ${Date.now() - t0}ms — faltando ${missing.length}`);

    if (preview) {
      const filename = `contrato-${safeFilePart(contractCode)}-v${nextVersion}-preview.pdf`;
      return new Response(pdfBytes, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="${filename}"`,
          "Cache-Control": "no-store",
          "X-Missing-Count": String(missing.length),
        },
      });
    }

    // ── 6) Upload ──
    const filePath = `${member.tenant_id}/${intermediationId}/contrato-v${nextVersion}-${Date.now()}.pdf`;
    const { error: upErr } = await sb.storage.from(BUCKET).upload(filePath, pdfBytes, { contentType: "application/pdf", upsert: false });
    if (upErr) throw new HttpError(500, `Erro ao salvar o PDF no storage: ${upErr.message}`);

    // ── 7) Registro (nova versão; anteriores não assinadas viram cancelled) ──
    const { data: doc, error: regErr } = await sb.rpc("contract_document_register", {
      p_intermediation: intermediationId,
      p_document_type: documentType,
      p_template_id: template.id,
      p_template_version: template.version,
      p_snapshot: snapshot,
      p_file_path: filePath,
      p_sha256: sha256,
      p_generated_by: member.id,
      p_reason: reason,
    });
    if (regErr || !doc) {
      console.error(LOG, "contract_document_register falhou, removendo arquivo:", regErr?.message);
      const { error: rmErr } = await sb.storage.from(BUCKET).remove([filePath]);
      if (rmErr) console.error(LOG, "não conseguiu remover o arquivo órfão:", rmErr.message);
      throw new HttpError(500, `Erro ao registrar o documento: ${regErr?.message ?? "sem retorno"}`);
    }

    // ── 8) URL assinada ──
    const { data: signed, error: signErr } = await sb.storage.from(BUCKET).createSignedUrl(filePath, SIGNED_URL_TTL);
    if (signErr) console.warn(LOG, "createSignedUrl falhou:", signErr.message);

    console.log(LOG, `documento registrado ${contractCode} v${nextVersion} por ${member.name ?? member.id} sha ${sha256.slice(0, 12)}`);
    return json({ ok: true, document: doc, signed_url: signed?.signedUrl ?? null, sha256, file_path: filePath });
  } catch (err) {
    if (err instanceof HttpError) {
      console.error(LOG, err.status, err.message);
      return json({ error: err.message, ...err.extra }, err.status);
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(LOG, "erro inesperado:", message);
    return json({ error: `Erro ao gerar o contrato: ${message}` }, 500);
  }
});
