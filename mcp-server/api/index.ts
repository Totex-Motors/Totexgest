import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  AGENDA_HTML, FICHA_HTML, INBOX_HTML, PIPELINE_HTML, RANKING_HTML, UI_CSP, UI_MIME,
  UI_URI_AGENDA, UI_URI_FICHA, UI_URI_INBOX, UI_URI_PIPELINE, UI_URI_RANKING,
} from './_lib/ui.js';

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
  | 'mcp_intermediacao_repasse' | 'mcp_criar_tarefa' | 'mcp_concluir_tarefa' | 'mcp_decidir_aprovacao'
  | 'mcp_ranking_time' | 'mcp_agenda_hoje' | 'mcp_buscar_lead' | 'mcp_agendar_followup'
  | 'mcp_ficha_lead' | 'mcp_pipeline_do_dia' | 'mcp_inbox' | 'mcp_conversa' | 'mcp_responder' | 'mcp_envio_status'
  | 'mcp_agenda_semana';

async function verifyToken(token: string) {
  // O servidor OAuth do Supabase não amarra o token ao recurso (sem RFC 8707),
  // então o access token sai com aud padrão "authenticated". Aceitamos tanto o
  // recurso (caso um dia passe a amarrar) quanto "authenticated". A segurança
  // continua garantida por: issuer (só esse Supabase) + role authenticated +
  // client_id (só tokens emitidos via OAuth, não sessão normal do app).
  const { payload } = await jwtVerify(token, jwks, {
    issuer, audience: [publicUrl.href, 'authenticated'], algorithms: ['ES256', 'RS256'],
    requiredClaims: ['sub', 'exp', 'iat', 'client_id'],
  });
  // session_id é opcional (o token do servidor OAuth pode não trazer esse claim);
  // quando vier, precisa ser um uuid válido.
  const sidOk = payload.session_id === undefined || z.string().uuid().safeParse(payload.session_id).success;
  const ok = z.string().uuid().safeParse(payload.sub).success && sidOk
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
// Resultado com tela: o texto vai pro modelo, o structuredContent vai pro iframe da tela.
const asView = (value: Record<string, unknown>) => ({ ...asText(value), structuredContent: value });

// MCP Apps: a ferramenta aponta pro recurso ui:// que o Claude renderiza num iframe.
// `ui.resourceUri` é a chave atual; `ui/resourceUri` é a antiga (hosts mais velhos).
const uiToolMeta = (resourceUri: string) => ({ ui: { resourceUri }, 'ui/resourceUri': resourceUri });
const uiResourceMeta = { ui: { csp: UI_CSP, prefersBorder: true } };

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
  read('agenda_hoje', 'Reuniões e atividades agendadas para hoje (horário, responsável, se já concluída).', 'mcp_agenda_hoje');

  server.registerTool('ranking_time', {
    title: 'Ranking do time',
    description: 'Mostra numa tela o ranking dos vendedores no período (semana/mês/tudo): vendas ganhas, valor, em aberto, perdidas, ' +
      'leads novos, leads que responderam, tarefas feitas e atrasadas. Use quando pedirem "ranking", "quem vendeu mais", "como está o time".',
    inputSchema: { periodo: z.enum(['week', 'month', 'all']).default('month') },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: uiToolMeta(UI_URI_RANKING),
  }, async ({ periodo }) => {
    try { return asView(await rpc('mcp_ranking_time', { p_period: periodo }) as Record<string, unknown>); } catch (e) { return asFail(e instanceof Error ? e.message : 'Falhou'); }
  });

  server.registerTool('buscar_lead', {
    description: 'Busca um lead por nome ou telefone. Retorna etapa, deals abertos e a próxima tarefa. Use o id retornado para agendar_followup.',
    inputSchema: { termo: z.string().trim().min(2).max(120) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ termo }) => {
    try { return asText(await rpc('mcp_buscar_lead', { p_termo: termo })); } catch (e) { return asFail(e instanceof Error ? e.message : 'Falhou'); }
  });

  // ─── Telas (MCP Apps) ──────────────────────────────────────────────────────
  const view = (name: string, uri: string, title: string, html: string) =>
    server.registerResource(name, uri, { title, description: `Tela "${title}" do Totexgest.`, mimeType: UI_MIME, _meta: uiResourceMeta },
      async () => ({ contents: [{ uri, mimeType: UI_MIME, text: html, _meta: uiResourceMeta }] }));
  view('ficha_lead_view', UI_URI_FICHA, 'Ficha do lead', FICHA_HTML);
  view('pipeline_dia_view', UI_URI_PIPELINE, 'Pipeline do dia', PIPELINE_HTML);
  view('inbox_view', UI_URI_INBOX, 'Inbox', INBOX_HTML);
  view('agenda_semana_view', UI_URI_AGENDA, 'Agenda da semana', AGENDA_HTML);
  view('ranking_view', UI_URI_RANKING, 'Ranking do time', RANKING_HTML);

  server.registerTool('inbox', {
    title: 'Inbox (WhatsApp + Instagram)',
    description: 'Abre numa tela o INBOX da loja: conversas do WhatsApp oficial e DMs do Instagram, com quem está aguardando resposta, ' +
      'janela de 24h aberta ou não, última mensagem, vendedor e o que a Nina fez. Filtros: canal (todos/whatsapp/instagram), ' +
      'filtro (pendentes = aguardando resposta, todas) e busca (nome, @usuário, telefone, código). Clicar numa conversa abre o chat. ' +
      'Use quando pedirem "inbox", "quem está esperando resposta", "mensagens do WhatsApp/Instagram". Resuma só quem precisa de resposta.',
    inputSchema: {
      canal: z.enum(['todos', 'whatsapp', 'instagram']).default('todos'),
      filtro: z.enum(['pendentes', 'todas']).default('pendentes'),
      busca: z.string().trim().min(2).max(80).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: uiToolMeta(UI_URI_INBOX),
  }, async ({ canal, filtro, busca }) => {
    try { return asView(await rpc('mcp_inbox', { p_canal: canal, p_filtro: filtro, p_busca: busca ?? null }) as Record<string, unknown>); }
    catch (e) { return asFail(e instanceof Error ? e.message : 'Falhou'); }
  });

  server.registerTool('conversa', {
    title: 'Conversa',
    description: 'Abre numa tela o CHAT completo com um lead (WhatsApp, id = id do lead) ou uma DM do Instagram (id = id da conversa, ' +
      'pegue em inbox). Mostra as últimas mensagens, se a janela de 24h está aberta e, se der, a caixa pra responder pelo canal oficial.',
    inputSchema: { canal: z.enum(['whatsapp', 'instagram']), id: z.string().uuid(), limite: z.number().int().min(5).max(120).default(40) },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: uiToolMeta(UI_URI_INBOX),
  }, async ({ canal, id, limite }) => {
    try { return asView(await rpc('mcp_conversa', { p_canal: canal, p_id: id, p_limite: limite }) as Record<string, unknown>); }
    catch (e) { return asFail(e instanceof Error ? e.message : 'Falhou'); }
  });

  server.registerTool('ficha_lead', {
    title: 'Ficha do lead',
    description: 'Abre a FICHA COMPLETA de um lead numa tela: contato, etapa, vendedor, carro de interesse e de troca, ' +
      'negócios, tarefas, últimas mensagens do WhatsApp, histórico (mesclagens, código antigo, e-mail de reativação) e ações da Nina. ' +
      'Aceita código (L000123 ou só o número), nome ou telefone. Se houver vários, devolve a lista pra escolher. ' +
      'Prefira esta ferramenta a buscar_lead quando o usuário quiser VER o lead; resuma em 2-3 linhas o que importa e deixe a tela mostrar o resto.',
    inputSchema: { termo: z.string().trim().min(2).max(120).describe('Código (L000123), nome ou telefone do lead') },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: uiToolMeta(UI_URI_FICHA),
  }, async ({ termo }) => {
    try { return asView(await rpc('mcp_ficha_lead', { p_termo: termo }) as Record<string, unknown>); }
    catch (e) { return asFail(e instanceof Error ? e.message : 'Falhou'); }
  });

  server.registerTool('pipeline_do_dia', {
    title: 'Pipeline do dia',
    description: 'Mostra numa tela o PIPELINE DE HOJE da loja: resumo do dia (novos leads, quem respondeu, cards movidos, ganhos, ' +
      'tarefas e atrasadas), kanban por etapa com os cards mais recentes, fila do playbook (quem precisa de mensagem/ligação hoje), ' +
      'agenda de hoje, atrasadas e novos leads. Use quando o usuário pedir "pipeline", "como está o dia", "o que tenho pra hoje", "kanban". ' +
      'Destaque em texto só o que pede ação (fila, atrasadas, quem respondeu); a tela mostra o restante.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: uiToolMeta(UI_URI_PIPELINE),
  }, async () => {
    try { return asView(await rpc('mcp_pipeline_do_dia') as Record<string, unknown>); }
    catch (e) { return asFail(e instanceof Error ? e.message : 'Falhou'); }
  });

  server.registerTool('agenda_semana', {
    title: 'Agenda da semana',
    description: 'Mostra numa tela a AGENDA DA SEMANA da loja (segunda a domingo): reuniões, visitas, ligações e tarefas por dia, com lead e ' +
      'responsável. Sem "inicio" é a semana atual; "inicio" (AAAA-MM-DD, uma segunda-feira) navega. Use quando pedirem "agenda", "semana", "o que tem marcado".',
    inputSchema: { inicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Primeiro dia da semana (AAAA-MM-DD)') },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: uiToolMeta(UI_URI_AGENDA),
  }, async ({ inicio }) => {
    try { return asView(await rpc('mcp_agenda_semana', { p_inicio: inicio ?? null }) as Record<string, unknown>); }
    catch (e) { return asFail(e instanceof Error ? e.message : 'Falhou'); }
  });

  if (context.can_write) {
    server.registerTool('responder', {
      title: 'Responder conversa',
      description: 'Envia uma resposta de TEXTO pelo canal OFICIAL (WhatsApp Cloud API ou DM do Instagram) a uma conversa aberta — ' +
        'só funciona dentro da janela de 24h desde a última mensagem da pessoa. id = id do lead (whatsapp) ou da conversa (instagram). ' +
        'SEMPRE mostre o texto exato e CONFIRME com o usuário antes de chamar. Nunca invente texto por conta própria. ' +
        'Depois, use envio_status com o request_id pra confirmar que a Meta aceitou.',
      inputSchema: { canal: z.enum(['whatsapp', 'instagram']), id: z.string().uuid(), texto: z.string().trim().min(1).max(1500) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    }, async ({ canal, id, texto }) => {
      try { return asText(await rpc('mcp_responder', { p_canal: canal, p_id: id, p_texto: texto })); }
      catch (e) { return asFail(e instanceof Error ? e.message : 'Falhou'); }
    });

    server.registerTool('envio_status', {
      title: 'Status do envio',
      description: 'Confirma se um envio feito por "responder" foi aceito (request_id devolvido por responder). pronto=false = ainda processando.',
      inputSchema: { request_id: z.number().int().positive() },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ['model', 'app'] } },
    }, async ({ request_id }) => {
      try { return asText(await rpc('mcp_envio_status', { p_request_id: request_id })); }
      catch (e) { return asFail(e instanceof Error ? e.message : 'Falhou'); }
    });

    server.registerTool('agendar_followup', {
      description: 'Cria uma tarefa de follow-up ligada a um lead (pegue o id em buscar_lead). CONFIRME com o usuário antes.',
      inputSchema: {
        lead_id: z.string().uuid(),
        quando: z.string().datetime({ offset: true }).optional().describe('ISO 8601 com fuso, ex 2026-09-22T10:00:00-03:00'),
        nota: z.string().trim().max(300).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    }, async ({ lead_id, quando, nota }) => {
      try { return asText(await rpc('mcp_agendar_followup', { p_lead: lead_id, p_quando: quando ?? null, p_nota: nota ?? null })); }
      catch (e) { return asFail(e instanceof Error ? e.message : 'Falhou'); }
    });

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
  } catch (e) {
    // DIAGNÓSTICO (temporário): registra o motivo real da recusa + o formato do
    // token recebido (só claims não sensíveis), pra achar o descasamento. Nunca
    // loga a assinatura. Remover depois que o conector estiver estável.
    try {
      const reason = e instanceof Error ? e.message : String(e);
      let claimInfo: Record<string, unknown> = {};
      if (match) {
        const parts = match[1].split('.');
        if (parts.length === 3) {
          const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
          claimInfo = {
            iss: p.iss, aud: p.aud, role: p.role,
            has_client_id: 'client_id' in p, client_id: p.client_id,
            has_session_id: 'session_id' in p,
            has_sub: 'sub' in p, alg_hint: parts[0] ? JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')).alg : null,
            keys: Object.keys(p),
          };
        }
      }
      console.error('[mcp][auth-fail]', JSON.stringify({ reason, expected_aud: publicUrl.href, expected_iss: issuer, dynamic_clients: allowDynamicClients, fixed_clients: clientIds, token: claimInfo }));
    } catch (logErr) {
      console.error('[mcp][auth-fail] (sem detalhe)', logErr instanceof Error ? logErr.message : String(logErr));
    }
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
