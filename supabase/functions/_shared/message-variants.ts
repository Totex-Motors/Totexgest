/**
 * Variantes de mensagem por ponto de contato (otimizador de conversas, 2026-11-02).
 *
 * pickVariant(): escolhe entre as variantes ATIVAS do touchpoint por amostragem de Thompson
 * (Beta(respondidas+1, silenciosas+1) — quem responde mais ganha mais envios, mas as outras
 * continuam sendo testadas). logVariantSend() registra o envio; a resposta é medida depois
 * (message_variant_stats) olhando a whatsapp_messages. Variante do tipo template só é usada
 * se o template estiver APROVADO na Meta (whatsapp_cloud_templates, com conferência ao vivo).
 */
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export interface Variant {
  id: string; tenant_id: string; touchpoint: string; name: string; kind: "template" | "text";
  body: string | null; buttons: { text: string; id?: string }[]; status: string; weight: number;
  /** o que vai em cada {{n}}: chaves do vocabulário (nome, assinatura, carro, assunto, motivo, parcela, loja) */
  params_spec?: string[];
}

/** Vocabulário de parâmetros que todo ponto de contato sabe preencher. */
export type ParamCtx = Partial<Record<"nome" | "assinatura" | "carro" | "assunto" | "motivo" | "parcela" | "loja", string | null | undefined>>;

/** Monta os params do template a partir do params_spec da variante. Chave desconhecida → "". */
export function buildParams(v: Variant, ctx: ParamCtx): string[] {
  const spec = Array.isArray(v.params_spec) && v.params_spec.length ? v.params_spec : [];
  if (!spec.length) {
    // sem spec: conta as variáveis do corpo e assume nome, (assinatura), carro…
    // Conta variáveis DISTINTAS ({{1}}..{{N}}). Faltar parâmetro = Meta recusa com #132000 (bug 08-09/11:
    // reaquecimento_viu_carro_v2 sem params_spec mandava 3 de 4 e falhou ~48 vezes em 24 h).
    const n = new Set(String(v.body || "").match(/\{\{\d+\}\}/g) || []).size;
    const def = n >= 4 ? ["nome", "assinatura", "carro", "parcela"] : n === 3 ? ["nome", "assinatura", "carro"] : n === 2 ? ["nome", "carro"] : n === 1 ? ["nome"] : [];
    return def.map((k) => String((ctx as any)[k] ?? ""));
  }
  return spec.map((k) => String((ctx as any)[k] ?? ""));
}

/** Janela de 24 h da Meta: aberta se o cliente mandou algo nas últimas 23 h. */
export async function janelaAberta(sb: SupabaseClient, leadId: string | null, phone: string): Promise<boolean> {
  const last8 = String(phone || "").replace(/\D/g, "").slice(-8);
  let q = sb.from("whatsapp_messages").select("sent_at").eq("is_from_me", false).order("sent_at", { ascending: false }).limit(1);
  q = leadId ? q.eq("lead_id", leadId) : q.like("sender_phone", `%${last8}`);
  const { data } = await q.maybeSingle();
  if (data?.sent_at && Date.now() - new Date(data.sent_at).getTime() < 23 * 3600_000) return true;
  if (leadId) {
    const { data: d2 } = await sb.from("whatsapp_messages").select("sent_at").eq("is_from_me", false).like("sender_phone", `%${last8}`).order("sent_at", { ascending: false }).limit(1).maybeSingle();
    return !!d2?.sent_at && Date.now() - new Date(d2.sent_at).getTime() < 23 * 3600_000;
  }
  return false;
}

export async function templateAprovado(sb: SupabaseClient, tenantId: string, name: string): Promise<boolean> {
  const { data: tpl } = await sb.from("whatsapp_cloud_templates").select("id, status, meta_waba_id").eq("name", name).eq("tenant_id", tenantId).limit(1).maybeSingle();
  if (!tpl) return false;
  if (String(tpl.status).toUpperCase() === "APPROVED") return true;
  try {
    const { data: inst } = await sb.from("whatsapp_instances").select("api_key").eq("provider", "meta_cloud").eq("tenant_id", tenantId).limit(1).maybeSingle();
    if (!inst?.api_key || !tpl.meta_waba_id) return false;
    const r = await fetch(`https://graph.facebook.com/v22.0/${tpl.meta_waba_id}/message_templates?name=${encodeURIComponent(name)}&fields=status`, { headers: { Authorization: `Bearer ${inst.api_key}` } });
    const j = await r.json().catch(() => ({}));
    const live = j?.data?.[0]?.status;
    if (live && live !== tpl.status) await sb.from("whatsapp_cloud_templates").update({ status: live, updated_at: new Date().toISOString() }).eq("id", tpl.id);
    return String(live || "").toUpperCase() === "APPROVED";
  } catch { return false; }
}

function sampleBeta(a: number, b: number): number {
  // Beta via duas gamas (Marsaglia-Tsang) — suficiente pra bandit
  const g = (k: number): number => {
    if (k < 1) return g(k + 1) * Math.pow(Math.random(), 1 / k);
    const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x: number, v: number;
      do { const u1 = Math.random(), u2 = Math.random(); x = Math.sqrt(-2 * Math.log(u1 || 1e-12)) * Math.cos(2 * Math.PI * u2); v = 1 + c * x; } while (v <= 0);
      v = v * v * v; const u = Math.random();
      if (u < 1 - 0.0331 * x * x * x * x || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  };
  const x = g(a), y = g(b);
  return x / (x + y);
}

/**
 * Escolhe a variante do touchpoint. Só template aprovado (ou kind=text). null = nenhuma
 * disponível (quem chama cai no comportamento antigo).
 */
export async function pickVariant(sb: SupabaseClient, tenantId: string, touchpoint: string, opts: { kind?: "template" | "text" } = {}): Promise<Variant | null> {
  let q = sb.from("message_variants").select("*").eq("tenant_id", tenantId).eq("touchpoint", touchpoint).in("status", ["active", "submitted"]);
  if (opts.kind) q = q.eq("kind", opts.kind);
  const { data } = await q;
  const cands: Variant[] = [];
  for (const v of (data || []) as Variant[]) {
    if (v.kind === "template") {
      const ok = await templateAprovado(sb, tenantId, v.name);
      if (!ok) continue;
      if (v.status === "submitted") await sb.from("message_variants").update({ status: "active", updated_at: new Date().toISOString() }).eq("id", v.id);
    }
    cands.push(v);
  }
  if (!cands.length) return null;
  if (cands.length === 1) return cands[0];
  // métricas dos últimos 30 dias
  const { data: stats } = await sb.rpc("message_variant_stats", { p_tenant: tenantId, p_days: 30 });
  const byId = new Map((stats || []).map((s: any) => [s.variant_id, s]));
  let best: Variant | null = null, bestScore = -1;
  for (const v of cands) {
    const s: any = byId.get(v.id) || {};
    const resp = Number(s.respondidas || 0), env = Number(s.enviadas || 0);
    const score = sampleBeta(resp + 1, Math.max(0, env - resp) + 1) * Number(v.weight || 1);
    if (score > bestScore) { bestScore = score; best = v; }
  }
  return best;
}

export async function logVariantSend(sb: SupabaseClient, v: Variant, a: { leadId: string | null; phone: string; delivered?: boolean; metadata?: Record<string, unknown> }): Promise<string | null> {
  const { data } = await sb.from("message_variant_sends").insert({
    tenant_id: v.tenant_id, variant_id: v.id, touchpoint: v.touchpoint, lead_id: a.leadId, phone: String(a.phone).replace(/\D/g, ""),
    delivered: a.delivered ?? null, metadata: a.metadata || {},
  }).select("id").single();
  return data?.id || null;
}

/** Marca o desfecho do último envio daquele telefone no touchpoint (replied | permitted | scheduled). */
export async function markVariantOutcome(sb: SupabaseClient, phone: string, outcome: "replied" | "permitted" | "scheduled", touchpoint?: string): Promise<void> {
  const last8 = String(phone || "").replace(/\D/g, "").slice(-8);
  let q = sb.from("message_variant_sends").select("id, outcome, replied_at").like("phone", `%${last8}`).gte("sent_at", new Date(Date.now() - 7 * 86400_000).toISOString()).order("sent_at", { ascending: false }).limit(1);
  if (touchpoint) q = q.eq("touchpoint", touchpoint);
  const { data } = await q.maybeSingle();
  if (!data) return;
  const rank: Record<string, number> = { silent: 0, failed: 0, replied: 1, permitted: 2, scheduled: 3 };
  const upd: Record<string, unknown> = {};
  if (!data.replied_at) upd.replied_at = new Date().toISOString();
  if ((rank[outcome] || 0) >= (rank[String(data.outcome || "")] || 0)) upd.outcome = outcome;
  if (Object.keys(upd).length) await sb.from("message_variant_sends").update(upd).eq("id", data.id);
}
