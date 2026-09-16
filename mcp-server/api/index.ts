import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

// SEGUNDO CÉREBRO (MCP) — função serverless auto-contida (Vercel).
// Um único handler Node, sem Express, sem imports do próprio projeto: evita o
// erro "Invalid export found" e resolve tudo com pacotes externos.
// Login via OAuth nativo do Supabase (JWT validado por JWKS). Opera com o token
// do usuário (RLS) — nunca service_role. Só chama RPCs fixas public.mcp_*.

// ─── Config (lida uma vez) ───────────────────────────────────────────────────
const publicUrl = new URL(process.env.MCP_PUBLIC_URL ?? 'https://exemplo/mcp');
const supabaseOrigin = new URL(process.env.SUPABASE_URL ?? 'https://exemplo').origin;
const publishableKey = (process.env.SUPABASE_PUBLISHABLE_KEY ?? '').trim();
const clientIds = (process.env.MCP_OAUTH_CLIENT_IDS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const allowDynamicClients = process.env.MCP_DYNAMIC_CLIENTS === 'true';
const issuer = `${supabaseOrigin}/auth/v1`;
const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));

const contextSchema = z.object({
  user_id: z.string().uuid(), tenant_id: z.string().uuid(), tenant_name: z.string(),
  member_id: z.string().uuid(), role: z.string(), can_write: z.boolean(),
});
type TenantContext = z.infer<typeof contextSchema>;
type McpRpc =
  | 'mcp_context' | 'mcp_resumo_operacao' | 'mcp_o_que_esta_atrasado' | 'mcp_aprovacoes_pendentes'
  | 'mcp_intermediacao_repasse' | 'mcp_criar_tarefa' | 'mcp_concluir_tarefa' | 'mcp_decidir_aprovacao';

async function verifyToken(token: string) {
  const { payload } = await jwtVerify(token, jwks, {
    issuer, audience: publicUrl.href, algorithms: ['ES256', 'RS256'],
    requiredClaims: ['sub', 'exp', 'iat', 'client_id', 'session_id'],
  });
  const ok = z.string().uuid().safeParse(payload.sub).success && z.string().uuid().safeParse(payload.session_id).success
    && payload.role === 'authenticated' && typeof payload.client_id === 'string'
    && (clientIds.includes(payload.client_id) || (allowDynamicClients && z.string().uuid().safeParse(payload.client_id).success));
  if (!ok) throw new Error('Cliente OAuth ou usuário inválido.');
  return payload;
}

function rpcClient(token: string) {
  return async (name: McpRpc, args: Record<string, unknown> = {}) => {
    const response = await fetch(`${supabaseOrigin}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: publishableKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => null) as { code?: string; message?: string } | null;
      if (err?.code && ['22023', '40001', '42501', 'P0001', 'P0002'].includes(err.code) && err.message && err.message.length < 500) throw new Error(err.message);
      throw new Error('O CRM recusou a operação. Confira seu vínculo ativo e suas permissões.');
    }
    return response.json();
  };
}

const asText = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const asFail = (msg: string) => ({ ...asText({ error: msg }), isError: true });

function buildServer(context: TenantContext, rpc: ReturnType<typeof rpcClient>) {
  const server = new McpServer({ name: 'totexgest-segundo-cerebro', version: '1.0.0' }, {
    instructions:
      'Você é o "segundo cérebro" da operação do Totexgest (concessionária/intermediação de veículos). ' +
      'Responda em português brasileiro, direto e prático. resumo_operacao dá o panorama; o_que_esta_atrasado ' +
      'mostra o que precisa de ação; aprovacoes_pendentes antes de decidir alçadas. SEMPRE confirme com o usuário ' +
      'antes de qualquer ação de escrita (criar_tarefa, concluir_tarefa, decidir_aprovacao) e mostre o que vai fazer. ' +
      'Nunca invente dados; se uma ferramenta falhar, diga o que aconteceu. Traga sempre o próximo passo recomendado.',
  });
  const read = (tool: string, desc: string, rpcName: McpRpc) =>
    server.registerTool(tool, { description: desc, annotations: { readOnlyHint: true, openWorldHint: false } },
      async () => { try { return asText(await rpc(rpcName)); } catch (e) { return asFail(e instanceof Error ? e.message : 'Falhou'); } });

  server.registerTool('consultar_empresa', { description: 'Identifica a empresa e as permissões da conexão atual.', annotations: { readOnlyHint: true, openWorldHint: false } }, async () => asText(context));
  read('resumo_operacao', 'Panorama da operação agora: leads (hoje/7 dias), deals abertos, tarefas atrasadas/críticas, aprovações pendentes, intermediações por status e repasse.', 'mcp_resumo_operacao');
  read('o_que_esta_atrasado', 'O que precisa de ação: tarefas vencidas, deals parados há mais de 14 dias e aprovações esperando decisão.', 'mcp_o_que_esta_atrasado');
  read('aprovacoes_pendentes', 'Aprovações de alçada esperando decisão (venda abaixo do mínimo, comissão, concessão), com valor e há quantos dias esperam.', 'mcp_aprovacoes_pendentes');
  read('intermediacao_e_repasse', 'Status da intermediação (por etapa, recentes) e do repasse por indicação (indicações, entraram, converteram).', 'mcp_intermediacao_repasse');

  if (context.can_write) {
    server.registerTool('criar_tarefa', {
      description: 'Cria uma tarefa. CONFIRME o texto e o prazo com o usuário antes de chamar.',
      inputSchema: { titulo: z.string().trim().min(2).max(300), prazo: z.string().datetime({ offset: true }).optional(), critica: z.boolean().default(false) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    }, async ({ titulo, prazo, critica }) => { try { return asText(await rpc('mcp_criar_tarefa', { p_titulo: titulo, p_due: prazo ?? null, p_critica: critica })); } catch (e) { return asFail(e instanceof Error ? e.message : 'Falhou'); } });

    server.registerTool('concluir_tarefa', {
      description: 'Marca uma tarefa como concluída pelo id (pegue em o_que_esta_atrasado). CONFIRME antes.',
      inputSchema: { id: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ id }) => { try { return asText(await rpc('mcp_concluir_tarefa', { p_id: id })); } catch (e) { return asFail(e instanceof Error ? e.message : 'Falhou'); } });

    server.registerTool('decidir_aprovacao', {
      description: 'Aprova ou recusa uma alçada pendente (id em aprovacoes_pendentes). Só quem tem alçada. SEMPRE confirme a decisão com o usuário antes.',
      inputSchema: { id: z.string().uuid(), decisao: z.enum(['aprovar', 'recusar']), nota: z.string().trim().max(500).optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    }, async ({ id, decisao, nota }) => { try { return asText(await rpc('mcp_decidir_aprovacao', { p_request_id: id, p_decisao: decisao, p_nota: nota ?? null })); } catch (e) { return asFail(e instanceof Error ? e.message : 'Falhou'); } });
  }
  return server;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > 65536) throw new Error('too_large'); chunks.push(c as Buffer); }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

export default async function handler(req: IncomingMessage & { method?: string; url?: string }, res: ServerResponse) {
  const url = new URL(req.url ?? '/', publicUrl.origin);
  const path = url.pathname;
  const metadataUrl = `${publicUrl.origin}/.well-known/oauth-protected-resource/mcp`;

  if (path === '/healthz') return sendJson(res, 200, { status: 'ok', service: 'totexgest-segundo-cerebro' });

  if ((path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') && req.method === 'GET') {
    return sendJson(res, 200, { resource: publicUrl.href, authorization_servers: [issuer], scopes_supported: ['openid'], bearer_methods_supported: ['header'], resource_name: 'Totexgest — Segundo Cérebro' });
  }

  if (path !== '/mcp') return sendJson(res, 404, { error: 'Endereço não encontrado.' });

  // Proteção contra DNS rebinding (o Host precisa bater com o domínio público).
  if (req.headers.host !== publicUrl.host || (req.headers.origin && req.headers.origin !== publicUrl.origin)) {
    return sendJson(res, 403, { error: 'Origem não permitida.' });
  }

  const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '');
  let context: TenantContext; let rpc: ReturnType<typeof rpcClient>;
  try {
    if (!match) throw new Error('Token ausente.');
    const claims = await verifyToken(match[1]);
    rpc = rpcClient(match[1]);
    context = contextSchema.parse(await rpc('mcp_context'));
    if (context.user_id !== claims.sub) throw new Error('Contexto inconsistente.');
  } catch {
    return sendJson(res, 401, { error: 'Conecte sua conta do CRM (admin/gestor) com uma empresa ativa.' }, { 'WWW-Authenticate': `Bearer resource_metadata="${metadataUrl}"` });
  }

  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Método não suportado.' }, { Allow: 'POST' });

  let body: unknown;
  try { body = await readBody(req); }
  catch (e) { return sendJson(res, e instanceof Error && e.message === 'too_large' ? 413 : 400, { error: 'Requisição inválida.' }); }

  const server = buildServer(context, rpc);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { void transport.close(); void server.close(); });
  try { await server.connect(transport); await transport.handleRequest(req, res, body); }
  catch { if (!res.headersSent) sendJson(res, 500, { error: 'Falha no protocolo MCP.' }); }
}
