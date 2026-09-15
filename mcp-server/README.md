# Totexgest — Segundo Cérebro (Servidor MCP)

Servidor MCP que conecta o CRM ao Claude (celular/PC). Login pelo **OAuth nativo do
Supabase**; opera com a permissão do usuário (RLS) — **nunca** usa service_role.
Ferramentas: supervisão da operação + ações (criar/concluir tarefa, decidir aprovação),
todas nas RPCs `public.mcp_*`.

## Publicar na Vercel

1. Crie um **projeto novo** na Vercel apontando para esta pasta (`mcp-server/`) do repo.
   - Root Directory: `mcp-server`
   - Framework preset: **Other**. Build/Install padrão (a Vercel detecta o `vercel.json`).
2. Em **Settings → Environment Variables**, cadastre (veja `.env.example`):
   - `MCP_PUBLIC_URL` = `https://SEU-DOMINIO-VERCEL/mcp` (o domínio que a Vercel der + `/mcp`)
   - `SUPABASE_URL` = `https://mztfyavuclqzivywkaeu.supabase.co`
   - `SUPABASE_PUBLISHABLE_KEY` = a chave **anon/publicável** do projeto
   - `MCP_DYNAMIC_CLIENTS` = `true`
3. Faça o deploy. Teste: `https://SEU-DOMINIO-VERCEL/healthz` deve responder `{"status":"ok"}`.

## Configurar o Supabase (uma vez, no painel do projeto)

1. **Authentication → JWT / Signing Keys**: garanta **assinatura assimétrica** (ES256/RS256)
   com JWKS público — o servidor valida o token por aí. (Projetos novos já vêm assim; se
   estiver em HS256, migre para chave assimétrica.)
2. **Authentication → OAuth Server**: habilite o servidor OAuth e o **registro dinâmico de
   clientes**; **Authorization Path** = `/oauth/consent`.
3. **Authentication → URL Configuration**: em Site URL / Redirect URLs, inclua a origem
   HTTPS do **CRM** (onde mora a página `/oauth/consent`).

## Conectar no Claude

No app do Claude (Settings → Connectors → Add custom connector), informe a URL
`https://SEU-DOMINIO-VERCEL/mcp`. O Claude abrirá o `/oauth/consent` do CRM: entre com a
conta **de gestor/admin** e autorize. Pronto — pergunte "como está a operação?".

## Local (dev)
```bash
npm ci && npm run build && \
  MCP_PUBLIC_URL=http://127.0.0.1:8081/mcp SUPABASE_URL=https://mztfyavuclqzivywkaeu.supabase.co \
  SUPABASE_PUBLISHABLE_KEY=<anon> MCP_DYNAMIC_CLIENTS=true npm start
```
