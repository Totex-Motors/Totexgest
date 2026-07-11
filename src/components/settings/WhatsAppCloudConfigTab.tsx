import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Phone,
  Plus,
  Pencil,
  Trash2,
  CheckCircle2,
  XCircle,
  Copy,
  ExternalLink,
  Loader2,
  Eye,
  EyeOff,
  ChevronDown,
  ShieldCheck,
  Info,
  AlertTriangle,
  Sparkles,
} from "lucide-react";

// ============================================================
// Tipagem do Facebook JS SDK (Embedded Signup / Coexistência)
// ============================================================
declare global {
  interface Window {
    FB?: any;
    fbAsyncInit?: () => void;
  }
}

const FB_SDK_VERSION = "v22.0";

// ============================================================
// WhatsApp Cloud API (Meta oficial) — Settings Tab
// ============================================================
// Admin cadastra/edita instância Meta Cloud API por tenant.
// Tudo persistido em whatsapp_instances (provider='meta_cloud').
// Credencial per-tenant — NUNCA global/hardcoded.
// ============================================================

interface CloudInstance {
  id: string;
  tenant_id: string;
  name: string;
  api_key: string;            // token permanente Meta
  phone_number_id: string;
  business_account_id: string | null;
  verify_token: string | null;
  status: string;
  purpose: string;
  pipeline_ids: string[] | null; // null/[] = aparece em todos os pipelines
  created_at: string;
}

const WEBHOOK_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/whatsapp-cloud-webhook`;

// ============================================================
// Carrega o Facebook JS SDK uma única vez e inicializa com o appId.
// ============================================================
function loadFacebookSDK(appId: string): Promise<void> {
  return new Promise((resolve) => {
    // Se já carregou e inicializou, resolve direto.
    if (window.FB) {
      resolve();
      return;
    }

    window.fbAsyncInit = function () {
      window.FB.init({
        appId,
        autoLogAppEvents: true,
        xfbml: true,
        version: FB_SDK_VERSION,
      });
      resolve();
    };

    // Evita injetar o script duas vezes.
    if (document.getElementById("facebook-jssdk")) {
      // Script já está no DOM mas FB ainda não pronto — aguarda fbAsyncInit.
      return;
    }

    const script = document.createElement("script");
    script.id = "facebook-jssdk";
    script.src = "https://connect.facebook.net/en_US/sdk.js";
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    document.body.appendChild(script);
  });
}

export function WhatsAppCloudConfigTab() {
  const { tenantId, isAdmin, isSuperAdmin } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<CloudInstance | null>(null);
  const [connecting, setConnecting] = useState(false);
  // Guarda waba_id/phone_number_id capturados pelo listener de mensagens do popup.
  const signupDataRef = useRef<{ waba_id?: string; phone_number_id?: string }>({});

  const canEdit = isAdmin || isSuperAdmin;

  // ---- Embedded Signup (Coexistência) ----------------------
  const handleCoexistenceConnect = async () => {
    if (connecting) return;
    setConnecting(true);
    signupDataRef.current = {};

    try {
      // 1) Busca app_id + config_id do backend (lidos da config table).
      const { data: cfg, error: cfgErr } = await supabase.functions.invoke(
        "whatsapp-embedded-signup",
        { body: { action: "config" } }
      );
      if (cfgErr) throw cfgErr;
      if (cfg?.error || !cfg?.app_id || !cfg?.config_id) {
        toast({
          title: "Configuração pendente",
          description:
            cfg?.error ||
            "Configure META_APP_ID e EMBEDDED_SIGNUP_CONFIG_ID em Configurações → Integrações.",
          variant: "destructive",
        });
        setConnecting(false);
        return;
      }

      // 2) Carrega o FB SDK e inicializa.
      await loadFacebookSDK(cfg.app_id);

      // 3) Listener pra capturar waba_id / phone_number_id do popup.
      const messageListener = (event: MessageEvent) => {
        if (
          event.origin !== "https://www.facebook.com" &&
          event.origin !== "https://web.facebook.com"
        ) {
          return;
        }
        try {
          const parsed = JSON.parse(event.data);
          if (parsed.type === "WA_EMBEDDED_SIGNUP") {
            const d = parsed.data || {};
            if (d.waba_id) signupDataRef.current.waba_id = d.waba_id;
            if (d.phone_number_id) signupDataRef.current.phone_number_id = d.phone_number_id;
          }
        } catch {
          // mensagem não-JSON — ignora.
        }
      };
      window.addEventListener("message", messageListener);

      const cleanup = () => {
        window.removeEventListener("message", messageListener);
        setConnecting(false);
      };

      // 4) Dispara o FB.login com o fluxo de coexistência.
      window.FB.login(
        async (response: any) => {
          const authCode = response?.authResponse?.code;
          if (!authCode) {
            toast({
              title: "Conexão cancelada",
              description: "O login com a Meta foi cancelado ou não retornou o código.",
            });
            cleanup();
            return;
          }

          try {
            const { data: ex, error: exErr } = await supabase.functions.invoke(
              "whatsapp-embedded-signup",
              {
                body: {
                  action: "exchange",
                  code: authCode,
                  waba_id: signupDataRef.current.waba_id,
                  phone_number_id: signupDataRef.current.phone_number_id,
                  tenant_id: tenantId,
                },
              }
            );
            if (exErr) throw exErr;
            if (!ex?.success) {
              toast({
                title: "Falha ao conectar",
                description: ex?.error || "Não foi possível concluir a conexão.",
                variant: "destructive",
              });
              cleanup();
              return;
            }

            toast({
              title: "Número conectado!",
              description: "Seu WhatsApp foi conectado via coexistência sem perder conversas.",
            });
            queryClient.invalidateQueries({ queryKey: ["whatsapp-cloud-instances", tenantId] });
          } catch (err: any) {
            toast({
              title: "Erro ao conectar",
              description: err?.message || "Erro inesperado ao trocar o código.",
              variant: "destructive",
            });
          } finally {
            cleanup();
          }
        },
        {
          config_id: cfg.config_id,
          response_type: "code",
          override_default_response_type: true,
          extras: {
            setup: {},
            featureType: "whatsapp_business_app_onboarding",
            sessionInfoVersion: "3",
          },
        }
      );
    } catch (err: any) {
      toast({
        title: "Erro",
        description: err?.message || "Não foi possível iniciar o Embedded Signup.",
        variant: "destructive",
      });
      setConnecting(false);
    }
  };

  const { data: instances = [], isLoading } = useQuery({
    queryKey: ["whatsapp-cloud-instances", tenantId],
    queryFn: async (): Promise<CloudInstance[]> => {
      if (!tenantId) return [];
      const { data, error } = await supabase
        .from("whatsapp_instances")
        .select("id, tenant_id, name, api_key, phone_number_id, business_account_id, verify_token, status, purpose, pipeline_ids, created_at")
        .eq("tenant_id", tenantId)
        .eq("provider", "meta_cloud")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data || []) as CloudInstance[];
    },
    enabled: !!tenantId,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("whatsapp_instances")
        .delete()
        .eq("id", id)
        .eq("tenant_id", tenantId!);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-cloud-instances", tenantId] });
      toast({ title: "Instância removida" });
    },
    onError: (err: any) => toast({ title: "Erro ao remover", description: err.message, variant: "destructive" }),
  });

  const openCreate = () => {
    setEditing(null);
    setModalOpen(true);
  };

  const openEdit = (instance: CloudInstance) => {
    setEditing(instance);
    setModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Remover esta instância? Esta ação não pode ser desfeita.")) return;
    await deleteMutation.mutateAsync(id);
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast({ title: `${label} copiado` });
  };

  if (!canEdit) {
    return (
      <Alert>
        <ShieldCheck className="h-4 w-4" />
        <AlertTitle>Restrito a administradores</AlertTitle>
        <AlertDescription>Apenas admins do tenant podem configurar a WhatsApp Cloud API.</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header com webhook URL pra copiar */}
      <Card className="border-accent/30 bg-accent/5">
        <CardHeader className="pb-3">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 h-8 w-8 rounded-md bg-accent/20 flex items-center justify-center shrink-0">
              <Info className="h-4 w-4 text-accent" />
            </div>
            <div className="flex-1 min-w-0">
              <CardTitle className="text-base">Webhook URL para a Meta</CardTitle>
              <CardDescription className="text-xs mt-1">
                Use esta URL ao configurar o webhook no Meta Developer Console. O Verify Token você define em cada instância abaixo.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 p-3 rounded-md bg-background border font-mono text-xs break-all">
            <code className="flex-1 min-w-0">{WEBHOOK_URL}</code>
            <Button variant="ghost" size="icon" onClick={() => copyToClipboard(WEBHOOK_URL, "URL")}>
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </div>
          <a
            href="https://developers.facebook.com/apps/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 mt-3 text-xs text-accent hover:underline"
          >
            Abrir Meta Developer Console
            <ExternalLink className="h-3 w-3" />
          </a>
        </CardContent>
      </Card>

      {/* Lista de instâncias */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>Números oficiais cadastrados</CardTitle>
            <CardDescription>
              Cada instância representa um número oficial verificado na Meta. Credenciais ficam isoladas por tenant.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              onClick={handleCoexistenceConnect}
              size="sm"
              variant="default"
              disabled={connecting}
              className="bg-green-600 hover:bg-green-700 text-white"
            >
              {connecting ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4 mr-2" />
              )}
              Conectar com Meta (Coexistência)
            </Button>
            <Button onClick={openCreate} size="sm" variant="outline">
              <Plus className="h-4 w-4 mr-2" />
              Nova instância
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <Alert className="mb-4 border-green-500/30 bg-green-500/5">
            <Sparkles className="h-4 w-4 text-green-600" />
            <AlertTitle className="text-sm">Coexistência — conecte o número que você já usa</AlertTitle>
            <AlertDescription className="text-xs">
              Use coexistência pra conectar um número que você já usa no app WhatsApp Business,
              sem perder conversas. Clique em <strong>"Conectar com Meta (Coexistência)"</strong> e
              siga o popup oficial da Meta. O cadastro manual continua disponível em "Nova instância".
            </AlertDescription>
          </Alert>
          {isLoading ? (
            <div className="text-center py-8 text-muted-foreground text-sm">
              <Loader2 className="h-5 w-5 animate-spin inline mr-2" />
              Carregando...
            </div>
          ) : instances.length === 0 ? (
            <EmptyState onCreate={openCreate} />
          ) : (
            <div className="space-y-3">
              {instances.map((inst) => (
                <InstanceRow
                  key={inst.id}
                  instance={inst}
                  onEdit={() => openEdit(inst)}
                  onDelete={() => handleDelete(inst.id)}
                  onCopy={copyToClipboard}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Documentação colapsada */}
      <Collapsible>
        <CollapsibleTrigger className="w-full">
          <div className="flex items-center justify-between p-4 rounded-lg border bg-muted/30 hover:bg-muted/50 transition-colors text-left">
            <div className="flex items-center gap-3">
              <Info className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Como configurar do zero (passo-a-passo)</span>
            </div>
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2">
          <Card>
            <CardContent className="pt-6 text-sm space-y-3 leading-relaxed">
              <ol className="list-decimal list-inside space-y-2 text-muted-foreground">
                <li>Acesse <a href="https://business.facebook.com" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">business.facebook.com</a> e crie/selecione sua conta comercial Meta.</li>
                <li>Vá em <a href="https://developers.facebook.com/apps/" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">developers.facebook.com/apps</a> → criar App → tipo "Empresa".</li>
                <li>No app, adicione o produto <strong>WhatsApp</strong>.</li>
                <li>Em <strong>WhatsApp → Configuração da API</strong>, anote o <strong>Phone Number ID</strong> e o <strong>WhatsApp Business Account ID</strong> (WABA ID).</li>
                <li>Verifique um número próprio (ou use o número de teste inicialmente).</li>
                <li>Gere um <strong>Token Permanente</strong> via System User com permissões <code className="px-1 py-0.5 bg-muted rounded">whatsapp_business_messaging</code> + <code className="px-1 py-0.5 bg-muted rounded">whatsapp_business_management</code>.</li>
                <li>Clique em <strong>"Nova instância"</strong> aqui em cima e preencha com os dados que anotou.</li>
                <li>Defina um <strong>Verify Token</strong> (qualquer string — só a gente precisa bater com a Meta).</li>
                <li><strong>Validar a URL do webhook</strong> — Meta Console → <strong>WhatsApp → Configuração → Webhook → Editar</strong>:
                  <ul className="list-disc list-inside ml-4 mt-1">
                    <li>Callback URL: copie do topo desta página</li>
                    <li>Verify Token: igual ao que salvou aqui</li>
                    <li>Clique <strong>Verificar e salvar</strong></li>
                  </ul>
                </li>
                <li><strong className="text-foreground">Inscrever o campo <code className="px-1 py-0.5 bg-muted rounded">messages</code></strong> — na MESMA tela, em <strong>"Campos do webhook"</strong> → <strong>Gerenciar</strong> → marque <code className="px-1 py-0.5 bg-muted rounded">messages</code> (e <code className="px-1 py-0.5 bg-muted rounded">message_template_status_update</code>). <span className="text-foreground">Sem isso você envia, mas NÃO recebe as respostas no CRM.</span></li>
                <li>Aprove seus templates na Meta e sincronize aqui em <em>Templates Cloud</em> (próxima seção).</li>
              </ol>
              <Alert className="border-amber-500/40 bg-amber-500/5">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                <AlertTitle className="text-sm">Validar a URL ≠ Receber mensagem</AlertTitle>
                <AlertDescription className="text-xs">
                  São dois passos separados. Validar a Callback URL só confirma o endereço.
                  Pra as <strong>respostas dos leads caírem no CRM</strong>, é obrigatório <strong>Inscrever-se (Subscribe) no campo <code className="px-1 py-0.5 bg-muted rounded">messages</code></strong> (passo 10). É o erro mais comum.
                </AlertDescription>
              </Alert>
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription className="text-xs">
                  UAZAPI continua funcionando normalmente em paralelo. Esta integração é complementar, não substitui.
                </AlertDescription>
              </Alert>
            </CardContent>
          </Card>
        </CollapsibleContent>
      </Collapsible>

      {/* Modal criar/editar */}
      <InstanceFormModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        instance={editing}
        tenantId={tenantId!}
        onSaved={() => {
          queryClient.invalidateQueries({ queryKey: ["whatsapp-cloud-instances", tenantId] });
          setModalOpen(false);
        }}
      />
    </div>
  );
}

// ============================================================
// Empty State
// ============================================================

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="text-center py-10">
      <div className="mx-auto h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-3">
        <Phone className="h-5 w-5 text-muted-foreground" />
      </div>
      <h3 className="text-sm font-medium mb-1">Nenhum número oficial cadastrado</h3>
      <p className="text-xs text-muted-foreground max-w-sm mx-auto mb-4">
        Cadastre seu primeiro número da WhatsApp Cloud API para começar a enviar mensagens via API oficial da Meta.
      </p>
      <Button onClick={onCreate} variant="outline" size="sm">
        <Plus className="h-4 w-4 mr-2" />
        Cadastrar primeiro número
      </Button>
    </div>
  );
}

// ============================================================
// Instance Row
// ============================================================

function InstanceRow({
  instance,
  onEdit,
  onDelete,
  onCopy,
}: {
  instance: CloudInstance;
  onEdit: () => void;
  onDelete: () => void;
  onCopy: (text: string, label: string) => void;
}) {
  const [showSecrets, setShowSecrets] = useState(false);

  const maskToken = (token: string) => {
    if (!token) return "—";
    return token.length > 16 ? `${token.slice(0, 6)}...${token.slice(-4)}` : "***";
  };

  return (
    <div className="p-4 border rounded-lg bg-card hover:shadow-sm transition-shadow">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="flex items-start gap-3 min-w-0 flex-1">
          <div className="h-10 w-10 rounded-md bg-green-50 border border-green-200 flex items-center justify-center shrink-0">
            <Phone className="h-4 w-4 text-green-700" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h4 className="font-medium text-sm truncate">{instance.name}</h4>
              <Badge variant="outline" className="text-[10px] bg-green-50 text-green-700 border-green-200">
                Meta Oficial
              </Badge>
              {instance.status === "connected" && (
                <Badge variant="outline" className="text-[10px] bg-blue-50 text-blue-700 border-blue-200">
                  Conectado
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 capitalize">{instance.purpose}</p>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="icon" onClick={() => setShowSecrets((s) => !s)} title="Mostrar/ocultar credenciais">
            {showSecrets ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
          <Button variant="ghost" size="icon" onClick={onEdit}>
            <Pencil className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={onDelete}>
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      </div>

      <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-xs">
        <FieldRow label="Phone Number ID" value={instance.phone_number_id} onCopy={() => onCopy(instance.phone_number_id, "Phone Number ID")} />
        <FieldRow label="WABA ID" value={instance.business_account_id || "—"} onCopy={instance.business_account_id ? () => onCopy(instance.business_account_id!, "WABA ID") : undefined} />
        <FieldRow
          label="Verify Token"
          value={showSecrets ? (instance.verify_token || "—") : maskToken(instance.verify_token || "")}
          onCopy={instance.verify_token ? () => onCopy(instance.verify_token!, "Verify Token") : undefined}
        />
        <FieldRow
          label="Token Meta"
          value={showSecrets ? instance.api_key : maskToken(instance.api_key)}
          onCopy={() => onCopy(instance.api_key, "Token Meta")}
        />
      </dl>

      <PipelinesAccessRow instance={instance} />
    </div>
  );
}

// ============================================================
// Pipelines de acesso da instance — multi-select inline
// ============================================================
function PipelinesAccessRow({ instance }: { instance: CloudInstance }) {
  const { tenantId } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);

  const { data: pipelines = [] } = useQuery({
    queryKey: ["sales-pipelines-list", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sales_pipelines")
        .select("id, name")
        .order("name");
      if (error) throw error;
      return (data || []) as { id: string; name: string }[];
    },
    enabled: !!tenantId,
  });

  const updateMutation = useMutation({
    mutationFn: async (ids: string[] | null) => {
      const { error } = await supabase
        .from("whatsapp_instances")
        .update({ pipeline_ids: ids })
        .eq("id", instance.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-cloud-instances", tenantId] });
      queryClient.invalidateQueries({ queryKey: ["available-whatsapp-instances"] });
      toast({ title: "Pipelines da instance atualizados" });
    },
    onError: (e: any) => toast({ title: "Erro", description: e.message, variant: "destructive" }),
  });

  const selectedIds = instance.pipeline_ids || [];
  const hasRestriction = selectedIds.length > 0;
  const selectedNames = pipelines
    .filter(p => selectedIds.includes(p.id))
    .map(p => p.name);

  const togglePipeline = (id: string) => {
    const current = selectedIds.includes(id) ? selectedIds.filter(x => x !== id) : [...selectedIds, id];
    updateMutation.mutate(current.length > 0 ? current : null);
  };

  return (
    <div className="mt-3 pt-3 border-t border-dashed">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
          <span>Pipelines onde aparece</span>
        </div>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="text-[11px] text-blue-600 hover:underline"
        >
          {open ? 'Ocultar' : 'Editar'}
        </button>
      </div>
      <div className="text-xs">
        {hasRestriction ? (
          <div className="flex flex-wrap gap-1">
            {selectedNames.map(n => (
              <Badge key={n} variant="outline" className="text-[10px] bg-blue-50 text-blue-700 border-blue-200">
                {n}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground italic">Todos os pipelines (sem restrição)</span>
        )}
      </div>
      {open && (
        <div className="mt-2 p-2 rounded-md bg-muted/40 border border-border/50 space-y-1.5">
          {pipelines.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nenhum pipeline cadastrado.</p>
          ) : (
            pipelines.map(p => (
              <label key={p.id} className="flex items-center gap-2 cursor-pointer hover:bg-background rounded px-1.5 py-1 transition-colors">
                <input
                  type="checkbox"
                  checked={selectedIds.includes(p.id)}
                  onChange={() => togglePipeline(p.id)}
                  disabled={updateMutation.isPending}
                  className="h-3.5 w-3.5 rounded border-muted-foreground/30"
                />
                <span className="text-xs">{p.name}</span>
              </label>
            ))
          )}
          <p className="text-[10px] text-muted-foreground pt-1 border-t border-border/50 mt-1">
            Marque os pipelines onde essa instance deve aparecer no chat. Desmarcar todos = aparece em todos.
          </p>
        </div>
      )}
    </div>
  );
}

function FieldRow({ label, value, onCopy }: { label: string; value: string; onCopy?: () => void }) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <dt className="text-muted-foreground text-[11px] uppercase tracking-wider shrink-0 w-[110px]">{label}</dt>
      <dd className="font-mono text-xs truncate flex-1 min-w-0">{value}</dd>
      {onCopy && (
        <button
          type="button"
          onClick={onCopy}
          className="shrink-0 h-6 w-6 rounded hover:bg-muted flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
          title="Copiar"
        >
          <Copy className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

// ============================================================
// Form Modal — Criar/Editar instância
// ============================================================

interface FormData {
  name: string;
  phone_number_id: string;
  business_account_id: string;
  api_key: string;
  verify_token: string;
  purpose: "inbox" | "campaign";
}

function InstanceFormModal({
  open,
  onOpenChange,
  instance,
  tenantId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  instance: CloudInstance | null;
  tenantId: string;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormData>({
    name: "",
    phone_number_id: "",
    business_account_id: "",
    api_key: "",
    verify_token: "",
    purpose: "inbox",
  });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"ok" | "fail" | null>(null);
  const [saving, setSaving] = useState(false);

  // Reset quando abrir/editar
  useEffect(() => {
    if (!open) return;
    setForm(
      instance
        ? {
            name: instance.name,
            phone_number_id: instance.phone_number_id || "",
            business_account_id: instance.business_account_id || "",
            api_key: instance.api_key || "",
            verify_token: instance.verify_token || "",
            purpose: (instance.purpose as any) || "inbox",
          }
        : {
            name: "",
            phone_number_id: "",
            business_account_id: "",
            api_key: "",
            verify_token: autoGenerateVerifyToken(),
            purpose: "inbox",
          }
    );
    setTestResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, instance?.id]);

  const update = (patch: Partial<FormData>) => {
    setForm((f) => ({ ...f, ...patch }));
    setTestResult(null);
  };

  const testConnection = async () => {
    if (!form.phone_number_id || !form.api_key) {
      toast({ title: "Preencha Phone Number ID e Token antes", variant: "destructive" });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      // Testa chamando a Graph API pra ler o próprio número
      const res = await fetch(`https://graph.facebook.com/v22.0/${form.phone_number_id}?fields=display_phone_number,verified_name,quality_rating`, {
        headers: { Authorization: `Bearer ${form.api_key}` },
      });
      const data = await res.json();
      const ok = res.ok;
      setTestResult(ok ? "ok" : "fail");

      // Persiste o resultado verificado no status (fonte única de prontidão).
      // Só quando a instância já existe (no modo criação, o status é definido ao salvar).
      if (instance?.id) {
        await supabase
          .from("whatsapp_instances")
          .update({ status: ok ? "connected" : "disconnected" })
          .eq("id", instance.id)
          .eq("tenant_id", tenantId);
        queryClient.invalidateQueries({ queryKey: ["whatsapp-cloud-instances", tenantId] });
        queryClient.invalidateQueries({ queryKey: ["available-whatsapp-instances"] });
      }

      toast(
        ok
          ? { title: "Conectado com sucesso", description: `${data.verified_name || data.display_phone_number || "número"} respondeu OK` }
          : { title: "Conexão falhou", description: data.error?.message || "Token ou Phone Number ID inválido", variant: "destructive" }
      );
    } catch (err: any) {
      setTestResult("fail");
      toast({ title: "Erro de rede", description: err.message, variant: "destructive" });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!form.name || !form.phone_number_id || !form.api_key || !form.verify_token) {
      toast({ title: "Preencha todos os campos obrigatórios", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      // Prontidão da Cloud API = ter credenciais válidas. Ao salvar, marca connected
      // (a menos que um teste explícito tenha falhado). status é a fonte única de prontidão.
      const readyStatus = testResult === "fail" ? "disconnected" : "connected";
      if (instance) {
        // Update
        const { error } = await supabase
          .from("whatsapp_instances")
          .update({
            name: form.name,
            phone_number_id: form.phone_number_id,
            business_account_id: form.business_account_id || null,
            api_key: form.api_key,
            verify_token: form.verify_token,
            purpose: form.purpose,
            status: readyStatus,
          })
          .eq("id", instance.id)
          .eq("tenant_id", tenantId);
        if (error) throw error;
        toast({ title: "Instância atualizada" });
      } else {
        // Create
        const { error } = await supabase.from("whatsapp_instances").insert({
          tenant_id: tenantId,
          name: form.name,
          provider: "meta_cloud",
          api_key: form.api_key,
          api_url: "https://graph.facebook.com",
          webhook_url: WEBHOOK_URL,
          phone_number_id: form.phone_number_id,
          business_account_id: form.business_account_id || null,
          verify_token: form.verify_token,
          status: readyStatus,
          purpose: form.purpose,
          metadata: { created_via: "settings_ui", cloud_api: true },
        });
        if (error) throw error;
        toast({ title: "Instância criada" });
      }
      onSaved();
    } catch (err: any) {
      toast({ title: "Erro ao salvar", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[580px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{instance ? "Editar instância Cloud API" : "Nova instância Cloud API"}</DialogTitle>
          <DialogDescription>
            Credenciais obtidas em <a href="https://developers.facebook.com/apps/" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">developers.facebook.com/apps</a>. Todas isoladas por tenant.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="name">
              Nome <span className="text-destructive">*</span>
            </Label>
            <Input
              id="name"
              placeholder="Ex: Vendas — Oficial"
              value={form.name}
              onChange={(e) => update({ name: e.target.value })}
            />
            <p className="text-[11px] text-muted-foreground">Nome interno pra identificação. Não aparece pro lead.</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="phone_number_id">
                Phone Number ID <span className="text-destructive">*</span>
              </Label>
              <Input
                id="phone_number_id"
                placeholder="663196283535436"
                value={form.phone_number_id}
                onChange={(e) => update({ phone_number_id: e.target.value })}
                className="font-mono text-sm"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="waba_id">WABA ID</Label>
              <Input
                id="waba_id"
                placeholder="123456789012345"
                value={form.business_account_id}
                onChange={(e) => update({ business_account_id: e.target.value })}
                className="font-mono text-sm"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="api_key">
              Token Permanente (System User) <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="api_key"
              placeholder="EAA..."
              value={form.api_key}
              onChange={(e) => update({ api_key: e.target.value })}
              className="font-mono text-xs min-h-[70px]"
              rows={3}
            />
            <p className="text-[11px] text-muted-foreground">
              Gerado em Meta Business → Configurações → Usuários do sistema → Gerar token.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="verify_token">
              Verify Token (webhook) <span className="text-destructive">*</span>
            </Label>
            <div className="flex gap-2">
              <Input
                id="verify_token"
                placeholder="qualquer_string_aleatoria"
                value={form.verify_token}
                onChange={(e) => update({ verify_token: e.target.value })}
                className="font-mono text-sm flex-1"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => update({ verify_token: autoGenerateVerifyToken() })}
                title="Gerar novo"
              >
                Gerar
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Use esta mesma string ao configurar o webhook na Meta Console.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="purpose">Finalidade</Label>
            <div className="flex gap-2">
              {(["inbox", "campaign"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => update({ purpose: p })}
                  className={cn(
                    "flex-1 px-3 py-2 rounded-md border text-sm transition-colors capitalize",
                    form.purpose === p
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-background hover:bg-muted"
                  )}
                >
                  {p === "inbox" ? "Inbox (atendimento)" : "Campanha (disparo)"}
                </button>
              ))}
            </div>
          </div>

          {/* Test connection */}
          <div className="pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={testConnection}
              disabled={testing || !form.phone_number_id || !form.api_key}
              className="w-full"
            >
              {testing ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Testando...</>
              ) : testResult === "ok" ? (
                <><CheckCircle2 className="h-4 w-4 mr-2 text-green-600" /> Conexão OK — clique pra testar novamente</>
              ) : testResult === "fail" ? (
                <><XCircle className="h-4 w-4 mr-2 text-destructive" /> Falhou — revisar credenciais</>
              ) : (
                <>Testar conexão com a Meta</>
              )}
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={handleSave} disabled={saving || !form.name || !form.phone_number_id || !form.api_key || !form.verify_token}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {instance ? "Salvar" : "Criar instância"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// Utils
// ============================================================

function autoGenerateVerifyToken(): string {
  // 24 chars alfanuméricos
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "cb_";
  for (let i = 0; i < 24; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
