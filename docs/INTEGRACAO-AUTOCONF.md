# Integração Autoconf × Totex Motors

**Contexto (09/11/2026).** O Autoconf é o ERP das lojas. O app "Totex Motors" entra no marketplace
de apps do Autoconf; quando a loja ativa o app, o Autoconf avisa a Totex (webhook) com os dados da
loja, o link do feed de estoque do site e o contato de quem ativou. A Totex então: provisiona a loja
no Totexgest (tenant), cadastra o feed no marketplace totexmotors.com e passa a mandar leads do
stand dos shoppings pra essa loja.

Especificação pública (enviada pro time do Autoconf): artifact "Integração Autoconf Totex" (link
no chat com o Marco) e o próprio `GET /functions/v1/autoconf-webhook`, que devolve o contrato em JSON.

## Direções
| Fase | Direção | Como | Status |
|---|---|---|---|
| 1 | Autoconf → Totex: ativação/desativação do app, dados da loja, feed | `POST autoconf-webhook` | pronto |
| 2 | Autoconf → Totex: estoque | feed XML/JSON público, lido pelo marketplace | depende do feed deles |
| 3 | Totex → Autoconf: leads do stand/marketplace qualificados pela Nina | API de leads do Autoconf | **precisa da documentação deles** |

## Fase 1 — webhook de ativação
- URL: `https://mztfyavuclqzivywkaeu.supabase.co/functions/v1/autoconf-webhook`
- Auth: header `x-autoconf-secret` = config `AUTOCONF_WEBHOOK_SECRET` (gerado na migration;
  enviar ao Autoconf por canal privado; trocar o valor na tabela `config` se vazar).
- Eventos: `app.activated`, `app.deactivated`, `store.updated`, `feed.updated`.
- Idempotência: `event_id` único (tabela `autoconf_events`); reenvio devolve o mesmo resultado.
- Tolerância: o parser aceita variações de nome (`store/loja/dealership`, `feed/feed_url`,
  `activated_by/contact/contato`, campos em pt/en) — o canonical está em `CONTRATO` no código.
- Efeitos: `autoconf_stores` (loja ↔ tenant, feed, status) → `provision-tenant` (mesma porta do
  TotexMotors OS; `external_dealership_id = autoconf:<store.id>`, `external_source = autoconf`,
  contato que ativou vira admin convidado por e-mail) → tarefa crítica na matriz
  (`company_activities`, "cadastrar feed no marketplace e dar boas-vindas").

## Fase 2 — feed de estoque
O marketplace totexmotors.com (projeto separado) consome o feed. Pedimos ao Autoconf o feed
padrão que eles já geram pra portais (XML), público, estável, atualizado a cada hora, com:
id do veículo, marca, modelo, versão, ano fabricação/modelo, km, cor, câmbio, combustível,
preço, fotos (URLs), opcionais, descrição, status (disponível/vendido). O cadastro do feed na
loja do marketplace ainda é manual (tarefa aberta pelo webhook).

## Fase 3 — leads de volta pro Autoconf
Quando a Nina qualifica um lead do stand e o `stand-handoff` repassa pra loja dona do carro, se a
loja veio do Autoconf (`autoconf_stores.tenant_id`), mandar o lead pro CRM do Autoconf.
Falta: endpoint, auth e formato do lead no Autoconf (pedido à Carla).

## Operação
- Lojas ativas: `select * from autoconf_stores`; eventos: `autoconf_events` (payload bruto +
  normalizado + resultado). Admin/superadmin leem via RLS.
- Teste: `GET` no endpoint mostra o contrato; `POST` com o segredo e um `store.id` de teste
  cria a loja; reenviar o mesmo `event_id` devolve `duplicate: true`.
