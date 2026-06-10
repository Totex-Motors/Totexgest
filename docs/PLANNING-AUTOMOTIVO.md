# Planning — Customização Automotiva do CRM Totexgest

> **Handoff doc.** Self-contained pra um modelo/sessão nova continuar. Leia também
> `CLAUDE.md` (visão geral do projeto) na raiz. Atualize este doc conforme avançar.

## Contexto rápido do projeto
- **CRM Totexgest** = SaaS multi-tenant pras lojas parceiras da Totex Motors gerenciarem leads.
- Stack: React 18 + Vite + TS + Tailwind + shadcn/ui + TanStack Query; backend Supabase (Postgres + Edge Functions Deno + RLS).
- **Roda SÓ LOCAL** (`npm run dev`) — NÃO está na Vercel, sem auto-deploy. Frontend fala com o Supabase remoto (projeto `mztfyavuclqzivywkaeu`).
- Multi-tenant: `tenant_id` via JWT `app_metadata.tenant_id`; RLS `get_tenant_id()`. Super-admin = membro de tenant com `tenants.is_super_admin=true` (tenant `c13681e3-5db9-48d1-9c5c-856e6041d77f`). Módulos por-tenant em `tenants.enabled_modules`. API keys por-tenant em `tenant_integration_keys` (fallback global `config`).

## ⚠️ Estado do git (IMPORTANTE)
- Há **muita coisa não commitada** na working tree (trabalho do item #5 API-keys-por-tenant + fixes). O João faz **commit em massa** quando tudo estiver pronto — **NÃO** descartar/resetar a working tree; **construir por cima**.
- Commitar só quando o João pedir. Branch atual: `main` (sem branch protection; push direto funciona).

## Como validar / aplicar
- Typecheck frontend: `npx tsc --noEmit -p tsconfig.json` (deve dar exit 0).
- Edge functions: `deno lint <arquivo>` (ignorar warnings `no-explicit-any`/import-prefix pré-existentes; olhar só erros de parse). Deno em `C:\Users\USER\.deno\bin`.
- Migrations: criar em `supabase/migrations/AAAAMMDD_nome.sql`; aplicar com `supabase db push --linked --yes` (CLI logada, projeto linkado `mztfyavuclqzivywkaeu`). `supabase` em `C:\Users\USER\AppData\Roaming\npm`.
- `gh` CLI: `C:\Users\USER\AppData\Local\GitHubCLI\bin\gh.exe` (autenticado). Repo `Totex-Motors/Totexgest`.
- Convenções: UI em pt-BR; shadcn/ui; React Query; `@/` alias.

## Dados que já existem (não duplicar)
- Lead do marketplace traz o veículo em **`leads.metadata.vehicle`**: `{ id, description, brand, model, version, year, mileage, price, price_formatted }`. Também `metadata.marketplace_store_id`, `marketplace_store_name`, `marketplace_origin`, `store{}`.
- Tela `/comercial/marketplace` (`src/pages/MarketplaceLeads.tsx`) já lista esses leads com o veículo.
- Pipeline por-tenant em `sales_pipeline_stages` (configurável). Defaults criados em `provision-tenant` e `admin-tenants`.
- **Estoque fica no MARKETPLACE** (decisão do João) — CRM não guarda estoque; no máximo consulta a API pública do marketplace (`GET https://totexmotors.com/api/dealerships`; endpoint de veículo a confirmar no repo `Totex-Motors/totexmotors-marketplace`).

## Decisões do João
- Estoque: **só no marketplace**, CRM consulta via API quando precisar.
- Trade-in: **manual agora** (vendedor digita avaliação); automático/FIPE **depois**.
- **FIPE: adiado** (complexo — escolha de API, versões de tabela, cache).
- Branding por-tenant: **não precisa**.

## Tarefas (em ordem)

### T1 — Veículo de interesse no lead  ⬅️ COMEÇAR POR AQUI
- **Objetivo:** mostrar o veículo do lead na tela de detalhe do lead/deal (hoje só aparece em /comercial/marketplace).
- Card "Veículo de interesse" lendo `lead.metadata.vehicle`: marca/modelo/versão, ano, km, preço (`price_formatted` ou formatar `price`), e link pro anúncio se houver.
- **Sub-tarefa (pode ser depois):** botão "Vincular veículo" pra leads não-marketplace → vendedor cola ID/URL do anúncio → CRM busca via API do marketplace e grava em `metadata.vehicle`.
- **Onde:** tela de detalhe do lead — localizar (provável `src/pages/LeadDetail*.tsx` ou `src/components/sales/...`). Reusar o padrão de card de `MarketplaceLeads.tsx`.

### T2 — Funil + campos automotivos
- **Funil:** conjunto-padrão automotivo em `sales_pipeline_stages` (Novo Lead → Qualificação → Test Drive → Avaliação/Proposta → Financiamento (Credere) → Ganho/Perdido). Aplicar nos defaults de `provision-tenant`/`admin-tenants` e/ou permitir o tenant configurar.
- **Campos "perfil de compra"** no lead: faixa de preço/orçamento, precisa financiar?, entrada disponível, tem veículo na troca?, forma de pagamento. Guardar em `leads.metadata` (jsonb) ou colunas; exibir num bloco na tela do lead.

### T3 — Veículo na troca (trade-in) — MANUAL
- **Tabela dedicada** `trade_in_vehicles` (decisão: tabela, não jsonb — permite histórico/relatórios): `id, tenant_id, lead_id, deal_id?, marca, modelo, ano, km, placa?, condicao, valor_pedido, valor_avaliado, created_at/updated_at`. RLS por tenant (+ super-admin read, padrão das migrations 20260613).
- **UI:** card "Veículo na troca" no lead/deal com form; valor avaliado **manual**.
- **Conta da proposta:** `preço do veículo de interesse − valor_avaliado da troca = diferença` (a financiar/à vista). Conecta com a etapa Avaliação/Proposta e com o Credere.

### T4 — FIPE  ⬅️ ADIADO
- Integração FIPE pra valor de referência (troca + veículo de interesse). Decidir API/cache. Não fazer agora.

## Progresso
- **T1 (COMPLETO, 2026-06-10):** card "Veículo de interesse" + botão "Vincular veículo" para leads manuais. `VehicleOfInterestCard` aceita `leadId` prop; modal `LinkVehicleModal` extrai ID de URL ou raw ID, tenta `GET https://totexmotors.com/api/vehicles/{id}`, grava resultado em `leads.metadata.vehicle` via `useUpdateLeadMetadata`. Se a API falhar, salva só o ID (link "Ver anúncio" ainda funciona). tsc 0 erros.
- **T2a (COMPLETO, 2026-06-10):** pipeline automotivo padrão atualizado em `supabase/functions/admin-tenants/index.ts` e `provision-tenant/index.ts`: Novo Lead → Em Qualificação → Test Drive → Avaliação/Proposta → Financiamento (Credere) → Ganho → Perdido.
- **T2b (COMPLETO, 2026-06-10):** card `BuyerProfileCard.tsx` na sidebar do lead. Campos em `leads.metadata`: `faixa_preco_min`, `faixa_preco_max`, `precisa_financiar`, `entrada_disponivel`, `tem_veiculo_troca`, `forma_pagamento`. Hook `useUpdateLeadMetadata` faz merge do JSONB. tsc 0 erros.
- **T3 (COMPLETO, 2026-06-10):** migration `20260616_trade_in_vehicles.sql` (aplicada em prod). Hook `useTradeInVehicles.ts` (`useTradeInByLead`, `useUpsertTradeIn`, `useDeleteTradeIn`). Card `TradeInVehicleCard.tsx` na sidebar do lead: form completo (marca/modelo/versão/ano/km/placa/condição/valores), cálculo automático "preço interesse − avaliado = diferença". tsc 0 erros.
- **T4 (adiado):** FIPE.
- **Nota de endpoint marketplace:** `GET https://totexmotors.com/api/vehicles/{id}` é uma suposição (endpoint exato não confirmado). Se retornar 404/CORS, o botão salva só o ID e avisa o usuário — ajuste o endpoint quando confirmado no repo `Totex-Motors/totexmotors-marketplace`.
- **Não commitado** (tudo na working tree, João commita quando quiser).
