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

## Telas dentro do Claude (MCP Apps)

Duas ferramentas abrem uma **tela** na conversa (Claude Desktop / claude.ai), em vez de só texto:

| Ferramenta | RPC | Tela |
|---|---|---|
| `ficha_lead` (código `L000123`, nome ou telefone) | `mcp_ficha_lead` | `ui://totexgest/ficha-lead.html` — contato, etapa, negociação (carro de interesse/troca), negócios, tarefas, últimas mensagens do WhatsApp, histórico (mesclagens, código antigo, e-mail de reativação), ações da Nina |
| `pipeline_do_dia` | `mcp_pipeline_do_dia` | `ui://totexgest/pipeline-dia.html` — resumo do dia, kanban por etapa, fila do playbook, agenda de hoje, atrasadas, novos leads. Clicar num card abre a ficha na mesma tela |

Como funciona: a ferramenta devolve `structuredContent` + `_meta.ui.resourceUri`; o Claude lê o
recurso (HTML em `api/_lib/ui.ts`, mimeType `text/html;profile=mcp-app`) e abre num iframe
isolado. A tela fala com o host pelo SDK oficial `@modelcontextprotocol/ext-apps` (carregado do
unpkg — único domínio liberado no CSP) e chama de volta as ferramentas do servidor pelo próprio
host (`callServerTool`), ou seja, com o mesmo login OAuth e RLS do usuário. Nenhuma chave no HTML.

Pra testar fora do Claude: `api/_lib/ui.ts` é puro; um host falso em Playwright que responda
`ontoolresult`/`callServerTool` basta pra ver as telas.

## Local (dev)
```bash
npm ci && npm run build && \
  MCP_PUBLIC_URL=http://127.0.0.1:8081/mcp SUPABASE_URL=https://mztfyavuclqzivywkaeu.supabase.co \
  SUPABASE_PUBLISHABLE_KEY=<anon> MCP_DYNAMIC_CLIENTS=true npm start
```
