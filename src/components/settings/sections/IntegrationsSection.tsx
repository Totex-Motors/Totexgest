import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { toast as sonner } from "sonner";
import { supabase } from "@/lib/supabase";
import { useClicksignRegisterWebhook, useClicksignTest } from "@/hooks/useIntermediation";
import {
  Eye,
  EyeOff,
  Save,
  Loader2,
  CheckCircle2,
  XCircle,
  ExternalLink,
  PlugZap,
  Webhook,
  Info,
} from "lucide-react";

// =====================================================
// INTEGRATION DEFINITIONS
// =====================================================

interface IntegrationDef {
  key: string;
  label: string;
  description: string;
  placeholder: string;
  docsUrl?: string;
  category: "ai" | "whatsapp" | "telephony" | "payment" | "email" | "marketplace" | "signature" | "vehicle" | "other";
  // "tenant" → chave da loja (cada lojista paga a própria), gravada via RPC
  //            set_my_tenant_integration_key. "global" → infra central da Totex
  //            (Google OAuth, webhook secret do marketplace), gravada em `config`.
  scope?: "tenant" | "global";
  /** Valor de lista fechada (ex.: ambiente) — vira <Select> em vez de input mascarado. */
  options?: { value: string; label: string }[];
}

// Chaves que as edge functions leem por-tenant (espelha o allowlist da RPC
// set_my_tenant_integration_key). Tudo que não estiver aqui é tratado como global.
const TENANT_SCOPED_KEYS = new Set<string>([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "UAZAPI_ADMIN_URL",
  "UAZAPI_ADMIN_TOKEN",
  "WHATSAPP_CLOUD_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "SONIOX_API_KEY",
  "WAVOIP_API_KEY",
  "ASAAS_API_KEY",
  "RESEND_API_KEY",
  "CLICKSIGN_API_KEY",
  "CLICKSIGN_ENV",
  "CLICKSIGN_WEBHOOK_SECRET",
  "PUXAPLACA_TOKEN",
]);

const isTenantScoped = (key: string) => TENANT_SCOPED_KEYS.has(key);

const INTEGRATIONS: IntegrationDef[] = [
  // AI
  {
    key: "ANTHROPIC_API_KEY",
    label: "Anthropic (Claude)",
    description: "Usado pelo Agente de Vendas, Coach, CEO Bot e análises de IA",
    placeholder: "sk-ant-api03-...",
    docsUrl: "https://console.anthropic.com/settings/keys",
    category: "ai",
  },
  {
    key: "OPENAI_API_KEY",
    label: "OpenAI (GPT)",
    description: "Alternativa para análises e geração de conteúdo",
    placeholder: "sk-...",
    docsUrl: "https://platform.openai.com/api-keys",
    category: "ai",
  },
  {
    key: "GEMINI_API_KEY",
    label: "Google Gemini",
    description: "Alternativa para análises e geração de conteúdo",
    placeholder: "AIza...",
    docsUrl: "https://aistudio.google.com/app/apikey",
    category: "ai",
  },
  // WhatsApp
  {
    key: "UAZAPI_ADMIN_URL",
    label: "UAZAPI — URL do Servidor",
    description: "URL base do seu servidor UAZAPI. Todas as instâncias são criadas e gerenciadas a partir dessa URL.",
    placeholder: "https://meuservidor.uazapi.com",
    docsUrl: "https://uazapi.com",
    category: "whatsapp",
  },
  {
    key: "UAZAPI_ADMIN_TOKEN",
    label: "UAZAPI — Token Admin",
    description: "Token de administrador do UAZAPI. Necessário para criar/listar instâncias e configurar webhooks.",
    placeholder: "admin-token-...",
    docsUrl: "https://uazapi.com",
    category: "whatsapp",
  },
  {
    key: "WHATSAPP_CLOUD_TOKEN",
    label: "WhatsApp Cloud API — Token",
    description: "Token de acesso da API oficial do WhatsApp Business (Meta)",
    placeholder: "EAAx...",
    docsUrl: "https://developers.facebook.com/docs/whatsapp/cloud-api",
    category: "whatsapp",
  },
  {
    key: "WHATSAPP_PHONE_NUMBER_ID",
    label: "WhatsApp Cloud API — Phone Number ID",
    description: "ID do número do WhatsApp Business (Meta Dashboard > WhatsApp > API Setup)",
    placeholder: "663196283535436",
    docsUrl: "https://developers.facebook.com/docs/whatsapp/cloud-api/get-started",
    category: "whatsapp",
  },
  {
    key: "WHATSAPP_CLOUD_VERIFY_TOKEN",
    label: "WhatsApp Cloud API — Verify Token (webhook)",
    description: "Senha que VOCÊ inventa. Use o mesmo valor aqui e na configuração do webhook no painel da Meta. Usado só no handshake de validação do webhook.",
    placeholder: "ex: totex-stand-2026",
    docsUrl: "https://developers.facebook.com/docs/graph-api/webhooks/getting-started",
    category: "whatsapp",
    scope: "global",
  },
  // Telephony
  {
    key: "SONIOX_API_KEY",
    label: "Soniox",
    description: "Transcrição de áudio em tempo real para ligações",
    placeholder: "soniox_...",
    docsUrl: "https://soniox.com",
    category: "telephony",
  },
  // WaVoIP não usa chave global — o token é por device em /configuracoes > Telefonia (VoIP)
  // Payment
  {
    key: "ASAAS_API_KEY",
    label: "Asaas",
    description: "Gateway de pagamento: cobranças, boletos, PIX",
    placeholder: "$aact_...",
    docsUrl: "https://docs.asaas.com",
    category: "payment",
  },
  // Email
  {
    key: "RESEND_API_KEY",
    label: "Resend",
    description: "Envio de emails transacionais e campanhas",
    placeholder: "re_...",
    docsUrl: "https://resend.com/api-keys",
    category: "email",
  },
  // Assinatura eletrônica (Intermediação — fase 3)
  {
    key: "CLICKSIGN_API_KEY",
    label: "Clicksign — Access Token",
    description:
      "Assinatura eletrônica dos contratos de intermediação. Pegue em Clicksign › Configurações › API › Access Tokens. Sandbox e produção têm tokens DIFERENTES — o token precisa bater com o ambiente escolhido abaixo. Fica guardado só no servidor.",
    placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    docsUrl: "https://developers.clicksign.com",
    category: "signature",
  },
  {
    key: "CLICKSIGN_ENV",
    label: "Clicksign — Ambiente",
    description: "Sandbox pra testar sem valor jurídico (sandbox.clicksign.com); Produção pra valer (app.clicksign.com). Vazio = Sandbox.",
    placeholder: "sandbox",
    docsUrl: "https://developers.clicksign.com",
    category: "signature",
    options: [
      { value: "sandbox", label: "Sandbox (testes)" },
      { value: "production", label: "Produção" },
    ],
  },
  {
    key: "CLICKSIGN_WEBHOOK_SECRET",
    label: "Clicksign — Webhook Secret (HMAC)",
    description:
      "Preenchido automaticamente por \"Registrar webhook na Clicksign\". Só edite na mão se você cadastrou o webhook direto no painel da Clicksign — cole aqui o secret que ela mostrou.",
    placeholder: "preenchido ao registrar o webhook",
    docsUrl: "https://developers.clicksign.com",
    category: "signature",
  },
  // Marketplace
  {
    key: "MARKETPLACE_WEBHOOK_SECRET",
    label: "Marketplace — Webhook Secret",
    description:
      "Segredo compartilhado entre o marketplace totexmotors.com e o webhook marketplace-lead-webhook. Use o MESMO valor configurado em TOTEXGEST_WEBHOOK_SECRET no backend do marketplace. Gere um valor aleatório forte.",
    placeholder: "ex: cc64bf7e...984a5327 (32 bytes hex)",
    category: "marketplace",
  },
  // Consulta de placa
  {
    key: "PUXAPLACA_TOKEN",
    label: "PuxaPlaca — Token",
    description:
      "Token da API PuxaPlaca (consulta de veículo por placa). Autopreenche marca, modelo, ano, cor e combustível no cadastro da promotora e nos dados do contrato. Cada consulta é cobrada; o sistema guarda em cache por 30 dias e limita por dia.",
    placeholder: "ex: 07bffdef-c8d9-4c15-9088-...",
    docsUrl: "https://painel.puxaplaca.app",
    category: "vehicle",
  },
  // Google
  {
    key: "GOOGLE_CLIENT_ID",
    label: "Google Client ID",
    description: "ID do aplicativo OAuth do Google. Necessário para integração com Google Calendar e Meet",
    placeholder: "123456789-xxxxx.apps.googleusercontent.com",
    docsUrl: "https://console.cloud.google.com/apis/credentials",
    category: "other",
  },
  {
    key: "GOOGLE_CLIENT_SECRET",
    label: "Google Client Secret",
    description: "Secret do aplicativo OAuth do Google. Usado pela Edge Function para trocar tokens",
    placeholder: "GOCSPX-...",
    docsUrl: "https://console.cloud.google.com/apis/credentials",
    category: "other",
  },
];

const CATEGORY_LABELS: Record<string, string> = {
  ai: "Inteligência Artificial",
  whatsapp: "WhatsApp",
  telephony: "Telefonia",
  payment: "Pagamentos",
  email: "Email",
  marketplace: "Marketplace",
  signature: "Assinatura eletrônica (Clicksign)",
  vehicle: "Consulta de placa",
  other: "Google & Outros",
};

// =====================================================
// CLICKSIGN — testar conexão / registrar webhook
// =====================================================

function ClicksignActions({ hasToken, env, hasSecret, onRegistered }: {
  hasToken: boolean;
  env: string;
  hasSecret: boolean;
  onRegistered: () => void;
}) {
  const test = useClicksignTest();
  const register = useClicksignRegisterWebhook();
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const envLabel = env === "production" ? "Produção" : "Sandbox";

  const runTest = async () => {
    try {
      const r = await test.mutateAsync();
      sonner.success(`Conectado na Clicksign (${r.env === "production" ? "Produção" : "Sandbox"}).`);
    } catch (e) {
      sonner.error(e instanceof Error ? e.message : "Não consegui conectar na Clicksign.", {
        description: "Confira se o Access Token é do mesmo ambiente escolhido (sandbox × produção).",
      });
    }
  };

  const runRegister = async () => {
    try {
      const r = await register.mutateAsync();
      setEndpoint(r.endpoint);
      sonner.success("Webhook registrado na Clicksign. O secret foi guardado no servidor.", {
        description: r.endpoint ?? undefined,
      });
      onRegistered();
    } catch (e) {
      sonner.error(e instanceof Error ? e.message : "Não consegui registrar o webhook na Clicksign.");
    }
  };

  return (
    <Card className="border-dashed">
      <CardContent className="pt-4 pb-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="font-medium text-sm">Conexão e webhook</p>
            <p className="text-xs text-muted-foreground">
              Ambiente atual: <strong>{envLabel}</strong>. Salve o token e o ambiente antes de testar. O webhook avisa o CRM quando alguém visualiza, assina ou recusa o contrato.
            </p>
          </div>
          <Badge
            variant="secondary"
            className={`text-[10px] px-1.5 py-0 ${hasSecret ? "bg-green-500/10 text-green-400 border-green-500/20" : "bg-muted text-muted-foreground"}`}
          >
            {hasSecret ? "Webhook registrado" : "Webhook pendente"}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" className="h-9" onClick={runTest} disabled={!hasToken || test.isPending || register.isPending}>
            {test.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <PlugZap className="h-3.5 w-3.5 mr-1" />} Testar conexão
          </Button>
          <Button size="sm" className="h-9" onClick={runRegister} disabled={!hasToken || test.isPending || register.isPending}>
            {register.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Webhook className="h-3.5 w-3.5 mr-1" />} Registrar webhook na Clicksign
          </Button>
          {!hasToken && <span className="text-[11px] text-muted-foreground">Salve o Access Token primeiro.</span>}
        </div>
        {endpoint && (
          <p className="text-[11px] text-muted-foreground flex items-start gap-1">
            <Info className="h-3 w-3 shrink-0 mt-0.5" /> Endpoint registrado: <code className="break-all">{endpoint}</code>
          </p>
        )}
        <p className="text-[11px] text-muted-foreground flex items-start gap-1">
          <Info className="h-3 w-3 shrink-0 mt-0.5" /> Registrar de novo cria outro webhook na Clicksign e troca o secret aqui — se fizer isso, apague o antigo no painel dela (Configurações › Webhooks). Trocou de ambiente? Registre de novo.
        </p>
      </CardContent>
    </Card>
  );
}

// =====================================================
// MAIN COMPONENT
// =====================================================

export function IntegrationsSection() {
  const { toast } = useToast();
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [visibleKeys, setVisibleKeys] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);

  // Load existing keys on mount
  useEffect(() => {
    loadKeys();
  }, []);

  const loadKeys = async () => {
    try {
      const keyMap: Record<string, string> = {};

      // Chaves DO tenant (lojista paga as próprias) — via RPC SECURITY DEFINER.
      const { data: tenantData, error: tenantErr } = await supabase.rpc(
        "get_my_tenant_integration_keys"
      );
      if (tenantErr) {
        console.error("Error loading tenant integration keys:", tenantErr);
      } else {
        ((tenantData || []) as { key: string; value: string | null }[]).forEach((row) => {
          keyMap[row.key] = row.value || "";
        });
      }

      // Chaves globais/centrais (Google, webhook secret) — tabela `config`.
      const globalKeys = INTEGRATIONS.filter((i) => !isTenantScoped(i.key)).map(
        (i) => i.key
      );
      if (globalKeys.length > 0) {
        const { data: globalData, error: globalErr } = await supabase
          .from("config")
          .select("key, value")
          .in("key", globalKeys);
        if (globalErr) {
          console.error("Error loading global config keys:", globalErr);
        } else {
          ((globalData || []) as { key: string; value: string | null }[]).forEach((row) => {
            keyMap[row.key] = row.value || "";
          });
        }
      }

      setKeys(keyMap);
    } catch (err) {
      console.error("Error loading integration keys:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (integration: IntegrationDef) => {
    setSaving((prev) => ({ ...prev, [integration.key]: true }));
    try {
      const value = keys[integration.key] || "";

      if (isTenantScoped(integration.key)) {
        // Chave DO tenant — grava via RPC (escrita controlada por SECURITY DEFINER).
        const { error } = await supabase.rpc("set_my_tenant_integration_key", {
          p_key: integration.key,
          p_value: value,
        });
        if (error) throw error;
      } else {
        // Chave global/central — tabela `config`.
        const { error } = await supabase.from("config").upsert(
          { key: integration.key, value, updated_at: new Date().toISOString() },
          { onConflict: "key" }
        );
        if (error) throw error;
      }

      toast({ title: `${integration.label} salvo com sucesso` });
    } catch (err) {
      toast({
        title: "Erro ao salvar",
        description: "Verifique a conexão e tente novamente",
        variant: "destructive",
      });
    } finally {
      setSaving((prev) => ({ ...prev, [integration.key]: false }));
    }
  };

  const toggleVisibility = (key: string) => {
    setVisibleKeys((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const maskValue = (value: string) => {
    if (!value || value.length < 8) return "••••••••";
    return value.slice(0, 4) + "••••••••" + value.slice(-4);
  };

  // Group by category
  const grouped = INTEGRATIONS.reduce(
    (acc, integration) => {
      if (!acc[integration.category]) acc[integration.category] = [];
      acc[integration.category].push(integration);
      return acc;
    },
    {} as Record<string, IntegrationDef[]>
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="p-3 rounded-lg border border-amber-500/30 bg-amber-500/10">
        <p className="text-sm text-foreground/80">
          ⚠️ As chaves de API são armazenadas de forma segura no banco de dados e acessadas apenas
          pelas Edge Functions no servidor. Nunca são expostas no frontend.
        </p>
      </div>

      {Object.entries(grouped).map(([category, integrations]) => (
        <div key={category}>
          <h3 className="text-sm font-medium text-muted-foreground/80 uppercase tracking-wider mb-3">
            {CATEGORY_LABELS[category] || category}
          </h3>
          <div className="space-y-3">
            {integrations.map((integration) => {
              const value = keys[integration.key] || "";
              const isVisible = visibleKeys[integration.key];
              const isConfigured = !!value;
              const isSaving = saving[integration.key];

              return (
                <Card key={integration.key}>
                  <CardContent className="pt-4 pb-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <p className="font-medium text-sm">{integration.label}</p>
                          <Badge
                            variant={isConfigured ? "default" : "secondary"}
                            className={`text-[10px] px-1.5 py-0 ${
                              isConfigured
                                ? "bg-green-500/10 text-green-400 border-green-500/20"
                                : "bg-muted text-muted-foreground"
                            }`}
                          >
                            {isConfigured ? (
                              <span className="flex items-center gap-1">
                                <CheckCircle2 className="h-3 w-3" />
                                Configurado
                              </span>
                            ) : (
                              <span className="flex items-center gap-1">
                                <XCircle className="h-3 w-3" />
                                Pendente
                              </span>
                            )}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mb-3">
                          {integration.description}
                        </p>
                        <div className="flex items-center gap-2">
                          {integration.options ? (
                            <Select
                              value={value || integration.options[0].value}
                              onValueChange={(v) => setKeys((prev) => ({ ...prev, [integration.key]: v }))}
                            >
                              <SelectTrigger className="h-9 flex-1 text-xs"><SelectValue placeholder={integration.placeholder} /></SelectTrigger>
                              <SelectContent>
                                {integration.options.map((o) => (
                                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <div className="relative flex-1">
                              <Input
                                type={isVisible ? "text" : "password"}
                                value={keys[integration.key] || ""}
                                onChange={(e) =>
                                  setKeys((prev) => ({
                                    ...prev,
                                    [integration.key]: e.target.value,
                                  }))
                                }
                                placeholder={integration.placeholder}
                                className="pr-10 font-mono text-xs h-9"
                              />
                              <button
                                type="button"
                                onClick={() => toggleVisibility(integration.key)}
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                              >
                                {isVisible ? (
                                  <EyeOff className="h-4 w-4" />
                                ) : (
                                  <Eye className="h-4 w-4" />
                                )}
                              </button>
                            </div>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleSave(integration)}
                            disabled={isSaving}
                            className="h-9 px-3"
                          >
                            {isSaving ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Save className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </div>
                      </div>
                    </div>
                    {integration.docsUrl && (
                      <a
                        href={integration.docsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/60 hover:text-primary mt-2 transition-colors"
                      >
                        <ExternalLink className="h-3 w-3" />
                        Obter chave de API
                      </a>
                    )}
                  </CardContent>
                </Card>
              );
            })}
            {category === "signature" && (
              <ClicksignActions
                hasToken={!!keys.CLICKSIGN_API_KEY}
                env={keys.CLICKSIGN_ENV || "sandbox"}
                hasSecret={!!keys.CLICKSIGN_WEBHOOK_SECRET}
                onRegistered={() => { void loadKeys(); }}
              />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
