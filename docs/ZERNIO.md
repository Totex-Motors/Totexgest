# Zernio — publicar o carrossel do Studio em outras redes (2026-10-19)

Decisão do Marco: **Instagram continua direto na Meta** (`instagram-publish`, DMs pelo
`instagram-webhook`). A Zernio (zernio.com) entra **só** pra espelhar o mesmo carrossel nas
outras redes. Plano grátis: 2 contas conectadas (sem cartão), posts ilimitados, analytics e
webhooks inclusos; da 3ª conta em diante US$ 6/conta/mês.

## O que cada rede aceita (o Studio gera JPEG)
| Rede | Carrossel de imagens | Observação |
|---|---|---|
| Facebook (página) | sim, até 10 imagens | precisa ser Admin/Editor da página |
| TikTok | sim, foto-carrossel até 35 | conecta pelo app Business do TikTok; moderação mais dura via API |
| Threads | sim | |
| YouTube | **não** (só vídeo) | fica pra quando tivermos vídeo (Shorts) |

Recomendação pro grátis: **Facebook + TikTok**.

## Peças
- Chaves (globais, Configurações › Integrações › Redes sociais): `ZERNIO_API_KEY`,
  `ZERNIO_WEBHOOK_SECRET` (inventado; mesmo valor no painel da Zernio).
- `_shared/zernio.ts`: cliente, `ensureProfile` (1 profile por loja, `externalId = tenant_id`),
  `listAccounts`, `verifyZernioSignature` (HMAC-SHA256 hex do corpo cru, header
  `X-Zernio-Signature`).
- `zernio-publish` (usuário logado, tenant do JWT): `accounts`, `connect` (devolve `authUrl`,
  redireciona de volta com `?zernio=connected`), `publish` (URL assinada de 7 dias das artes do
  bucket `instagram-publications` → `POST /v1/posts` com `publishNow`, `Idempotency-Key` = id
  da linha), `status` (`GET /v1/posts/{id}`), `disconnect`.
- `zernio-webhook` (`verify_jwt=false`, exige o secret): `post.published|partial|failed`,
  `post.platform.published|failed` → atualiza `social_publications`; `account.disconnected`
  só loga.
- Tabelas: `zernio_profiles`, `social_publications` (tenant, campanha, post da Zernio, status,
  `platforms[]` com status/url/erro por rede). RLS: leitura por tenant; escrita só service role.
- Tela: card "Outras redes (via Zernio)" na campanha do Studio (`SocialPublisher.tsx`),
  abaixo da publicação no Instagram: conectar redes, marcar contas, publicar, histórico.

## Passo a passo (Marco)
1. Criar conta grátis em zernio.com → Dashboard › API keys → copiar a chave.
2. CRM: Configurações › Integrações › Redes sociais → colar `ZERNIO_API_KEY`; inventar
   `ZERNIO_WEBHOOK_SECRET` e salvar.
3. Zernio › Dashboard › Webhooks → URL `https://<projeto>.supabase.co/functions/v1/zernio-webhook`,
   secret igual ao do passo 2, eventos `post.*` e `account.disconnected`.
4. Marketing › campanha do Studio → "Outras redes" → Conectar Facebook / TikTok (abre a
   Zernio, loga na rede, volta pro CRM).
5. Com as artes devolvidas pelo Studio: marcar as redes → "Publicar nas redes selecionadas".

## TikTok — detalhes
`platformSpecificData`: `mediaType: "photo"`, `privacyLevel` (lido de
`GET /v1/accounts/{id}/tiktok/creator-info`, padrão `PUBLIC_TO_EVERYONE`),
`contentPreviewConfirmed` e `expressConsentGiven` = true (obrigatórios), `description` =
legenda (4.000 chars). Limite diário de posts por API; `dryRun` existe se precisar.
