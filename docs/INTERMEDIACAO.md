# Intermediação de veículos — plano e estado (PRD v4 do Marco)

Fonte: `Contrato_TotexMotors_Intermediacao_TotexGest_v4_Representacao_Alcadas.docx` (Partes I–IV).
Decisões tomadas com o Marco em 2026-09-11:

- **Provedor de assinatura:** Clicksign (fase 3). Credenciais chegam depois.
- **Funil:** 8 macroetapas + Encerrada (não as 17 do PRD). Pagamento, financiamento e documento são
  submáquinas dentro do card, não colunas.
- **Fase 1 opera sem provedor:** "Formalizada" = contrato assinado **importado** (PDF + SHA-256 + motivo,
  só admin) — fallback previsto no PRD 13.2.13. Quando a Clicksign entrar, o evento é o mesmo.
- **Dois pontos que faltavam no PRD, incluídos:** alerta de prazo do contrato (vence em 7 dias / venceu)
  e comunicação às promotoras sobre a mudança do R$ 25.

## Nomenclatura

| Termo | No sistema |
|---|---|
| Intermediação | `intermediations` (entidade-mãe, `INT-00001`) |
| Captação | origem/1ª etapa. `leads.captured_by_member_id` + `lead_intent = sell_intermediation` |
| Veículo em intermediação | `seller_vehicles` (FK `intermediation_id`) — `status` = jornada do carro |
| Interessado comprador | lead/deal do comprador (`buyer_lead_id`, `buyer_deal_id`), casado por `marketplace_vehicle_id` |
| Formalizada | `intermediations.status = 'active'` + `contract_status in (signed, imported)` |
| Concluída | `status = 'completed'` (venda com evidência) |

## Funil "Intermediação Tamboré" (8 + Encerrada)

| # | Etapa | Como acende (evento) | Gate ao arrastar |
|---|---|---|---|
| 1 | Captação | lead da promotora (`create_capture_lead`) | — |
| 2 | Avaliação | tarefa de avaliação/visita/fotos (trigger `trg_capture_task_stage`) | — |
| 3 | Contratar | condições comerciais completas (`intermediation_set_terms`) | — |
| 4 | Preparação | contrato assinado/importado (`intermediation_import_signed_contract`) | **exige contrato** |
| 5 | Em vitrine | carro aparece no estoque do marketplace (`capture-listing-sync`) | exige contrato |
| 6 | Interessados | negócio do comprador em Proposta (`trg_capture_buyer_deal`) | exige contrato |
| 7 | Fechamento | (fase 4: proposta aprovada, compra e venda, pagamento) | exige contrato |
| 8 | Concluída | venda com evidência (`set_seller_vehicle_status('vendido')` ou comprador Ganho) | **só automático** |
| 9 | Encerrada | `intermediation_set_status` cancelada/recusada/perdida/vendida por fora | — |

Gate: `trg_intermediation_deal_gate` (BEFORE UPDATE em `deals`). Automações passam por
`capture_move_stage`/`intermediation_move_deal`, que setam `app.intermediation_bypass`.
Mensagens do gate chegam ao kanban via toast (`SalesPipeline.tsx`).

Etapas antigas migradas: Nova Captação/Contato feito/Nutrição → Captação; Avaliação agendada/Veio na
loja → Avaliação; Proposta → Contratar; Ganho → Concluída; Perdido → Encerrada. Toda FK que apontava
pras antigas (deals, leads, `lead_distribution_config`, `sales_automation_rules.action_config`) foi
repontada dinamicamente (`intermediation_setup_pipeline`).

## Estados da intermediação

`lead` → `contracting` → `active` → `completed`. Alternativos: `paused` (guarda `status_before_pause`),
`docs_pending`, `cancelled_by_owner`, `refused_by_totex`, `lost`, `sold_outside` (abre tarefa de análise
de comissão, cláusula 8.1). Pausar/encerrar com anúncio no ar abre tarefa "Retirar anúncio" (o CRM não
publica no marketplace, só lê). Encerrar intermediação **ativa** é só admin (alçada mínima da fase 1).

## Prêmios (reward engine)

| Evento | Regra | Gatilho |
|---|---|---|
| `lead_validated` | 40 válidos/semana → voucher | inalterado |
| `intermediation_formalized` | R$ 25 | `trg_intermediation_status` ao virar `active` (antes: `vehicle_captured` no deal Ganho) |
| `intermediation_completed` | R$ 50 | ao virar `completed` (nota do ledger = evidência da venda) |
| `monthly_champion` | R$ 100 | inalterado |

Idempotência: `capture_emit_event` (`intermediation_formalized:<id>`) + `capture_award` (`rule:<id>:lead:<lead>`).
Aviso às promotoras inserido no feed (`capture_lead_events`, "📣 Novidade nos prêmios") + card dismissível em Prêmios.

## Prazo do contrato

`intermediation_check_deadlines(7)` — cron `intermediation-deadlines` diário 09:15 BRT. `ends_at` em ≤ 7 dias →
`deadline_status = expiring` + tarefa pro especialista; vencido → `expired` + tarefa. Uma tarefa por transição
(idempotente). Promotora vê "Prazo do contrato vence em N dias" no card.

## RPCs

- `intermediation_set_terms(id, jsonb)` — comercial/admin. Completo = preço + comissão + prazo → `contracting` + deal em Contratar. Travado após `active`.
- `intermediation_import_signed_contract(id, file_path, sha256, signed_at, reason)` — **admin**. Formaliza, carro `captado`, deal → Preparação, R$ 25.
- `intermediation_set_status(id, status, reason)` — `paused | docs_pending | reactivate | cancelled_by_owner | refused_by_totex | lost | sold_outside`.
- `intermediation_set_commission(id, status, amount)` — admin: `pending | invoiced | paid | waived | disputed`.
- `intermediation_funnel(period)` — funil do gestor (Configurações › Prêmios › Funil).
- `list_my_capture_vehicles()` — promotora: agora devolve código, status, contrato, prazo.

Storage: bucket privado `intermediation-contracts` (`<tenant_id>/<intermediation_id>/<ts>-contrato.pdf`), promotora sem acesso.

## Telas

- Detalhe do lead › aba Comercial: `IntermediationCard` (termos, contrato, estado, comissão, timeline) acima do `CaptureVehicleCard` (venda com evidência continua lá).
- Configurações › Prêmios: labels novos + aba **Funil**.
- Promotora: "Intermediações" (código, contrato, prazo), jornada Avaliação → Contrato → Em vitrine → Negociação → Vendida, card "Novidade nos prêmios".

## Migração de dados (2026-09-11, produção)

3 leads de promotora → 3 intermediações (`lead`), 6 deals migrados (Captação 3, Avaliação 3),
1 `lead_distribution_config` e 2 automações repontadas, `legal_entities` semeada com a Totex Digital Mídia.
Smoke test local: `scratchpad/smoke_test8.sql`.

## Fase 2 — Documentos (entregue 2026-09-12)

Migration `20260912100000_intermediacao_contratos.sql` (aplicada em prod em 2 partes) + edge fn `contract-render`.

- **Templates jurídicos versionados** (`contract_templates`): global (`tenant_id` NULL, só superadmin) ou do tenant
  (admin). Body em markdown-lite (`#`/`##`/`###`, `- ` bullets, `**bold**`, `{{variável}}`, `[[signature:owner|company]]`).
  Publicado é **imutável** (trigger); publicar um draft aposenta o anterior. `contract_template_current(tenant, tipo)`
  escolhe o do tenant, senão o global. v1 = Parte I do PRD (Condições Específicas + Gerais + assinaturas), 22 variáveis obrigatórias.
- **Snapshot** `intermediation_contract_snapshot(id)` monta as variáveis (entidade jurídica, quem assina, proprietário,
  veículo, condições, data por extenso) e devolve `missing` com rótulo PT e origem (`terms` | `contract_data.owner` |
  `contract_data.vehicle` | `legal_entity`) — a UI mostra "Falta: …" e leva ao campo.
- **Dados do contrato** `intermediation_set_contract_data(id, {owner, vehicle})`: CPF/RG/endereço do proprietário
  (`intermediations.owner_data` + espelho no lead), placa/Renavam/chassi/cor/combustível do carro
  (`seller_vehicles.plate/renavam/chassis`). Bloqueado pra comercial depois de assinado.
- **Geração** (edge fn `contract-render`, JWT comercial/admin): snapshot → 422 com faltantes, ou PDF A4 via `pdf-lib`
  → bucket `intermediation-contracts` → `contract_document_register()` (service_role): versão n+1, anteriores
  `cancelled`, signatários previstos (proprietário + empresa), `intermediation.contract_status='generated'`,
  evento `intermediation_contract_generated`. `{preview:true}` devolve o PDF sem gravar.
- **Importar assinado** agora marca o documento gerado como `validated` (+ signers `signed`) e formaliza. Sem documento
  gerado, cria um registro `manual_import`.
- **Quem assina pela Totex** hoje: `legal_entities.signer_name/cpf/role` (Fabiana, Administradora). Fase 5 troca por procurações.
- **Clicksign**: `CLICKSIGN_API_KEY` e `CLICKSIGN_ENV` em Configurações › Integrações › API Keys (por tenant; allowlist
  da RPC `set_my_tenant_integration_key`). A fase 3 lê via `getIntegrationKey`.
- UI: `IntermediationCard` (Dados do contrato, checklist, Pré-visualizar, Gerar v{n}, Regenerar com motivo, histórico de
  versões, signatários), Configurações › Comercial › Intermediação (entidade jurídica + templates).
- Smoke local: `scratchpad/smoke_test9.sql`.

## Fase 3 — Assinatura eletrônica (entregue 2026-09-13)

Migration `20260913100000_intermediacao_assinatura.sql` (aplicada em prod em 2 partes) + adapter
`supabase/functions/_shared/signature/*` + edge fns `contract-send`, `clicksign-webhook`, `contract-reconcile`.

- **Provedor plugável**: interface `SignatureProvider` (createEnvelope, getStatus, cancel, notify, registerWebhook,
  verifyWebhook, parseWebhook). Primeiro provedor: **Clicksign API v3** (envelopes). Chaves por tenant em
  Configurações › Integrações: `CLICKSIGN_API_KEY`, `CLICKSIGN_ENV` (`sandbox` | `production`; ausente = sandbox),
  `CLICKSIGN_WEBHOOK_SECRET` (gravada pelo botão "Registrar webhook"). Nunca em código.
- **Envio** (`contract-send` `action:'send'`, JWT comercial/admin): documento `generated|ready|error` → PDF do bucket →
  envelope + documento + signatários (canal e-mail/WhatsApp/SMS, autenticação e-mail/WhatsApp/SMS/PIX, CPF quando houver)
  + requisitos + ativa + notifica → `contract_document_mark_sent()` (doc `sent`, signers `sent`,
  `intermediation.contract_status='sent'`). Prazo em dias vira `deadline_at`. Falha no meio → cancela envelope e
  `contract_document_set_status(doc,'error')`.
- **Eventos**: tudo que chega (webhook ou reconciliação) entra em `contract_events` com chave de idempotência
  (`provider_event_id` ou tipo+signatário+digest) e só depois `contract_apply_provider_event()` calcula a transição:
  signer `viewed|signed|declined`; documento `sent → partial → completed`, `declined|cancelled|expired|error`.
  Tolera fora de ordem (`signed` antes de `viewed`); estado terminal (`validated`) nunca regride.
  `intermediation.contract_status` espelha (`sent|partial|declined|expired|cancelled`) enquanto não formalizada.
- **`completed` NÃO formaliza.** A edge fn reconcilia via API, baixa o PDF assinado, calcula SHA-256, grava em
  `intermediation-contracts/<tenant>/<int>/contrato-v<n>-assinado-*.pdf` e chama `contract_document_finalize()` →
  `validated` → `intermediation_formalize()` (a MESMA rotina do import manual): `active`, R$ 25 idempotente, carro
  `captado`, deal → Preparação. Formalize é idempotente (`already:true`).
- **Webhook** `clicksign-webhook` (verify_jwt=false): acha o documento por `contract_document_by_provider_ref()`
  (document key ou envelope id) → carrega o secret do tenant → valida `Content-Hmac: sha256=<hex>` em tempo constante →
  aplica evento → se `completed`/todos assinaram, reconcilia. Documento desconhecido responde 200 `{ignored:true}`.
- **Reconciliação** `contract-reconcile` (cron `*/30 * * * *`, sem JWT): `contract_documents_to_reconcile(120)` =
  `completed` sem PDF validado, `sent|partial` sem evento há 2 h ou com `deadline_at` vencido. Mesma rotina do botão
  "Verificar agora" (`action:'status'`).
- **Cancelar/Reenviar**: `action:'cancel'` cancela no provedor + `contract_document_set_status(doc,'cancelled',motivo)`;
  `action:'resend'` re-notifica. Documento cancelado/recusado/expirado sai de cena ao gerar nova versão.
- **Import manual continua** como alternativa (assinado em papel), agora via `intermediation_formalize(mode='imported')`.
- Quem assina pela empresa: `legal_entities.signer_email/signer_phone` alimentam o signatário `company` no registro do documento.
- Smoke local: `scratchpad/smoke_test10.sql` (mark_sent, fora de ordem, duplicado, recusa, finalize 2× → R$25 uma vez,
  evento tardio não regride, permissões, lookup por ref).

## Fase 4 — Comprador e Pagamento (entregue 2026-09-14)

Migration `20260914100000_intermediacao_fechamento.sql` (aplicada em prod em 2 partes). Reaproveita o motor
de contrato/assinatura da Fase 3 — o Termo de Compra e Venda é só outro `document_type` (`SALE_CONTRACT`).

- **Comprador + proposta.** `intermediations.buyer_data` (jsonb) guarda o comprador do Termo. `intermediation_proposals`
  registra o histórico de propostas (valor, forma de pagamento, entrada, financiado, parcelas, status). RPCs
  `intermediation_set_buyer`, `intermediation_add_proposal`, `intermediation_decide_proposal(accepted|rejected)`.
  Aceitar carimba `sale_price`/`payment_method`/… na intermediação, supersede as outras pendentes e move o funil pra **Fechamento**.
- **Forma de pagamento.** `intermediations.payment_method` (`cash|financing|mixed|consortium|other`) + `down_payment`,
  `financed_amount`, `installments`. O snapshot monta `sale.payment_text` por extenso.
- **Termo de Compra e Venda (`SALE_CONTRACT`).** Mesmo `contract-render` / `contract-send` / webhook / `contract_document_finalize`.
  Novidades no banco: o snapshot ganhou variáveis `buyer.*` e `sale.*`; `contract_document_register` cria o signatário
  `party_type='buyer'` (proprietário + comprador + Totex = 3 assinantes). As funções de provedor viraram **conscientes do
  `document_type`**: `mark_sent`/`apply_event` espelham em `contract_status` (intermediação) OU `sale_contract_status` (venda),
  e `finalize` despacha — `SALE_CONTRACT` **não paga R$ 25 nem re-formaliza**, só marca `sale_contract_status='signed'`.
  Você escolhe na hora: **enviar pela Clicksign** ou **importar o papel** (`intermediation_import_sale_contract`, admin).
- **Pagamento (marcação manual).** `intermediation_confirm_payment(valor, nota, full)` → `payment_status='satisfied'` + `paid_amount`.
- **Conclusão com trava.** `intermediation_conclude_sale` exige `sale_contract_status IN (signed,imported)` **e**
  `payment_status='satisfied'`; então registra a entrega (`transfer_status='completed'`, `delivered_at`) e marca o carro
  `vendido` via `set_seller_vehicle_status`, disparando a conclusão da Fase 1 (intermediação `completed`, **R$ 50**, deal → Concluída).
- **Template `SALE_CONTRACT` v1** global publicado — **rascunho, revisar no jurídico** (editável na tela de Templates).
- **Credere fica pra fase 4.1**: `payment_method='financing'` é só campo; sem subfunil F0–FX nem vínculo automático ainda.
- Smoke local: `scratchpad/smoke_test11.sql` (proposta+aceite, 3 signatários, espelho por tipo, finalize sem R$25,
  trava de conclusão sem pagamento, R$50 na conclusão, import papel, permissões).

## Fase 5 — Representação e Alçadas (entregue 2026-09-15)

Migrations `20260915100000_intermediacao_procuracoes.sql` (5a) e `20260915140000_intermediacao_alcadas.sql` (5b). PRD v4 §14.

**5a — Procurações (representação).** `powers_of_attorney`: quem assina pela empresa (administradora ou procurador),
com escopo (`scopes` = document_types ou `['*']`), alçada de valor (`max_value`), poder de aprovar exceções (`can_approve`),
validade e `is_default`. Seed: administradora padrão de cada tenant (migrada de `legal_entities.signer_*`) + **Renata** como
2ª administradora da Totex (preencher CPF/ato na UI). `poa_upsert`/`poa_set_status`/`poa_set_default` (definir padrão espelha
em `legal_entities.signer_*`, então o snapshot/contrato não muda). `poa_active_default(tenant, entidade, tipo)` escolhe quem
assina; `contract_document_register` grava `company_authority` (auditoria: qual procuração assinou). `member_can_approve()`
= superadmin, ou membro com procuração `can_approve` ativa, ou admin do tenant.

**5b — Alçadas (fila de aprovação).** `approval_requests` + `approval_open`/`approval_decide`/`approval_cancel`. Quatro atos
passam por aprovação de uma administradora antes de acontecer: **vender abaixo do preço mínimo** (`sell_below_minimum`),
**alterar comissão** (`commission_change`), **renunciar comissão** (`commission_waive`), **encerrar intermediação ativa**
(`cancel_active`), **concessão financeira excepcional** (`financial_concession`). Regra de ouro: **quem tem a alçada
(`member_can_approve`) age direto; quem não tem abre um pedido**. As RPCs de domínio (`intermediation_decide_proposal`,
`intermediation_set_status`, `intermediation_change_commission`, `intermediation_set_commission` waived,
`intermediation_request_concession`) ganharam `p_via_approval` e devolvem `{needs_approval:true, request_id}` quando precisam
de aprovação. **Aprovar aplica o efeito** (`approval_decide` chama a ação de domínio com bypass). `intermediations` ganhou
`financial_concessions`/`concession_total`. Smoke: `scratchpad/smoke_test12.sql`.

## Fase 6 — Rede de franquias (entregue 2026-09-16)

**Franquia = tenant.** O sistema já é multi-tenant: entidade jurídica (`legal_entities`), templates globais (`contract_templates.tenant_id`
NULL) × locais (por tenant), procurações, alçadas e credenciais (`tenant_integration_keys`) **já são por tenant** — nada a criar
nesse eixo. Migration `20260916100000_intermediacao_rede.sql`: RPC **`intermediation_network_dashboard(period)`** (superadmin)
agrega a intermediação por franquia (ativas, vencendo, vendidas/valor no período, comissão, promotoras, aprovações pendentes) +
total da rede e contagem de templates globais. UI: página de rede do superadmin.

## Fases seguintes

| Fase | Entrega | Migrations/arquivos previstos |
|---|---|---|
| 4.1 · Credere | subpipeline F0–FX ligado à simulação Credere, status de financiamento no negócio | — |
| 5 · Alçadas | `powers_of_attorney`, `power_scopes`, `approval_requests/decisions`, `signer_authority_snapshots`, inbox de aprovações Renata/Fabiana | `20260915_alcadas.sql` |
| 6 · Franquias | `legal_entity_id`/`location_id` por unidade, templates globais × locais, credenciais por unidade | — |
