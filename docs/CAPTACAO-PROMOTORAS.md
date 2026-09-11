# Captação de Veículos — papel `promotora` + workspace `/captacao`

Entrega da **Fase 1 (segurança) + Fase 2 (workspace)** do plano
"Captação Promotoras / Franquias". Branch de revisão — **nada foi deployado**.

## O que é

Nova operação: promotoras em campo (ex.: Shopping Tamboré) captam **proprietários
que querem vender/intermediar o carro**. É o oposto do fluxo atual do stand
(`source = 'stand'` = comprador). Por isso o lead nasce com
`lead_intent = 'sell_intermediation'` e `source = 'captacao'` — nunca mistura
com o funil de compra.

## Arquivos

| Camada | Arquivo | O que faz |
|---|---|---|
| Banco | `supabase/migrations/20260910100000_captacao_promotoras_base.sql` | helpers, colunas, tabelas, RLS, RPCs |
| Auth | `src/contexts/AuthContext.tsx` | role `promotora` + `isPromotora` |
| Rotas | `src/components/auth/RoleRoute.tsx` | guarda por papel (URL direta) |
| Rotas | `src/App.tsx` | `ProtectedRoute` ganha `scope`; promotora fora de `/captacao` → redirect; rotas `/captacao/*` |
| Layout | `src/layouts/CaptureLayout.tsx` | mobile-first, bottom-nav 5 itens, sem AppSidebar |
| Telas | `src/pages/capture/CaptureHome.tsx` | Hoje: meta, CTA, 4 KPIs, pendências, frase do dia, microtreino |
| Telas | `src/pages/capture/CaptureNewLead.tsx` | Quick Capture (6 campos + passo opcional), dedupe, auto-save |
| Telas | `src/pages/capture/CaptureMyLeads.tsx` | Meus Leads + detalhe em bottom-sheet |
| Telas | `src/pages/capture/CaptureTraining.tsx` | Aulas, scripts, quiz (progresso local por enquanto) |
| Telas | `src/pages/capture/CaptureProfile.tsx` | Meta semanal, pontos, sair |
| Telas | `src/pages/capture/captureContent.ts` | Scripts/aulas estáticos do MVP |
| Comp. | `src/components/capture/SellerQualificationCard.tsx` | Qualificação de intermediação (edição) |
| Hooks | `src/hooks/useCaptureLeads.ts` | React Query sobre as RPCs |
| Tipos | `src/types/capture.ts` | tipos + espelho TS da regra de score |
| UI | `src/components/layout/AppSidebar.tsx` | item "Captação (promotoras)" pro gestor |
| UI | `src/pages/SalesSettings.tsx` | cargo "Promotora (captação)" no cadastro de membros |

## Modelo de dados (migration)

**leads** (novas colunas): `lead_intent`, `captured_by_member_id` (imutável —
trigger `trg_protect_captured_by`), `captured_at`, `capture_location_id`,
`capture_campaign_id`, `capture_channel`, `seller_qualification jsonb`.

**Tabelas novas**: `capture_locations`, `capture_campaigns`, `seller_vehicles`
(veículo do proprietário — não reutiliza `trade_in_vehicles`).

`captured_by_member_id` ≠ `sales_rep_id`: o primeiro é quem originou (promotora,
nunca muda); o segundo é quem atende (especialista, pode mudar).

## Segurança

- `is_promotora()` / `current_member_id()` (SECURITY DEFINER, como `is_admin`).
- Policies **RESTRICTIVE** em `leads` e `deals`: para quem não é promotora
  avaliam `true` (zero impacto no CRM). Para promotora: SELECT só dos próprios
  leads/deals; INSERT/UPDATE/DELETE direto **negados** — tudo passa por RPC.
- RPCs (SECURITY DEFINER): `create_capture_lead`, `update_my_capture_lead`,
  `list_my_capture_leads`, `capture_home_stats`, `ensure_capture_pipeline`
  (admin), `compute_capture_score`, `capture_temperature`.
- Frontend: `ProtectedRoute` redireciona promotora pra `/captacao` em qualquer
  rota do CRM; `RoleRoute` limita quem entra em `/captacao`.

## Score (regra transparente, sem IA)

| Sinal | Pontos |
|---|---|
| Quer vender agora / até 30 dias | +30 |
| Aceita avaliação | +20 |
| Autoriza contato do especialista | +20 |
| Veículo + ano + km informados | +15 |
| É o proprietário | +10 |
| Observação ≥ 10 chars ou valor em mente | +5 |

70–100 quente · 45–69 morno · <45 frio. Mesma função no banco
(`compute_capture_score`) e no front (`computeCaptureScore`) pra preview ao vivo.

## Como testar (depois de aplicar a migration)

1. Aplicar `20260910100000_captacao_promotoras_base.sql` (MCP `apply_migration`
   ou `supabase db push`). Nada destrutivo — só `ADD COLUMN IF NOT EXISTS` /
   `CREATE IF NOT EXISTS`.
2. (Admin) rodar `select ensure_capture_pipeline();` logado no tenant, ou
   deixar pra Fase 4 — sem o funil o lead entra sem `pipeline_stage_id`.
3. Configurações → Equipe → Membros → novo membro com cargo **Promotora**.
4. Logar com ela: `/` → cai em `/captacao`. Tentar `/comercial/leads` → volta.
5. Captar um cliente (6 campos) → conferir em Meus Leads e no CRM
   (`/comercial/leads`, lead com `source = captacao`).
6. Como promotora, no console: `supabase.from('leads').select('*')` → só os
   dela; `insert`/`update` direto → erro de RLS.

## Fase 4 — Handoff (entregue)

Fluxo: captura → score → **rodízio** de especialista → **tarefa** (`company_activities`,
tipo `call`, prioridade por temperatura) → **aviso WhatsApp** (especialista + grupo)
→ **1º contato** detectado (WhatsApp enviado ao lead ou tarefa concluída) → **SLA**
(cron 10 min: re-avisa; 2× SLA escala) → **retorno pra promotora** (`capture_lead_events`).

| Peça | Onde |
|---|---|
| Config por tenant | `capture_handoff_config` — UI em Configurações › Comercial › **Captação (promotoras)** |
| Rodízio | `capture_pick_specialist()` — lista configurada ou todos os vendedores ativos |
| Handoff | `capture_handoff(lead_id)` — chamado por `create_capture_lead`; grava `leads.handoff_*`, `metadata.handoff` |
| Aviso | edge function `capture-handoff` (`mode=notify`), disparada do banco via pg_net |
| SLA | cron `capture-sla` → `capture-handoff` (`mode=sla`): `sla_breached` → `escalated` |
| 1º contato | triggers em `whatsapp_messages` (is_from_me) e `company_activities` (completed) → `first_contact_at` |
| Retorno | `capture_lead_events` (handoff / contacted / stage / won / lost / reassigned) — tela Hoje ("Retornos") e Meus Leads (linha do tempo) |

Canal de aviso: usa a instância UAZAPI + grupo configurados; vazio = herda de
`operation_alert_config` (Torre de Controle). Cloud API (número oficial) não serve
pra isso — exige template.

Funil: o handoff usa o funil do tenant cujo nome começa com "Capta" (na Totex, o
**Captação Tamboré** já existente). Estágio `is_won` = "carro captado".

**Funil único + automações** (`20260910180000_captacao_funil_automacoes.sql`):
o Kanban é por **deals**, então `capture_handoff` cria um deal por lead captado
(`deals.metadata.captacao = true`); `deals.pipeline_stage_id` é a fonte da verdade
e o trigger `sync_lead_from_deal` espelha em `leads`. Etapas do Captação Tamboré:
Nova Captação → Contato feito → Avaliação agendada → Veio na loja / fotos →
Proposta → Nutrição (não agendou) → Ganho | Perdido. `capture_move_stage(lead,
'Padrão%')` move só pra frente, por nome (funciona em qualquer tenant que use os
mesmos nomes). Gatilhos: 1º contato → "Contato%"; tarefa trade_eval/visit/meeting/
video_call com data → "Avalia%"; concluída (trade_eval/visit/photo_session) →
"Veio%"; tarefa proposal → "Proposta%"; `capture_stale_followups(3)` (cron do SLA)
cria follow-up + avisa o grupo após 3 dias em "Contato feito" sem avaliação.

**Resumo da Captação** (grupo "CRM Captação Tamboré", mesmo canal da Torre de
Controle): cron `capture-summary` de hora em hora → `capture-handoff` `mode=summary`
posta nas horas de `capture_handoff_config.summary_hours` (default 13h e 19h BRT).
Conteúdo vem de `capture_daily_summary(tenant)`: hoje (total/quentes/mornos/frios/
contatados), por promotora (hoje · semana · faltam X pro prêmio semanal), leads
quente/morno sem 1º contato (com atraso), carros captados no mês. Forçar um envio:
`POST /functions/v1/capture-handoff {"mode":"summary","force":true}`.

## Gamificação — Prêmios por meta (entregue)

| Peça | Onde |
|---|---|
| Catálogo | `capture_rewards` (nome, descrição, imagem, critério, meta, estoque, ativo) — UI em Configurações › Comercial › **Prêmios da captação** ("Gerenciar Prêmios" + "Novo Prêmio") |
| Critérios | `leads_semana` (padrão), `pontos_semana` (10/lead + 20/quente), `leads_mes` — semana/mês no fuso SP |
| Progresso | RPC `capture_reward_progress()` → tela Hoje (prêmio em destaque no card da meta) e Perfil (todos, com barra) |
| Resgate | RPC `claim_capture_reward(id)` valida meta + estoque no servidor, 1 resgate por promotora/prêmio/período; gestor marca "Entregue" na mesma tela |
| Imagens | bucket público `capture-rewards` (upload no dialog) ou URL; o Outback está em `public/rewards/outback-vale-presente.jpg` |
| Seed | "Voucher Outback R$ 100,00" — 40 leads na semana, estoque 25 (tenant Totex Motors) |

## Reward Engine (PRD "Gamificação & Incentivos" — F4/F5/F7, entregue)

Dinheiro nasce **só no servidor**, por evento verificável, com idempotência e ledger.
Migration `20260911100000_captacao_reward_engine.sql`.

| Peça | Onde |
|---|---|
| Regras configuráveis | `capture_reward_rules` (evento, limiar/período, cash/voucher, valor, cap, mínimo pra campeã) — UI em Configurações › Comercial › Prêmios da captação › Regras |
| Eventos imutáveis | `capture_events` (`idempotency_key` UNIQUE): lead_validated, lead_invalidated, vehicle_captured, vehicle_sold, monthly_champion, reward_approved/paid/cancelled |
| Ledger | `capture_reward_ledger` (`idempotency_key` UNIQUE; pending → approved → paid / cancelled; quem/quando/motivo). Só muda por `capture_ledger_set_status()` (admin) |
| Lead válido | `leads.capture_valid` = nome + telefone + veículo + ano + intenção + **autorização de contato**; `capture_invalid_reason` diz o que falta. Reavaliado por trigger ao editar lead/veículo |
| Meta semanal | ao validar o N-ésimo lead (threshold da regra, ex. 40) nasce **um** voucher no ledger pro período — sem cron, sem botão |
| Jornada do carro | `seller_vehicles.status` lead → avaliacao → captado → preparacao → anunciado → negociacao → vendido; deal em etapa `is_won` marca **captado** automaticamente; time muda o resto por `set_seller_vehicle_status()` (card no detalhe do lead). captado → R$25, vendido → R$50 (regras) |
| Campeã do mês | `capture_close_month()` (admin): melhor conversão captados÷válidos com mínimo de válidos → R$100 |
| Carteira | `capture_wallet()` (pendente/aprovado/pago + extrato); `list_my_capture_vehicles()` (Meus Carros) |
| Gestor | `capture_ranking('week'|'month')` (válidos, taxa, captados, vendidos, conversão, incentivos, custo por captação); `capture_invalidate_lead()` tira lead da meta e cancela voucher pendente se a meta cair |
| Campanha | `capture_campaigns.focus_phrase / objection_phrase / objection_answer` — frase e objeção do dia saem do código |

Testes (Postgres local, `scratchpad/smoke_test6.sql`): 39→40 libera 1 voucher; reavaliação não duplica; captado 2× paga 1×; vendido 2× paga 1×; promotora não altera ledger; aprovação/pagamento auditados; campeã idempotente; invalidação desfaz meta.

## Treino — Roleplay com IA (F8, entregue)

| Peça | Onde |
|---|---|
| Cenários | `capture_roleplay_scenarios` — 5 padrão (tenant NULL): apressado, desconfiado, quer preço, "não agora", "por conta própria"; cada um com persona, fala inicial, fatos ocultos (carro/prazo/telefone) e `max_turns`. Tenant pode criar os seus (admin) |
| Sessões | `capture_roleplay_sessions` (mensagens, turnos, status, score, evaluation) — escrita só pela edge function |
| Edge function | `capture-roleplay` (JWT do usuário): `start` / `reply` (IA = cliente, Haiku 4.5, nunca sai do personagem, `[FIM]` encerra) / `finish` (Sonnet 4.6 avalia com rubrica abordagem 20 · descoberta 25 · objeção 20 · consentimento 20 · fechamento 15 → JSON com critérios, pontos fortes, melhorias, melhor frase, próximo treino) / `abandon` |
| Chave | `ANTHROPIC_API_KEY` via `getIntegrationKey` (tenant_integration_keys → config → env) |
| Progresso | `capture_training_progress` (aulas saem do localStorage) — RPCs `capture_training_mark_lesson`, `capture_training_summary` (aulas, nº de roleplays, média, melhor nota, últimos) |
| UI | aba Treino › Roleplay: cards de cenário → chat estilo WhatsApp → tela de resultado |

## Perfil de captação: padrão × folgista (entregue)

`team_members.capture_profile` = `padrao` | `folgista` (migration `20260911140000`).
**Folgista** = promotora esporádica: capta, treina e vê os próprios leads/carros
normalmente, mas **não participa dos valores em pecúnia nem vouchers** — salvo
regra de prêmio marcada com `include_folgista`. Enforce no servidor:
`capture_award()` (ponto único de lançamento) pula quando `capture_rule_applies()`
= false; `capture_close_month()` tira folgista da disputa; `capture_home_stats()`
devolve `perfil` + `incentivos` e o front mostra o painel simples (só "Meta de
hoje", sem carteira; 5º item do menu vira Treino). Gestor troca o perfil em
Configurações › Captação › Promotoras (`set_capture_profile`) e marca "vale pra
folgista" por regra em Prêmios da captação › Regras. Trigger
`protect_team_member_privileges` impede que o próprio membro altere `role` ou
`capture_profile` (fecha a brecha da policy de auto-edição de `team_members`).

## Fora desta entrega (próximas fases)

- Fase 3: KM/foto/voz, dedupe mais rica, auto-save em banco.
- Fase 5: `performance_goals` (metas reais no lugar do placeholder 8/dia, 40/semana),
  painel do gestor, ranking.
- Fase 6: `script_cards` / `training_progress` no banco + roleplay com IA.
- Fase 7/8: franquias (consolidação super-admin) e agente IA pra intenção de venda.
