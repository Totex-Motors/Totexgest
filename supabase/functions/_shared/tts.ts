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
 *   - ElevenLabs: ELEVENLABS_API_KEY  → Ogg/Opus mono (opus_48000_64) = nota de voz (ícone de microfone)
 *   - OpenAI:     OPENAI_API_KEY      → gpt-4o-mini-tts, response_format "opus" (Ogg/Opus 48 kHz mono) = nota de voz
 *   "auto" = ElevenLabs se tiver chave, senão OpenAI.
 * O arquivo vai pro bucket privado `whatsapp-media`; a send-whatsapp-cloud baixa pelo service role.
 *
 * Nunca envia texto com link/lista/tabela em áudio (vira ruído): shouldReplyWithVoice
 * devolve false e o chamador manda texto normal.
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "./config.ts";

export type VoiceReplyMode = "mirror" | "always";
export type VoiceProvider = "auto" | "openai" | "elevenlabs";

/**
 * Ajuste fino da ElevenLabs (settings.voice_reply.eleven). Voz CLONADA com os padrões da
 * ElevenLabs (stability 0.5, style 0) sai "robótica"/chapada — por isso mandamos
 * voice_settings explícitos em toda chamada.
 */
export interface ElevenTuning {
  model_id: string;        // eleven_multilingual_v2 (estável) | eleven_v3 (mais expressivo) | eleven_turbo_v2_5 (rápido)
  stability: number;       // 0–1: baixo = mais emoção/variação; alto = monótono
  similarity: number;      // 0–1: fidelidade à voz clonada
  style: number;           // 0–1: exagero do estilo (só v2); >0.5 fica teatral
  speaker_boost: boolean;  // realce de timbre
  speed: number;           // 0.7–1.2 (1.0 = normal)
}

export const DEFAULT_ELEVEN_TUNING: ElevenTuning = {
  model_id: "eleven_multilingual_v2",
  stability: 0.4,
  similarity: 0.85,
  style: 0.35,
  speaker_boost: true,
  speed: 1.0,
};

export interface VoiceReplyConfig {
  enabled: boolean;
  mode: VoiceReplyMode;
  provider: VoiceProvider;
  voice: string;
  max_chars: number;
  instructions?: string;
  eleven: ElevenTuning;
}

export const DEFAULT_VOICE_REPLY: VoiceReplyConfig = {
  enabled: false,
  mode: "mirror",
  provider: "auto",
  voice: "",
  max_chars: 600,
  eleven: DEFAULT_ELEVEN_TUNING,
};

const OPENAI_DEFAULT_VOICE = "nova";
const ELEVEN_MODELS = new Set(["eleven_multilingual_v2", "eleven_v3", "eleven_turbo_v2_5", "eleven_flash_v2_5"]);

function clamp01(v: unknown, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : def;
}

/** Lê settings.voice_reply do agente. null = desligado. */
export function resolveVoiceReply(settings: Record<string, unknown> | null | undefined): VoiceReplyConfig | null {
  const raw = (settings as { voice_reply?: Partial<VoiceReplyConfig> } | null)?.voice_reply;
  if (!raw || raw.enabled !== true) return null;
  const mode: VoiceReplyMode = raw.mode === "always" ? "always" : "mirror";
  const provider: VoiceProvider = raw.provider === "openai" || raw.provider === "elevenlabs" ? raw.provider : "auto";
  const maxChars = Number(raw.max_chars);
  const e = (raw.eleven || {}) as Partial<ElevenTuning>;
  const speed = Number(e.speed);
  return {
    enabled: true,
    mode,
    provider,
    voice: String(raw.voice || "").trim(),
    max_chars: Number.isFinite(maxChars) && maxChars >= 80 ? Math.min(maxChars, 2000) : DEFAULT_VOICE_REPLY.max_chars,
    instructions: raw.instructions ? String(raw.instructions).slice(0, 500) : undefined,
    eleven: {
      model_id: ELEVEN_MODELS.has(String(e.model_id)) ? String(e.model_id) : DEFAULT_ELEVEN_TUNING.model_id,
      stability: clamp01(e.stability, DEFAULT_ELEVEN_TUNING.stability),
      similarity: clamp01(e.similarity, DEFAULT_ELEVEN_TUNING.similarity),
      style: clamp01(e.style, DEFAULT_ELEVEN_TUNING.style),
      speaker_boost: e.speaker_boost !== false,
      speed: Number.isFinite(speed) ? Math.min(1.2, Math.max(0.7, speed)) : DEFAULT_ELEVEN_TUNING.speed,
    },
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
  if (/\|/.test(t) || /```/.test(t)) return false;                       // ficha "a | b" / código
  if (/\d{2}[\s.-]?\d{4,5}[\s.-]?\d{4}/.test(t)) return false;           // telefone (o lead precisa copiar)
  // Ficha com 2+ linhas começando por emoji (🚗 modelo / 📅 ano / 💰 preço) → texto
  const emojiLines = t.split("\n").filter((l) => /^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(l.trim())).length;
  if (emojiLines >= 2) return false;
  return true;
}

export interface ReplySegment {
  kind: "voice" | "text";
  text: string;
}

/**
 * Divide a resposta em trechos: o que é conversa vira ÁUDIO, o que é "ficha"
 * (lista, tabela com |, link, telefone, código) continua em TEXTO.
 * Ex.: "Achei um Q3 que parece o que você viu" (áudio) + ficha do carro (texto) +
 * "Quer que eu agende uma visita?" (áudio). Parágrafos falados consecutivos viram um
 * áudio só, até max_chars. Devolve null quando não há nada pra falar (tudo em texto).
 */
export function planReplySegments(cfg: VoiceReplyConfig | null, inboundType: string | null | undefined, text: string): ReplySegment[] | null {
  if (!cfg || !cfg.enabled) return null;
  if (cfg.mode === "mirror" && inboundType !== "audio") return null;
  const paras = String(text || "").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (!paras.length) return null;

  const segs: ReplySegment[] = [];
  for (const para of paras) {
    const spoken = shouldReplyWithVoice(cfg, "audio", para) && prepareTextForSpeech(para).length >= 2;
    const last = segs[segs.length - 1];
    if (spoken) {
      if (last && last.kind === "voice" && (last.text + "\n\n" + para).length <= cfg.max_chars) {
        last.text += "\n\n" + para;
      } else {
        segs.push({ kind: "voice", text: para });
      }
    } else if (last && last.kind === "text") {
      last.text += "\n\n" + para;
    } else {
      segs.push({ kind: "text", text: para });
    }
  }
  return segs.some((s) => s.kind === "voice") ? segs : null;
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
  const t = cfg.eleven;
  // v3 ignora `style` e aceita stability só em 3 níveis (0 / 0.5 / 1) — normaliza.
  const isV3 = t.model_id === "eleven_v3";
  const stability = isV3 ? (t.stability < 0.34 ? 0 : t.stability < 0.67 ? 0.5 : 1) : t.stability;
  const voice_settings: Record<string, unknown> = {
    stability,
    similarity_boost: t.similarity,
    use_speaker_boost: t.speaker_boost,
    speed: t.speed,
    ...(isV3 ? {} : { style: t.style }),
  };
  // opus_48000_128 (não 64): WhatsApp recomprime; partir de mais qualidade soa menos "metálico".
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=opus_48000_128`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json", "Accept": "audio/ogg" },
    // sem language_code: o multilingual_v2 detecta o idioma e rejeita o parâmetro
    body: JSON.stringify({ text, model_id: t.model_id, voice_settings }),
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
      // Ogg/Opus (48 kHz mono) = nota de voz no WhatsApp (ícone de microfone). O 131053 de
      // antes não era do formato: era o multipart do upload sem a linha em branco antes do
      // arquivo (corrigido em send-whatsapp-cloud). Se a Meta voltar a recusar, trocar
      // para "mp3" (audio/mpeg) — chega como áudio comum, mas sempre entrega.
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
  const ext = audio.mime === "audio/mpeg" ? "mp3" : "ogg";
  const path = `tts_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await supabase.storage.from(TTS_BUCKET).upload(path, audio.bytes, { contentType: audio.mime });
  if (error) { console.error("[tts] upload err:", error.message); return null; }
  const { data } = supabase.storage.from(TTS_BUCKET).getPublicUrl(path);
  return { publicUrl: data.publicUrl, path, provider: audio.provider };
}
