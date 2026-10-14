/**
 * Chamada curta à Anthropic devolvendo JSON (extração/avaliação pós-ligação).
 * Chave: ANTHROPIC_API_KEY do tenant (fallback global) via getIntegrationKey.
 * Nunca lança: sem chave/erro → null (quem chama segue sem o dado).
 */
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "./config.ts";

export const CLAUDE_FAST = "claude-haiku-4-5-20251001";

export function extractJson(text: string): Record<string, any> | null {
  if (!text) return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const first = t.indexOf("{"); const last = t.lastIndexOf("}");
  if (first === -1 || last === -1) return null;
  try { return JSON.parse(t.slice(first, last + 1)); } catch { return null; }
}

export async function askClaudeJson(
  sb: SupabaseClient, tenantId: string | null, system: string, user: string,
  opts: { model?: string; maxTokens?: number; tag?: string } = {},
): Promise<Record<string, any> | null> {
  const key = await getIntegrationKey(sb, "ANTHROPIC_API_KEY", tenantId || undefined);
  if (!key) { console.warn(`[claude-json${opts.tag ? ":" + opts.tag : ""}] sem ANTHROPIC_API_KEY`); return null; }
  const model = opts.model || (await getIntegrationKey(sb, "NINA_REVIEW_MODEL")) || CLAUDE_FAST;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: opts.maxTokens || 1500, system, messages: [{ role: "user", content: user }] }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { console.warn(`[claude-json${opts.tag ? ":" + opts.tag : ""}] ${r.status} ${JSON.stringify(j).slice(0, 200)}`); return null; }
    const text = Array.isArray(j?.content) ? j.content.map((c: any) => c?.text || "").join("") : "";
    return extractJson(text);
  } catch (e) {
    console.warn(`[claude-json${opts.tag ? ":" + opts.tag : ""}] erro:`, (e as Error).message);
    return null;
  }
}
