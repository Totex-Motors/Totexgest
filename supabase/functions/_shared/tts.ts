/**
 * tts.ts — resposta do agente em ÁUDIO (mensagem de voz no WhatsApp).
 *
 * Fase 1 da "Nina" (docs: agente que fala): o agente V2 responde com nota de voz
 * quando o lead mandou áudio (modo "mirror") ou sempre (modo "always").
 *
 * Config por agente em agents_registry.settings.voice_reply:
 * {
 *   enabled:   boolean,
 *   mode:      "mirror" | "always",   // mirror = só responde em áudio quando o lead mandou áudio
 *   provider:  "auto" | "openai" | "elevenlabs",
 *   voice:     string,                 // OpenAI: nome da voz (ex.: "nova"); ElevenLabs: voice_id
 *   max_chars: number,                 // acima disso vai em texto (áudio longo cansa)
 *   instructions?: string              // OpenAI gpt-4o-mini-tts: "fale como vendedora simpática…"
 * }
 *
 * Provedores (chave via getIntegrationKey — nunca hardcode):
 *   - ElevenLabs: ELEVENLABS_API_KEY  → output Ogg/Opus (opus_48000_64)
 *   - OpenAI:     OPENAI_API_KEY      → gpt-4o-mini-tts, response_format "opus" (Ogg/Opus)
 *   "auto" = ElevenLabs se tiver chave, senão OpenAI.
 * O WhatsApp Cloud API aceita nota de voz em audio/ogg com codec opus — por isso os dois
 * provedores saem em Ogg/Opus e o arquivo vai pro bucket privado `whatsapp-media`.
 *
 * Nunca envia texto com link/lista/tabela em áudio (vira ruído): shouldReplyWithVoice
 * devolve false e o chamador manda texto normal.
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "./config.ts";

export type VoiceReplyMode = "mirror" | "always";
export type VoiceProvider = "auto" | "openai" | "elevenlabs";

export interface VoiceReplyConfig {
  enabled: boolean;
  mode: VoiceReplyMode;
  provider: VoiceProvider;
  voice: string;
  max_chars: number;
  instructions?: string;
}

export const DEFAULT_VOICE_REPLY: VoiceReplyConfig = {
  enabled: false,
  mode: "mirror",
  provider: "auto",
  voice: "",
  max_chars: 600,
};

const OPENAI_DEFAULT_VOICE = "nova";
const ELEVENLABS_DEFAULT_MODEL = "eleven_multilingual_v2";

/** Lê settings.voice_reply do agente. null = desligado. */
export function resolveVoiceReply(settings: Record<string, unknown> | null | undefined): VoiceReplyConfig | null {
  const raw = (settings as { voice_reply?: Partial<VoiceReplyConfig> } | null)?.voice_reply;
  if (!raw || raw.enabled !== true) return null;
  const mode: VoiceReplyMode = raw.mode === "always" ? "always" : "mirror";
  const provider: VoiceProvider = raw.provider === "openai" || raw.provider === "elevenlabs" ? raw.provider : "auto";
  const maxChars = Number(raw.max_chars);
  return {
    enabled: true,
    mode,
    provider,
    voice: String(raw.voice || "").trim(),
    max_chars: Number.isFinite(maxChars) && maxChars >= 80 ? Math.min(maxChars, 2000) : DEFAULT_VOICE_REPLY.max_chars,
    instructions: raw.instructions ? String(raw.instructions).slice(0, 500) : undefined,
  };
}

/**
 * Decide se ESTA resposta vai em áudio.
 * - mirror: só se a mensagem do lead foi áudio.
 * - texto com link, lista, tabela, código ou muito longo → texto (áudio não carrega isso bem).
 */
export function shouldReplyWithVoice(cfg: VoiceReplyConfig | null, inboundType: string | null | undefined, text: string): boolean {
  if (!cfg || !cfg.enabled) return false;
  if (cfg.mode === "mirror" && inboundType !== "audio") return false;
  const t = String(text || "").trim();
  if (!t || t.length > cfg.max_chars) return false;
  if (/https?:\/\/|www\./i.test(t)) return false;                       // link
  if (/(^|\n)\s*(\d+[.)]|[-*•])\s+\S/.test(t)) return false;             // lista
  if (/\|.*\|/.test(t) || /```/.test(t)) return false;                   // tabela / código
  if (/\d{2}[\s.-]?\d{4,5}[\s.-]?\d{4}/.test(t)) return false;           // telefone (o lead precisa copiar)
  return true;
}

/** Texto limpo pra fala: sem markdown, sem emoji, sem "[Áudio]" de sistema. */
export function prepareTextForSpeech(text: string): string {
  return String(text || "")
    .replace(/<(thinking|thought|reasoning)>[\s\S]*?<\/\1>/gi, "")
    .replace(/[*_~`]+/g, "")
    .replace(/^\s*#+\s*/gm, "")
    .replace(/\[[^\]]*\]\([^)]*\)/g, (m) => m.replace(/\[([^\]]*)\]\([^)]*\)/, "$1"))
    .replace(/[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ")
    .replace(/\s*\.\s*\./g, ".")
    .trim();
}

export interface SynthesizedAudio {
  bytes: Uint8Array;
  mime: string;
  provider: "openai" | "elevenlabs";
}

/** Gera o áudio (Ogg/Opus). null = sem chave/erro — chamador cai pra texto. */
export async function synthesizeSpeech(
  supabase: SupabaseClient,
  text: string,
  tenantId: string | null,
  cfg: VoiceReplyConfig,
): Promise<SynthesizedAudio | null> {
  const spoken = prepareTextForSpeech(text);
  if (!spoken) return null;

  const wantEleven = cfg.provider === "elevenlabs" || cfg.provider === "auto";
  const wantOpenAI = cfg.provider === "openai" || cfg.provider === "auto";

  if (wantEleven) {
    const key = await getIntegrationKey(supabase, "ELEVENLABS_API_KEY", tenantId);
    if (key) {
      const out = await elevenLabsTts(key, spoken, cfg).catch((e) => {
        console.error("[tts] elevenlabs err:", (e as Error).message);
        return null;
      });
      if (out) return out;
      if (cfg.provider === "elevenlabs") return null;
    } else if (cfg.provider === "elevenlabs") {
      console.warn("[tts] ELEVENLABS_API_KEY ausente");
      return null;
    }
  }

  if (wantOpenAI) {
    const key = await getIntegrationKey(supabase, "OPENAI_API_KEY", tenantId);
    if (!key) { console.warn("[tts] OPENAI_API_KEY ausente"); return null; }
    return await openAiTts(key, spoken, cfg).catch((e) => {
      console.error("[tts] openai err:", (e as Error).message);
      return null;
    });
  }
  return null;
}

async function elevenLabsTts(apiKey: string, text: string, cfg: VoiceReplyConfig): Promise<SynthesizedAudio | null> {
  const voiceId = cfg.voice;
  if (!voiceId) { console.warn("[tts] elevenlabs: voice_id não configurado (settings.voice_reply.voice)"); return null; }
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=opus_48000_64`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json", "Accept": "audio/ogg" },
    // sem language_code: o multilingual_v2 detecta o idioma e rejeita o parâmetro
    body: JSON.stringify({ text, model_id: ELEVENLABS_DEFAULT_MODEL }),
  });
  if (!res.ok) throw new Error(`elevenlabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { bytes: new Uint8Array(await res.arrayBuffer()), mime: "audio/ogg", provider: "elevenlabs" };
}

async function openAiTts(apiKey: string, text: string, cfg: VoiceReplyConfig): Promise<SynthesizedAudio | null> {
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      input: text,
      voice: cfg.voice || OPENAI_DEFAULT_VOICE,
      response_format: "opus",
      ...(cfg.instructions ? { instructions: cfg.instructions } : {}),
    }),
  });
  if (!res.ok) throw new Error(`openai tts ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { bytes: new Uint8Array(await res.arrayBuffer()), mime: "audio/ogg", provider: "openai" };
}

export const TTS_BUCKET = "whatsapp-media";

/**
 * Gera o áudio e sobe pro bucket privado `whatsapp-media`. Devolve a URL "pública"
 * (padrão do sistema: a UI assina via storage-utils; a send-whatsapp-cloud baixa pelo
 * service role). null = cair pra texto.
 */
export async function synthesizeToStorage(
  supabase: SupabaseClient,
  text: string,
  tenantId: string | null,
  cfg: VoiceReplyConfig,
): Promise<{ publicUrl: string; path: string; provider: string } | null> {
  const audio = await synthesizeSpeech(supabase, text, tenantId, cfg);
  if (!audio || audio.bytes.byteLength < 200) return null;
  const path = `tts_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.ogg`;
  const { error } = await supabase.storage.from(TTS_BUCKET).upload(path, audio.bytes, { contentType: "audio/ogg" });
  if (error) { console.error("[tts] upload err:", error.message); return null; }
  const { data } = supabase.storage.from(TTS_BUCKET).getPublicUrl(path);
  return { publicUrl: data.publicUrl, path, provider: audio.provider };
}
