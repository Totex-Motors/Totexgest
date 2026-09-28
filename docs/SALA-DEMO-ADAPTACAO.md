# Sala de Demo — Mapa de Adaptação (Fase 0)

> Planejamento técnico da adaptação do "Kit de demo personalizada" ao Totexgest.
> Este documento **não altera nada** — é o mapa "o que já existe × o que criar".
> Companheiro do plano em linguagem de negócio (Claude Doc "Sala de Demo — Plano
> de Adaptação no Totexgest"). Nada vai a produção sem branch + homologação.

Data: 2026-09-28

---

## 1. Objetivo

Lead recebe um link único `/demo/:token` → vê apresentação gravada (câmera + tela
sincronizadas) com saudação pelo primeiro nome (voz ElevenLabs) → pode agendar →
o CRM registra os eventos e move o funil. Comando administrativo reinicia a sessão
mantendo o link. **Reaproveitar** os módulos do Totexgest; criar só o essencial.

---

## 2. Decisão do gatilho (a decisão da Fase 0)

**Como a demo é criada/enviada?** Três caminhos possíveis:

- **A. Tool do agente** (`agents_tools`, `action_type = edge_function` → `create-demo`):
  o agente, ao qualificar o lead na conversa, cria a demo e devolve o link pra enviar.
- **B. Botão manual** ("Criar link de demo") no lead/deal, pra quando um humano quer mandar.
- **C. Regra de automação** (`sales_automation_rules`) que dispara ao mover pra "Demo enviada".

**Recomendação: A + B (não C).**

- A + B são **criação** (gatilhos explícitos: o agente decide, ou a pessoa clica).
- A etapa **"Demo enviada" deve ser CONSEQUÊNCIA** da criação (setada pela `create-demo`),
  não o gatilho dela. Isso segue a regra de ouro do sistema: *"o estágio do funil é
  consequência do evento, nunca o contrário"* (ver `CLAUDE.md` / intermediação).
- Evitar C como gatilho de criação impede **duplo envio** (humano move o card e a regra
  reenvia). "Demo assistida" também é consequência (setada pela `handle-milestone`).

> **Pendente de confirmação do Marco:** OK com A + B, e a etapa como consequência?

---

## 3. Reaproveitar (já existe no Totexgest)

| Peça do kit | Reusar | Referência |
|---|---|---|
| Rota pública sem login | Padrão existente | `src/App.tsx` — rotas fora do `<ProtectedRoute>` (ex.: `/agendar`, `/r/:code`, `/unsubscribe`) |
| Página pública "modelo" | Clonar estrutura (sem sidebar/auth) | `src/pages/BookMeeting.tsx`, `src/pages/RepasseLanding.tsx` |
| Agendamento (a call do fim) | Reusar como está | `src/pages/BookMeeting.tsx` + `supabase/functions/book-meeting/` (cria deal, reunião, Meet, e-mail). **Sem iframe** — chamada direta. |
| Envio WhatsApp | Reusar | `supabase/functions/send-whatsapp-cloud/` — body `{ action, phone, lead_id, sent_by, sent_by_name, tenant_id }` |
| Agente + tools | Reusar infra | `agents_tools` (`supabase/migrations/20260618001_agents_platform.sql`), runner `supabase/functions/agent-runner/` (`lib/tools/executor.ts`, `lib/tools/edge-function.ts`) |
| Mover funil por evento | Reusar | `sales_automation_rules` + `supabase/functions/process-automation-rules/` |
| Segredos/chaves | Reusar mecanismo | `getIntegrationKey` em `supabase/functions/_shared/config.ts` (tenant → config → env) |
| Bucket privado (modelo) | Copiar padrão | `supabase/migrations/20260415000_call_recordings_bucket.sql` (bucket privado + policies) |
| Isolamento por loja | Reusar | `get_tenant_id()` (`000_base_schema.sql`) — 191 tabelas c/ `tenant_id`, 875 policies RLS |
| Base UI | Reusar | `@/lib/supabase`, `@/lib/utils` (`cn`), toast (shadcn + sonner), `framer-motion` |

---

## 4. Criar novo

| Novo | Tipo | Notas |
|---|---|---|
| `src/pages/DemoRoom.tsx` (`/demo/:token`) | Front | Rota pública, lazy, junto de `/r/:code`. Sem `useAuth`. |
| Botão "Criar link de demo" | Front | No lead/deal; gera e copia link. Ação de envio separada. |
| `demo_rooms` | Tabela | `id, token, lead_id, tenant_id, video_camera_key, video_screen_key, camera_duration_s, screen_share_start_s, booking_slide_at_s, greeting_audio_path, cta_url, status, started_at, ended_at, expires_at, created_by, created_at` |
| `demo_events` | Tabela | `id, room_id, tenant_id, event_type, watched_seconds, metadata, created_at` |
| bucket `demo-greetings` | Storage | Privado; áudio por sessão; servido por URL assinada/proxy por token. |
| `create-demo` | Edge fn | Admin autenticado; token forte (128+ bits); grava `expires_at`; NÃO envia WhatsApp sozinha; seta etapa "Demo enviada". |
| `get-demo` | Edge fn (pública) | Por token; checa `expires_at`; devolve **só primeiro nome** + o mínimo. |
| `generate-greeting` | Edge fn | ElevenLabs (`ELEVENLABS_API_KEY` via `getIntegrationKey`); quota; trava concorrência por sessão; valida o UPDATE do áudio. |
| `stream-greeting` | Edge fn (pública) | Valida token + prazo; Range/206; só serve do bucket configurado; nunca público. |
| `handle-milestone` | Edge fn | Idempotente; valida marco; seta "Demo assistida"; nunca regride etapa. |
| RPCs `demo_public_mark` / `demo_public_event` | Banco | Públicas por token; allowlist de eventos; rate-limit; prazo. |
| Tool `criar_demo` | `agents_tools` | `action_type=edge_function` → `create-demo`. `lead_id` via `runtime_context`, não pelo LLM. |
| 2 etapas de funil | Migration | "Demo enviada" + "Demo assistida" (ver §6). |
| `ELEVENLABS_API_KEY` | Config | Cadastrar em Configurações › Integrações (grava em `config`/`tenant_integration_keys`). |
| bloco `verify_jwt=false` | `supabase/config.toml` | Para `get-demo` e `stream-greeting` (públicas). `create-demo`/`generate-greeting`/`handle-milestone` = autenticadas/restritas. |

---

## 5. Contrato dos 5 endpoints (resumo)

| Função | Entrada | Saída / efeito | Endurecer |
|---|---|---|---|
| `create-demo` | `lead_id, video_*_key, durations, cta_url, cta_label` | cria sessão + `url /demo/token`; seta "Demo enviada" | login + tenant/lead; token forte; `expires_at`; sem envio automático |
| `get-demo` | `token` | sessão + display name | pública por token; checa prazo; só nome |
| `generate-greeting` | `session token/id` | `audio_url` | restrita; quota; concorrência; valida save |
| `stream-greeting` | `token` | `audio/mpeg` Range/206 | token + prazo; só bucket configurado; privado |
| `handle-milestone` | `token, milestone` | move etapa elegível (idempotente) | dedupe durável; vincula deal/pipeline/tenant certo; não regride |

Regra de ouro: **o navegador é não-confiável** — `session_id`/eventos vindos dele não
autorizam nada; validar sempre no servidor pelo token + `tenant_id`.

---

## 6. Funil

Hoje (pipeline Closer): `Novo → Em contato → Qualificado → Call agendada → No-show →
Call realizada → Em fechamento`. Não existe "Demo enviada"/"Demo assistida".

Inserir entre *Qualificado* e *Call agendada*:

```
Qualificado → Demo enviada → Demo assistida → Call agendada
```

Padrão de migration (igual `supabase/migrations/20260823120000_totex_noshow_stage_and_rules.sql`):

1. `UPDATE sales_pipeline_stages SET position = position + 2 WHERE position >= <pos de Call agendada>` (abrir espaço, do maior pro menor).
2. `INSERT INTO sales_pipeline_stages (id, name, position, color, pipeline_id, tenant_id) VALUES (...) ON CONFLICT (id) DO NOTHING;` para as 2 etapas, por tenant.
3. Revisar regras `sales_automation_rules` com `only_if_position_less_than` (gate lido em `process-automation-rules`, case `move_deal_stage`).

O `STAGE_IDS` do front (`src/pages/SalesPipeline.tsx`) **não precisa mudar**: o cálculo
de urgência tem `default: 'ok'`, então etapas novas não quebram. Ajustar cor/regra depois se quiser.

---

## 7. Segurança — 14 correções (critérios de aceite)

1. Isolamento por loja (`tenant_id` + RLS) em `demo_rooms`/`demo_events` e no bucket.
2. Dados mínimos na sala pública + `expires_at` checado em consulta/streaming/eventos.
3. Mídia sempre privada (URL assinada/proxy por token); matar fallback de URL pública.
4. Marcos idempotentes (75%/fim não duplica fila do agente).
5. Vincular ao deal/pipeline/tenant certo; updates condicionais (não regride etapa).
6. Áudio robusto: esperar `canplay`, timeout, retry, quota; validar UPDATE do save.
7. Config centralizada (durações e timestamps reais do vídeo, não os do kit).
8. Reset auditável (admin + log; preserva áudio e histórico; nunca público).
9. Webcam honesta (só local; não prometer "ao vivo"/gravação; funciona se negar câmera).
10. `verify_jwt` correto por função; nunca ampliar permissão pra contornar erro.

*(agrupamento das 14 observações de `docs/ADAPTACOES.md` do kit)*

---

## 8. O que NÃO fazer

- ❌ Copiar `verify_jwt=false` das funções administrativas do kit.
- ❌ Servir bucket privado por URL pública (`getPublicUrl`).
- ❌ Confiar em `session_id` do navegador como autorização.
- ❌ Enviar WhatsApp real durante a homologação (usar contato fictício, envio desligado).
- ❌ Regredir etapa ganha/perdida/agendada.
- ❌ Rodar o `cleanup_unused_tables.sql` (assunto separado; ver análise de enxugamento).

---

## 9. Próximos passos (após o OK do gatilho)

- **Fase 1** — Banco + segurança: `demo_rooms`, `demo_events` (com `tenant_id` + RLS),
  bucket `demo-greetings`, migration das 2 etapas de funil.
- **Fase 2** — as 5 edge functions endurecidas.
- **Fase 3** — `DemoRoom.tsx` + botão criar link.
- **Fase 4** — ElevenLabs + agenda + tool do agente (WhatsApp/agente desligados no teste).
- **Fase 5** — homologação (RLS entre 2 lojas, expiração, mídia privada, reset) → autorização de publicação.

**Do Marco:** vídeos (câmera + tela) + durações/timestamps; voz ElevenLabs autorizada +
OK da chave; marca (logo/cores); confirmação do gatilho (§2).
