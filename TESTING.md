# TESTING.md — Estratégia de qualidade do Totexgest

Documento vivo. Define **o que não pode quebrar** e como validamos. Três camadas,
do mais barato ao mais robusto.

## Camadas

| Camada | O quê | Como rodar | Quando usar |
|--------|-------|-----------|-------------|
| 1. Agente QA | Revisão sob demanda de bugs + fluxo (somente leitura) | Peça pro Claude usar o agente `qa-fluxo` | Toda vez que mexer numa feature |
| 2. Checks de alto sinal | tsc, eslint de bugs, segredos, testes unit | `npm run validar` | Antes de cada commit / push |
| 3. E2E (Playwright) | Caminhos críticos no navegador | `npm run test:e2e` | Antes de subir pra produção |

### Como acionar o agente QA (camada 1)
Peça algo como: *"usa o agente qa-fluxo pra auditar o fluxo de cadastro de lead"*.
Ele lê o código de ponta a ponta, roda os checks e devolve um relatório
priorizado (🔴 bugs críticos / 🟡 menores / 🟢 melhorias de UX). **Ele nunca
altera nada** — você decide o que aplicar.

---

## Fluxos críticos (os que não podem quebrar)

Ordenados por impacto no negócio. Cada um lista a rota, os arquivos-chave e os
casos de borda a verificar.

### F1 — Autenticação
- **Rotas:** `/login`, `/forgot-password`, `/reset-password`
- **Código:** `src/pages/Login.tsx`, `src/contexts/Auth*`, `ProtectedRoute` em `src/App.tsx`
- **Casos:** login válido; senha errada; rota protegida sem sessão → redireciona p/ login; reset de senha; multi-tenant (tenant_id no JWT).

### F2 — Cadastro e gestão de lead
- **Rotas:** `/comercial/leads`, `/comercial/leads/:id`
- **Código:** `src/pages/SalesLeads.tsx`, `SalesLeadDetail.tsx`, `src/hooks/useSalesLeads.ts`
- **Casos:** criar lead; lead **sem telefone**; editar; mover de etapa; scoring IA; merge de leads (`useMergeLeads.ts`); deletar (tem confirmação?).

### F3 — Pipeline Kanban (drag & drop)
- **Rota:** `/comercial/pipeline`
- **Código:** `src/pages/SalesPipeline.tsx`, `useSalesPipeline.ts`, `usePipelineConfig.ts`, `useSalesAutomationRules.ts`
- **Casos:** arrastar card entre estágios; persistência após reload; multi-pipeline; automação dispara (`deal_stage_changed`); pipeline vazio.

### F4 — Inbox WhatsApp
- **Rota:** `/comercial/inbox`
- **Código:** `src/pages/SalesWhatsAppInbox.tsx`, `useWhatsAppInbox.ts`, edge `whatsapp-webhook`
- **Casos:** enviar mensagem; receber em tempo real; **instância desconectada**; áudio/imagem; sem API key configurada.

### F5 — Agente IA responde lead
- **Config:** `/configuracoes?s=agente-ia`
- **Código:** `useAISalesAgent.ts`, edge `ai-sales-agent`, tabela `ai_agent_chat_events`
- **Casos:** responde dentro do horário; **fora do horário** (skip logado); sem `ANTHROPIC_API_KEY`; sem `GEMINI_API_KEY` (mídia); humano ativo (cooldown); pausa de conversa.

### F6 — Deals / Oportunidades + pagamentos
- **Rotas:** `/comercial/deals`, `/comercial/deals/:id`
- **Código:** `SalesDeals.tsx`, `SalesDealDetail.tsx`, `useSalesDeals.ts`, `useDealPayments.ts`, `useCommissions.ts`
- **Casos:** criar deal; **deal sem produto**; mudar estágio (dispara automação + comissão); registrar pagamento; cálculo de comissão.

### F7 — Reuniões / Agenda
- **Rotas:** `/comercial/agenda`, `/gestao/reunioes`, `/agendar` (público)
- **Código:** `SalesAgendaV2.tsx`, `TeamMeetings.tsx`, `BookMeeting.tsx`, `useMeetings.ts`, edges `book-meeting`, `create-calendar-event`
- **Casos:** agendar (dispara automação `meeting_scheduled`); **sem Google Calendar conectado**; no-show; reunião concluída → resumo IA.

### F8 — Telefonia / Cockpit de chamada
- **Rota:** `/comercial/cockpit`, `SalesCallCockpit`
- **Código:** `useCallCockpit.ts`, `useCallRecording.ts`, `useGeminiLiveCoach.ts`, edges `process-call-recording`, `soniox-token`
- **Casos:** iniciar chamada; transcrição real-time; coach IA sugere; upload de gravação (bucket existe?); sem `SONIOX_API_KEY`.

### F9 — Tarefas
- **Rota:** `/gestao/tarefas`
- **Código:** `TaskManagement.tsx`, `useTasks.ts`
- **Casos:** criar (dispara `task_created`); concluir (`task_completed`); lembrete; tarefa sem responsável.

### F10 — Configurações / API Keys
- **Rota:** `/configuracoes`
- **Código:** `SettingsUnified.tsx`, `src/components/settings/`
- **Casos:** salvar API key (upsert `onConflict: key`); ligar/desligar módulo; vincular membro a instância WhatsApp; **nenhuma chave hardcoded no código**.

---

## Camada 2 — Checks de alto sinal

```bash
npm run validar     # tsc + eslint de bugs + segredos hardcoded + vitest
npm run typecheck   # só tipos
npm run test        # só testes unitários (vitest)
```
> Lembrete: o build do Vite **não** roda tsc — sempre passe pelo `validar`.

## Camada 3 — E2E (Playwright)

Base configurada em `playwright.config.ts`, testes em `e2e/`. Os exemplos cobrem
F1 (login) e a navegação protegida. Expanda para F2–F10 conforme prioridade.

```bash
npx playwright install   # 1ª vez: baixa os navegadores
npm run test:e2e         # roda os testes E2E
npm run test:e2e:ui      # modo interativo (debug visual)
```
Configure a URL base e credenciais de teste via `.env` (`E2E_BASE_URL`,
`E2E_EMAIL`, `E2E_PASSWORD`) — nunca commite credenciais reais.
