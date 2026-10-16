# Segurança das edge functions — pente fino de 2026-10-16

## O problema
61 funções rodam com `verify_jwt = false` (webhooks, crons, ferramentas do agente). Boa parte
não tinha checagem própria: com a URL e a **anon key** (que é pública no front) dava pra
disparar envio pelo WhatsApp oficial (`send-whatsapp-cloud`), rodar o agente (`agent-runner`),
criar tarefas, distribuir leads, gerar o card da simulação pra qualquer número
(`simulacao-card`, o achado que abriu a revisão).

## A porta única: `_shared/auth.ts`
`getCaller(req)` classifica quem chama:
- **service** — `Authorization: Bearer <SERVICE_ROLE_KEY>` (função → função, poller, webhooks)
- **internal** — `x-internal-token` = config `INTERNAL_CRON_TOKEN` (todos os crons do pg_cron
  passaram a mandar) ou `x-voice-token` = `VOICE_AGENT_TOKEN` (ferramentas da Nina)
- **user** — JWT do usuário logado (tela); tenant vem do `app_metadata`; superadmin via
  `is_platform_superadmin()`
- anon key sozinha → **recusada (401)**

`requireCaller(req, { allowUser })` é a barreira padrão; `callerCanTouchLead(caller, leadId)`
garante que usuário só mexe em lead da própria loja.

## Onde entrou (16/10)
agent-runner (usuário não aponta tenant de outra loja), send-whatsapp-cloud (usuário só manda
pra lead/número da própria loja), simulacao-card (telefone sempre do lead, nunca do body),
agendar-visita, distribuir-lead, lead-rewarm, instagram-send-dm, process-automation-rules,
renew-calendar-watches, migrate-profile-photos, batch-fetch-avatars, agent-jobs-poller
(só service/internal), daily-brain-briefing, capture-handoff, instagram-crons,
operation-alerts, ai-sales-agent, process-message-sequences, process-scheduled-messages.
Chamadas internas sem credencial corrigidas: webhook → distribuir-lead, cloud-template →
send-whatsapp-cloud, health-check → ai-sales-agent.

## Webhook da Meta
`whatsapp-cloud-webhook` passa a validar `X-Hub-Signature-256` (HMAC-SHA256 do corpo com o
**App Secret** do app da Meta) **quando** `META_APP_SECRET` estiver em Integrações. Sem o secret
só avisa no log. **Pendente:** cadastrar `META_APP_SECRET` (Meta for Developers › App › Settings
› Basic › App Secret). Vale também pro `meta-lead-webhook`.

## Ainda sem checagem própria (próxima rodada)
Funções `verify_jwt=false` que continuam sem barreira: `whatsapp-webhook` (UAZAPI — só grupos;
checar se a UAZAPI assina), `instagram-webhook` (assinatura da Meta), `wavoip-webhook`,
`telegram-webhook` (secret token do Telegram), `google-calendar-webhook` (token do canal),
`receive-lead`/`meta-lead-webhook` (intake público: por token), `book-meeting`, `unsubscribe`,
`campaign-processor`, `check-*`, `process-notification-*`, `process-task-reminders`,
`process-noshow-followup`, `daily-sales-digest`, `sync-whatsapp-*`, `sync-missed-messages`,
`validate-meta-token`, `fetch-meta-creative`, `generate-embedding`, `agents-codex-import`,
`connect-meta` (tem getUser), `soniox-token` (tem getUser), `email-automation-tick`,
`community-window-tick`, `repasse-track`, `import-copilot-leads`, `repasse-reconcile-joins`.
Regra pra funções novas: começar com `requireCaller`.

## Como testar
- anon key → 401 em qualquer função protegida.
- cron: `net._http_response` dos jobs com status 200 depois do deploy.
- tela: usuário logado continua enviando/rodando; usuário de uma loja não alcança lead de outra.
