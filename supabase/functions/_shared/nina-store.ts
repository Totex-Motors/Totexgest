/**
 * Nina (voz) — LOJA EXCLUSIVA e VOZ DA LIGAÇÃO (2026-10-13).
 *
 * config NINA_LOJA_EXCLUSIVA = tenant_id da loja (ex.: Cardoso Veículos). Com ela:
 *  - a Nina se apresenta como "Nina, da <loja>" e o prompt ganha um bloco de regra
 *    (só estoque/agendamento/endereço dessa loja; nunca cita outra);
 *  - voice-agent-tools força a loja em consultar_estoque (tenant_id), agendar_visita e
 *    info_lojas.
 * Vazia = comportamento antigo (ecossistema Totex, todas as lojas).
 *
 * config VOICE_CALL_VOICE_ID = voz da LIGAÇÃO na ElevenLabs (ex.: Carla). Sem ela, a
 * ligação usa a mesma voz da nota de voz do agente de texto (agente-stand).
 *
 * Quem aplica no agente da ElevenLabs: nina-dialer (syncNinaAgent, a cada execução do
 * cron, só quando algo mudou) e voice-agent-setup (provisionamento).
 */
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "./config.ts";

export type NinaStore = { tenantId: string; name: string };

export const BLOCK_START = "<!-- LOJA_EXCLUSIVA:inicio -->";
export const BLOCK_END = "<!-- LOJA_EXCLUSIVA:fim -->";
export const BLOCK_VERSION = "v2"; // v2: identidade Totex + loja parceira (2026-10-14)

export async function getNinaExclusiveStore(sb: SupabaseClient): Promise<NinaStore | null> {
  const raw = String((await getIntegrationKey(sb, "NINA_LOJA_EXCLUSIVA")) || "").trim();
  if (!raw) return null;
  const isUuid = /^[0-9a-f-]{36}$/i.test(raw);
  const q = sb.from("tenants").select("id, name");
  const { data } = isUuid ? await q.eq("id", raw).maybeSingle() : await q.ilike("name", raw).limit(1).maybeSingle();
  if (!data?.id) return null;
  return { tenantId: String(data.id), name: String(data.name || raw).trim() };
}

/** A Nina responde SEMPRE pelo ecossistema Totex (decisão do Marco, 2026-10-14); a loja só
 *  define estoque, visita e endereço. */
export function ninaBrand(_store: NinaStore | null): string {
  return "Totex Motors";
}

export function exclusivityBlock(store: NinaStore): string {
  const l = store.name;
  return [
    BLOCK_START,
    "# LOJA PARCEIRA DESTA OPERAÇÃO — REGRA MAIS IMPORTANTE (vale acima de tudo abaixo)",
    `Você é a Nina, da Totex Motors, e nesta operação atende EXCLUSIVAMENTE a loja parceira ${l}.`,
    `- Apresente-se como "Nina, da Totex Motors". O discurso é o da Totex; o estoque, a visita, a avaliação e o endereço são da ${l}.`,
    `- Só fale do estoque, endereço, horário e condições da ${l}.`,
    "- NUNCA cite, indique, compare ou agende em outra loja, e não diga que existem outras lojas.",
    `- Todo agendamento é na ${l} (numa das unidades que info_lojas devolve). Não pergunte "qual loja".`,
    `- Se o carro pedido não estiver no estoque da ${l}, ofereça os parecidos da própria ${l} ou anote o interesse pra equipe procurar.`,
    `- Se perguntarem: a ${l} é uma loja parceira do ecossistema Totex.`,
    "- Se a consulta de estoque der erro, NÃO diga que o carro não existe ou não está disponível: diga que vai confirmar com a equipe e siga pro agendamento.",
    BLOCK_END,
  ].join("\n");
}

/** Põe/atualiza (ou remove, se store = null) o bloco de loja exclusiva no topo do prompt. */
export function applyExclusivity(prompt: string, store: NinaStore | null): string {
  const re = new RegExp(`${BLOCK_START}[\\s\\S]*?${BLOCK_END}\\n*`, "g");
  const clean = String(prompt || "").replace(re, "").trimStart();
  return store ? `${exclusivityBlock(store)}\n\n${clean}` : clean;
}

/** 1ª frase da ligação recebida: a Nina é sempre "da Totex Motors" (desfaz a marca da loja da v1). */
export function brandFirstMessage(msg: string, _store: NinaStore | null): string {
  return String(msg || "").replace(/da Cardoso Veículos/gi, "da Totex Motors");
}

/** Termos que a transcrição erra com frequência → como estão no estoque. */
const ALIASES: Array<[RegExp, string]> = [
  [/\btanque\b/gi, "Tank"], // GWM Tank 300 — a transcrição escreve "Tanque 300"
];
export function normalizeStockSearch(s: string): string {
  let out = String(s || "");
  for (const [re, to] of ALIASES) out = out.replace(re, to);
  return out;
}

/**
 * Clima de escritório na ligação (2026-10-13, pedido do Marco):
 *  - som de fundo da ElevenLabs (conversation.background_sound, presets office1/office2/
 *    restaurant/city/typing/elevator1-4) — config VOICE_BACKGROUND_SOUND (padrão office1;
 *    "off" desliga) e VOICE_BACKGROUND_VOLUME (0.01–1, padrão 0.08 = bem suave);
 *  - som de teclado enquanto a ferramenta roda (tool_call_sound "typing", behavior "always"
 *    = toca mesmo quando a Nina não fala antes) — config VOICE_TOOL_SOUND (padrão typing;
 *    "off" desliga) nas tools de consulta/agendamento.
 * O agente NÃO ouve o som de fundo (não entra no reconhecimento de voz).
 */
export const TOOLS_WITH_SOUND = ["identificar_cliente", "consultar_estoque", "agendar_visita", "info_lojas"];
const BG_PRESETS = ["office1", "office2", "restaurant", "city", "typing", "elevator1", "elevator2", "elevator3", "elevator4"];

export type NinaSounds = {
  background: { source_type: string | null; source_id: string | null; volume?: number; crossfade_loop?: boolean };
  toolSound: string | null;
  key: string;
};

export async function getNinaSounds(sb: SupabaseClient): Promise<NinaSounds> {
  const bgRaw = String((await getIntegrationKey(sb, "VOICE_BACKGROUND_SOUND")) || "office1").trim().toLowerCase();
  const volRaw = Number(await getIntegrationKey(sb, "VOICE_BACKGROUND_VOLUME"));
  const volume = Number.isFinite(volRaw) && volRaw >= 0.01 && volRaw <= 1 ? volRaw : 0.08;
  const toolRaw = String((await getIntegrationKey(sb, "VOICE_TOOL_SOUND")) || "typing").trim().toLowerCase();
  const bgOn = bgRaw !== "off" && BG_PRESETS.includes(bgRaw);
  const background = bgOn
    ? { source_type: "preset", source_id: bgRaw, volume, crossfade_loop: true }
    : { source_type: null, source_id: null };
  const toolSound = toolRaw === "off" || toolRaw === "none" ? null : toolRaw;
  return { background, toolSound, key: `${bgOn ? bgRaw : "off"}@${volume}/${toolSound || "off"}` };
}
