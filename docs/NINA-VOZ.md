# Nina (voz) — IA atendendo LIGAÇÃO no WhatsApp oficial

> Fase 2 do "agente que fala" (Fase 1 = resposta em nota de voz, `_shared/tts.ts`).
> Referência: vídeo da Viver de IA ("Nina atende ligação pelo WhatsApp e agenda").

Data: 2026-10-11 — parte do Totexgest pronta (PR); WaVoIP + ElevenLabs a configurar.

---

## 1. Como a ligação chega

```
Cliente toca "ligar" no WhatsApp
  → Meta (número IAP - OFICIAL, Business Calling API; ligação RECEBIDA é grátis)
  → WaVoIP (dispositivo tipo OFFICIAL vinculado ao número; faz a ponte SIP e o codec Opus)
  → SIP (TCP) → ElevenLabs Agents (a "Nina": escuta, pensa, fala em pt-BR)
  → durante a ligação: webhook tools → `voice-agent-tools` (Totexgest)
  → ao desligar: post-call webhook → `voice-agent-postcall` (Totexgest grava em call_history)
```

Regras da casa que isso respeita: **nada de WhatsApp escaneado** falando com cliente
(o dispositivo WaVoIP tem que ser `OFFICIAL`, nunca `UNOFFICIAL`); nenhuma função
daqui envia mensagem pra ninguém; lead entra pela porta única `find_or_create_lead`.

## 2. O que o Totexgest expõe

### `voice-agent-tools` (ferramentas da Nina durante a ligação)
`POST https://mztfyavuclqzivywkaeu.supabase.co/functions/v1/voice-agent-tools/<tool>`
Header obrigatório: `x-voice-token: <config VOICE_AGENT_TOKEN>` (sem token = 401).
Corpo JSON. Em toda tool mande `caller_phone` = `{{system__caller_id}}` (dynamic variable da ElevenLabs).

| tool | corpo | devolve |
|---|---|---|
| `identificar_cliente` | `{ caller_phone }` | `conhecido`, `nome`, `primeiro_nome`, `interesse`, `loja_referencia`, `orientacao` |
| `consultar_estoque` | `{ caller_phone, busca \| marca \| modelo, loja?, preco_max? }` | até 5 carros: `titulo, ano, preco, km, cor, cambio, cidade, loja` (mesmo motor do agente de texto) |
| `agendar_visita` | `{ caller_phone, data_hora (ISO -03:00), loja, carro, tipo?, nome_cliente?, observacoes? }` | `success`, `message` — grava tarefa no CRM, avisa o grupo de operação, confirma pro cliente por template oficial |
| `info_lojas` | `{}` | endereço/horário/telefone das lojas (config `VOICE_LOJAS_INFO`, JSON) |
| `horario_atual` | `{}` | `iso`, `texto`, `dia_semana` (Brasília) — usar ANTES de agendar |

Sessão: a função cria/acha uma `agents_sessions` (channel `voice`) por telefone, do agente
`VOICE_AGENT_SLUG` (padrão `agente-stand`), então `agendar-visita`/`consultar-estoque`
funcionam igual ao WhatsApp de texto.

### `voice-agent-postcall` (pós-chamada)
`POST https://mztfyavuclqzivywkaeu.supabase.co/functions/v1/voice-agent-postcall`
Valida `ElevenLabs-Signature` (HMAC) com config `ELEVENLABS_WEBHOOK_SECRET`. Grava em
`call_history` (`call_type = whatsapp_ai`, resumo em `ai_summary`, transcrição em
`transcriptions`), que já aparece na timeline do lead como "Chamada Recebida". Idempotente
por `conversation_id`.

### Chaves (Configurações › Integrações)
| chave | o que é |
|---|---|
| `VOICE_AGENT_TOKEN` | senha inventada; mesma nos headers das tools na ElevenLabs |
| `ELEVENLABS_WEBHOOK_SECRET` | segredo que a ElevenLabs gera ao criar o webhook pós-chamada |
| `ELEVENLABS_API_KEY` | voz da Fase 1 (opcional aqui) |
| `VOICE_AGENT_SLUG` (config, opcional) | agente do CRM cuja sessão/ferramentas a voz reaproveita (padrão `agente-stand`) |
| `VOICE_AGENT_TENANT_ID` (config, opcional) | tenant dos leads da ligação (padrão: tenant da instância oficial / HQ) |
| `VOICE_LOJAS_INFO` (config, opcional) | JSON `[{"nome":"Cardoso Veículos","endereco":"…","horario":"seg–sex 9h–18h, sáb 9h–13h","telefone":"…"}]` |

## 3. Configuração na WaVoIP (Marco + suporte)

1. Contratar **1 canal do tipo `OFFICIAL`** (`callType: "OFFICIAL"`). Perguntar preço e se cobre a Business Calling API.
2. Vincular ao número oficial: `PUT /v2/devices/{deviceId}/waba-link` com `fb_token` (token da Meta com
   `whatsapp_business_management`) e `id_phone_number` (ID do **número**, já cadastrado em
   `WHATSAPP_PHONE_NUMBER_ID`). Ou pelo painel (Embedded Signup).
3. Saída SIP do dispositivo: `PUT /v2/devices/{deviceId}/sip` → `active: true`, `ip: sip.rtc.elevenlabs.io`,
   `port: 5060`, `transport: TCP`, `caller_id: <número oficial>`.
4. Webhook do dispositivo → `https://mztfyavuclqzivywkaeu.supabase.co/functions/v1/wavoip-webhook`
   (já recebe `CALL`/`RECORD`/`DEVICE`).
5. Pré-requisito da Meta (vale igual): número com limite de mensagens ≥ 2.000/dia e app em modo Live.

## 4. Configuração na ElevenLabs (eu faço com o acesso)

1. **Phone Numbers › Import from SIP trunk**: número `+5511978846716`, transporte TCP, media encryption
   "Allowed", digest opcional (se usar, o mesmo usuário/senha vai no SIP da WaVoIP).
2. **Agent "Nina — Totex"**: idioma pt-BR, voz feminina natural, LLM rápido (gpt-4.1-mini/gemini flash),
   primeira frase: "Oi, aqui é a Nina, da Totex Motors. Com quem eu falo?".
   System prompt: vendedora simpática, frases curtas, sempre confirma antes de agendar, nunca inventa
   endereço/preço (usa as ferramentas), fala valores por extenso.
3. **Tools (webhook)**: 5 tools acima. Em cada uma: URL com o nome da tool no fim, método POST, header
   `x-voice-token` como **secret**, parâmetro `caller_phone` do tipo *dynamic variable* = `system__caller_id`.
4. **Post-call webhook** (Settings): URL `…/voice-agent-postcall`, tipo transcription; copiar o secret
   pra `ELEVENLABS_WEBHOOK_SECRET`.
5. Atribuir o número importado ao agente.

## 5. Teste
1. Ligar pro número oficial pelo WhatsApp → a Nina atende e cumprimenta pelo nome (se o lead existe).
2. Perguntar estoque, endereço, horário → respostas vindas das tools (ver logs `voice-tools`).
3. Pedir pra agendar → tarefa no CRM + aviso no grupo + template de confirmação.
4. Desligar → "Chamada Recebida" com resumo e transcrição na timeline do lead.

## 6. Fora do escopo (por enquanto)
- Ligação **de saída** pela IA (precisa permissão do cliente na conversa + cobrança por minuto da Meta).
- Gravação de áudio da ligação (o pós-chamada traz transcrição; áudio só com webhook `post_call_audio`).
- Transferir pra humano no meio da ligação (ElevenLabs tem "transfer to number"; depende do SIP de saída da WaVoIP).
