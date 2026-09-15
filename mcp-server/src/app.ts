import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { contextSchema, rpcClient, tokenVerifier, type Config, type TenantContext } from './auth.js';
import { createServer } from './tools.js';

// SEGUNDO CÉREBRO (MCP) — servidor HTTP (Streamable HTTP + OAuth do Supabase).
// Endpoint público = MCP_PUBLIC_URL (…/mcp). Resposta JSON (sem SSE) — roda bem
// em serverless (Vercel). Proteção contra DNS rebinding pela checagem de Host/Origin.

type Access = { context: TenantContext; rpc: ReturnType<typeof rpcClient> };

export function createApp(config: Config, authenticate?: (token: string) => Promise<Access>) {
  const app = express();
  app.disable('x-powered-by');
  const resource = new URL(config.publicUrl);
  const metadataUrl = `${resource.origin}/.well-known/oauth-protected-resource/mcp`;
  const verify = tokenVerifier(config);
  const authorize = authenticate ?? (async (token: string) => {
    const claims = await verify(token);
    const rpc = rpcClient(config, token);
    const context = contextSchema.parse(await rpc('mcp_context'));
    if (context.user_id !== claims.sub) throw new Error('Contexto inconsistente.');
    return { context, rpc };
  });

  app.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.get('/healthz', (_req, res) => { res.json({ status: 'ok', service: 'totexgest-segundo-cerebro' }); });

  app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (_req, res) => {
    res.json({
      resource: config.publicUrl,
      authorization_servers: [`${config.supabaseUrl}/auth/v1`],
      scopes_supported: ['openid'], bearer_methods_supported: ['header'],
      resource_name: 'Totexgest — Segundo Cérebro',
    });
  });

  app.use('/mcp', (req, res, next) => {
    if (req.headers.host !== resource.host || (req.headers.origin && req.headers.origin !== resource.origin)) {
      res.status(403).json({ error: 'Origem não permitida.' }); return;
    }
    next();
  });

  app.all('/mcp', async (req, res, next) => {
    const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '');
    try {
      if (!match) throw new Error('Token ausente.');
      res.locals.access = await authorize(match[1]);
      next();
    } catch {
      res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${metadataUrl}"`);
      res.status(401).json({ error: 'Conecte sua conta do CRM (admin/gestor) com uma empresa ativa.' });
    }
  });

  app.post('/mcp', express.json({ limit: '64kb' }), async (req, res) => {
    const { context, rpc } = res.locals.access as Access;
    const server = createServer(context, rpc);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch { if (!res.headersSent) res.status(500).json({ error: 'Falha no protocolo MCP.' }); }
  });

  app.all('/mcp', (_req, res) => { res.setHeader('Allow', 'POST'); res.status(405).end(); });

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof err === 'object' && err && 'status' in err && (err as { status?: number }).status === 413 ? 413 : 400;
    res.status(status).json({ error: 'Requisição inválida.' });
  });

  return app;
}
