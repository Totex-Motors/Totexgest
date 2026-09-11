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

## Fases seguintes

| Fase | Entrega | Migrations/arquivos previstos |
|---|---|---|
| 2 · Documentos | `contract_templates` versionados, snapshot de variáveis, renderer PDF do Contrato de Intermediação (Condições Específicas + Gerais), preview; `legal_entities` na UI | `20260912_contratos_templates.sql`, edge fn `contract-render`, `ContractPreview.tsx` |
| 3 · Assinatura | adapter `SignatureProvider` + Clicksign, `contract_documents/signers/events/files`, webhook autenticado + idempotência + reconciliação, formalização automática (`intermediation_contract_signed`) | `20260913_assinatura.sql`, edge fns `clicksign-webhook`, `contract-send`, `contract-reconcile` |
| 4 · Comprador & pagamento | proposta do comprador, aceite do proprietário, Termo de Compra e Venda, `payment_method` (cash/financing/mixed/consortium), subpipeline F0–FX ligado à Credere, gates de entrega | `20260914_fechamento_pagamento.sql` |
| 5 · Alçadas | `powers_of_attorney`, `power_scopes`, `approval_requests/decisions`, `signer_authority_snapshots`, inbox de aprovações Renata/Fabiana | `20260915_alcadas.sql` |
| 6 · Franquias | `legal_entity_id`/`location_id` por unidade, templates globais × locais, credenciais por unidade | — |
