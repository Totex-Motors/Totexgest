import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';

// SEGUNDO CÉREBRO (MCP) — autenticação e acesso ao CRM.
//
// Reaproveitado do núcleo comprovado do template: valida o token OAuth emitido
// pelo Supabase (assinatura via JWKS, emissor, audiência = URL pública do MCP) e
// chama as RPCs public.mcp_* com o TOKEN DO USUÁRIO (RLS + tenant do próprio JWT).
// Nunca usa service_role. Só chama RPCs fixas — nunca SQL livre nem tabela do LLM.

export interface Config {
  publicUrl: string; supabaseUrl: string; publishableKey: string;
  clientIds: string[]; allowDynamicClients?: boolean; host: string; port: number;
}

export function readConfig(env: NodeJS.ProcessEnv): Config {
  const publicUrl = new URL(env.MCP_PUBLIC_URL ?? 'http://127.0.0.1:8081/mcp');
  const supabaseUrl = new URL(env.SUPABASE_URL ?? '');
  const local = (u: URL) => ['127.0.0.1', 'localhost'].includes(u.hostname);
  for (const url of [publicUrl, supabaseUrl]) {
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local(url))) throw new Error('HTTPS obrigatório fora do localhost.');
    if (url.username || url.password || url.search || url.hash) throw new Error('URL não pode conter credenciais, query ou fragmento.');
  }
  if (publicUrl.pathname !== '/mcp') throw new Error('MCP_PUBLIC_URL deve terminar em /mcp.');
  const publishableKey = env.SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!publishableKey || publishableKey.startsWith('sb_secret_')) throw new Error('Configure uma chave publicável (anon), nunca uma chave secreta.');
  if (publishableKey.split('.').length === 3) {
    const payload = JSON.parse(Buffer.from(publishableKey.split('.')[1], 'base64url').toString());
    if (payload.role !== 'anon') throw new Error('Somente a chave anon/publicável é aceita.');
  }
  const clientIds = (env.MCP_OAUTH_CLIENT_IDS ?? '').split(',').map(x => x.trim()).filter(Boolean);
  const allowDynamicClients = env.MCP_DYNAMIC_CLIENTS === 'true';
  if (!clientIds.length && !allowDynamicClients) throw new Error('Cadastre ao menos um cliente OAuth aprovado em MCP_OAUTH_CLIENT_IDS, ou ligue MCP_DYNAMIC_CLIENTS=true.');
  const port = z.coerce.number().int().min(1).max(65535).parse(env.PORT ?? 8081);
  return { publicUrl: publicUrl.href, supabaseUrl: supabaseUrl.origin, publishableKey, clientIds, allowDynamicClients, port, host: env.MCP_HOST ?? '127.0.0.1' };
}

export function tokenVerifier(config: Config, keys?: JWTVerifyGetKey) {
  const issuer = `${config.supabaseUrl}/auth/v1`;
  const jwks = keys ?? createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  return async (token: string) => {
    const { payload } = await jwtVerify(token, jwks, {
      issuer, audience: config.publicUrl, algorithms: ['ES256', 'RS256'],
      requiredClaims: ['sub', 'exp', 'iat', 'client_id', 'session_id'],
    });
    if (!z.string().uuid().safeParse(payload.sub).success || !z.string().uuid().safeParse(payload.session_id).success || payload.role !== 'authenticated' ||
        typeof payload.client_id !== 'string' || (!config.clientIds.includes(payload.client_id) && !(config.allowDynamicClients && z.string().uuid().safeParse(payload.client_id).success))) {
      throw new Error('Cliente OAuth ou usuário inválido.');
    }
    return payload;
  };
}

export const contextSchema = z.object({
  user_id: z.string().uuid(), tenant_id: z.string().uuid(), tenant_name: z.string(),
  member_id: z.string().uuid(), role: z.string(), can_write: z.boolean(),
});
export type TenantContext = z.infer<typeof contextSchema>;

// Somente RPCs fixas public.mcp_* — sem service_role, sem SQL livre, sem nome vindo do LLM.
export type McpRpc =
  | 'mcp_context' | 'mcp_resumo_operacao' | 'mcp_o_que_esta_atrasado'
  | 'mcp_aprovacoes_pendentes' | 'mcp_intermediacao_repasse'
  | 'mcp_criar_tarefa' | 'mcp_concluir_tarefa' | 'mcp_decidir_aprovacao';

export function rpcClient(config: Config, token: string) {
  return async (name: McpRpc, args: Record<string, unknown> = {}) => {
    const response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: config.publishableKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null) as { code?: string; message?: string } | null;
      if (error?.code && ['22023', '40001', '42501', 'P0001', 'P0002'].includes(error.code) && error.message && error.message.length < 500) throw new Error(error.message);
      throw new Error('O CRM recusou a operação. Confira seu vínculo ativo e suas permissões.');
    }
    return response.json();
  };
}
