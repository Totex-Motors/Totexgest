# Entradas de Leads — Mapa, Problemas e Proposta de Simplificação

> Levantamento feito varrendo o código (2026-10-07): todo lugar que cria um registro
> em `leads` (ou roteia/copia um existente). Base pra decidir **separar por tipo de
> pessoa** e **simplificar as portas** antes de abrir o Totexgest pras franquias.
> Nada aqui altera código — é o mapa com evidência (arquivo:linha).

> **Status da execução**
> - ✅ **Passo 1 (estancar)** — concluído em 2026-10-07 (PR #116 + migration `20261007120000` aplicada).
> - 🔄 **Passo 2 (uma dedupe só)** — backend: função `find_or_create_lead` (migration
>   `20261008120000`) plugada em stand-intake, stand-handoff, marketplace (2 eventos), Credere,
>   receive-lead (lookup), WhatsApp oficial, distribuir-lead e totem (captar-comprador).
>   Frontend (2b): modal manual sem "criar mesmo assim"; checagem de duplicado por sufixo
>   dos 8 dígitos; importação CSV linha a linha pela porta única. (PR #117)
> - 🔄 **Passo 3 (separar por tipo)** — 3a banco: coluna `lead_kind` real (seller/buyer/
>   franchise/contact) + backfill + trigger (migration `20261008130000` — **aplicar via SQL
>   Editor ANTES do merge**; o `apply_migration` do MCP dá timeout em `ALTER TABLE`);
>   3b: todas as portas declaram o tipo; 3c: lista filtra Compradores/Vendedores (franqueado
>   e contato ficam fora), detalhe por tipo, origem legível (`src/lib/leadKind.ts`).
> - 🔄 **SLA humano (Fase 2 da auditoria da jornada do lead)** — horário comercial
>   (`next_business_time`, config `SLA_HORARIO_INICIO/FIM`, `SLA_DIAS_SEMANA`); `capture_handoff`
>   grava `metadata.handoff.due_at`/`escalate_at` e o runner da SLA usa esses prazos (nunca de
>   madrugada); "Chamei/Liguei/Falei" no grupo de handoff (`capture-contact-confirm`, via
>   webhook), ligação atendida (trigger em `call_history`) e botão "Marquei o 1º contato" no
>   card de Captação marcam o 1º contato e param a escalada. Migration `20261008140000`.
> - 🔄 **Franqueados (tela + funil)** — `lead_kind='franchise'` ganhou funil próprio
>   "Recrutamento de Franqueados" (pipeline no HQ, migration `20261009120000`): os triggers
>   que criam deal automaticamente (`_auto_create_deal_for_lead`, `auto_create_deal_for_channel_lead`)
>   desviam franqueado pra esse funil (nunca pro de carro); RPC `franchise_ensure_deal`
>   ("Colocar no funil"); `receive-lead` grava `lead_kind='franchise'` na campanha de franquia
>   e não cria deal no funil de carro. Tela `/comercial/franqueados` (kanban + "Novo franqueado"
>   pela porta única + fora-do-funil); o funil some das abas do Pipeline de carro e da aba
>   "Todas"; detalhe do lead mostra "Perfil do franqueado" no lugar dos cards de comprador.

---

## 0. Duas regras que valem pra TODAS as portas

- **Tenant padrão "fantasma":** `leads.tenant_id` tem `DEFAULT get_tenant_id()`, que cai
  em `00000000-0000-0000-0000-000000000001` quando o JWT não traz `tenant_id`
  (`000_base_schema.sql:57`, `:702-714`). **Todo insert via service-role sem `tenant_id`
  cai nesse tenant** — o lead "some" num lugar que ninguém olha.
- **Triggers pós-insert:**
  - `auto_create_deal_for_channel_lead` — se `source`/`utm_source` ∈ {`credere`,
    `marketplace`, `stand`, `stand_totex`}, cria um deal na 1ª etapa do pipeline padrão
    (`20260823160000_fix_leads_stand_sem_etapa.sql:18-110`). Também dispara no **UPDATE**
    de source → risco de deal duplicado.
  - `trg_intermediation_from_lead` — se `captured_by_member_id` preenchido, cria a
    intermediação (`20260911200000_intermediacao_nucleo.sql:183-201`).
  - `trg_capture_evaluate_lead` — avalia prêmio da captação (`20260911100000:293`).

---

## 1. As 27 portas, agrupadas por TIPO DE PESSOA

Legenda dedupe: **L8** = últimos 8 dígitos · **EX** = telefone exato · **—** = nenhuma por telefone.

### A) Vendedor do carro (captação / intermediação) — 2 portas ✅ as mais saudáveis

| # | Entrada | De onde vem | Insere em | Dedupe | Origem gravada | Tenant | Depois |
|---|---|---|---|---|---|---|---|
| 17 | `create_capture_lead` | Promotora, app `/captacao/novo` (Vender/Trocar) | `20260912120000_consulta_placa.sql:161-175` | L8 no tenant, pega o mais antigo (reconversão por UPDATE) | `source=captacao`, `utm=promotora`, `capture_channel=presencial`, `origin_actor=promotora` | da promotora | `capture_handoff` (especialista + tarefa SLA + deal "Captação —"), intermediação, prêmio |
| 27 | `capture_link_attendance` | Promotora, `/captacao/vincular` | `20261003120000:137-151` (master) | L8 pra achar o lead da loja; idempotente por `distributed_to`; recusa se já tem `origin` | `source=stand-vinculo`, `comprador`, `promoter_*`, `distributed_to` | master na promotora; carimba lead da loja | R$150 via deal ganho na loja |

### B) Comprador de carro — 14 portas ⚠️ onde nascem os duplicados

| # | Entrada | De onde vem | Insere em | Dedupe | Origem gravada | Tenant | Problema |
|---|---|---|---|---|---|---|---|
| 18 | `captar-comprador` | Promotora, totem (Comprar) | `captar-comprador/index.ts:73-88` | **—** no master | `source=utm=totem-compra`, `comprador`, `owner_tenant_id` | da promotora (master) → `distribuir-lead` pra loja | repetir a captação **duplica o master** |
| 26 | `distribuir-lead` | chamado por #6 e #18 | `distribuir-lead/index.ts:64-74` | `ilike %L8` no tenant destino (mais recente) | `source=distribuicao`, `metadata.origin{…}` | a loja | **sobrescreve o metadata** do lead da loja se já existir (`:77`); `distribuicao` não cria deal |
| 3 | marketplace `INTERESSE_VEICULO` | Site/marketplace (form de interesse) | `marketplace-lead-webhook/index.ts:88-128` | **—** (só id externo) | `source=marketplace`, `marketplace_origin` | a loja (`marketplace_store_mappings`) | mesmo cliente em anúncio diferente = **lead novo** |
| 4 | marketplace `NEGOCIO_CAPTADO` | Marketplace "porta única" `/api/deals/intake` | `:320-336` | EX (com 55), janela 90 dias, no tenant do Stand | `source=marketplace`, `utm=canal` (stand_shopping, marketing, site_marketplace, indicacao, lojista_parceiro, prospeccao_franqueado) | **tenant do Stand** (cross-tenant; loja só no metadata) | abre sessão de agente + template Cloud |
| 5 | `credere-webhook` | Simulação de financiamento (Credere) | `credere-webhook/index.ts:116-179` | **—** (só uuid da simulação) | `source=credere`, `qualificacao.origem=credere` | a loja (`credere_store_mappings`) | **cada simulação = lead novo** |
| 6 | `whatsapp-cloud-webhook` | Cliente manda msg no WhatsApp oficial | `whatsapp-cloud-webhook/index.ts:229-241` | `ilike %L8` **em TODOS os tenants**, pega o mais recente | nada em source | **tenant do lead mais recente** com aquele telefone (imprevisível); senão o da instância | cross-tenant; agente V2 pode sobrescrever `source` |
| 7 | `whatsapp-webhook` UAZAPI | Qualquer msg em instância UAZAPI, **inclusive grupo e fromMe** | `whatsapp-webhook/contacts.ts:154-162` | `ilike %L8` no tenant da instância (global se instância sem tenant) | nada | da instância; **…0001** se nulo | **cria lead pra participante de grupo**; fromMe em grupo grava o JID do grupo como telefone (`:244-249`) |
| 8 | `stand-intake` | Atendente menciona o bot no grupo do stand | `stand-intake/index.ts:230-241` | **—** | `utm=stand` (sem source) | tenant do Stand | **cada menção repetida duplica** |
| 9 | `stand-handoff` | Tool `repassar_lead_loja` do agente do stand | `stand-handoff/index.ts:386-402` | EX no tenant da loja | `utm=stand_totex`, `qualificacao.origem=agente-stand` | **a loja** (cross-tenant) | regra diferente do `distribuir-lead`; **não grava `origin`** (perde atribuição) |
| 1 | `receive-lead` | API genérica: formulários, RD Station, Elementor, portais, **franquia** (chave → tenant) | `receive-lead/index.ts:1130-1180` | `find_lead_by_phone_suffix` (L8, **LIMIT 1 sem ORDER BY** = lead arbitrário) + e-mail | `source=payload/utm/api`, `metadata.origin=rdstation\|api` | o da chave | round-robin, notificações, reconversão; se `source` ∈ lista do trigger → **deal duplicado** |
| 2 | `meta-lead-webhook` | Meta Lead Ads | não insere; chama #1 (`:185-203`) | o de #1 | `source="Meta Lead Ads \| form"`, `utm=facebook` | o de #1 | — |
| 11 | `book-meeting` | Página pública `/agendar` | `book-meeting/index.ts:353-371` | chama RPC **`find_lead_by_phone_normalized` que NÃO EXISTE** nas migrations; fallback e-mail global | `utm=webinar_pitch`, `utm_campaign=agendamento_0704` | **…0001** (não passa tenant) | pipeline `WEBINAR` e vendedor `SAMUEL_ID` **hardcoded** (`:398-428`) — legado do template |
| 19 | `CreateLeadOrDealModal` | Usuário do CRM (manual / OCR) | `CreateLeadOrDealModal.tsx:612-626` | `like %L8%` + e-mail — **só avisa, cria mesmo assim** no 2º clique (`:789-801`) | `utm=instagram` por padrão (!); sem `source` | do usuário | duplicado "consentido"; origem padrão errada |
| 23 | `ImportLeadsWizard` (CSV) | Usuário do CRM | `ImportLeadsWizard.tsx:164-169` | EX entre dígitos do CSV e valor gravado | `source=import_csv` | do usuário | máscara / 55 diferente = **não reconhece duplicado** |

### C) Contatos secundários (decisor, sócio, indicação) — 3 portas (criam "lead" que não é lead)

| # | Entrada | Insere em | Dedupe | Observação |
|---|---|---|---|---|
| 20 | `ClientInfoPanel` (Inbox) | `ClientInfoPanel.tsx:240-253` | `ilike %full OR %last9` | copia utm do lead pai |
| 21 | `DealContactsTab` (decisor) | `DealContactsTab.tsx:179-189` | **—** | vira linha em `leads` |
| 22 | `MergeLeadsModal` (sócio/indicação) | `MergeLeadsModal.tsx:194-208` | **—** | `utm=indicacao`, `partner_lead_id` |

### D) Legado do template "IA na Prática" / fora do negócio Totex — 7 portas 🔴 desligar

| # | Entrada | Por que é problema |
|---|---|---|
| 10 | `instagram-webhook` campanha de comentário | grava `phone=""`; dedupe só por username |
| 12 | `whatsapp-task-assistant` `create_lead` | LLM decide; `phone="0000000000"` se faltar; busca **sem tenant**; cai em **…0001** |
| 13 | `agent_create_lead` (tool `criar_lead`) | **sem dedupe**; `source` texto livre do LLM |
| 14 | `chat-manager` `create_leads_from_pain` | busca no tenant do usuário mas **grava em …0001** |
| 15 | trigger em `pain_registrations` | cria deal **produto PAIN R$ 25.000** (`000_base_schema.sql:980-1007`) |
| 16 | `sync-member-data` | membros do PAIN viram "lead" com `phone=""` em **…0001** |
| 24, 25 | `CreateSalesLeadModal`, `InstagramClientInfoPanel` | **código morto** (ninguém monta) e gravam coluna `origin` que **não existe** no schema |

### E) Franqueado / lojista — 0 portas próprias
`lead_kind='franchise'` **nunca é gravado** por nenhuma entrada (tudo nasce `car`). A única
ponta é a campanha de franquia dentro do `receive-lead` (#1, `:1470-1620`).

> **Resolvido (2026-10-09):** 3 portas gravam `franchise` — `receive-lead` (chave de
> campanha de franquia), marketplace (`papel = LOJISTA`) e o cadastro manual em
> `/comercial/franqueados`. Todas caem no funil "Recrutamento de Franqueados" (ver status).

### F) Não criam lead (roteiam/mesclam)
`merge_leads` (mesmo tenant), `repasse_track` (só `repasse_referrals`, UNIQUE tenant+telefone),
agente V2 com `lead_source` (só UPDATE de `source` → dispara trigger de deal), `extract-lead-from-image` (só preenche formulário).

---

## 2. Os problemas sistêmicos (por que duplica e confunde)

1. **9 regras diferentes de duplicidade por telefone** — L8 exato em SQL, `ilike %L8`,
   `like %L8%` (contém), `%last9`, exato, "contém todos os dígitos", sem tenant, com janela de
   90 dias, e uma RPC inexistente. Cada porta decide sozinha → **o mesmo cliente vira 2, 3 leads**.
2. **10+ portas sem nenhuma dedupe por telefone** (#3, #5, #8, #13, #18, #21, #22, #25 e as de
   id externo/e-mail).
3. **O tenant fantasma `…0001`** engole leads de 5 portas (#7 sem tenant, #11, #12, #14, #16).
4. **Cross-tenant imprevisível**: #6 procura em todos os tenants e grava "no tenant do lead
   mais recente"; #26 sobrescreve metadata da loja; #9 não grava atribuição de origem.
5. **Taxonomia de origem caótica**: ~25 valores distintos entre `source` e `utm_source`
   (`captacao`, `totem-compra`, `stand`, `stand_totex`, `stand-vinculo`, `distribuicao`,
   `marketplace`, `credere`, `import_csv`, `pain_registration`, `webinar_pitch`,
   `instagram_comment_campaign`, `Meta Lead Ads | …`, texto livre do LLM…). Umas gravam
   `source`, outras só `utm_source`, outras nada. `lead_kind` nunca é usado.
6. **Trigger de deal por `source`** cria deal duplicado quando o `receive-lead` recebe
   `source` ∈ {credere, marketplace, stand}, e dispara de novo no UPDATE de source.
7. **UAZAPI transforma participante de grupo em lead** — com a regra anti-ban (tudo é
   grupo), isso polui a base com gente que não é cliente.
8. **Legado do template ainda vivo** (PAIN R$25k, webinar com vendedor hardcoded, campanha
   de Instagram) — nada disso é o negócio Totex.

---

## 3. Proposta: separar por TIPO e reduzir 27 portas pra 6

### 3.1 Separar — `lead_kind` obrigatório em toda entrada
| `lead_kind` | Quem é | Funil | Tela |
|---|---|---|---|
| `seller` | quer **vender/trocar** o carro (captação) | Intermediação | "modo captação" (já começou na Fase 1) |
| `buyer` | quer **comprar** (totem, site, WhatsApp da loja, stand, Credere) | Vendas da loja | tela de comprador (veículo de interesse, perfil de compra, financiamento) |
| `franchise` | lojista/franqueado (recrutamento, sala de demo) | Recrutamento de Franqueados (HQ) | própria |
| `contact` | decisor/sócio/indicação (não é lead) | — | só aparece dentro do lead principal |

A tela de detalhe passa a ser decidida por `lead_kind`, não por adivinhação — cada tipo vê
**só** os cards que fazem sentido pra ele.

### 3.2 Simplificar — 6 portas canônicas (e o resto desliga ou vira cliente delas)
| Porta canônica | Absorve | `lead_kind` |
|---|---|---|
| **1. Promotora – Vender/Trocar** (`create_capture_lead`) | mantém | `seller` |
| **2. Promotora – Comprar / Vincular** (`captar-comprador` + `capture_link_attendance`) | adicionar dedupe no master | `buyer` |
| **3. Site / Marketplace / Anúncios** (`receive-lead`) | #2 Meta, #3 e #4 marketplace, #5 Credere passam a usar a mesma dedupe/roteamento | `buyer` |
| **4. WhatsApp da loja** (`whatsapp-cloud-webhook`) | dedupe **dentro do tenant da loja**, nunca global | `buyer` |
| **5. Stand (agente)** (`stand-intake` → `stand-handoff`) | dedupe + gravar `origin` | `buyer` |
| **6. Manual / Importação** (modal do CRM + CSV) | dedupe **bloqueia** (não só avisa); CSV normaliza telefone; origem padrão deixa de ser "instagram" | escolhido pelo usuário |
| + **Franquia** (`receive-lead` campanha + sala de demo) | | `franchise` |

### 3.3 Uma função única de "achar ou criar"
`find_or_create_lead(tenant, phone, lead_kind, source, …)`: normaliza o telefone (55 + DDD +
número), compara **últimos 8 dígitos dentro do tenant**, resultado **determinístico** (ORDER BY),
grava `lead_kind` e `source` da taxonomia. **Todas** as 6 portas chamam ela. Fim das 9 regras.

### 3.4 Uma taxonomia de origem legível
`source` ∈ { `promotora`, `totem`, `site`, `marketplace`, `anuncio`, `whatsapp`, `stand`,
`indicacao`, `manual`, `importacao`, `franquia` }. `utm_*` continua só como detalhe de campanha.
Na tela, origem vira uma palavra que a pessoa comum entende.

### 3.5 Desligar / remover
#10 campanha Instagram, #12 `create_lead` do task-assistant (ou exigir tenant + dedupe),
#13 `agent_create_lead` (dedupe), #14 `create_leads_from_pain`, #15 trigger PAIN, #16
`sync-member-data`, #11 `book-meeting` (reescrever sem vendedor fixo ou desligar), #24/#25
código morto; e **UAZAPI não cria lead de participante de grupo**.

### 3.6 Guarda contra o tenant fantasma
Toda porta exige `tenant_id` resolvido; se não resolver, **rejeita com erro visível** em vez
de cair em `…0001`.

---

## 4. Ordem sugerida de execução
1. **Estancar o sangramento (rápido):** desligar legado/código morto (§3.5), guarda do tenant
   fantasma (§3.6), corrigir a RPC inexistente do `book-meeting`.
2. **Uma dedupe só:** criar `find_or_create_lead` e plugar nas 6 portas canônicas.
3. **Separar de verdade:** `lead_kind` em toda entrada + taxonomia de `source` + telas e
   funis por tipo (estende a Fase 1).
