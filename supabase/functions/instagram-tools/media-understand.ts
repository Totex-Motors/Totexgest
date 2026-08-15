// ig-media-understand — dá "ouvido e olho" pro agente do Instagram.
//
// Por que existe: o webhook cortava toda mensagem de mídia ("[audio]", "[image]")
// antes de chegar no agente, pra ele não responder besteira em cima de um
// placeholder. Resultado: lead que manda áudio ou responde story ficava sem
// resposta (caso edu.amato 10/08 — mandou áudio respondendo a qualificação e
// levou silêncio).
//
// Agora:
//   audio        → Whisper transcreve → vira o texto da mensagem
//   image        → Gemini descreve o que tem na imagem
//   story_reply  → Gemini descreve O STORY que a pessoa respondeu (reference_url),
//                  que é o contexto que faltava: "ela comentou no story do X"
//
// Entrada: { message_id }  ou  { conversation_id, only_last: true }
// Saída:   { ok, tipo, texto }  — e grava em instagram_messages.content

import { createClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "../_shared/config.ts";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };

async function transcrever(url: string, OPENAI_KEY: string): Promise<string | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const blob = await r.blob();
    const mime = r.headers.get("content-type") || "audio/mp4";
    const ext = mime.includes("ogg") ? "ogg" : mime.includes("mpeg") ? "mp3" : "m4a";

    const boundary = `----IGBoundary${Date.now()}`;
    const enc = new TextEncoder();
    const parts: Uint8Array[] = [
      enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`),
      enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\npt\r\n`),
      enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.${ext}"\r\nContent-Type: ${mime}\r\n\r\n`),
      new Uint8Array(await blob.arrayBuffer()),
      enc.encode(`\r\n--${boundary}--\r\n`),
    ];
    const total = parts.reduce((a, p) => a + p.length, 0);
    const body = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { body.set(p, off); off += p.length; }

    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body,
    });
    const d = await resp.json();
    if (!resp.ok) { console.error("whisper:", JSON.stringify(d).slice(0, 300)); return null; }
    const t = (d.text || "").trim();
    return t || null;
  } catch (e) { console.error("transcrever:", e); return null; }
}

async function descrever(url: string, prompt: string, GEMINI_KEY: string): Promise<string | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode(...buf.subarray(i, i + 8192));
    const b64 = btoa(bin);
    const mime = r.headers.get("content-type") || "image/jpeg";

    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: b64 } }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 200 },
        }),
      },
    );
    const d = await resp.json();
    const t = d?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    return t || null;
  } catch (e) { console.error("descrever:", e); return null; }
}

export async function handleMediaUnderstand(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const out = (b: Record<string, unknown>, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    const { message_id, conversation_id, only_last } = await req.json();
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    let msg: Record<string, any> | null = null;
    if (message_id) {
      const { data } = await supabase.from("instagram_messages")
        .select("id, tenant_id, content, message_type, media_url, reference_url, conversation_id")
        .eq("id", message_id).maybeSingle();
      msg = data;
    } else if (conversation_id && only_last) {
      const { data } = await supabase.from("instagram_messages")
        .select("id, tenant_id, content, message_type, media_url, reference_url, conversation_id")
        .eq("conversation_id", conversation_id).eq("is_from_me", false)
        .order("sent_at", { ascending: false }).limit(1);
      msg = data?.[0] || null;
    }
    if (!msg) return out({ ok: false, error: "mensagem não encontrada" }, 404);

    // Tenant vem da ENTIDADE (a linha processada tem tenant_id) — padrão B3
    const tenantId: string | null = msg.tenant_id || null;

    // já processada? não gasta API de novo
    if (msg.content && !/^\[\w+\]$/.test(String(msg.content).trim())) {
      return out({ ok: true, ja_processada: true, texto: msg.content });
    }

    let texto: string | null = null;
    const tipo = msg.message_type;

    if (tipo === "audio" && msg.media_url) {
      const OPENAI_KEY = await getIntegrationKey(supabase, "OPENAI_API_KEY", tenantId);
      if (!OPENAI_KEY) return out({ ok: false, error: "OPENAI_API_KEY não configurada em Configurações → API Keys" });
      texto = await transcrever(msg.media_url, OPENAI_KEY);
    } else if (tipo === "image" && msg.media_url) {
      const GEMINI_KEY = await getIntegrationKey(supabase, "GEMINI_API_KEY", tenantId);
      if (!GEMINI_KEY) return out({ ok: false, error: "GEMINI_API_KEY não configurada em Configurações → API Keys" });
      const d = await descrever(msg.media_url,
        "Descreva em 1-2 frases, em português, o que esta imagem mostra. Se for print de conversa, resuma o conteúdo. Se tiver texto, transcreva o essencial. Seja objetivo.", GEMINI_KEY);
      if (d) texto = `[imagem] ${d}`;
    } else if (tipo === "story_reply" && msg.reference_url) {
      const GEMINI_KEY = await getIntegrationKey(supabase, "GEMINI_API_KEY", tenantId);
      if (!GEMINI_KEY) return out({ ok: false, error: "GEMINI_API_KEY não configurada em Configurações → API Keys" });
      const d = await descrever(msg.reference_url,
        "Este é um story da conta que uma pessoa acabou de responder. Descreva em 1-2 frases, em português, o que o story mostra/diz (transcreva o texto que aparecer). Isso serve de CONTEXTO pra entender a resposta dela.", GEMINI_KEY);
      if (d) texto = `[respondeu teu story: ${d}]`;
    }

    if (!texto) return out({ ok: false, error: `não consegui processar ${tipo}` });

    await supabase.from("instagram_messages")
      .update({ content: texto, metadata: { entendido_por: "ig-media-understand", tipo_original: tipo } })
      .eq("id", msg.id);

    return out({ ok: true, tipo, texto, message_id: msg.id, conversation_id: msg.conversation_id });
  } catch (e: any) {
    return out({ ok: false, error: String(e?.message || e) }, 500);
  }
}
