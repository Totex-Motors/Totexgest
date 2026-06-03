# TotexMotors OS — API Reference

> Documentação para integração entre o **TotexMotors OS** e sistemas externos
> (em especial o **CRM multi-tenant dos lojistas**).
>
> Versão: 1.0 · Última atualização: 2026-05-28

---

## 1. Visão geral

O TotexMotors OS roda sobre **Supabase** (PostgreSQL + PostgREST + Edge Functions
+ Auth + Realtime). A "API" é composta por 3 camadas:

| Camada | Para quê | Auth |
|--------|----------|------|
| **REST (PostgREST)** | CRUD direto nas tabelas, com RLS | JWT do usuário **ou** service_role |
| **Edge Functions (Deno)** | Lógica server-side (agentes IA, integrações) | JWT **ou** API key própria |
| **Realtime (WebSocket)** | Assinar mudanças em tabelas em tempo real | JWT do usuário |

### Arquitetura da integração OS ↔ CRM

```
┌──────────────────────────┐   machine-to-machine    ┌──────────────────────────┐
│  TotexMotors OS          │ ◄──── service_role ────► │  CRM dos Lojistas        │
│  (Supabase A)            │      ou Edge Function    │  (Supabase B, multi-     │
│  fbgtqiqovwxccinbzvmx    │                          │   tenant)                │
│                          │                          │                          │
│  • dealerships (lojistas)│ ──registro de lojista──► │  cria tenant por lojista │
│  • financial_records     │ ◄──métricas de leads──── │  leads/deals fechados    │
│  • agent_logs            │                          │                          │
└──────────────────────────┘                          └──────────────────────────┘
```

**Direções de dados:**
- **OS → CRM:** quando um lojista é cadastrado/ativado no OS, o CRM cria um *tenant* correspondente.
- **CRM → OS:** o CRM reporta métricas (leads recebidos, deals fechados) que alimentam o Dashboard CEO e a cobrança por resultado.

---

## 2. Ambientes e Base URLs

| Recurso | URL |
|---------|-----|
| **Project URL** | `https://fbgtqiqovwxccinbzvmx.supabase.co` |
| **REST API** | `https://fbgtqiqovwxccinbzvmx.supabase.co/rest/v1` |
| **Edge Functions** | `https://fbgtqiqovwxccinbzvmx.supabase.co/functions/v1` |
| **Auth** | `https://fbgtqiqovwxccinbzvmx.supabase.co/auth/v1` |
| **Realtime** | `wss://fbgtqiqovwxccinbzvmx.supabase.co/realtime/v1` |

---

## 3. Autenticação

### 3.1. Chaves

| Chave | Onde usar | Exposição |
|-------|-----------|-----------|
| **Publishable (anon)** | Frontend / navegador | Pública — protegida por RLS. `sb_publishable_7FBkjLTMpozEHHcgucNA1g_xTNWsrfp` |
| **Secret (service_role)** | **Apenas servidor** (Edge Functions, backend do dev) | **SECRETA — ignora RLS, acesso total.** Pegue em: Dashboard → Project Settings → API → `service_role` |

> ⚠️ **NUNCA** exponha a `service_role` no frontend, em repositório, ou no app do lojista.
> Para integração machine-to-machine (CRM ↔ OS), use `service_role` **somente** no
> backend/Edge Function do CRM, lida de variável de ambiente.

### 3.2. Headers obrigatórios

Toda requisição REST precisa de:

```http
apikey: <publishable-ou-service_role>
Authorization: Bearer <jwt-do-usuario-ou-service_role>
Content-Type: application/json
```

### 3.3. Login (obter JWT de usuário)

```bash
curl -X POST 'https://fbgtqiqovwxccinbzvmx.supabase.co/auth/v1/token?grant_type=password' \
  -H "apikey: sb_publishable_7FBkjLTMpozEHHcgucNA1g_xTNWsrfp" \
  -H "Content-Type: application/json" \
  -d '{"email":"usuario@totexmotors.com","password":"********"}'
```

Resposta:
```json
{
  "access_token": "eyJhbGci...",   // JWT — use em Authorization: Bearer
  "token_type": "bearer",
  "expires_in": 3600,
  "refresh_token": "v1.Mxxx...",
  "user": { "id": "uuid", "email": "..." }
}
```

### 3.4. Machine-to-machine (recomendado pro dev do CRM)

Para o CRM ler/escrever no OS sem usuário logado, use a `service_role` direto:

```js
import { createClient } from '@supabase/supabase-js'

// SOMENTE no backend do CRM — nunca no browser
const osClient = createClient(
  'https://fbgtqiqovwxccinbzvmx.supabase.co',
  process.env.TOTEX_OS_SERVICE_ROLE_KEY,  // service_role secreta
  { auth: { persistSession: false } }
)
```

---

## 4. Convenções REST (PostgREST)

A API REST é auto-gerada a partir das tabelas. Padrões:

| Operação | Método | Exemplo |
|----------|--------|---------|
| Listar | `GET /rest/v1/{tabela}` | `GET /rest/v1/dealerships` |
| Filtrar | `GET /rest/v1/{tabela}?coluna=eq.valor` | `?status=eq.active_shopping` |
| Selecionar colunas | `?select=col1,col2` | `?select=id,trade_name,status` |
| Joins (embed) | `?select=*,relacao(*)` | `?select=*,dealership_services(*)` |
| Ordenar | `?order=coluna.desc` | `?order=created_at.desc` |
| Paginar | header `Range: 0-49` | primeiras 50 linhas |
| Inserir | `POST /rest/v1/{tabela}` | body = objeto ou array |
| Atualizar | `PATCH /rest/v1/{tabela}?id=eq.{id}` | body = campos a mudar |
| Deletar | `DELETE /rest/v1/{tabela}?id=eq.{id}` | — |
| Upsert | `POST` + header `Prefer: resolution=merge-duplicates` | — |

**Operadores de filtro:** `eq` (=), `neq` (≠), `gt` (>), `gte` (≥), `lt` (<),
`lte` (≤), `like`, `ilike`, `in`, `is` (null), `cs`/`cd` (contains/contained — arrays/jsonb).

**Retornar o registro inserido/atualizado:** header `Prefer: return=representation`.

---

## 5. Referência de tabelas

Todas as tabelas estão no schema `public`. IDs são `uuid` (gerados via
`gen_random_uuid()`). Timestamps são `timestamptz` (ISO 8601 UTC).

### 5.1. `dealerships` — Lojistas (TABELA-CHAVE PARA A INTEGRAÇÃO)

Cada registro = 1 lojista. **No CRM, cada `dealership.id` deve mapear pra 1 `tenant`.**

| Coluna | Tipo | Notas |
|--------|------|-------|
| `id` | uuid | PK |
| `legal_name` | text | Razão social (obrigatório) |
| `trade_name` | text | Nome fantasia (obrigatório) |
| `cnpj` | text? | |
| `state_registration` | text? | Inscrição estadual |
| `address`, `city`, `state`, `zip_code` | text? | Endereço |
| `website`, `instagram` | text? | |
| `phone`, `whatsapp` | text? | |
| `financial_email`, `operational_email` | text? | |
| `status` | enum `DealershipStatus` | ver §6.1 |
| `notes` | text? | |
| `logo_url` | text? | |
| `created_at`, `updated_at` | timestamptz | |

### 5.2. `dealership_contacts` — Contatos do lojista

| Coluna | Tipo | Notas |
|--------|------|-------|
| `id` | uuid | PK |
| `dealership_id` | uuid | FK → dealerships |
| `name` | text | |
| `role` | text? | Cargo |
| `cpf`, `rg` | text? | |
| `email`, `phone`, `whatsapp` | text? | |
| `contact_type` | enum `ContactType` | `legal`, `financial`, `leads`, `technical`, `erp_support` |
| `is_primary` | boolean | |
| `created_at` | timestamptz | |

### 5.3. `services` — Catálogo de produtos

| Coluna | Tipo | Notas |
|--------|------|-------|
| `id` | uuid | PK |
| `name` | text | |
| `kind` | enum `ServiceKind` | ver §6.3 |
| `description` | text? | |
| `base_price` | numeric | Preço de tabela |
| `internal_cost` | numeric | Custo interno |
| `active` | boolean | |
| `metadata` | jsonb? | Ex.: `{max_slots, daily_exhibitions}` |
| `created_at` | timestamptz | |

### 5.4. `dealership_services` — Planos contratados (lojista × serviço)

| Coluna | Tipo | Notas |
|--------|------|-------|
| `id` | uuid | PK |
| `dealership_id` | uuid | FK → dealerships |
| `service_id` | uuid | FK → services |
| `price` | numeric | Preço negociado |
| `internal_cost` | numeric | |
| `status` | enum | `active`, `paused`, `cancelled` |
| `start_date`, `end_date` | date? | |
| `due_day` | int? | Dia de vencimento |
| `notes` | text? | |
| `created_at` | timestamptz | |

### 5.5. `contract_templates` / `contracts`

`contract_templates`: `id`, `contract_type` (enum, §6.4), `name`, `body` (texto com
`{{variaveis}}`), `variables` (text[]), `active`, `created_at`.

`contracts`: `id`, `dealership_id?`, `template_id?`, `contract_type`, `status`
(enum §6.5), `monthly_value?`, `setup_fee?`, `start_date?`, `end_date?`, `due_day?`,
`signed_file_url?`, `editable_fields` (jsonb), `rendered_body?`, `sent_at?`,
`signed_at?`, `created_at`.

### 5.6. `stock_integrations` — Integração de estoque com ERP

| Coluna | Tipo | Notas |
|--------|------|-------|
| `id` | uuid | PK |
| `dealership_id` | uuid | FK |
| `erp_name`, `erp_company`, `erp_support_contact` | text? | |
| `feed_type` | enum | `xml`, `json`, `api`, `manual` |
| `feed_url`, `api_base_url`, `api_token` | text? | ⚠️ `api_token` é sensível |
| `documentation_url` | text? | |
| `status` | enum `IntegrationStatus` | §6.6 |
| `last_sync_at`, `last_error` | timestamptz?/text? | |
| `developer_responsible`, `notes` | text? | |
| `created_at` | timestamptz | |

### 5.7. `onboarding_tasks` — Esteira de onboarding (Kanban)

`id`, `dealership_id`, `stage` (enum §6.7), `title`, `description?`,
`responsible_agent?` (enum `AgentName`), `responsible_user?`, `due_date?`,
`completed_at?`, `position` (int), `created_at`.

### 5.8. `financial_records` — Lançamentos financeiros (RELEVANTE P/ MÉTRICAS DO CRM)

| Coluna | Tipo | Notas |
|--------|------|-------|
| `id` | uuid | PK |
| `dealership_id` | uuid? | FK (null = custo geral) |
| `type` | enum | `revenue`, `fixed_cost`, `variable_cost` |
| `category` | text? | Ex.: "Plano", "Credere", "Lead" |
| `description` | text | |
| `amount` | numeric | |
| `due_date`, `paid_date` | date? | |
| `reference_month` | text? | Formato `YYYY-MM` |
| `status` | enum | `pending`, `paid`, `overdue`, `cancelled` |
| `service_id` | uuid? | |
| `created_at` | timestamptz | |

### 5.9. `fixed_costs` — Custos fixos

`id`, `name`, `amount` (numeric), `category?`, `active` (bool), `notes?`, `created_at`.

### 5.10. `support_tickets`

`id`, `dealership_id?`, `title`, `description?`, `priority` (enum §6.8),
`status` (enum §6.9), `assigned_agent?` (enum `AgentName`), `resolved_at?`, `created_at`.

### 5.11. `agent_logs` — Log de ações dos agentes IA (ÚTIL P/ AUDITORIA DA INTEGRAÇÃO)

`id`, `agent_name` (enum `AgentName`), `dealership_id?`, `action` (text),
`result?` (text), `metadata?` (jsonb), `created_at`.

### 5.12. `credere_activations` — Ativações do Credere

`id`, `dealership_id`, `status` (enum §6.10), `link_sent_at?`, `form_filled_at?`,
`activated_at?`, `monthly_fee` (numeric), `internal_cost` (numeric), `notes?`, `created_at`.

### 5.13. `agent_conversations` / `agent_messages` — Chat dos agentes IA

`agent_conversations`: `id`, `user_id` (FK auth.users), `agent_name`, `title?`,
`created_at`, `updated_at`. **RLS: cada usuário vê só as próprias.**

`agent_messages`: `id`, `conversation_id` (FK), `role` (`user`/`assistant`/`system`),
`content` (text), `tokens_input?`, `tokens_output?`, `created_at`.

---

## 6. Enums (valores válidos)

### 6.1. DealershipStatus
`lead`, `negotiation`, `contract_sent`, `contract_signed`, `onboarding`,
`integration_pending`, `site_production`, `published_site`, `active_shopping`,
`active_marketplace`, `overdue`, `suspended`, `cancelled`

### 6.2. ContactType
`legal`, `financial`, `leads`, `technical`, `erp_support`

### 6.3. ServiceKind
`totem_30`, `totem_60`, `marketplace`, `credere`, `b2c_capture`, `repass`,
`new_cars`, `custom`

### 6.4. ContractType
`dealer_main`, `stock_authorization`, `credere_addendum`, `service_provider`

### 6.5. ContractStatus
`draft`, `sent`, `signed`, `cancelled`, `expired`

### 6.6. IntegrationStatus
`pending`, `awaiting_erp`, `feed_received`, `token_received`, `testing`,
`integrated`, `error`, `published`

### 6.7. OnboardingStage
`contract_closed`, `awaiting_signature`, `awaiting_data`, `awaiting_material`,
`erp_request_sent`, `awaiting_feed`, `integration_dev`, `site_production`,
`stock_test`, `leads_test`, `credere_activation`, `published_marketplace`,
`published_totem`, `training`, `active`, `support`, `renewal`

### 6.8. TicketPriority
`low`, `medium`, `high`, `critical`

### 6.9. TicketStatus
`open`, `in_progress`, `waiting_client`, `resolved`, `closed`

### 6.10. CredereStatus
`pending`, `link_sent`, `form_filled`, `active`, `cancelled`

### 6.11. AgentName
`ceo`, `onboarding`, `legal`, `technical`, `financial`, `support`, `commercial`

---

## 7. Edge Functions

### 7.1. `POST /functions/v1/agent-chat`

Conversa com os agentes IA (CEO via Claude, demais via OpenAI). Carrega snapshot
do banco em tempo real e responde no contexto da operação.

**Auth:** `Authorization: Bearer <jwt-de-usuario>` (verify_jwt = true).

**Request:**
```json
{
  "agent_name": "ceo",            // enum AgentName (obrigatório)
  "message": "Qual a margem do mês?", // obrigatório
  "conversation_id": "uuid|null"  // null = cria nova conversa
}
```

**Response 200:**
```json
{
  "conversation_id": "uuid",
  "message": {
    "id": "uuid",
    "role": "assistant",
    "content": "A margem do mês está em...",
    "tokens_input": 2451,
    "tokens_output": 380,
    "created_at": "2026-05-28T12:00:00Z"
  },
  "provider": "anthropic",
  "model": "claude-sonnet-4-5-20250929"
}
```

**Erros:** `400` (agente/mensagem inválidos), `401` (sem auth), `500/502` (erro do provedor de IA).

---

## 8. Contrato de integração OS ↔ CRM (proposta para o dev)

> Esta seção descreve o **padrão recomendado** para o dev do CRM consumir e
> alimentar o OS. Os endpoints abaixo usam a REST API descrita acima.

### 8.1. Sincronizar lojistas (OS → CRM)

Quando o CRM precisa saber quais lojistas existem (pra criar/mapear tenants):

```bash
# Lojistas ativos + plano contratado
curl 'https://fbgtqiqovwxccinbzvmx.supabase.co/rest/v1/dealerships?status=in.(active_shopping,active_marketplace)&select=id,trade_name,legal_name,cnpj,whatsapp,status,dealership_services(price,status,services(name,kind))' \
  -H "apikey: <service_role>" \
  -H "Authorization: Bearer <service_role>"
```

**Mapeamento sugerido no CRM:**
```
dealership.id  →  tenants.external_id   (guarde o uuid do OS no tenant)
dealership.trade_name  →  tenants.name
dealership.cnpj  →  tenants.cnpj
```

### 8.2. Reportar métricas de leads (CRM → OS)

Quando o CRM fecha um deal ou entrega leads, registra no OS como `financial_record`
(receita futura) ou `agent_log` (auditoria). Exemplo — registrar lead entregue:

```bash
curl -X POST 'https://fbgtqiqovwxccinbzvmx.supabase.co/rest/v1/agent_logs' \
  -H "apikey: <service_role>" \
  -H "Authorization: Bearer <service_role>" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d '{
    "agent_name": "commercial",
    "dealership_id": "<uuid-do-lojista>",
    "action": "Lead entregue via CRM",
    "result": "Cliente João — interesse em SUV — score 82",
    "metadata": {"lead_id":"<uuid-no-crm>","score":82,"source":"totem"}
  }'
```

Registrar comissão/receita de um deal fechado:
```bash
curl -X POST 'https://fbgtqiqovwxccinbzvmx.supabase.co/rest/v1/financial_records' \
  -H "apikey: <service_role>" \
  -H "Authorization: Bearer <service_role>" \
  -H "Content-Type: application/json" \
  -d '{
    "dealership_id": "<uuid-do-lojista>",
    "type": "revenue",
    "category": "Comissão CRM",
    "description": "Deal fechado #1234 — Honda Civic",
    "amount": 1500.00,
    "reference_month": "2026-05",
    "status": "pending"
  }'
```

### 8.3. Recomendações de segurança para a integração

1. **Crie uma Edge Function dedicada** no CRM (ex.: `sync-with-totex`) que encapsula
   a `service_role` do OS — nunca chame a REST do OS direto do frontend do lojista.
2. **Idempotência:** ao reportar métricas, inclua um identificador único no `metadata`
   (ex.: `crm_event_id`) e cheque duplicidade antes de inserir.
3. **Rate limit:** agrupe métricas em lote (1 chamada com array) em vez de 1 por evento.
4. **Webhook reverso (futuro):** se quiser que o OS notifique o CRM quando um lojista
   muda de status (ex.: `suspended`), criaremos uma Edge Function no OS que dispara
   POST pro endpoint do CRM. Combinar URL + secret compartilhado.

---

## 9. Realtime (opcional)

Assinar mudanças em tempo real (ex.: novo lojista cadastrado):

```js
const channel = osClient
  .channel('dealerships-changes')
  .on('postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'dealerships' },
    (payload) => console.log('Novo lojista:', payload.new)
  )
  .subscribe()
```

---

## 10. Tratamento de erros

| HTTP | Significado | Ação |
|------|-------------|------|
| `400` | Payload inválido | Verificar corpo/enum |
| `401` | Sem auth ou token expirado | Renovar JWT / checar apikey |
| `403` | RLS bloqueou | Token sem permissão pra esse recurso |
| `404` | Recurso/rota inexistente | Conferir path |
| `409` | Conflito (PK/unique duplicada) | Usar upsert |
| `5xx` | Erro server / provedor IA | Retry com backoff exponencial |

Corpo de erro PostgREST:
```json
{ "code": "23505", "message": "duplicate key value...", "details": "...", "hint": null }
```

---

## 11. SDK recomendado

```bash
npm install @supabase/supabase-js
```

```ts
import { createClient } from '@supabase/supabase-js'

const os = createClient(
  'https://fbgtqiqovwxccinbzvmx.supabase.co',
  process.env.TOTEX_OS_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
)

// Listar lojistas ativos com plano
const { data, error } = await os
  .from('dealerships')
  .select('id, trade_name, status, dealership_services(price, services(name))')
  .in('status', ['active_shopping', 'active_marketplace'])

// Reportar lead entregue
await os.from('agent_logs').insert({
  agent_name: 'commercial',
  dealership_id: dealershipId,
  action: 'Lead entregue via CRM',
  metadata: { lead_id, score, source: 'totem' },
})
```

---

## 12. Tipos TypeScript

As interfaces completas (Row types) estão em
[`src/types/database.ts`](../src/types/database.ts) e podem ser copiadas direto pro
projeto do CRM, ou regeradas via:

```bash
npx supabase gen types typescript --project-id fbgtqiqovwxccinbzvmx > database.types.ts
```

---

## 13. Checklist para o dev

- [ ] Pegar a `service_role` no Dashboard do OS (Project Settings → API)
- [ ] Guardar como variável de ambiente no backend do CRM (`TOTEX_OS_SERVICE_ROLE_KEY`)
- [ ] Implementar leitura de `dealerships` → criar/mapear tenants no CRM
- [ ] Guardar `dealership.id` como `external_id` em cada tenant
- [ ] Implementar reporte de métricas (`agent_logs` + `financial_records`) com idempotência
- [ ] Agrupar reportes em lote
- [ ] Encapsular a `service_role` em Edge Function do CRM (nunca no frontend)
- [ ] Definir com a equipe do OS o secret compartilhado pro webhook reverso (fase futura)
