// Helper compartilhado: lê tenant_email_config (multi-tenant)
//
// MULTI-TENANT: 1 row por tenant na tabela `tenant_email_config` (PK = tenant_id).
// Edge functions usam service_role e PRECISAM passar tenantId explicitamente —
// service_role bypassa RLS e NÃO aciona o DEFAULT get_tenant_id().

export interface EmailConfig {
  tenant_id: string;
  resend_api_key: string | null;
  resend_webhook_secret: string | null;
  from_email: string | null;
  from_name: string | null;
  reply_to: string | null;
  company_address: string | null;
  company_name: string | null;
  app_url: string | null;
  is_active: boolean;
  domain_verified: boolean;
}

// Mantém alias antigo pra evitar refactor em massa em outros edges
export type TenantEmailConfig = EmailConfig;

/**
 * Lê a config de email do tenant.
 * Retorna null se não existir ainda.
 */
export async function getTenantConfig(
  supabase: any,
  tenantId: string,
): Promise<EmailConfig | null> {
  const { data, error } = await supabase
    .from("tenant_email_config")
    .select("*")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) {
    console.error(`Erro ao ler tenant_email_config (tenant=${tenantId}):`, error);
    return null;
  }
  return data || null;
}

// Alias antigo (compat) — chama getTenantConfig
export async function getEmailConfig(
  supabase: any,
  tenantId: string,
): Promise<EmailConfig | null> {
  return getTenantConfig(supabase, tenantId);
}

/**
 * Garante que config existe e tá ativa.
 * Lança erro se não estiver — edge function deve abortar.
 */
export function requireActiveConfig(
  config: EmailConfig | null,
  tenantId: string,
): EmailConfig {
  if (!config) {
    throw new Error(
      `tenant_email_config não encontrado para tenant ${tenantId}. ` +
      "Configure em Settings → Marketing → Email Config.",
    );
  }
  if (!config.is_active) {
    throw new Error(
      `Email marketing inativo para tenant ${tenantId}. ` +
      "Ative em Settings → Marketing → Email Config após verificar domínio no Resend.",
    );
  }
  if (!config.resend_api_key) {
    throw new Error(`resend_api_key faltando para tenant ${tenantId}.`);
  }
  if (!config.from_email) {
    throw new Error(`from_email faltando para tenant ${tenantId}.`);
  }
  return config;
}
