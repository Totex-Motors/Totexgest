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
import { applyExclusivity, brandFirstMessage, getNinaExclusiveStore, getNinaSounds, getNinaVoiceTts, TOOLS_WITH_SOUND } from "../_shared/nina-store.ts";
import { NINA_PROMPT } from "../_shared/nina-prompt.ts";

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
// O discador (nina-dialer) manda a 1ª frase por playbook em
// conversation_config_override.agent.first_message — a ElevenLabs derruba a ligação
// ("Override for field 'first_message' is not allowed by config") se o agente não liberar.
const NINA_PLATFORM_SETTINGS = {
  overrides: { conversation_config_override: { agent: { first_message: true } } },
};

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const TOOLS_URL = `${SUPABASE_URL}/functions/v1/voice-agent-tools`;

// ───────────────────────────── defaults da Nina ─────────────────────────────
const DEFAULT_FIRST_MESSAGE = "Oi! Aqui é a Nina, da Totex Motors. Com quem eu falo?";
import { NINA_ASR_KEYWORDS } from "../_shared/nina-store.ts";
import { withLessons } from "../_shared/nina-learnings.ts";

const DEFAULT_PROMPT = NINA_PROMPT; // v3 — docs/nina/PROMPT-V3.md

/**
 * Prompt em vigor: o salvo em config, EXCETO se for a versão antiga (sem playbooks) —
 * aí vale o DEFAULT_PROMPT atual e o próximo "Atualizar Nina" regrava o novo.
 * (Migração sem mexer no banco à mão.)
 */
function currentPrompt(stored: string | null | undefined): string {
  const p = String(stored || "").trim();
  if (!p || !p.includes("# PLAYBOOK")) return DEFAULT_PROMPT;
  return p;
}

type ToolDef = { name: string; description: string; properties: Record<string, unknown>; required: string[] };
const TOOL_DEFS: ToolDef[] = [
  {
    name: "identificar_cliente",
    description: "DOSSIÊ de quem está ligando: nome, por onde entrou (promotora no shopping, QR Code da loja), intenção (vender, trocar, comprar) e o PLAYBOOK a seguir, carro do cliente, FIPE e as três propostas da Totex calculadas, carro de interesse e loja, observações da promotora, agendamentos existentes, última ligação e últimas mensagens. Chame SEMPRE no início da ligação, antes de falar qualquer coisa além do oi.",
    properties: {},
    required: [],
  },
  {
    name: "consultar_estoque",
    description: "Busca carros no estoque da rede por texto (marca, modelo, versão, tipo) com filtro opcional de loja e preço máximo. Devolve até oito opções com ano, preço, quilometragem e loja. CHAME DE NOVO toda vez que o cliente citar um modelo, número ou versão específica (ex.: '330', 'X5', 'Civic 2020'), passando o termo exato — nunca diga que não tem sem ter buscado esse termo.",
    properties: {
      busca: { type: "string", description: "O que o cliente procura, ex.: 'Audi Q3', 'SUV automático', 'Onix 2022'." },
      loja: { type: "string", description: "Nome da loja, se o cliente citou uma (ex.: Cardoso Veículos)." },
      preco_max: { type: "number", description: "Preço máximo em reais, só número, se o cliente falou orçamento." },
    },
    required: ["busca"],
  },
  {
    name: "simular_plano",
    description: "Plano de parcelas pelo Simulador da Cardoso: parcela por prazo, quanto o bônus tira da parcela e a jogada de antecipar (pagar a parcela do mês junto com a última, ou usar décimo terceiro, férias ou PLR pra eliminar parcelas do fim). Use quando o cliente perguntar de parcela, financiamento ou 'cabe no bolso'. Fale só em reais, nunca em taxa. Passe o valor do carro (do consultar_estoque) ou o nome dele.",
    properties: {
      valor: { type: "number", description: "Preço do carro em reais, só número (vem do consultar_estoque)." },
      carro: { type: "string", description: "Nome do carro, se não tiver o valor (ex.: 'GWM Ora 03')." },
      entrada: { type: "number", description: "Entrada em reais, se o cliente falou. Sem isso, usa 20%." },
      carro_na_troca: { type: "number", description: "Valor estimado do carro do cliente na troca, em reais, se houver." },
      extra: { type: "number", description: "Dinheiro que entra de vez em quando (décimo terceiro, férias, PLR, FGTS), em reais, pra mostrar a antecipação." },
      prazo: { type: "number", description: "Prazo em meses, se o cliente escolheu (24, 36, 48 ou 60)." },
    },
    required: [],
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
    name: "anotar_conversa",
    description: "Registra no CRM o resumo da ligação, o próximo passo combinado e a temperatura do cliente. O agente de WhatsApp e a equipe leem essa nota para continuar de onde você parou. Chame SEMPRE antes de encerrar e quando o cliente pedir retorno em outro horário.",
    properties: {
      resumo: { type: "string", description: "Duas frases: o que o cliente quer e o que foi conversado." },
      proximo_passo: { type: "string", description: "O que ficou combinado, com dia/hora se houver (ex.: 'retornar quinta 10h', 'visita sábado 11h na Cardoso')." },
      temperatura: { type: "string", enum: ["quente", "morno", "frio"], description: "Chance de fechar nas próximas semanas." },
      interesse: { type: "string", description: "Carro ou tipo de carro de interesse, se mudou ou ficou claro na ligação." },
      instagram: { type: "string", description: "O @ do Instagram do cliente, se ele disse (ex.: @fulano)." },
    },
    required: ["resumo"],
  },
  {
    name: "enviar_instagram_totex",
    description: "Manda no WhatsApp do cliente o link do Instagram da Totex Motors (quem segue participa de brindes e sorteios). Chame UMA vez, no fim da ligação, depois de combinar visita ou retorno e só se o clima estiver bom. Não chame em ligação de reclamação ou quando o cliente pediu pra não ser contatado.",
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

function toolConfig(def: ToolDef, token: string, secretId: string | null, toolSound: string | null = null) {
  const headerValue = secretId ? { secret_id: secretId } : token;
  const sound = TOOLS_WITH_SOUND.includes(def.name) ? toolSound : null;
  return {
    tool_config: {
      type: "webhook",
      name: def.name,
      description: def.description,
      // teclado digitando enquanto a ferramenta roda (_shared/nina-store.ts → getNinaSounds)
      tool_call_sound: sound,
      tool_call_sound_behavior: "always",
      api_schema: {
        url: `${TOOLS_URL}/${def.name}`,
        method: "POST",
        request_headers: { "x-voice-token": headerValue },
        request_body_schema: {
          type: "object",
          required: ["caller_phone", ...def.required],
          properties: {
            // A API só aceita UM de: description | dynamic_variable | constant_value… — sem description aqui.
            caller_phone: { type: "string", dynamic_variable: "system__caller_id" },
            // Número que RECEBEU a ligação. Na de SAÍDA é o cliente (system__caller_id é o nosso).
            // Variável de sistema: sempre existe. (customer_phone customizada derrubava a ligação
            // RECEBIDA com "Missing required dynamic variables in tools" — placeholder não vale em SIP.)
            called_phone: { type: "string", dynamic_variable: "system__called_number" },
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
    outbound: {
      enabled: (await cfg("NINA_OUTBOUND_ENABLED")) === "true",
      sources: (await cfg("NINA_AUTO_CALL_SOURCES")) || "captacao,stand,stand_totex,totem-compra,marketplace",
      delay_min: Number((await cfg("NINA_AUTO_CALL_DELAY_MIN")) || 10),
      hora_inicio: Number((await cfg("NINA_HORARIO_INICIO")) || 10),
      hora_fim: Number((await cfg("NINA_HORARIO_FIM")) || 22),
      dias: (await cfg("NINA_DIAS_SEMANA")) || "0,1,2,3,4,5,6",
      trunk_configured_at: await cfg("VOICE_ELEVEN_OUTBOUND_AT"),
      sip_user: await cfg("VOICE_WAVOIP_SIP_USER"),
      queue: await queueSummary(sb),
    },
    prompt: currentPrompt(await cfg("VOICE_AGENT_PROMPT")),
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
  // Loja exclusiva (config NINA_LOJA_EXCLUSIVA): regra no topo do prompt + "Nina, da <loja>".
  const store = await getNinaExclusiveStore(sb);
  const prompt = applyExclusivity(currentPrompt(await getIntegrationKey(sb, "VOICE_AGENT_PROMPT")), store);
  const firstMessage = brandFirstMessage((await getIntegrationKey(sb, "VOICE_FIRST_MESSAGE")) || DEFAULT_FIRST_MESSAGE, store);

  // 1. token das tools (gera se não existir)
  let token = await getIntegrationKey(sb, "VOICE_AGENT_TOKEN");
  if (!token) { token = randomToken(); await setConfig(sb, "VOICE_AGENT_TOKEN", token); }

  // 2. voz + ajuste fino = os mesmos da nota de voz (agente de texto)
  const slug = (await getIntegrationKey(sb, "VOICE_AGENT_SLUG")) || "agente-stand";
  const { data: agentRow } = await sb.from("agents_registry").select("settings").eq("slug", slug).limit(1).maybeSingle();
  const vr = ((agentRow?.settings as any)?.voice_reply || {}) as any;
  // Voz da LIGAÇÃO: config VOICE_CALL_VOICE_ID (ex.: Carla) > voice_id do pedido > voz da nota de voz.
  const voiceId = String(body.voice_id || (await getIntegrationKey(sb, "VOICE_CALL_VOICE_ID")) || vr.voice || "").trim();
  if (!voiceId) return json({ error: "Sem Voice ID: cadastre a voz na aba Humanização do agente (Responder por áudio) ou informe voice_id." }, 400);
  const tune = { stability: 0.4, similarity: 0.85, speed: 1.0, ...(vr.eleven || {}) };
  const callTts = await getNinaVoiceTts(sb, { stability: Number(tune.stability), similarity: Number(tune.similarity), speed: Number(tune.speed) });

  const log: string[] = [];

  // 3. secret com o token (header x-voice-token nunca fica em texto puro na ElevenLabs)
  let secretId: string | null = (await getIntegrationKey(sb, "VOICE_ELEVEN_SECRET_ID")) || null;
  if (!secretId) {
    const r = await elevenFetch(apiKey, "/convai/secrets", { method: "POST", body: JSON.stringify({ type: "new", name: `totexgest_voice_token_${Date.now()}`, value: token }) });
    if (r.ok && r.data?.secret_id) { secretId = r.data.secret_id; await setConfig(sb, "VOICE_ELEVEN_SECRET_ID", secretId); log.push("secret criado"); }
    else log.push(`secret falhou (${r.status}) — header vai em texto`);
  }

  // 4. tools (cria ou atualiza) — com som de teclado nas de consulta/agendamento
  const sounds = await getNinaSounds(sb);
  const toolIds: Record<string, string> = JSON.parse((await getIntegrationKey(sb, "VOICE_ELEVEN_TOOL_IDS")) || "{}");
  for (const def of TOOL_DEFS) {
    let cfgBody = toolConfig(def, token, secretId, sounds.toolSound);
    let r = toolIds[def.name]
      ? await elevenFetch(apiKey, `/convai/tools/${toolIds[def.name]}`, { method: "PATCH", body: JSON.stringify(cfgBody) })
      : await elevenFetch(apiKey, "/convai/tools", { method: "POST", body: JSON.stringify(cfgBody) });
    if (!r.ok && secretId && r.status === 422) {
      // formato do secret no header pode variar entre versões da API → tenta texto puro
      cfgBody = toolConfig(def, token, null, sounds.toolSound);
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
      // A 1ª frase não pode ser cortada: o Gabriel (14/10) falou por cima e a Nina perdeu o motivo
      // da ligação (a Toro). O cliente é ouvido logo depois; a abertura sai inteira.
      disable_first_message_interruptions: true,
      prompt: { prompt: (await withLessons(sb, prompt)).prompt, llm: String(body.llm || "gpt-4.1-mini"), tool_ids: Object.values(toolIds), temperature: 0.4 },
    },
    tts: {
      voice_id: voiceId,
      // modelo e ajuste fino da LIGAÇÃO (config VOICE_CALL_*; padrão turbo v2.5 — flash soava diferente da Carla)
      ...(({ key: _k, ...rest }) => rest)(callTts),
    },
    // nomes de carro que a transcrição erra ("Hora"→Ora, "Nivos"→Nivus) — _shared/nina-store.ts
    asr: { keywords: NINA_ASR_KEYWORDS },
    turn: { turn_timeout: 7, turn_eagerness: "normal" },
    // clima de escritório: som de fundo bem baixo (config VOICE_BACKGROUND_SOUND/VOLUME)
    conversation: { background_sound: sounds.background },
  };
  // Placeholders das dynamic variables: na ligação RECEBIDA ninguém preenche customer_phone.
  // Vazio a ElevenLabs derruba a chamada ("Missing required dynamic variables in tools") →
  // placeholder "desconhecido" e as tools caem pro system__caller_id. Na SAÍDA o nina-dialer preenche.
  (conversation_config.agent as any).dynamic_variables = {
    dynamic_variable_placeholders: { customer_phone: "desconhecido", customer_name: "", playbook: "descobrir", reason: "" },
  };
  let agentId: string | null = (await getIntegrationKey(sb, "VOICE_ELEVEN_AGENT_ID")) || null;
  let r = agentId
    ? await elevenFetch(apiKey, `/convai/agents/${agentId}`, { method: "PATCH", body: JSON.stringify({ name: "Nina — Totex Motors", conversation_config, platform_settings: NINA_PLATFORM_SETTINGS }) })
    : await elevenFetch(apiKey, "/convai/agents/create", { method: "POST", body: JSON.stringify({ name: "Nina — Totex Motors", tags: ["totexgest", "voz"], conversation_config, platform_settings: NINA_PLATFORM_SETTINGS }) });
  if (!r.ok && agentId && r.status === 404) {
    agentId = null;
    r = await elevenFetch(apiKey, "/convai/agents/create", { method: "POST", body: JSON.stringify({ name: "Nina — Totex Motors", tags: ["totexgest", "voz"], conversation_config, platform_settings: NINA_PLATFORM_SETTINGS }) });
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

  // Número oficial cadastrado no Totexgest (pra casar com o dispositivo certo)
  const { data: inst } = await sb.from("whatsapp_instances").select("phone_number").eq("provider", "meta_cloud").limit(1).maybeSingle();
  const officialDigits = String(inst?.phone_number || "").replace(/\D/g, "");

  // Dispositivo OFFICIAL. A LISTA (/devices) não traz `plan`; só o detalhe
  // (/devices/{id}) tem plan.call_type = OFFICIAL | UNOFFICIAL. Então: lista →
  // detalhe de cada um → filtra. Prioridade: device_id informado > já salvo >
  // o que tem o telefone do número oficial > único OFFICIAL.
  const list = await wavoipFetch(jwt, "/devices");
  const listed: any[] = Array.isArray(list.data?.data) ? list.data.data : Array.isArray(list.data) ? list.data : [];
  if (!list.ok) return json({ error: `Lista de dispositivos falhou (${list.status}): ${JSON.stringify(list.data).slice(0, 200)}` }, 502);
  const details: any[] = [];
  for (const d of listed.slice(0, 20)) {
    const det = await wavoipFetch(jwt, `/devices/${d.id}`);
    const full = det.ok ? (det.data?.data || det.data) : d;
    details.push({ ...d, ...full, call_type: String(full?.plan?.call_type || "").toUpperCase() || null });
  }
  const officials = details.filter((d) => d.call_type === "OFFICIAL");
  const byPhone = officials.find((d) => officialDigits && String(d.phone || "").replace(/\D/g, "").endsWith(officialDigits.slice(-8)));
  let deviceId: string | null = String(body.device_id || "").trim() || null;
  if (!deviceId) {
    const saved = await getIntegrationKey(sb, "VOICE_WAVOIP_DEVICE_ID");
    if (saved && officials.some((d) => String(d.id) === saved)) deviceId = saved;
  }
  if (!deviceId && byPhone) deviceId = String(byPhone.id);
  if (!deviceId && officials.length === 1) deviceId = String(officials[0].id);
  const resumo = details.map((d) => ({ id: d.id, name: d.name, phone: d.phone || null, call_type: d.call_type || "sem plano", status: d.status }));
  if (!deviceId) {
    if (officials.length > 1) return json({ error: "Mais de um dispositivo OFFICIAL e nenhum com o número oficial — informe device_id.", devices: resumo }, 400);
    return json({ error: "Nenhum dispositivo do tipo OFFICIAL na conta WaVoIP (o detalhe /devices/{id} não trouxe plan.call_type = OFFICIAL). Veja a lista.", devices: resumo }, 400);
  }
  const device = details.find((d) => String(d.id) === deviceId);
  if (device && device.call_type !== "OFFICIAL") {
    return json({ error: `Dispositivo ${deviceId} não é OFFICIAL (é ${device.call_type || "sem plano"}). Regra da casa: nunca escaneado.`, devices: resumo }, 400);
  }
  await setConfig(sb, "VOICE_WAVOIP_DEVICE_ID", deviceId);
  log.push(`dispositivo ${deviceId} (${device?.name || "?"}, ${device?.phone || "sem telefone"})`);

  // Vínculo com o número oficial: se já está CONNECTED (feito pelo painel), não refaz.
  const waba = await wavoipFetch(jwt, `/devices/${deviceId}/waba`);
  const wabaStatus = String(waba.data?.data?.status || waba.data?.status || "").toUpperCase();
  let linkOk = false;
  if (waba.ok && wabaStatus === "CONNECTED") {
    linkOk = true;
    await setConfig(sb, "VOICE_WAVOIP_LINKED_AT", new Date().toISOString());
    log.push(`já vinculado ao número oficial (${waba.data?.data?.phone || device?.phone || ""})`);
  } else {
    const fbToken = await getIntegrationKey(sb, "WHATSAPP_CLOUD_TOKEN", HQ_TENANT);
    const phoneNumberId = await getIntegrationKey(sb, "WHATSAPP_PHONE_NUMBER_ID", HQ_TENANT);
    if (!fbToken || !phoneNumberId) return json({ error: "Faltam WHATSAPP_CLOUD_TOKEN / WHATSAPP_PHONE_NUMBER_ID em Integrações.", log }, 400);
    const link = await wavoipFetch(jwt, `/devices/${deviceId}/waba-link`, { method: "PUT", body: JSON.stringify({ fb_token: fbToken, id_phone_number: phoneNumberId }) });
    linkOk = link.ok;
    if (link.ok) { await setConfig(sb, "VOICE_WAVOIP_LINKED_AT", new Date().toISOString()); log.push("vinculado ao número oficial"); }
    else log.push(`waba-link falhou (${link.status}): ${JSON.stringify(link.data).slice(0, 200)}`);
  }

  // SIP → ElevenLabs
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

  const allOk = linkOk && sip.ok && wh.ok;
  return json({ ok: allOk, device_id: deviceId, log }, allOk ? 200 : 207);
}

async function queueSummary(sb: any) {
  const { data } = await sb.from("nina_call_queue")
    .select("id, lead_id, phone, playbook, reason, status, scheduled_for, attempts, outcome, last_error, created_at, leads(name)")
    .order("created_at", { ascending: false }).limit(20);
  const rows = (data || []).map((r: any) => ({ ...r, lead_name: r.leads?.name || null, leads: undefined }));
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  return { recent: rows, counts };
}

/** Tronco de SAÍDA na ElevenLabs → WaVoIP (sipv2.wavoip.com) com as credenciais SIP do dispositivo. */
async function actionElevenOutbound(sb: any, body: any) {
  const apiKey = await getIntegrationKey(sb, "ELEVENLABS_API_KEY", HQ_TENANT);
  const phoneId = await getIntegrationKey(sb, "VOICE_ELEVEN_PHONE_ID");
  if (!apiKey || !phoneId) return json({ error: "Faça o passo 1 (Criar Nina) antes." }, 400);
  const user = String(body.sip_user || "").trim();
  const pass = String(body.sip_password || "");
  if (!user || !pass) return json({ error: "Informe usuário e senha SIP do dispositivo WaVoIP (painel › dispositivo › SIP)." }, 400);
  const address = String(body.sip_host || (await getIntegrationKey(sb, "WAVOIP_SIP_HOST")) || "sipv2.wavoip.com").trim();
  // TCP, não "auto"/UDP: o INVITE da ElevenLabs é grande e estourou o MTU em UDP
  // ("size of packet larger than MTU. transaction transport error"). Codecs mínimos
  // (G.711) também encurtam o SDP.
  const transport = ["udp", "tcp", "tls"].includes(String(body.transport)) ? String(body.transport) : "tcp";
  // media_encryption "disabled": com "allowed" a ElevenLabs ofertava RTP/SAVP (SRTP obrigatório)
  // e a WaVoIP tocava (180) e recusava (603 Decline) ao negociar o áudio. Tronco SIP comum = RTP/AVP.
  const mediaEncryption = ["disabled", "allowed", "required"].includes(String(body.media_encryption)) ? String(body.media_encryption) : "disabled";
  const r = await elevenFetch(apiKey, `/convai/phone-numbers/${phoneId}`, {
    method: "PATCH",
    body: JSON.stringify({
      outbound_trunk_config: {
        address, transport, media_encryption: mediaEncryption,
        credentials: { username: user, password: pass },
        enabled_codecs: ["PCMU/8000", "PCMA/8000"],
      },
    }),
  });
  if (!r.ok) return json({ error: `ElevenLabs ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}` }, 502);
  await setConfig(sb, "VOICE_WAVOIP_SIP_USER", user);
  await setConfig(sb, "VOICE_ELEVEN_OUTBOUND_AT", new Date().toISOString());
  return json({ ok: true, address, transport, media_encryption: mediaEncryption });
}

/** Interruptor mestre + fontes + atraso da ligação automática. */
async function actionSetOutbound(sb: any, body: any) {
  if (typeof body.enabled === "boolean") await setConfig(sb, "NINA_OUTBOUND_ENABLED", body.enabled ? "true" : "false");
  if (typeof body.sources === "string") await setConfig(sb, "NINA_AUTO_CALL_SOURCES", body.sources.trim() || null);
  if (body.delay_min !== undefined && Number.isFinite(Number(body.delay_min))) await setConfig(sb, "NINA_AUTO_CALL_DELAY_MIN", String(Math.max(0, Math.min(1440, Number(body.delay_min)))));
  if (body.hora_inicio !== undefined && Number.isFinite(Number(body.hora_inicio))) await setConfig(sb, "NINA_HORARIO_INICIO", String(Math.max(0, Math.min(23, Number(body.hora_inicio)))));
  if (body.hora_fim !== undefined && Number.isFinite(Number(body.hora_fim))) await setConfig(sb, "NINA_HORARIO_FIM", String(Math.max(1, Math.min(24, Number(body.hora_fim)))));
  if (typeof body.dias === "string") await setConfig(sb, "NINA_DIAS_SEMANA", body.dias.replace(/[^0-6,]/g, "") || "0,1,2,3,4,5,6");
  return json({ ok: true });
}

/** Enfileira uma ligação de teste agora (lead pelo id) — ignora o atraso. */
async function actionEnqueueTest(sb: any, body: any, userId: string) {
  const leadId = String(body.lead_id || "").trim();
  if (!leadId) return json({ error: "lead_id obrigatório" }, 400);
  const { data: member } = await sb.from("team_members").select("id").eq("auth_user_id", userId).maybeSingle();
  const { data, error } = await sb.rpc("_nina_enqueue_call", { p_lead_id: leadId, p_reason: "manual", p_delay_minutes: 0, p_requested_by: member?.id || null });
  if (error) return json({ error: error.message }, 400);
  return json({ ok: true, queue_id: data });
}

/**
 * Diagnóstico Meta: configurações de ligação do número (status, horário permitido, SIP,
 * callback) + permissão do telefone informado. Lê direto do Graph com o token da loja.
 */
async function actionMetaDiag(sb: any, body: any) {
  const waToken = await getIntegrationKey(sb, "WHATSAPP_CLOUD_TOKEN", HQ_TENANT);
  const phoneNumberId = await getIntegrationKey(sb, "WHATSAPP_PHONE_NUMBER_ID", HQ_TENANT);
  if (!waToken || !phoneNumberId) return json({ error: "Faltam WHATSAPP_CLOUD_TOKEN / WHATSAPP_PHONE_NUMBER_ID" }, 400);
  const h = { Authorization: `Bearer ${waToken}` };
  const settings = await fetch(`https://graph.facebook.com/v22.0/${phoneNumberId}/settings`, { headers: h }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));
  const numero = await fetch(`https://graph.facebook.com/v22.0/${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier,status,code_verification_status`, { headers: h }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));
  const phone = String(body.phone || "").replace(/\D/g, "");
  const permission = phone
    ? await fetch(`https://graph.facebook.com/v22.0/${phoneNumberId}/call_permissions?user_wa_id=${phone}`, { headers: h }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }))
    : null;
  return json({ numero: numero.data, calling: settings.data?.calling ?? settings.data, permission: permission?.data ?? null, http: { settings: settings.status, numero: numero.status, permission: permission?.status ?? null } });
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
      case "eleven_outbound": return await actionElevenOutbound(sb, body);
      case "set_outbound": return await actionSetOutbound(sb, body);
      case "enqueue_test": return await actionEnqueueTest(sb, body, u.user.id);
      case "meta_diag": return await actionMetaDiag(sb, body);
      default: return json({ error: `action desconhecida: ${action}` }, 400);
    }
  } catch (e) {
    console.error("[voice-setup]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
