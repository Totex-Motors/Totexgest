# Integração Autoconf × Totex Motors

**Contexto (09/11/2026, corrigido pelo Marco no mesmo dia).** O Autoconf é o ERP/CRM das lojas. O app
"Totex Motors" entra no marketplace de apps do Autoconf. Lojista que ativa o app tem o **estoque
publicado** no marketplace totexmotors.com, nos totens do stand dos shoppings e no atendimento da Nina,
e **os leads caem direto no CRM do Autoconf** da loja. O lojista Autoconf **não** usa o Totexgest
(não ganha tenant nem convite). Objetivo da Totex: vender franquias e atender os clientes do Autoconf.

Especificação pública (enviada pro time do Autoconf): artifact "Integração Autoconf Totex" (link
no chat com o Marco) e o próprio `GET /functions/v1/autoconf-webhook`, que devolve o contrato em JSON.

## Direções
| Fase | Direção | Como | Status |
|---|---|---|---|
| 1 | Autoconf → Totex: ativação/desativação do app, dados da loja, feed | `POST autoconf-webhook` | pronto |
| 2 | Autoconf → Totex: estoque no marketplace, totens do stand e Nina | ativação repassada ao marketplace (`POST /api/integrations/autoconf/activation`) → loja + integração ERP AUTOCONF + sync automático (cron do marketplace, padrão 6 h) | pronto (marketplace PR) |
| 3 | Totex → Autoconf: leads do site (marketplace) e do stand (Nina qualificou) | JSON POST no CRM do Autoconf (`leads.webhook_url` da loja ou `AUTOCONF_LEADS_URL`) | código pronto; **falta o endereço/auth do Autoconf** |

## Fase 1 — webhook de ativação
- URL: `https://mztfyavuclqzivywkaeu.supabase.co/functions/v1/autoconf-webhook`
- Auth: header `x-autoconf-secret` = config `AUTOCONF_WEBHOOK_SECRET` (gerado na migration;
  enviar ao Autoconf por canal privado; trocar o valor na tabela `config` se vazar).
- Eventos: `app.activated`, `app.deactivated`, `store.updated`, `feed.updated`.
- Idempotência: `event_id` único (tabela `autoconf_events`); reenvio devolve o mesmo resultado.
- Tolerância: o parser aceita variações de nome (`store/loja/dealership`, `feed/feed_url`,
  `activated_by/contact/contato`, campos em pt/en) — o canonical está em `CONTRATO` no código.
- Efeitos: `autoconf_stores` (loja, feed, destino de leads, status) → repasse ao marketplace
  (Fase 2) → tarefa crítica na matriz (`company_activities`: conferir os carros; avisa se a loja
  ainda não tem destino de leads). **Não** cria tenant no Totexgest nem convida ninguém.

## Fase 2 — estoque das lojas Autoconf no marketplace (automático)
`autoconf-webhook` chama o marketplace (`TOTEX_MARKETPLACE_API_URL` ou https://totexmotors.com)
em `POST /api/integrations/autoconf/activation` com `Authorization: Bearer <MARKETPLACE_WEBHOOK_SECRET>`
(o mesmo segredo dos leads; no marketplace é `TOTEXGEST_WEBHOOK_SECRET` — nenhuma variável nova).
O marketplace (repo totexmotors-marketplace, `erp-importer/autoconf-activation.controller.ts`):
casa a loja (marca `fieldMapping.autoconfStoreId` → CNPJ → mesmo feed), cria/atualiza o
`Dealership` e o `ErpIntegration` `AUTOCONF` com o feed, e enfileira o sync na hora (parser
`autoconf.parser.ts`, carros sem foto são pulados, carro que some do feed vira INACTIVE).
Desativação: integração, loja e carros ficam inativos. Sem migration no marketplace.
A Nina acha o estoque pelo nome da loja no marketplace (`consultar-estoque`), sem tenant.
O destino de leads da loja vira `Dealership.leadWebhookUrl` no marketplace: lead do site vai
direto pro CRM do Autoconf (o marketplace também manda uma cópia pro `marketplace-lead-webhook`
do Totexgest, que responde 422 "loja não mapeada" pras lojas Autoconf — esperado).

### Formato do feed

O marketplace totexmotors.com (projeto separado) consome o feed. Pedimos ao Autoconf o feed
padrão que eles já geram pra portais (XML), público, estável, atualizado a cada hora, com:
id do veículo, marca, modelo, versão, ano fabricação/modelo, km, cor, câmbio, combustível,
preço, fotos (URLs), opcionais, descrição, status (disponível/vendido). O XML padrão de site do
Autoconf (`<ADS><AD>…`) já é lido pelo parser do marketplace. O cadastro é automático; a tarefa
aberta pelo webhook é só pra conferir (ou cadastrar na mão se o repasse ao marketplace falhar).

## Fase 3 — leads no CRM do Autoconf
- **Site (marketplace)**: o marketplace manda o lead (evento `INTERESSE_VEICULO`) pro
  `Dealership.leadWebhookUrl` da loja, na hora.
- **Stand (totem → Nina)**: a Nina qualifica; morno/quente/muito quente → `stand-handoff` casa a
  loja do carro com `autoconf_stores` (pelo id da loja no marketplace; sem tenant casado, pelo nome)
  e entrega em `_shared/autoconf-leads.ts` (mesmo JSON do marketplace + `qualificacao` da Nina,
  `origem: STAND_TOTEX`). Frio fica em nutrição no stand (mesma régua das outras lojas).
- Destino: `autoconf_stores.lead_webhook_url` (vem em `leads.webhook_url` na ativação) ou a URL global
  do Autoconf em config `AUTOCONF_LEADS_URL` (recebe `?store_id=`); token opcional em
  `AUTOCONF_LEADS_TOKEN` (`Authorization: Bearer`). Sem destino → entrega fica `sem_destino` e a
  tarefa da ativação avisa.
- Auditoria: `autoconf_lead_deliveries` (status `entregue | falhou | sem_destino`, HTTP, erro, payload).
- **Pendente do Autoconf**: endereço e autenticação pra receber leads, e se o formato
  `INTERESSE_VEICULO` serve ou precisa de outro.

## Operação
- Lojas ativas: `select * from autoconf_stores`; eventos: `autoconf_events` (payload bruto +
  normalizado + resultado). Admin/superadmin leem via RLS.
- Teste: `GET` no endpoint mostra o contrato; `POST` com o segredo e um `store.id` de teste
  cria a loja; reenviar o mesmo `event_id` devolve `duplicate: true`.
