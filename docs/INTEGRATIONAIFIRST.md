# Integração TotexMotors OS ↔ CRM AI-First

> Guia passo-a-passo para integrar o **TotexMotors OS** com o **CRM AI-First**
> (multi-tenant, baseado no template do programa "IA na Prática").
>
> Pré-requisito: leia antes o [`docs/API.md`](./API.md) — convenções REST,
> autenticação e referência de tabelas do OS.
>
> Versão: 1.0 · Atualizado: 2026-05-28

---

## 1. Topologia (alto nível)

```
┌─────────────────────────────┐                      ┌─────────────────────────────┐
│  TotexMotors OS             │                      │  TotexMotors CRM            │
│  (Supabase A)               │                      │  (Supabase B, multi-tenant) │
│  fbgtqiqovwxccinbzvmx       │                      │  <ref-do-novo-projeto>      │
│                             │                      │                             │
│  Single-tenant interno      │                      │  Tenants:                   │
│  ───────────────────────    │                      │  ─────────────────────────  │
│  • dealerships              │ ──tenant provisioning│  • tenant_totex_master      │
│  • dealership_services      │ ─►(Edge Fn dedicada)─►│  • tenant_quest             │
│  • contracts                │                      │  • tenant_pg_motors         │
│  • financial_records ◄──────│ ──métricas/comissão──│  • tenant_julio             │
│  • agent_logs ◄─────────────│ ──eventos comerciais─│  • tenant_…                 │
│  • support_tickets ◄────────│ ──SLA quebrado───────│                             │
│                             │                      │  Em cada tenant:            │
│  Dashboard CEO consome      │                      │  - leads + deals            │
│  agregado de TODOS tenants  │ ◄─aggregate query────│  - whatsapp_instances       │
│                             │                      │  - ai_sales_agents          │
└─────────────────────────────┘                      └─────────────────────────────┘
       ▲                                                       ▲
       │ Marcos / equipe Totex                                 │ cada lojista loga
       │ admin via Supabase Auth                               │ via Supabase Auth
       │                                                       │ com JWT contendo
       │                                                       │ app_metadata.tenant_id
```

**Princípio de design:** OS é **fonte da verdade** sobre lojistas, planos e
finanças do ecossistema. CRM é **fonte da verdade** sobre leads, deals e
conversas. Sincronização é **bidirecional** mas em direções diferentes:

- **OS → CRM:** registro de lojistas (espelho leve), status, plano contratado
- **CRM → OS:** métricas operacionais (leads recebidos, deals fechados, comissões)

---

## 2. Mapeamento de dados

### 2.1. Lojista (OS) ↔ Tenant (CRM)

| OS — `dealerships` | CRM — `tenants` |
|--------------------|-----------------|
| `id` (uuid) | `external_dealership_id` (uuid, NOVO campo) |
| `trade_name` | `name` |
| `legal_name` | (em `tenants.metadata.legal_name` ou nova coluna) |
| `cnpj` | (em `tenants.metadata.cnpj` ou nova coluna) |
| `status = active_*` | `tenants.is_active = true` |
| `status = suspended/cancelled` | `tenants.is_active = false` |
| `whatsapp` | usado pra `whatsapp_instances.phone_number` inicial |
| `logo_url` | `tenants.metadata.logo_url` |

> O OS **não** guarda o `tenant_id` do CRM. O CRM guarda o `dealership_id` do
> OS (`external_dealership_id`) — relação 1:1. Faça lookup pelo CRM quando
> precisar resolver.

### 2.2. Plano contratado (OS) ↔ Limites do tenant (CRM)

| OS — `dealership_services` + `services` | CRM (sugestão) |
|-----------------------------------------|----------------|
| `services.kind = totem_30` | tenant tem direito a 1 slot de mídia |
| `services.kind = totem_60` | tenant tem direito a 1 slot de mídia |
| `services.kind = marketplace` | tenant tem acesso ao módulo Marketplace |
| `services.kind = credere` | tenant tem módulo Credere habilitado |
| `dealership_services.price` | informativo (cobrança fica no OS) |
| `dealership_services.status = active` | tenant tem acesso completo |
| `dealership_services.status = paused` | tenant em modo somente-leitura |

**Implementação no CRM:** popular `config` table do CRM com chaves tipo
`enabled_modules` e `service_limits` lidas do OS.

### 2.3. Lead (CRM) ↔ Registro contábil (OS)

| CRM — `leads` / `deals` / `ai_agent_chat_events` | OS — `agent_logs` / `financial_records` |
|--------------------------------------------------|-----------------------------------------|
| Lead criado via webhook UAZAPI | `agent_logs.action = "Lead capturado"`, `agent_name = commercial`, `metadata.lead_id` |
| Lead transferido entre tenants | `agent_logs.action = "Lead transferido"`, `metadata = {from_tenant, to_tenant, lead_id}` |
| Deal `is_won = true` (estágio) | `financial_records.type = revenue, category = "Comissão CRM"` |
| Lead sem resposta há > SLA | `support_tickets` (priority=high, agent=commercial) |
| Agente IA respondeu | `agent_logs.action = "Agente IA respondeu"`, `metadata = {tokens, model}` |

### 2.4. Equipe (OS dealership_contacts) ↔ team_members (CRM)

| OS — `dealership_contacts` | CRM — `team_members` |
|----------------------------|----------------------|
| `contact_type = leads` | criar `team_members` com `role = comercial` no tenant do lojista |
| `name`, `email`, `phone`, `whatsapp` | mesmos campos |
| `is_primary = true` | `team_members.is_admin = true` |

---

## 3. Cenários de integração

### Cenário 1 — Lojista ativado no OS → Tenant provisionado no CRM

**Trigger:** `dealerships.status` muda pra `active_shopping` ou `active_marketplace`.

**Fluxo:**

```
1. OS: status change detectado
   └─► dispara Edge Function `provision-tenant` no OS
2. OS Edge Fn busca dados do dealership + dealership_services + dealership_contacts
3. OS Edge Fn chama Edge Fn no CRM (machine-to-machine, secret compartilhado):
   POST <CRM_URL>/functions/v1/provision-tenant
   Body: {
     external_dealership_id, trade_name, legal_name, cnpj,
     whatsapp_number, logo_url,
     plan: { totem_60: true, marketplace_pro: true, credere: false },
     team: [{ name, email, phone, role: 'admin' }]
   }
4. CRM Edge Fn cria:
   - 1 record em `tenants` (is_active=true)
   - 1 user em auth.users com app_metadata.tenant_id setado
   - 1 record em `team_members` linkado ao user
   - 1 record em `ai_sales_agents` com system_prompt template inicial
   - 1 record em `config` (enabled_modules)
5. CRM responde: { tenant_id, invite_url }
6. OS guarda invite_url temporariamente (não persiste o tenant_id)
7. OS dispara e-mail/WhatsApp pro contato com invite_url
8. OS registra em agent_logs: "Tenant provisionado", metadata = { tenant_id, invite_url }
```

**Idempotência:** o CRM rejeita se já existir tenant com mesmo `external_dealership_id`. Retorna 409 + tenant existente.

### Cenário 2 — Lead chega no totem (B2C)

**Pré-requisito:** UAZAPI conectado a 1 número WhatsApp da TotexMotors central, vinculado ao `tenant_totex_master`.

```
1. Cliente interage no totem → totem chama API do CRM (Edge Fn `webhook-totem`)
   POST <CRM_URL>/functions/v1/webhook-totem
   Body: {
     fingerprint, name?, phone, vehicle_interest?, source: 'totem_tambore'
   }
2. CRM Edge Fn:
   - busca/cria lead em leads (tenant=tenant_totex_master)
   - sales_score inicial via calculate-lead-score (Claude analisa contexto)
   - dispara mensagem WhatsApp inicial via UAZAPI (Agente IA "Carla")
   - cria ai_agent_conversation
3. Cliente responde no WhatsApp:
   - whatsapp-webhook recebe
   - trigger enqueue_message_for_ai_agent → ai_agent_message_queue
   - cron processa fila → ai-sales-agent (Claude/Gemini) responde
4. (opcional) CRM Edge Fn `sync-lead-to-os` chama OS:
   POST <OS_URL>/functions/v1/log-crm-event
   Body: { event: 'lead_captured', dealership_id: null, lead_id, score, source }
```

### Cenário 3 — Lead qualificado é transferido pra um lojista

**Trigger:** lead atinge `sales_score >= 70` E `vehicle_interest` mapeia pra um lojista (regra de match — fase 1 manual, fase 2 automática).

```
1. Operador OS (ou regra automática) escolhe target_dealership_id
2. OS Edge Fn `assign-lead-to-dealership` chama CRM:
   POST <CRM_URL>/functions/v1/transfer-lead
   Body: { lead_id, from_tenant: tenant_totex_master, to_tenant: <tenant_da_loja> }
3. CRM Edge Fn:
   - clona lead na tabela leads do tenant destino (mantém phone, name, interest, score)
   - move ai_agent_conversation referenciando o novo lead_id
   - notifica lojista via WhatsApp dele: "Você recebeu 1 lead novo"
   - cria activity em company_activities (lead_transferred)
4. OS recebe resposta com novo_lead_id e registra:
   agent_logs: action="Lead atribuído", dealership_id=X,
   metadata={from_lead_id, to_lead_id, score}
```

### Cenário 4 — Deal fechado no CRM → receita no OS

**Trigger:** estágio do deal muda pra um com `is_won = true`.

```
1. Vendedor do lojista move deal pra estágio "Fechado/Ganho"
2. Trigger SQL em sales_pipeline_stage_changes (ou Edge Fn `on-deal-won`)
3. CRM chama OS:
   POST <OS_URL>/functions/v1/log-crm-event
   Body: {
     event: 'deal_won',
     dealership_id: <external_id>,
     deal_id, value, commission_value,
     lead_id, closed_at
   }
4. OS:
   - insere em financial_records: type=revenue, category='Comissão CRM',
     amount=<commission_value>, dealership_id=X, status=pending
   - insere em agent_logs: agent=financial, action="Deal fechado", metadata={...}
5. Dashboard CEO no OS reflete automaticamente.
```

### Cenário 5 — Lojista suspende serviço no OS

**Trigger:** `dealerships.status` muda pra `suspended`, `cancelled` ou `overdue`.

```
1. OS detecta mudança de status
2. OS Edge Fn `update-tenant-status` chama CRM:
   POST <CRM_URL>/functions/v1/update-tenant
   Body: { external_dealership_id, action: 'suspend'|'cancel'|'reactivate' }
3. CRM:
   - 'suspend' → tenants.is_active = false (login bloqueado, dados preservados)
   - 'cancel' → tenants.is_active = false + agenda hard-delete em 90 dias
   - 'reactivate' → tenants.is_active = true
4. CRM retorna OK; OS registra em agent_logs.
```

---

## 4. Alterações de schema necessárias

### 4.1. No CRM (AI-First) — adicionar

```sql
-- Liga tenant a registro de lojista no OS
alter table public.tenants
  add column external_dealership_id uuid unique,
  add column external_source text default 'totex_os',
  add column metadata jsonb default '{}'::jsonb;

create index tenants_external_dealership_idx
  on public.tenants(external_dealership_id);

-- Coluna pra rastrear origem do lead (totem, marketplace, lojista direto)
alter table public.leads
  add column external_source_id text,
  add column transferred_from_tenant uuid;

-- Tabela de eventos sincronizados com o OS (auditoria + idempotência)
create table public.os_sync_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,        -- 'tenant_provisioned' | 'lead_transferred' | etc
  tenant_id uuid references public.tenants(id),
  external_event_id text unique,   -- idempotência
  payload jsonb not null,
  status text default 'sent',      -- 'sent' | 'failed' | 'retry'
  attempts int default 1,
  last_error text,
  created_at timestamptz default now()
);
```

### 4.2. No OS (TotexMotors) — adicionar

```sql
-- Tabela espelho leve dos tenants criados (cache)
create table public.crm_tenants (
  id uuid primary key default gen_random_uuid(),
  dealership_id uuid unique references public.dealerships(id) on delete cascade,
  crm_tenant_id uuid not null,
  crm_user_id uuid,
  invite_url text,
  is_active boolean default true,
  provisioned_at timestamptz default now(),
  last_synced_at timestamptz
);

-- Webhook secrets (chave compartilhada com o CRM)
create table public.integration_secrets (
  key text primary key,
  value text not null,
  created_at timestamptz default now()
);

-- Eventos recebidos do CRM (idempotência + auditoria)
create table public.crm_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,           -- 'deal_won' | 'lead_captured' | etc
  dealership_id uuid references public.dealerships(id),
  external_event_id text unique,
  payload jsonb not null,
  processed_at timestamptz,
  created_at timestamptz default now()
);
```

---

## 5. Autenticação & secrets

### 5.1. Princípios

1. **Nunca expor `service_role` no frontend** de nenhum dos dois lados.
2. **Toda chamada machine-to-machine** entre OS e CRM usa **shared secret**
   (gerado uma vez, guardado nas duas pontas como env var).
3. **Edge Functions são o único canal** de comunicação cross-projeto.
4. **JWT de usuário** só pra fluxos onde o usuário está logado (CRM tem RLS por tenant).

### 5.2. Secrets a configurar

**No OS (Supabase → Edge Functions → Secrets):**

| Nome | Valor | Uso |
|------|-------|-----|
| `CRM_API_URL` | `https://<crm-ref>.supabase.co/functions/v1` | URL base do CRM |
| `CRM_WEBHOOK_SECRET` | string aleatória 64 chars | autentica chamadas OS → CRM |
| `INCOMING_CRM_SECRET` | string aleatória 64 chars | valida chamadas CRM → OS |

**No CRM (Supabase → Edge Functions → Secrets):**

| Nome | Valor | Uso |
|------|-------|-----|
| `OS_API_URL` | `https://fbgtqiqovwxccinbzvmx.supabase.co/functions/v1` | URL base do OS |
| `OS_WEBHOOK_SECRET` | mesmo valor de `INCOMING_CRM_SECRET` do OS | autentica chamadas CRM → OS |
| `INCOMING_OS_SECRET` | mesmo valor de `CRM_WEBHOOK_SECRET` do OS | valida chamadas OS → CRM |

### 5.3. Validação do shared secret nas Edge Functions

```ts
// padrão a usar em TODAS as Edge Fns que recebem chamada da outra ponta
const SHARED_SECRET = Deno.env.get('INCOMING_OS_SECRET') ?? Deno.env.get('INCOMING_CRM_SECRET')!

Deno.serve(async (req) => {
  const provided = req.headers.get('x-integration-secret')
  if (provided !== SHARED_SECRET) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
  }
  // ... lógica
})
```

E pra disparar:

```ts
const res = await fetch(`${Deno.env.get('CRM_API_URL')}/provision-tenant`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-integration-secret': Deno.env.get('CRM_WEBHOOK_SECRET')!,
  },
  body: JSON.stringify(payload),
})
```

---

## 6. Edge Functions a criar

### 6.1. No OS

| Função | Trigger | O que faz |
|--------|---------|-----------|
| `provision-tenant` | Status change em dealerships (via DB trigger ou cron) | Coleta dados + chama `<CRM>/provision-tenant` |
| `assign-lead-to-dealership` | UI / regra automática | Chama `<CRM>/transfer-lead` |
| `update-tenant-status` | Status change em dealerships | Chama `<CRM>/update-tenant` |
| `log-crm-event` | **Recebe** webhooks do CRM | Valida secret, insere em `crm_events`, dispara handler (financial_records, agent_logs, etc.) |
| `crm-aggregate-stats` | Cron diário | Busca métricas no CRM via service_role e atualiza snapshot no Dashboard CEO |

### 6.2. No CRM

| Função | Trigger | O que faz |
|--------|---------|-----------|
| `provision-tenant` | **Recebe** chamada do OS | Cria tenant, user, team_member, ai_sales_agent inicial |
| `webhook-totem` | Chamada pública do totem | Cria/atualiza lead no tenant_totex_master, dispara Agente IA |
| `transfer-lead` | **Recebe** chamada do OS | Clona lead entre tenants, notifica lojista |
| `update-tenant` | **Recebe** chamada do OS | Ativa/suspende/cancela tenant |
| `on-deal-won` | DB trigger em deals (is_won) | Chama `<OS>/log-crm-event` com `event=deal_won` |
| `on-lead-sla-broken` | Cron horário | Detecta leads sem resposta há > SLA, chama OS pra abrir ticket |

---

## 7. Roadmap de implementação

| Fase | Duração | Entregáveis |
|------|---------|-------------|
| **0 — Setup CRM** | 1 dia | Criar projeto Supabase, rodar `cleanup_unused_tables.sql` + 27 migrations, deploy das 53 Edge Functions, secrets configuradas |
| **1 — Schema delta** | 1 dia | Aplicar `4.1` no CRM e `4.2` no OS. Gerar secrets compartilhados. |
| **2 — Provisioning** | 2 dias | Implementar `provision-tenant` em ambas as pontas + UI no OS pra disparar manualmente |
| **3 — Totem → CRM** | 3 dias | UAZAPI conectado ao número TotexMotors central, `webhook-totem`, system prompt do Agente IA "Carla" |
| **4 — Lead routing** | 2 dias | `assign-lead-to-dealership` + `transfer-lead`, fase 1 manual via UI |
| **5 — Reporting reverso** | 2 dias | `on-deal-won`, `log-crm-event`, registrar receitas no OS |
| **6 — Piloto Quest** | 5 dias | Provisionar `tenant_quest`, conectar WhatsApp do lojista, treinar, monitorar |
| **7 — Dashboard agregado** | 2 dias | `crm-aggregate-stats` no OS + KPIs novos no Dashboard CEO (leads gerados, deals fechados, conversão) |
| **8 — Escalar Cat A** | contínuo | Onboarding dos demais lojistas |

**Total fase 0-7:** ~3 semanas até primeiro lojista no ar.

---

## 8. Exemplo end-to-end — provisionar tenant

### 8.1. Edge Function no OS: `provision-tenant`

```ts
// supabase/functions/provision-tenant/index.ts
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRM_URL = Deno.env.get('CRM_API_URL')!
const CRM_SECRET = Deno.env.get('CRM_WEBHOOK_SECRET')!

Deno.serve(async (req) => {
  const { dealership_id } = await req.json()
  const supa = createClient(SUPABASE_URL, SERVICE_ROLE)

  // 1. Carrega dados do lojista
  const { data: dealer } = await supa
    .from('dealerships')
    .select(`
      id, trade_name, legal_name, cnpj, whatsapp, logo_url,
      dealership_services(price, status, services(name, kind)),
      dealership_contacts(name, email, phone, contact_type, is_primary)
    `)
    .eq('id', dealership_id)
    .single()

  if (!dealer) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })

  // 2. Monta payload pro CRM
  const plan = {
    totem_60: dealer.dealership_services?.some((ds) =>
      ds.services?.kind === 'totem_60' && ds.status === 'active'),
    marketplace: dealer.dealership_services?.some((ds) =>
      ds.services?.kind === 'marketplace' && ds.status === 'active'),
    credere: dealer.dealership_services?.some((ds) =>
      ds.services?.kind === 'credere' && ds.status === 'active'),
  }

  const primaryLead = dealer.dealership_contacts?.find(
    (c) => c.is_primary && c.contact_type === 'leads')

  // 3. Chama CRM
  const res = await fetch(`${CRM_URL}/provision-tenant`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-integration-secret': CRM_SECRET },
    body: JSON.stringify({
      external_dealership_id: dealer.id,
      trade_name: dealer.trade_name,
      legal_name: dealer.legal_name,
      cnpj: dealer.cnpj,
      whatsapp: dealer.whatsapp,
      logo_url: dealer.logo_url,
      plan,
      primary_contact: primaryLead && {
        name: primaryLead.name,
        email: primaryLead.email,
        phone: primaryLead.phone,
      },
    }),
  })

  const body = await res.json()
  if (!res.ok) return new Response(JSON.stringify(body), { status: res.status })

  // 4. Guarda referência no OS
  await supa.from('crm_tenants').upsert({
    dealership_id: dealer.id,
    crm_tenant_id: body.tenant_id,
    crm_user_id: body.user_id,
    invite_url: body.invite_url,
  })

  await supa.from('agent_logs').insert({
    agent_name: 'onboarding',
    dealership_id: dealer.id,
    action: 'Tenant CRM provisionado',
    result: `tenant ${body.tenant_id}`,
    metadata: { invite_url: body.invite_url },
  })

  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  })
})
```

### 8.2. Edge Function no CRM: `provision-tenant`

```ts
// supabase/functions/provision-tenant/index.ts
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const OS_SECRET = Deno.env.get('INCOMING_OS_SECRET')!

Deno.serve(async (req) => {
  if (req.headers.get('x-integration-secret') !== OS_SECRET) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
  }

  const payload = await req.json()
  const supa = createClient(SUPABASE_URL, SERVICE_ROLE)

  // Idempotência
  const { data: existing } = await supa
    .from('tenants')
    .select('id')
    .eq('external_dealership_id', payload.external_dealership_id)
    .maybeSingle()
  if (existing) {
    return new Response(JSON.stringify({
      tenant_id: existing.id, conflict: true,
    }), { status: 409 })
  }

  // 1. Cria tenant
  const { data: tenant } = await supa.from('tenants').insert({
    name: payload.trade_name,
    slug: payload.trade_name.toLowerCase().replace(/\s+/g, '-'),
    external_dealership_id: payload.external_dealership_id,
    metadata: {
      legal_name: payload.legal_name,
      cnpj: payload.cnpj,
      logo_url: payload.logo_url,
    },
  }).select('id').single()

  // 2. Cria usuário primário via Auth admin API
  let userId: string | null = null
  let inviteUrl: string | null = null
  if (payload.primary_contact?.email) {
    const { data: invite } = await supa.auth.admin.inviteUserByEmail(
      payload.primary_contact.email,
      {
        data: { name: payload.primary_contact.name },
        redirectTo: `${Deno.env.get('CRM_APP_URL')}/auth/callback`,
      },
    )
    userId = invite.user?.id ?? null
    inviteUrl = (invite as any).properties?.action_link ?? null

    if (userId) {
      // Seta tenant_id no app_metadata
      await supa.auth.admin.updateUserById(userId, {
        app_metadata: { tenant_id: tenant!.id, role: 'admin' },
      })

      // Cria team_member
      await supa.from('team_members').insert({
        tenant_id: tenant!.id,
        user_id: userId,
        name: payload.primary_contact.name,
        email: payload.primary_contact.email,
        phone: payload.primary_contact.phone,
        role: 'admin',
      })
    }
  }

  // 3. Cria pipeline default + estágios
  const { data: pipeline } = await supa.from('sales_pipelines').insert({
    tenant_id: tenant!.id,
    name: 'Pipeline padrão',
    is_default: true,
  }).select('id').single()

  await supa.from('sales_pipeline_stages').insert([
    { tenant_id: tenant!.id, pipeline_id: pipeline!.id, name: 'Novo Lead', position: 0 },
    { tenant_id: tenant!.id, pipeline_id: pipeline!.id, name: 'Em Qualificação', position: 1 },
    { tenant_id: tenant!.id, pipeline_id: pipeline!.id, name: 'Reunião Agendada', position: 2 },
    { tenant_id: tenant!.id, pipeline_id: pipeline!.id, name: 'Proposta Enviada', position: 3 },
    { tenant_id: tenant!.id, pipeline_id: pipeline!.id, name: 'Ganho', position: 4, is_won: true },
    { tenant_id: tenant!.id, pipeline_id: pipeline!.id, name: 'Perdido', position: 5, is_lost: true },
  ])

  // 4. Cria agente IA default
  await supa.from('ai_sales_agents').insert({
    tenant_id: tenant!.id,
    name: `Vendedor IA — ${payload.trade_name}`,
    system_prompt: `Você é o assistente comercial da ${payload.trade_name}. Atenda leads no WhatsApp com cortesia, qualifique interesse em veículos, agende test drive.`,
    is_active: true,
    settings: {
      debounce_seconds: 30,
      horario_inicio: '08:00',
      horario_fim: '20:00',
      max_messages_per_day: 50,
    },
  })

  // 5. Habilita módulos por plano
  if (payload.plan?.credere) {
    await supa.from('config').upsert({
      tenant_id: tenant!.id,
      key: 'enabled_modules.credere',
      value: 'true',
    })
  }

  return new Response(JSON.stringify({
    tenant_id: tenant!.id,
    user_id: userId,
    invite_url: inviteUrl,
  }), { headers: { 'content-type': 'application/json' } })
})
```

---

## 9. Testes recomendados

### 9.1. Smoke test pós-deploy

```bash
# Variáveis
OS_URL=https://fbgtqiqovwxccinbzvmx.supabase.co
CRM_URL=https://<crm-ref>.supabase.co
SECRET=<shared-secret>

# 1. Provisiona tenant fake
curl -X POST $OS_URL/functions/v1/provision-tenant \
  -H "Authorization: Bearer $OS_SERVICE_ROLE" \
  -H "Content-Type: application/json" \
  -d '{"dealership_id":"<uuid-de-um-lojista-real>"}'

# 2. Verifica no CRM
curl "$CRM_URL/rest/v1/tenants?external_dealership_id=eq.<uuid>" \
  -H "apikey: $CRM_SERVICE_ROLE" -H "Authorization: Bearer $CRM_SERVICE_ROLE"

# 3. Lojista loga via invite_url, acessa /comercial/pipeline

# 4. Simula lead via webhook-totem
curl -X POST $CRM_URL/functions/v1/webhook-totem \
  -H "Content-Type: application/json" \
  -d '{"fingerprint":"test","name":"Cliente Teste","phone":"+5511999999999","vehicle_interest":"SUV"}'

# 5. Verifica no OS que log foi gravado
curl "$OS_URL/rest/v1/agent_logs?action=eq.Lead+capturado&order=created_at.desc&limit=1" \
  -H "apikey: $OS_SERVICE_ROLE" -H "Authorization: Bearer $OS_SERVICE_ROLE"
```

### 9.2. Cenários a cobrir (E2E)

1. ✅ Provisionar tenant pra lojista novo
2. ✅ Re-provisionar (deve retornar 409 e tenant existente)
3. ✅ Suspender tenant via mudança de status no OS
4. ✅ Reativar tenant
5. ✅ Lead chega no totem, Agente IA responde, lead vira deal
6. ✅ Deal ganho → receita aparece no OS
7. ✅ Transferir lead entre tenants
8. ✅ Tenant sem plano Credere não consegue acessar módulo Credere
9. ✅ Tentativa de chamar Edge Fn sem secret = 401
10. ✅ Idempotência: 2 webhooks do mesmo deal_won não duplicam receita

---

## 10. Operação & monitoramento

### 10.1. Métricas a acompanhar (diariamente)

| Métrica | Onde olhar | Alerta |
|---------|-----------|--------|
| Eventos de sync com falha | `os_sync_events.status = 'failed'` (CRM) | > 5 falhas/dia |
| Eventos OS pendentes de processar | `crm_events.processed_at IS NULL` (OS) | qualquer pendente > 1h |
| Tenants sem `external_dealership_id` | query | sempre 0 esperado |
| Leads do totem sem resposta > 1h | dashboard CRM | > 3 leads |
| Tokens consumidos por LLM | `ai_agent_chat_events.metadata.tokens` | alertar > limite |

### 10.2. Runbook de incidentes

- **CRM down:** OS continua funcionando, eventos vão pra `crm_events` na CRM
  (após CRM voltar, reprocessa). Mas `provision-tenant` falha — operador
  retenta via UI.
- **OS down:** CRM continua funcionando, mas `on-deal-won` falha ao reportar
  receita. Eventos ficam em `os_sync_events.status = 'failed'`, cron retry com
  backoff exponencial.
- **Secret vazado:** invalida secret no Supabase, gera novo, atualiza em ambas
  as pontas, audita `os_sync_events` / `crm_events` recentes.

---

## 11. Checklist final do dev

### Setup
- [ ] Projeto Supabase do CRM criado em `sa-east-1`
- [ ] `cleanup_unused_tables.sql` rodado antes das migrations
- [ ] 27 migrations aplicadas na ordem
- [ ] 53 Edge Functions deployadas (com `--no-verify-jwt` nos webhooks UAZAPI)
- [ ] Secrets configuradas (ANTHROPIC, GEMINI, OPENAI, UAZAPI, OS_*, INCOMING_OS_SECRET)
- [ ] Shared secret gerado e configurado nas DUAS pontas
- [ ] `4.1` (delta no CRM) e `4.2` (delta no OS) aplicados

### Edge Functions
- [ ] `provision-tenant` em ambas pontas + testado E2E
- [ ] `webhook-totem` no CRM + UAZAPI vinculada ao tenant master
- [ ] `transfer-lead` no CRM + UI de gatilho no OS
- [ ] `on-deal-won` no CRM + `log-crm-event` no OS
- [ ] `update-tenant` no CRM + `update-tenant-status` no OS
- [ ] `crm-aggregate-stats` no OS (cron diário)

### Frontend
- [ ] Botão "Provisionar no CRM" na página /lojistas/:id do OS
- [ ] Status do tenant CRM visível no card do lojista
- [ ] Link "Abrir CRM do lojista" (deep link com SSO ou login dele)
- [ ] Dashboard CEO mostrando KPIs agregados do CRM

### Segurança & qualidade
- [ ] `service_role` apenas em backend
- [ ] Todas as Edge Fns que recebem chamada externa validam secret
- [ ] Idempotência via `external_event_id` em todos os flows
- [ ] LGPD: política de retenção/deleção combinada com lojistas
- [ ] Logs estruturados em `os_sync_events` e `crm_events`

---

**Próximo passo:** validar este desenho com o time, criar projeto CRM no
Supabase, e arrancar pela Fase 0.

Dúvidas técnicas → me chama (Claude) com prints/logs específicos.
