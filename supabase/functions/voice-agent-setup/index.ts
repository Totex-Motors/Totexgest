/**
 * voice-agent-setup — "módulo de ligação" da Nina (docs/NINA-VOZ.md): configura os
 * provedores pela API, pra ninguém precisar colar JSON na mão.
 *
 * Só superadmin da plataforma (JWT do usuário + is_platform_superadmin()).
 *
 * actions (POST { action, ... }):
 *   status            → checklist: chaves, ids salvos, device WaVoIP
 *   eleven_provision  → cria/atualiza na ElevenLabs: secret (token das tools), 5 tools,
 *                       agente "Nina" (prompt, voz clonada, LLM), número SIP e atribui.
 *                       Guarda os ids em config (VOICE_ELEVEN_*). Idempotente.
 *   wavoip_setup      → { email, password, device_id? } faz login na WaVoIP (JWT 7 dias,
 *                       NÃO guarda a senha), acha o dispositivo OFFICIAL, vincula ao número
 *                       oficial (waba-link com o token/ID da Meta já cadastrados), aponta o
 *                       SIP pra ElevenLabs e configura o webhook. Guarda VOICE_WAVOIP_*.
 *   test_tools        → chama voice-agent-tools/horario_atual com o token (prova a auth)
 *
 * Chaves lidas (getIntegrationKey): ELEVENLABS_API_KEY, VOICE_AGENT_TOKEN (gera se faltar),
 * WHATSAPP_CLOUD_TOKEN, WHATSAPP_PHONE_NUMBER_ID. Prompt/1ª frase: config VOICE_AGENT_PROMPT,
 * VOICE_FIRST_MESSAGE (opcionais; há padrão). Voz e ajuste: agente de texto
 * (agents_registry.settings.voice_reply) — a mesma voz da nota de voz.
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey, invalidateIntegrationKeyCache } from "../_shared/config.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const ELEVEN = "https://api.elevenlabs.io/v1";
const WAVOIP = "https://api.wavoip.com/v2";
const ELEVEN_SIP_HOST = "sip.rtc.elevenlabs.io";
const HQ_TENANT = "c13681e3-5db9-48d1-9c5c-856e6041d77f";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const TOOLS_URL = `${SUPABASE_URL}/functions/v1/voice-agent-tools`;

// ───────────────────────────── defaults da Nina ─────────────────────────────
const DEFAULT_FIRST_MESSAGE = "Oi! Aqui é a Nina, da Totex Motors. Com quem eu falo?";
const DEFAULT_PROMPT = `Você é a Nina, atendente de voz da Totex Motors (rede de lojas de carros seminovos em São Paulo).
Está numa LIGAÇÃO por telefone: fale como gente, frases curtas, uma pergunta por vez, sem listas, sem símbolos.
Diga números por extenso ("cento e sessenta e nove mil e novecentos reais"). Nunca invente endereço, horário, preço ou estoque: use as ferramentas.

Como atender:
1. Logo no início chame identificar_cliente (com caller_phone). Se já for conhecido, cumprimente pelo primeiro nome e lembre do interesse dele. Se for novo, pergunte o nome de forma natural.
2. Descubra o que a pessoa quer: comprar, trocar, saber de um carro específico, endereço ou horário.
3. Estoque: use consultar_estoque. Fale só duas ou três opções por vez (modelo, ano, preço) e pergunte qual interessa.
4. Endereço e horário: use info_lojas.
5. Para agendar visita ou test drive: use horario_atual, confirme dia e hora com a pessoa em voz alta, depois chame agendar_visita. Confirme que ela vai receber a confirmação no WhatsApp.
6. Se pedirem desconto ou financiamento, explique que quem fecha condições é o especialista da loja e ofereça agendar.
7. Seja simpática e objetiva. Se não souber, diga que vai verificar e que a equipe retorna. Nunca fale de outras lojas fora da rede.
8. Ao encerrar, resuma o combinado em uma frase e se despeça pelo nome.`;

type ToolDef = { name: string; description: string; properties: Record<string, unknown>; required: string[] };
const TOOL_DEFS: ToolDef[] = [
  {
    name: "identificar_cliente",
    description: "Descobre quem está ligando pelo telefone: nome, se já é cliente conhecido, interesse anterior e loja de referência. Chame no início da ligação.",
    properties: {},
    required: [],
  },
  {
    name: "consultar_estoque",
    description: "Busca carros no estoque da rede por texto (modelo, marca, tipo) com filtro opcional de loja e preço máximo. Devolve até cinco opções com ano, preço, quilometragem e loja.",
    properties: {
      busca: { type: "string", description: "O que o cliente procura, ex.: 'Audi Q3', 'SUV automático', 'Onix 2022'." },
      loja: { type: "string", description: "Nome da loja, se o cliente citou uma (ex.: Cardoso Veículos)." },
      preco_max: { type: "number", description: "Preço máximo em reais, só número, se o cliente falou orçamento." },
    },
    required: ["busca"],
  },
  {
    name: "agendar_visita",
    description: "Agenda visita, test drive ou avaliação na loja. Só chame depois de confirmar dia, hora, loja e carro com o cliente em voz alta. Use horario_atual antes para calcular a data.",
    properties: {
      data_hora: { type: "string", description: "Data e hora no formato ISO com fuso de Brasília, ex.: 2026-10-15T15:00:00-03:00." },
      loja: { type: "string", description: "Nome da loja onde será a visita, como veio de consultar_estoque." },
      carro: { type: "string", description: "Carro de interesse (modelo e ano)." },
      tipo: { type: "string", enum: ["visita", "test_drive", "avaliacao"], description: "visita = ver o carro; test_drive; avaliacao = avaliar o carro do cliente na troca." },
      nome_cliente: { type: "string", description: "Nome do cliente, se ele disse." },
      observacoes: { type: "string", description: "Qualquer detalhe combinado." },
    },
    required: ["data_hora", "loja", "carro"],
  },
  {
    name: "info_lojas",
    description: "Endereço, horário de funcionamento e telefone das lojas da rede. Use quando perguntarem onde fica ou até que horas abre.",
    properties: {},
    required: [],
  },
  {
    name: "horario_atual",
    description: "Data e hora atual em Brasília. Use antes de agendar para transformar 'amanhã às 3' em data certa.",
    properties: {},
    required: [],
  },
];

// ───────────────────────────── helpers ─────────────────────────────
async function elevenFetch(apiKey: string, path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(`${ELEVEN}${path}`, {
    ...init,
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const text = await res.text();
  let data: any; try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

async function wavoipFetch(jwt: string, path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(`${WAVOIP}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const text = await res.text();
  let data: any; try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

async function setConfig(sb: any, key: string, value: string | null) {
  if (value === null) await sb.from("config").delete().eq("key", key);
  else await sb.from("config").upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  invalidateIntegrationKeyCache(key);
}

function randomToken(): string {
  const b = new Uint8Array(24); crypto.getRandomValues(b);
  return "nina_" + Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

function toolConfig(def: ToolDef, token: string, secretId: string | null) {
  const headerValue = secretId ? { secret_id: secretId } : token;
  return {
    tool_config: {
      type: "webhook",
      name: def.name,
      description: def.description,
      api_schema: {
        url: `${TOOLS_URL}/${def.name}`,
        method: "POST",
        request_headers: { "x-voice-token": headerValue },
        request_body_schema: {
          type: "object",
          required: ["caller_phone", ...def.required],
          properties: {
            caller_phone: { type: "string", description: "Telefone de quem está ligando (preenchido pelo sistema).", dynamic_variable: "system__caller_id" },
            ...def.properties,
          },
        },
      },
    },
  };
}

// ───────────────────────────── actions ─────────────────────────────
async function actionStatus(sb: any) {
  const k = async (key: string) => !!(await getIntegrationKey(sb, key, HQ_TENANT));
  const cfg = async (key: string) => (await getIntegrationKey(sb, key)) || null;
  const { data: inst } = await sb.from("whatsapp_instances").select("phone_number, name").eq("provider", "meta_cloud").limit(1).maybeSingle();
  const { data: agent } = await sb.from("agents_registry").select("slug, settings").eq("slug", (await cfg("VOICE_AGENT_SLUG")) || "agente-stand").limit(1).maybeSingle();
  const voice = (agent?.settings as any)?.voice_reply || {};
  return {
    keys: {
      elevenlabs_api_key: await k("ELEVENLABS_API_KEY"),
      voice_agent_token: await k("VOICE_AGENT_TOKEN"),
      webhook_secret: await k("ELEVENLABS_WEBHOOK_SECRET"),
      whatsapp_cloud_token: await k("WHATSAPP_CLOUD_TOKEN"),
      whatsapp_phone_number_id: await k("WHATSAPP_PHONE_NUMBER_ID"),
      openai_api_key: await k("OPENAI_API_KEY"),
    },
    numero_oficial: inst?.phone_number || null,
    voz: { voice_id: voice.voice || null, provider: voice.provider || null, agente: agent?.slug || null },
    eleven: {
      agent_id: await cfg("VOICE_ELEVEN_AGENT_ID"),
      phone_number_id: await cfg("VOICE_ELEVEN_PHONE_ID"),
      tool_ids: JSON.parse((await cfg("VOICE_ELEVEN_TOOL_IDS")) || "{}"),
      provisioned_at: await cfg("VOICE_ELEVEN_PROVISIONED_AT"),
    },
    wavoip: {
      device_id: await cfg("VOICE_WAVOIP_DEVICE_ID"),
      linked_at: await cfg("VOICE_WAVOIP_LINKED_AT"),
      sip_at: await cfg("VOICE_WAVOIP_SIP_AT"),
      webhook_at: await cfg("VOICE_WAVOIP_WEBHOOK_AT"),
    },
    prompt: (await cfg("VOICE_AGENT_PROMPT")) || DEFAULT_PROMPT,
    first_message: (await cfg("VOICE_FIRST_MESSAGE")) || DEFAULT_FIRST_MESSAGE,
    urls: { tools: TOOLS_URL, postcall: `${SUPABASE_URL}/functions/v1/voice-agent-postcall`, wavoip_webhook: `${SUPABASE_URL}/functions/v1/wavoip-webhook` },
  };
}

async function actionElevenProvision(sb: any, body: any) {
  const apiKey = await getIntegrationKey(sb, "ELEVENLABS_API_KEY", HQ_TENANT);
  if (!apiKey) return json({ error: "Cadastre a ELEVENLABS_API_KEY em Integrações primeiro." }, 400);

  // 0. salva prompt/1ª frase se vieram do formulário
  if (typeof body.prompt === "string" && body.prompt.trim()) await setConfig(sb, "VOICE_AGENT_PROMPT", body.prompt.trim());
  if (typeof body.first_message === "string" && body.first_message.trim()) await setConfig(sb, "VOICE_FIRST_MESSAGE", body.first_message.trim());
  const prompt = (await getIntegrationKey(sb, "VOICE_AGENT_PROMPT")) || DEFAULT_PROMPT;
  const firstMessage = (await getIntegrationKey(sb, "VOICE_FIRST_MESSAGE")) || DEFAULT_FIRST_MESSAGE;

  // 1. token das tools (gera se não existir)
  let token = await getIntegrationKey(sb, "VOICE_AGENT_TOKEN");
  if (!token) { token = randomToken(); await setConfig(sb, "VOICE_AGENT_TOKEN", token); }

  // 2. voz + ajuste fino = os mesmos da nota de voz (agente de texto)
  const slug = (await getIntegrationKey(sb, "VOICE_AGENT_SLUG")) || "agente-stand";
  const { data: agentRow } = await sb.from("agents_registry").select("settings").eq("slug", slug).limit(1).maybeSingle();
  const vr = ((agentRow?.settings as any)?.voice_reply || {}) as any;
  const voiceId = String(body.voice_id || vr.voice || "").trim();
  if (!voiceId) return json({ error: "Sem Voice ID: cadastre a voz na aba Humanização do agente (Responder por áudio) ou informe voice_id." }, 400);
  const tune = { stability: 0.4, similarity: 0.85, speed: 1.0, ...(vr.eleven || {}) };

  const log: string[] = [];

  // 3. secret com o token (header x-voice-token nunca fica em texto puro na ElevenLabs)
  let secretId: string | null = (await getIntegrationKey(sb, "VOICE_ELEVEN_SECRET_ID")) || null;
  if (!secretId) {
    const r = await elevenFetch(apiKey, "/convai/secrets", { method: "POST", body: JSON.stringify({ type: "new", name: `totexgest_voice_token_${Date.now()}`, value: token }) });
    if (r.ok && r.data?.secret_id) { secretId = r.data.secret_id; await setConfig(sb, "VOICE_ELEVEN_SECRET_ID", secretId); log.push("secret criado"); }
    else log.push(`secret falhou (${r.status}) — header vai em texto`);
  }

  // 4. tools (cria ou atualiza)
  const toolIds: Record<string, string> = JSON.parse((await getIntegrationKey(sb, "VOICE_ELEVEN_TOOL_IDS")) || "{}");
  for (const def of TOOL_DEFS) {
    let cfgBody = toolConfig(def, token, secretId);
    let r = toolIds[def.name]
      ? await elevenFetch(apiKey, `/convai/tools/${toolIds[def.name]}`, { method: "PATCH", body: JSON.stringify(cfgBody) })
      : await elevenFetch(apiKey, "/convai/tools", { method: "POST", body: JSON.stringify(cfgBody) });
    if (!r.ok && secretId && r.status === 422) {
      // formato do secret no header pode variar entre versões da API → tenta texto puro
      cfgBody = toolConfig(def, token, null);
      r = toolIds[def.name]
        ? await elevenFetch(apiKey, `/convai/tools/${toolIds[def.name]}`, { method: "PATCH", body: JSON.stringify(cfgBody) })
        : await elevenFetch(apiKey, "/convai/tools", { method: "POST", body: JSON.stringify(cfgBody) });
    }
    if (!r.ok && toolIds[def.name] && r.status === 404) {
      r = await elevenFetch(apiKey, "/convai/tools", { method: "POST", body: JSON.stringify(cfgBody) });
    }
    if (!r.ok) return json({ error: `tool ${def.name}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`, log }, 502);
    const id = r.data?.id || r.data?.tool_id || toolIds[def.name];
    toolIds[def.name] = id;
    log.push(`tool ${def.name} ok (${id})`);
  }
  await setConfig(sb, "VOICE_ELEVEN_TOOL_IDS", JSON.stringify(toolIds));

  // 5. agente
  const conversation_config = {
    agent: {
      first_message: firstMessage,
      language: "pt",
      prompt: { prompt, llm: String(body.llm || "gpt-4.1-mini"), tool_ids: Object.values(toolIds), temperature: 0.4 },
    },
    tts: {
      voice_id: voiceId,
      model_id: "eleven_flash_v2_5",
      stability: Number(tune.stability), similarity_boost: Number(tune.similarity), speed: Number(tune.speed),
    },
    turn: { turn_timeout: 7, turn_eagerness: "normal" },
  };
  let agentId: string | null = (await getIntegrationKey(sb, "VOICE_ELEVEN_AGENT_ID")) || null;
  let r = agentId
    ? await elevenFetch(apiKey, `/convai/agents/${agentId}`, { method: "PATCH", body: JSON.stringify({ name: "Nina — Totex Motors", conversation_config }) })
    : await elevenFetch(apiKey, "/convai/agents/create", { method: "POST", body: JSON.stringify({ name: "Nina — Totex Motors", tags: ["totexgest", "voz"], conversation_config }) });
  if (!r.ok && agentId && r.status === 404) {
    agentId = null;
    r = await elevenFetch(apiKey, "/convai/agents/create", { method: "POST", body: JSON.stringify({ name: "Nina — Totex Motors", tags: ["totexgest", "voz"], conversation_config }) });
  }
  if (!r.ok) return json({ error: `agente: ${r.status} ${JSON.stringify(r.data).slice(0, 400)}`, log }, 502);
  agentId = r.data?.agent_id || agentId;
  await setConfig(sb, "VOICE_ELEVEN_AGENT_ID", agentId!);
  log.push(`agente ok (${agentId})`);

  // 6. número SIP (importa 1x) + atribui ao agente
  const { data: inst } = await sb.from("whatsapp_instances").select("phone_number").eq("provider", "meta_cloud").limit(1).maybeSingle();
  const e164 = inst?.phone_number ? `+${String(inst.phone_number).replace(/\D/g, "")}` : null;
  let phoneId: string | null = (await getIntegrationKey(sb, "VOICE_ELEVEN_PHONE_ID")) || null;
  if (e164) {
    if (!phoneId) {
      const pr = await elevenFetch(apiKey, "/convai/phone-numbers", {
        method: "POST",
        body: JSON.stringify({
          provider: "sip_trunk", phone_number: e164, label: "WhatsApp oficial (via WaVoIP)", agent_id: agentId,
          inbound_trunk_config: { media_encryption: "allowed", allowed_addresses: [], allowed_numbers: [] },
        }),
      });
      if (pr.ok && pr.data?.phone_number_id) { phoneId = pr.data.phone_number_id; await setConfig(sb, "VOICE_ELEVEN_PHONE_ID", phoneId); log.push(`número SIP importado (${phoneId})`); }
      else log.push(`número SIP falhou (${pr.status}) ${JSON.stringify(pr.data).slice(0, 200)}`);
    } else {
      const ur = await elevenFetch(apiKey, `/convai/phone-numbers/${phoneId}`, { method: "PATCH", body: JSON.stringify({ agent_id: agentId }) });
      log.push(ur.ok ? "número atribuído ao agente" : `atribuição falhou (${ur.status})`);
    }
  } else log.push("sem número oficial cadastrado (whatsapp_instances meta_cloud) — número SIP não importado");

  await setConfig(sb, "VOICE_ELEVEN_PROVISIONED_AT", new Date().toISOString());
  return json({ ok: true, agent_id: agentId, phone_number_id: phoneId, tool_ids: toolIds, log });
}

async function actionWavoipSetup(sb: any, body: any) {
  const email = String(body.email || "").trim();
  const password = String(body.password || "");
  if (!email || !password) return json({ error: "Informe e-mail e senha da conta WaVoIP (não são guardados)." }, 400);

  const login = await fetch(`${WAVOIP}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  const loginData = await login.json().catch(() => ({}));
  const jwt = loginData?.data?.token;
  if (!login.ok || !jwt) return json({ error: `Login WaVoIP falhou (${login.status}): ${JSON.stringify(loginData).slice(0, 200)}` }, 400);

  const log: string[] = ["login ok"];

  // dispositivo OFFICIAL
  let deviceId: string | null = String(body.device_id || (await getIntegrationKey(sb, "VOICE_WAVOIP_DEVICE_ID")) || "").trim() || null;
  const list = await wavoipFetch(jwt, "/devices");
  const devices: any[] = Array.isArray(list.data?.data) ? list.data.data : Array.isArray(list.data) ? list.data : [];
  const officials = devices.filter((d) => String(d?.plan?.call_type || d?.call_type || "").toUpperCase() === "OFFICIAL");
  if (!deviceId) {
    if (officials.length === 1) deviceId = String(officials[0].id);
    else if (officials.length > 1) return json({ error: "Mais de um dispositivo OFFICIAL — informe device_id.", devices: officials.map((d) => ({ id: d.id, name: d.name, phone: d.phone })) }, 400);
    else return json({ error: "Nenhum dispositivo do tipo OFFICIAL na conta WaVoIP. Contrate um canal OFFICIAL primeiro.", devices: devices.map((d) => ({ id: d.id, name: d.name, call_type: d?.plan?.call_type || null })) }, 400);
  }
  const device = devices.find((d) => String(d.id) === deviceId);
  if (device && String(device?.plan?.call_type || "").toUpperCase() !== "OFFICIAL") {
    return json({ error: `Dispositivo ${deviceId} não é OFFICIAL (é ${device?.plan?.call_type || "sem plano"}). Regra da casa: nunca escaneado.` }, 400);
  }
  await setConfig(sb, "VOICE_WAVOIP_DEVICE_ID", deviceId);
  log.push(`dispositivo ${deviceId}`);

  // vínculo com o número oficial (token/ID da Meta já cadastrados no Totexgest)
  const fbToken = await getIntegrationKey(sb, "WHATSAPP_CLOUD_TOKEN", HQ_TENANT);
  const phoneNumberId = await getIntegrationKey(sb, "WHATSAPP_PHONE_NUMBER_ID", HQ_TENANT);
  if (!fbToken || !phoneNumberId) return json({ error: "Faltam WHATSAPP_CLOUD_TOKEN / WHATSAPP_PHONE_NUMBER_ID em Integrações.", log }, 400);
  const link = await wavoipFetch(jwt, `/devices/${deviceId}/waba-link`, { method: "PUT", body: JSON.stringify({ fb_token: fbToken, id_phone_number: phoneNumberId }) });
  if (link.ok) { await setConfig(sb, "VOICE_WAVOIP_LINKED_AT", new Date().toISOString()); log.push("vinculado ao número oficial"); }
  else log.push(`waba-link falhou (${link.status}): ${JSON.stringify(link.data).slice(0, 200)}`);

  // SIP → ElevenLabs
  const { data: inst } = await sb.from("whatsapp_instances").select("phone_number").eq("provider", "meta_cloud").limit(1).maybeSingle();
  const sip = await wavoipFetch(jwt, `/devices/${deviceId}/sip`, {
    method: "PUT",
    body: JSON.stringify({ active: true, ip: ELEVEN_SIP_HOST, port: 5060, transport: "TCP", caller_id: inst?.phone_number ? String(inst.phone_number).replace(/\D/g, "") : undefined }),
  });
  if (sip.ok) { await setConfig(sb, "VOICE_WAVOIP_SIP_AT", new Date().toISOString()); log.push("SIP apontado pra ElevenLabs"); }
  else log.push(`sip falhou (${sip.status}): ${JSON.stringify(sip.data).slice(0, 200)}`);

  // webhook → wavoip-webhook (já existente)
  const wh = await wavoipFetch(jwt, `/devices/${deviceId}/webhook/settings`, {
    method: "PUT",
    body: JSON.stringify({ url: `${SUPABASE_URL}/functions/v1/wavoip-webhook`, active: true, call_event: true, record_event: true, device_event: true }),
  });
  if (wh.ok) { await setConfig(sb, "VOICE_WAVOIP_WEBHOOK_AT", new Date().toISOString()); log.push("webhook configurado"); }
  else log.push(`webhook falhou (${wh.status}): ${JSON.stringify(wh.data).slice(0, 200)}`);

  const allOk = link.ok && sip.ok && wh.ok;
  return json({ ok: allOk, device_id: deviceId, log }, allOk ? 200 : 207);
}

async function actionTestTools(sb: any) {
  const token = await getIntegrationKey(sb, "VOICE_AGENT_TOKEN");
  if (!token) return json({ ok: false, error: "VOICE_AGENT_TOKEN não existe ainda (rode 'Criar Nina na ElevenLabs' ou cadastre em Integrações)." });
  const res = await fetch(`${TOOLS_URL}/horario_atual`, { method: "POST", headers: { "Content-Type": "application/json", "x-voice-token": token }, body: "{}" });
  const data = await res.json().catch(() => ({}));
  return json({ ok: res.ok, status: res.status, data });
}

// ───────────────────────────── server ─────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const auth = req.headers.get("Authorization") || "";
    if (!auth.startsWith("Bearer ")) return json({ error: "sem sessão" }, 401);
    const jwt = auth.slice(7);
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false, autoRefreshToken: false } });
    const { data: u } = await userClient.auth.getUser(jwt);
    if (!u?.user) return json({ error: "sessão inválida" }, 401);
    const { data: isSuper } = await userClient.rpc("is_platform_superadmin");
    if (isSuper !== true) return json({ error: "só superadmin da plataforma" }, 403);

    const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "status");

    switch (action) {
      case "status": return json(await actionStatus(sb));
      case "eleven_provision": return await actionElevenProvision(sb, body);
      case "wavoip_setup": return await actionWavoipSetup(sb, body);
      case "test_tools": return await actionTestTools(sb);
      default: return json({ error: `action desconhecida: ${action}` }, 400);
    }
  } catch (e) {
    console.error("[voice-setup]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
