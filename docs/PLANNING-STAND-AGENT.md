# PLANNING — Agente do Stand (Totem → IA → Loja dona)

> Status: **em andamento — pivô pra WhatsApp Cloud API**. Documento-fonte da feature.
> Modelo de negócio: a Totex tem stands físicos com totens. Atendentes captam o
> telefone do cliente e hoje repassam manualmente num grupo de WhatsApp. Este agente
> automatiza: captura → qualificação por IA → resumo no grupo → repasse pra loja dona
> do carro (aviso por WhatsApp + lead no CRM da loja).

---

## 0. ESTADO ATUAL (leia primeiro)

Ambiente: projeto Supabase **Totexgest** (ref `mztfyavuclqzivywkaeu`), linkado via CLI.
Tenant do stand: **Totex Motors (super-admin)** `c13681e3-5db9-48d1-9c5c-856e6041d77f`.

### ✅ Feito e deployado
- Migrations: `20260620000_tenant_lead_destinations`, `20260620001_stand_agent_seed`,
  `20260620002_whatsapp_cloud_provider` (todas aplicadas).
- Edge fns no ar: `stand-intake`, `stand-handoff`, `admin-tenants`, `whatsapp-webhook`,
  `whatsapp-cloud-webhook`, `agent-runner`.
- Agente V2 **`agente-stand`** criado (tenant c13681e3, model `claude-sonnet-4-6`,
  credencial anthropic linkada) com tools `repassar_lead_loja`, `qualify_lead`, `current_time_br`.
- UI: seção **Super Admin → Destinos de Lead** (`StandHandoffSection` + `useStandHandoff`).
- UI: provider **WhatsApp Cloud API** nos Credenciais V2 + campo **Verify Token** em API Keys.
- **Bugs corrigidos** (deployados): webhook UAZAPI nascia desligado (`enabled:true`);
  webhook não setava `tenant_id` nos inserts (FK falhava → nada salvava — afetava TODO o
  WhatsApp); providers anthropic/openai do agent-runner ignoravam a credencial (liam só do
  env) → agora leem `credential.auth_data.api_key`; key Anthropic errada em
  `tenant_integration_keys`; modelo inexistente na stand-intake.
- **E2E do intake validado na lógica** (lead+sessão+saudação gerada), mas o **envio UAZAPI
  falhou por desconexão/ban** do número.

### ⛔ Por que pivotamos
UAZAPI é cliente **não-oficial**. Número novo + abertura fria automática → o WhatsApp
**bane/desconecta** (`401: logged out from another device`, `session is not reconnectable`).
Decisão do João: ir pra **WhatsApp Cloud API (oficial Meta)**.

---

## 1. Fluxo alvo (com Cloud API)

```
Atendente marca @agente no grupo do stand:
"@agente Kevin (11961828095), interesse na BMW Z4, loja Quest"
   │  (o grupo ainda é via instância UAZAPI — só o canal DO CLIENTE muda pra Cloud)
   ▼
[stand-intake] IA extrai {nome, telefone, carro, loja} → casa loja (tenant_lead_destinations)
   │  cria lead no tenant do STAND + agents_session (working_memory)
   │  ENVIA A ABERTURA via Cloud API → send-whatsapp-cloud (send_template) [template aprovado]
   │  confirma no grupo
   ▼
Cliente responde → whatsapp-cloud-webhook → (NOVO) roteia pro agente V2 (agent-runner)
   │  janela de 24h aberta → agente conversa LIVRE e qualifica
   ▼
tool repassar_lead_loja (stand-handoff): resumo no grupo + aviso à loja + lead no CRM da loja
```

> Nota: o **gatilho** (menção no grupo do stand) continua chegando pela instância UAZAPI
> "IA Stand" — isso é interno e não fala com clientes, risco de ban baixo. O que muda pra
> Cloud é a **conversa com o cliente** (abertura + recebimento). Avaliar se o grupo do stand
> também migra; por ora pode seguir no UAZAPI.

---

## 2. Decisões tomadas (João)
- Destinos de lead geridos **só pelo super-admin**; v1 = **número individual**.
- Lead qualificado **entra no CRM da loja** (não só aviso).
- Matching de loja **por IA** com a lista cadastrada.
- Canal do cliente: **WhatsApp Cloud API** (oficial), por causa do ban no UAZAPI.
- Credencial Cloud aparece nos Credenciais V2 **e** em API Keys (mas o código lê das **API Keys**).

---

## 3. Fatos importantes do Cloud API
- **1 número = 1 mundo**: ao migrar pra Cloud, o número sai do app/WhatsApp Web → UAZAPI não
  conecta mais nele. Não existe híbrido no mesmo número. Logo, sem custo duplo.
- **Enviar**: basta `WHATSAPP_CLOUD_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID` (token PERMANENTE/System User).
- **Receber**: precisa de **verify token** (no painel Meta + em Config>API Keys), **assinar o
  webhook** (campo `messages`), e uma **linha de "instância oficial"** em `whatsapp_instances`
  com `metadata.phone_number_id` = PN ID.
- **Abertura fria**: exige **template aprovado** (ex: `primeiro_contato_qualificacao`).
- Conversa dentro da janela de 24h após o cliente responder = **grátis** e texto livre.
- Não precisa de App Secret (código não valida assinatura) nem WABA ID em runtime.

---

## 4. O QUE FALTA (próximo chat — fiação Cloud p/ o stand V2)

### T1. Instância oficial Cloud ✅ FEITO (migration aplicada)
`20260620003_stand_cloud_instance.sql`: linha `IAP - OFICIAL` (id `dc078726-dc53-4d16-8417-75c7e7ceb284`),
tenant c13681e3, status connected, `metadata.provider=whatsapp_cloud`,
`metadata.phone_number_id='__REPLACE_WITH_PHONE_NUMBER_ID__'` (placeholder). Nome bate com o
fallback `getOfficialInstance` → roteia mesmo antes do PN ID. **Falta**: UPDATE do
`phone_number_id` com o PN ID real (SQL comentado no fim da migration).

### T2. Recebimento Cloud → agente V2 ✅ FEITO (código local, não deployado)
Criado `whatsapp-cloud-webhook/agent-platform.ts` (`tryHandleViaAgentPlatformCloud`),
espelho do UAZAPI mas enviando via edge fn `send-whatsapp-cloud` (action send_text).
`index.ts`: instância agora traz `tenant_id`; `handleIncomingMessage` recebe `tenantId`,
escopa busca/criação de lead por tenant + seta `tenant_id` explícito nos inserts de
lead e whatsapp_messages (mesmo fix de FK do UAZAPI), e chama o roteador V2 ANTES do
enqueue legado (`ai_sales_agents`). Gated por `agent_platform_v2_enabled`. `deno check`
limpo no agent-platform.ts. FALTA: deploy (`whatsapp-cloud-webhook`) + criar a instância
oficial (T1) com `metadata.phone_number_id` pra rotear.

### T3. Abertura por template na stand-intake ✅ FEITO (deployado)
`stand-intake` agora envia a 1ª mensagem ao CLIENTE via `send-whatsapp-cloud`
(`action: send_template`, default `primeiro_contato_qualificacao`, param[0]=nome;
override por `config.stand_agent_config.stand_template_name`). Removido o kickoff via
agent-runner + envio UAZAPI ao cliente (abertura fria no Cloud não aceita texto livre).
A confirmação no grupo reflete se a abertura foi enviada. `runAgentKickoff` removida.
**stand-handoff NÃO mudou (decisão)**: grupo + aviso à loja seguem via UAZAPI (instância
"IA Stand", número interno/parceiro ≠ número Cloud) — risco de ban baixo (B2B), e Cloud
exigiria 2º template + opt-in da loja sem ganho. O ban foi por abertura fria ao consumidor,
que migrou pro Cloud.
**FALTA (lado Meta)**: criar+aprovar o template (T4) e cadastrar a linha em
`whatsapp_templates` (usada por buildTemplateText pra logar o texto enviado).

### T4. Template
Criar e aprovar na Meta o template de abertura (ex: `primeiro_contato_qualificacao`) com
variáveis. Cadastrar o nome usado no código.

### T5 (opcional). Fonte única de credencial
Se quiser que o Cloud leia da **credencial V2** (`whatsapp_cloud`) em vez das API Keys,
refatorar `send-whatsapp-cloud` + `whatsapp-cloud-webhook`. Hoje leem de config/tenant keys.

---

## 5. O que o João precisa providenciar (lado Meta)
1. Conta Meta Business + verificação do negócio (limites).
2. App no Meta for Developers com produto WhatsApp.
3. **Número dedicado** ao Cloud (não pode estar ativo no app normal).
4. **Phone Number ID**, **token permanente (System User)**, **verify token** (inventado).
5. **Template de abertura aprovado**.
6. Preencher em **Config → Integrações → API Keys**: `WHATSAPP_CLOUD_TOKEN`,
   `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_CLOUD_VERIFY_TOKEN`.
7. No painel Meta: webhook → `https://mztfyavuclqzivywkaeu.supabase.co/functions/v1/whatsapp-cloud-webhook`,
   verify token igual, assinar `messages`.

---

## 6. IDs / referências úteis
- Projeto: `mztfyavuclqzivywkaeu` (Totexgest).
- Tenant stand: `c13681e3-5db9-48d1-9c5c-856e6041d77f` (Totex Motors super-admin).
- Agente: slug `agente-stand`.
- Config keys: `stand_agent_config` (enabled/stand_tenant_id/stand_instance_id/stand_group_jids/
  stand_agent_slug), `agent_platform_v2_enabled`.
- Instância UAZAPI atual (gatilho do grupo): "IA Stand" `eb8199e5-3bc6-416f-9953-038ef04175cd`
  (caiu por ban; serve só pro grupo interno, reconectar se for usar o gatilho por menção).
- Grupo do stand (teste): JID `120363409978788662@g.us` (em `stand_agent_config.stand_group_jids`).
- Skill handoff: `repassar_lead_loja` → edge fn `stand-handoff`.

---

## 7. Pendências fora do stand (descobertas no caminho)
- Bot "Carol" (`whatsapp-task-assistant`) usa o mesmo modelo inexistente
  `claude-sonnet-4-20250514` → trocar p/ `claude-sonnet-4-6` (chip de task criado).
- João deve **reconferir a chave Anthropic** em Config>API Keys (estava colada errada;
  corrigida no banco a partir da credencial).
