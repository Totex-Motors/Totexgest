import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { rpcClient, TenantContext } from './auth.js';

// SEGUNDO CÉREBRO (MCP) — ferramentas sob medida do Totexgest.
// Leitura = supervisão. Ações = escrita (o Claude confirma com você antes).
// Toda a lógica e a segurança moram nas RPCs public.mcp_* (SECURITY DEFINER,
// escopadas por tenant, promotora/sdr barradas). Aqui é só a fachada MCP.

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const fail = (msg: string) => ({ ...text({ error: msg }), isError: true });

export function createServer(context: TenantContext, rpc: ReturnType<typeof rpcClient>) {
  const server = new McpServer({ name: 'totexgest-segundo-cerebro', version: '1.0.0' }, {
    instructions:
      'Você é o "segundo cérebro" da operação do Totexgest (concessionária/intermediação de veículos). ' +
      'Responda em português brasileiro, direto e prático. Use resumo_operacao para o panorama; ' +
      'o_que_esta_atrasado para o que precisa de ação; aprovacoes_pendentes antes de decidir alçadas. ' +
      'Sempre CONFIRME com o usuário antes de qualquer ação de escrita (criar_tarefa, concluir_tarefa, decidir_aprovacao) ' +
      'e mostre o que vai fazer. Nunca invente dados: se uma ferramenta falhar, diga o que aconteceu. ' +
      'Traga sempre o "próximo passo" recomendado junto do número.',
  });

  // ── Identidade da conexão ──────────────────────────────────────────────────
  server.registerTool('consultar_empresa', {
    description: 'Identifica a empresa e as permissões da conexão atual (quem está falando com o CRM).',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => text(context));

  // ── LEITURA (supervisão) ───────────────────────────────────────────────────
  server.registerTool('resumo_operacao', {
    description: 'Panorama da operação agora: leads (hoje/7 dias), deals abertos, tarefas atrasadas/críticas, aprovações pendentes, intermediações por status e repasse.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    try { return text(await rpc('mcp_resumo_operacao')); } catch (e) { return fail(e instanceof Error ? e.message : 'Falhou'); }
  });

  server.registerTool('o_que_esta_atrasado', {
    description: 'O que precisa de ação: tarefas vencidas, deals parados há mais de 14 dias e aprovações esperando decisão.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    try { return text(await rpc('mcp_o_que_esta_atrasado')); } catch (e) { return fail(e instanceof Error ? e.message : 'Falhou'); }
  });

  server.registerTool('aprovacoes_pendentes', {
    description: 'Lista as aprovações de alçada esperando decisão (venda abaixo do mínimo, comissão, concessão), com valor e há quantos dias esperam.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    try { return text(await rpc('mcp_aprovacoes_pendentes')); } catch (e) { return fail(e instanceof Error ? e.message : 'Falhou'); }
  });

  server.registerTool('intermediacao_e_repasse', {
    description: 'Status da intermediação (por etapa, recentes) e do repasse por indicação (indicações, entraram no grupo, converteram em venda).',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    try { return text(await rpc('mcp_intermediacao_repasse')); } catch (e) { return fail(e instanceof Error ? e.message : 'Falhou'); }
  });

  // ── AÇÕES (escrita — confirme com o usuário antes) ─────────────────────────
  if (context.can_write) {
    server.registerTool('criar_tarefa', {
      description: 'Cria uma tarefa. CONFIRME o texto e o prazo com o usuário antes de chamar.',
      inputSchema: {
        titulo: z.string().trim().min(2).max(300),
        prazo: z.string().datetime({ offset: true }).optional().describe('ISO 8601 com fuso, ex 2026-09-20T14:00:00-03:00'),
        critica: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    }, async ({ titulo, prazo, critica }) => {
      try { return text(await rpc('mcp_criar_tarefa', { p_titulo: titulo, p_due: prazo ?? null, p_critica: critica })); }
      catch (e) { return fail(e instanceof Error ? e.message : 'Falhou'); }
    });

    server.registerTool('concluir_tarefa', {
      description: 'Marca uma tarefa como concluída pelo id (pegue o id em o_que_esta_atrasado). CONFIRME antes.',
      inputSchema: { id: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ id }) => {
      try { return text(await rpc('mcp_concluir_tarefa', { p_id: id })); }
      catch (e) { return fail(e instanceof Error ? e.message : 'Falhou'); }
    });

    server.registerTool('decidir_aprovacao', {
      description: 'Aprova ou recusa uma alçada pendente (pegue o id em aprovacoes_pendentes). Só quem tem alçada. SEMPRE confirme a decisão com o usuário antes.',
      inputSchema: {
        id: z.string().uuid(),
        decisao: z.enum(['aprovar', 'recusar']),
        nota: z.string().trim().max(500).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    }, async ({ id, decisao, nota }) => {
      try { return text(await rpc('mcp_decidir_aprovacao', { p_request_id: id, p_decisao: decisao, p_nota: nota ?? null })); }
      catch (e) { return fail(e instanceof Error ? e.message : 'Falhou'); }
    });
  }

  return server;
}
