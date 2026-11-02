# Páginas de carro com IA ("autoconsultor") — 2026-11-02

Uma landing page por carro do estoque (marketplace totexmotors.com), escrita por IA como um
consultor honesto: headline, resumo, pontos fortes, pra quem é, equipamentos típicos da versão,
consumo e custo de manter (faixas), concorrentes, objeções, FAQ, CTA. Mais FIPE (porta única
`fipe-lookup`) e parcela (simulador, só nas lojas em `SIMULADOR_TENANT_IDS`).

## Onde
- CRM: Comercial › **Páginas de carro** (`/comercial/paginas`). Lista o estoque da loja no
  marketplace, "Gerar com IA", prévia, publicar/despublicar, copiar link, views e cliques.
  Superadmin escolhe a loja (select); usuário de loja vê a própria.
- Público: `https://totexgest.vercel.app/c/<slug>` (rewrite da Vercel → edge function
  `vehicle-page/<slug>`). Base configurável em `VEHICLE_PAGE_BASE_URL` (ex.: domínio próprio).
  `?preview=1` mostra rascunho; `?format=json` devolve os dados.

## Peças
- Tabela `vehicle_pages` (tenant, carro do marketplace, slug, status draft/published, snapshot
  do veículo, conteúdo da IA, fipe, simulacao, views, clicks). RLS leitura por tenant; escrita só
  pela função. `vehicle_page_hit(slug, kind)` incrementa contadores.
- `vehicle-page` (verify_jwt=false): GET público (HTML com OG tags + JSON-LD), POST `click`
  público (cria lead "clique" source=marketplace sem telefone, `metadata.marketplace_origin =
  LANDING_IA`, devolve `ref` = 8 chars do id e o número do WhatsApp), POST `estoque | generate |
  publish | unpublish | delete | list | lojas` (usuário logado da loja ou `x-internal-token`).
- `_shared/vehicle-page-html.ts`: template (mobile-first, claro/escuro, galeria, preço × FIPE,
  parcela, seções da IA, CTAs fixos: WhatsApp / Simular parcela / Agendar visita).
- Botão do WhatsApp: mesmo texto do site ("Eu vi o {carro} da loja {loja} no site da TotexMotors …
  (ref xxxxxxxx)"), então `absorbMarketplaceClick` casa a mensagem que chega com o clique.
  Número: instância `meta_cloud` da loja › telefone da loja no marketplace › `VEHICLE_PAGE_WHATSAPP`.

## Regras
- A IA só usa dados do anúncio sobre o exemplar; o resto é "referência do modelo" com aviso.
- Nunca taxa de juros (só reais). FIPE só se `fipe-lookup` confirmar o modelo sem ambiguidade
  (senão a página sai sem FIPE). Parcela só nas lojas com simulador.
- Modelo de IA: `VEHICLE_PAGE_MODEL` (padrão claude-sonnet-4-5-20250929).

## Config
`FIPE_LOOKUP_TOKEN` (gerado), `SIMULADOR_TENANT_IDS` (Cardoso), opcionais `VEHICLE_PAGE_BASE_URL`,
`VEHICLE_PAGE_MODEL`, `VEHICLE_PAGE_WHATSAPP` (por loja), `TOTEX_MARKETPLACE_API_URL`.

## Próximos passos (ideias)
- Botão "Mandar a página" no inbox/agente (tool `enviar_pagina_carro`) e no card da simulação.
- Regerar automaticamente quando o preço mudar no marketplace; arquivar quando o carro sair.
- Domínio próprio (ex.: carros.totexmotors.com) apontando pro rewrite.
- Vídeo curto do carro (IA) pra YouTube/TikTok via Zernio a partir das fotos.
