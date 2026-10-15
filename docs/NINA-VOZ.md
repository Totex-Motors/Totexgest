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

## 2b. Módulo de ligação (Configurações › IA & Bots › Nina — Ligações)

Tela só pra superadmin, backend `voice-agent-setup` (JWT + `is_platform_superadmin`). Botões:

1. **Criar Nina na ElevenLabs** — pela API: secret com o token das tools, 5 webhook tools
   (URLs `voice-agent-tools/<tool>`, header `x-voice-token`, `caller_phone` = `system__caller_id`),
   agente (prompt editável na tela, voz clonada = a mesma da nota de voz, `eleven_flash_v2_5`,
   LLM `gpt-4.1-mini`), importa o número oficial como tronco SIP e atribui. Ids em config
   `VOICE_ELEVEN_AGENT_ID`, `VOICE_ELEVEN_PHONE_ID`, `VOICE_ELEVEN_TOOL_IDS`, `VOICE_ELEVEN_SECRET_ID`.
   Idempotente (clicar de novo atualiza). Gera `VOICE_AGENT_TOKEN` se não existir.
   **1b (manual, 1x):** webhook pós-chamada na ElevenLabs → secret em `ELEVENLABS_WEBHOOK_SECRET`.
2. **Configurar WaVoIP** — login com e-mail/senha da conta (API da WaVoIP só tem JWT de 7 dias;
   a senha NÃO é guardada), acha o dispositivo `OFFICIAL` (recusa `UNOFFICIAL`), `waba-link` com
   `WHATSAPP_CLOUD_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID`, SIP → `sip.rtc.elevenlabs.io:5060 TCP`,
   webhook → `wavoip-webhook`. Marcas em `VOICE_WAVOIP_*`.
3. **Testar ferramentas** — chama `horario_atual` com o token (prova a autenticação ponta a ponta).

As seções 3 e 4 abaixo descrevem o mesmo passo a passo manual, caso a API falhe.

## 2c. O ouro: dossiê, playbooks e memória entre agentes (Fase A)

**Dossiê** (`_shared/lead-brief.ts`, devolvido por `identificar_cliente`): tudo que o CRM já sabe
quando o lead entra, pra Nina não perguntar de novo.

| campo | de onde vem |
|---|---|
| `playbook` vender / trocar / comprar / descobrir | `seller_qualification.intent` (promotora), `lead_intent`, `lead_kind`, origem (stand/totem/marketplace = comprar) |
| origem, promotora, local | `captured_by_member_id` → `team_members`, `capture_location_id` → `capture_locations`, `source` |
| carro do cliente | `seller_vehicles` (último) ou `vehicle_fipe_snapshot` |
| FIPE + **3 propostas** | `vehicle_fipe_snapshot` × config `NINA_PROPOSTA_RAPIDA_PCT` (80), `NINA_PROPOSTA_TROCA_PCT` (85), `NINA_PROPOSTA_INTERMEDIACAO_MIN_PCT` (90) / `_MAX_PCT` (95) — **percentuais a confirmar com a diretoria** |
| carro de interesse + loja (QR) | `leads.metadata.vehicle/veiculo_interesse_texto`, `working_memory` da sessão do agente de texto (`carro`, `owner_label`) |
| observações da promotora, temperatura | `seller_qualification.observacao/temperatura` |
| agendamento existente / intermediação | `company_activities` (meeting futuro), `intermediations` |
| memória entre agentes | últimas 6 mensagens do WhatsApp; `leads.metadata.nina.last_call` e `.notes` |

**Playbooks** (prompt padrão em `voice-agent-setup`, editável na tela): VENDER (lógica da
intermediação: loja comum compra até 25% abaixo da tabela; Totex chega a 90–95% da FIPE; três
caminhos: proposta rápida, troca, intermediação), TROCAR (avaliação + visita ao carro desejado),
COMPRAR (QR Code: o carro e a loja já vêm no dossiê; visita reservada), DESCOBRIR. Sempre fecha
com dia e hora. Antes de encerrar chama `anotar_conversa`.

**Memória compartilhada Nina ↔ agente de WhatsApp**: `anotar_conversa` e o pós-chamada gravam
`leads.metadata.nina` (`last_call` com resumo/outcome/agendou, `notes`) + nota na timeline; o
`agent-runner` (auto-context) injeta isso no prompt do agente de texto ("a Nina ligou, não atendeu
→ pergunte o melhor horário"). `call_history.call_outcome` = `agendou | qualificou | conversou |
nao_atendeu` (base do dashboard da Nina).

## 2d. Fase B — a Nina LIGA pro cliente

**Banco** (migration `20261011130000_nina_call_queue.sql` — **aplicar no SQL Editor**): tabela
`nina_call_queue` (status `queued → awaiting_permission → calling → done | no_answer | failed |
cancelled | expired`), RPCs `nina_enqueue_call(lead, reason, delay)` / `nina_cancel_call` (UI),
`_nina_enqueue_call` (interna, dedupe 1 aberta por lead, playbook pela intenção, horário via
`next_business_time`), trigger `trg_nina_auto_enqueue` (AFTER INSERT em leads — só com
`NINA_OUTBOUND_ENABLED='true'`; fontes `NINA_AUTO_CALL_SOURCES`; espera `NINA_AUTO_CALL_DELAY_MIN`,
padrão 10 min; lead de promotora sempre entra) e cron `nina-dialer` (*/2 min, header
`x-voice-token`).

**Discador** (`nina-dialer`): chave mestra → horário comercial → 1 ligação por vez (WaVoIP = 1
canal) → **permissão da Meta** (`GET /{phone_number_id}/call_permissions?user_wa_id=`): sem
permissão manda o pedido (`send-whatsapp-cloud` action `send_call_permission`, interactive
`call_permission_request`; limites da Meta: 1/24h, 2/7 dias; vale 7 dias; 4 não atendidas
seguidas revogam) e fica `awaiting_permission`; resposta chega no `whatsapp-cloud-webhook`
(`interactive.call_permission_reply`) → `leads.metadata.call_permission` + fila volta pra
`queued`. Com permissão: `POST /v1/convai/sip-trunk/outbound-call` (ElevenLabs → tronco de
saída WaVoIP `sipv2.wavoip.com` com usuário/senha SIP do dispositivo → Meta) com dynamic
variables `customer_phone`, `customer_name`, `playbook` e a 1ª frase por playbook
("você conversou com a Carol no Tamboré sobre vender o seu carro, né?").

**Resultado** (`voice-agent-postcall` → `settleQueue`): atendeu ⇒ `done` + outcome; não atendeu ⇒
retry em +2h (horário comercial) até `max_attempts` (3) e, na 1ª tentativa, WhatsApp "tentei te
ligar, qual horário?" (free-form; a janela de 24h costuma estar aberta). O agente de texto vê
`metadata.nina.last_call` (auto-context) e continua.

**Tela**: Nina — Ligações › passo 4 (tronco de saída com usuário/senha SIP da WaVoIP; interruptor
mestre; origens e espera; "Nina, liga" de teste; fila). Detalhe do lead › card **Nina (voz)**
("Pedir pra Nina ligar" / cancelar, última ligação, permissão).

**Custos**: ligação de saída da Meta é cobrada por minuto (pulsos de 6 s; tabela por país e
volume); pedido de permissão custa como mensagem. Recebida é grátis.

**Fase C: dashboard** (ligações, atendidas, qualificadas, agendadas, % por playbook/loja/promotora, meta e prêmio).

## 2e. Loja exclusiva e voz da ligação (2026-10-13)

Depois do 1º teste de saída (a Nina citou várias lojas, agendou na First Line e falou com a
voz clonada "Marcão" em vez da Carla), ficaram duas chaves na tabela `config`:

| Chave | Valor hoje | Efeito |
|---|---|---|
| `NINA_LOJA_EXCLUSIVA` | tenant da Cardoso Veículos | Nina é sempre "da Totex Motors" (decisão do Marco, 14/10); a loja parceira entra como regra no topo do prompt; `consultar_estoque` preso ao `tenant_id` da loja, `agendar_visita` e `info_lojas` só nela; dossiê com alternativas só dela. Vazia = ecossistema todo. |
| `VOICE_CALL_VOICE_ID` | Carla (`mPDAoQyGzxBSkE0OAOKw`) | Voz da LIGAÇÃO. Sem ela, usa a voz da nota de voz do `agente-stand`. |

Quem aplica no agente da ElevenLabs: `nina-dialer` (`syncNinaAgent`, a cada 2 min pelo cron,
só quando o hash `VOICE_ELEVEN_SYNC_HASH` muda — vale também pra ligação recebida) e
`voice-agent-setup` (provisionamento). Manutenção sem ligar: `POST nina-dialer`
`{ "action": "ensure_agent" }` com `x-voice-token`. Código em `_shared/nina-store.ts`.

Clima de escritório (pedido do Marco): som de fundo da ElevenLabs e teclado digitando nas
tools `identificar_cliente`, `consultar_estoque`, `agendar_visita` e `info_lojas` (toca
mesmo com a Nina em silêncio). Chaves: `VOICE_BACKGROUND_SOUND` (padrão `office1`; outros
presets `office2`, `restaurant`, `city`, `typing`, `elevator1-4`; `off` desliga),
`VOICE_BACKGROUND_VOLUME` (padrão `0.08`, faixa 0.01–1) e `VOICE_TOOL_SOUND` (padrão
`typing`; `off` desliga). Aplicado pelo `syncNinaAgent` quando a chave muda.

Voz da ligação (14/10): modelo `eleven_v4_turbo` (config `VOICE_CALL_TTS_MODEL`; flash soava
pobre, turbo v2.5 enroscava, multilingual v2 atrasava 20 s), `VOICE_CALL_STABILITY` 0.45,
`VOICE_CALL_SIMILARITY` 0.8, `VOICE_CALL_SPEED` 1.05, `VOICE_CALL_LATENCY` 1. Som de fundo e
teclado (`VOICE_BACKGROUND_SOUND`/`VOICE_TOOL_SOUND`) ficaram `off`: na linha de telefone viram chiado.
Nome do carro como se fala (`spokenCarName`): "BMW 330", "GWM Tank 300".

Prompt v3 (14/10): `docs/nina/PROMPT-V3.md` = `_shared/nina-prompt.ts`. Fonte da verdade: config
`VOICE_AGENT_PROMPT` (tela), vazia = padrão do código. `syncNinaAgent` reaplica no agente quando muda.
Propostas: 80 / 85 / até 90 da FIPE (`NINA_PROPOSTA_*_PCT`), sempre "detalhe sai na avaliação presencial".

Outros ajustes: busca "Tanque" → "Tank" (transcrição do GWM Tank 300); se a consulta de
estoque falhar, a Nina não diz que o carro não existe.

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

## 2f. Depois da ligação: cadastro automático, avaliação e aprendizado (2026-10-14)

Pedido do Marco depois da ligação do Gabriel (14/10): "ela não cadastrou o carro de
interesse, nem o perfil de compra, nem o carro da troca", "duplicou o agendamento",
"perdeu o foco da Toro quando ele falou por cima", "a Nina tem que aprender sempre".

- **Interrupção**: `agent.disable_first_message_interruptions = true` (a abertura sai inteira),
  `asr.keywords` com nomes de carro (`NINA_ASR_KEYWORDS` em `_shared/nina-store.ts`) e regra 7
  do prompt (retomar o ponto que ficou pela metade). O dossiê (`lead-brief.ts`) junta os
  **leads-irmãos** (mesmo telefone: lead da Totex + cópia distribuída pra loja) e lê
  `trade_in_vehicles`, então a 1ª frase cita o carro do totem.
- **Cadastro pós-ligação** (`_shared/call-facts.ts`, chamado por `voice-agent-postcall`): a
  transcrição vira `metadata.vehicle`/`vehicles` (vínculo no estoque via `consultar-estoque`),
  `veiculo_interesse_texto`, perfil de compra (`faixa_preco_*`, `precisa_financiar`,
  `tem_veiculo_troca`, `entrada_disponivel`, `forma_pagamento`), `trade_in_vehicles` (carro na
  troca), `leads.instagram` e `nao_contatar`, no lead e nos irmãos. Só preenche o que está vazio
  (ou o carro de interesse mais recente). Telefone da ligação de SAÍDA vem da fila
  (`nina_call_queue.conversation_id`): o `system__caller_id` era o nosso número e a ligação ia
  parar no lead "TotexMotors/Autotech".
- **Instagram**: tool `enviar_instagram_totex` manda o link (config `INSTAGRAM_TOTEX_URL`, padrão
  instagram.com/totexmotors) pelo WhatsApp oficial, 1x por 30 dias; `anotar_conversa.instagram`
  grava o @ do cliente. Regra no prompt: convidar depois de combinar a visita, só com clima bom.
- **Agendamento único**: `agendar-visita` é idempotente (mesmo cliente + mesmo horário + aberto →
  devolve o existente e avisa a Nina pra não chamar de novo). Prompt: "chame UMA vez".
- **Inteligência IA automática**: `generate-lead-intelligence` salva em
  `leads.ai_conversation_insights.full_intelligence` (+ `data_sources`, `generated_at`,
  `ai_last_analysis_at`, `sales_score`), lê as ligações da Nina, roda sozinha depois de cada
  ligação (postcall) e de hora em hora (cron `lead-intelligence-batch`, `{batch:true}`, leads com
  interação depois da última análise). Score novo dispara `lead_score_changed` em
  `process-automation-rules` (regras em Configurações › Comercial › Automações).
- **Aprendizado** (`_shared/nina-learnings.ts`): depois de cada ligação o "treinador" (Claude)
  dá nota 0–10, acertos, erros (ficam em `call_history.metadata.avaliacao`) e propõe até 3 lições
  como regra curta → `nina_learnings` (status `pendente`; repetida só soma `vezes`). Tela
  Nina — Ligações › **5. O que a Nina aprendeu**: aprovar/rejeitar (`nina_learning_set_status`).
  Lições aprovadas entram no fim do prompt (bloco `<!-- LICOES -->`, máx. `NINA_MAX_LICOES` = 20)
  pelo `syncNinaAgent` em até 2 min. Nada entra no prompt sem aprovação humana.

## 2g. Não atendeu: cadência de retorno (2026-10-15, decisão do Marco)

1ª ligação não atendida → liga de novo em **15 min**. 2ª não atendida → **mensagem de
curiosidade** no WhatsApp oficial e liga de novo em **1 h**. 3ª não atendida → **2ª mensagem
3 h depois** e encerra (`no_answer`); o reaquecimento e o agente de texto seguem dali.
Tudo no horário da Nina (`nina_business_time`). Mensagens: janela de 24 h aberta → texto
livre; fechada → templates `nina_curiosidade_1` / `nina_curiosidade_2` ({{1}} nome, {{2}}
assinatura, {{3}} assunto: "o Nivus que você viu" / "o seu Onix"). Template pendente → pula a
mensagem, a cadência de ligações segue. Config: `NINA_RETRY_1_MIN`, `NINA_RETRY_2_MIN`,
`NINA_MSG2_HOURS`. Código: `_shared/nina-cadence.ts`; o `voice-agent-postcall` aplica no
webhook (inclusive `call_initiation_failure`) e o `nina-dialer` confere na API da ElevenLabs as
ligações em `calling` há mais de 2 min (ligação não atendida nem sempre gera webhook). A 2ª
mensagem fica na fila como `queued` + `metadata.step = msg2`.

## 2h. Follow-up automático do agente de TEXTO (2026-10-15, decisão do Marco)

O agente nunca chamava `agendar_lembrete` (0 em 14 dias). Agora o `agent-runner` agenda sozinho
depois de cada resposta no WhatsApp (`_shared/followup-auto.ts`): **3 h** (dentro de 8h–20h; senão
9h30 do dia seguinte) → **9h30 do dia seguinte** → **48 h depois a mensagem de PAUSA com botões**
("Continuar por aqui" / "Me chama outro dia" / "Encerrar por agora"). Cliente respondeu → cancela
e recomeça. Não agenda se: não contatar, visita marcada, repassado pra loja na sessão, ou o agente
decidiu não retomar (responde `NAO_ENVIAR` à instrução do poller). Passos 1–2: o modelo escreve
a retomada com valor novo (`instrucaoRetomada`); passo 3: `enviarPausa` manda os botões direto
(`send-whatsapp-cloud` action `send_buttons`). Botões: "Encerrar" → `nao_contatar` 30 dias +
despedida; "Me chama outro dia" → retomada em 3 dias (9h30); "Continuar" → vai pro agente
(`whatsapp-cloud-webhook` › `handlePausaReply`). Fora da janela de 24 h: templates
`retomada_conversa` ({{1}} nome, {{2}} assinatura, {{3}} assunto — `agent.settings.followup_template_*`)
e `pausa_conversa` (2 vars + QUICK_REPLY). Config: `FOLLOWUP_AUTO_ENABLED`, `FOLLOWUP_1_HOURS`,
`FOLLOWUP_PAUSA_ENABLED`, `FOLLOWUP_PAUSA_HOURS`.
