import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Instagram, Plus, Pencil, Trash2, Loader2, Eye, EyeOff, Copy, CheckCircle2,
  XCircle, AlertTriangle, Info, Megaphone, FlaskConical,
} from "lucide-react";

// ============================================================
// Instagram Oficial (API Meta) — CONFIGURAÇÃO da conta
// ============================================================
// Só o que se mexe uma vez: tokens da conta, webhook e modo teste.
// Campanhas e gatilhos (operação diária) vivem em
// Marketing → Campanhas Instagram (/marketing/instagram).
//
// A regra da Meta que define tudo: DM só sai em 2 situações —
// respondendo um COMENTÁRIO (1x, até 7 dias) ou dentro da janela
// de 24h depois que a pessoa mandou DM. Comentário NÃO abre a janela.
// ============================================================

const WEBHOOK_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/instagram-webhook`;

interface IgAccount {
  id: string;
  tenant_id: string;
  instagram_username: string;
  name: string;
  instagram_business_id: string | null;
  access_token: string;
  ig_login_id: string | null;
  ig_login_token: string | null;
  facebook_page_id: string | null;
  page_access_token: string | null;
  webhook_verify_token: string | null;
  status: string;
}

function SecretInput({ value, onChange, placeholder }: {
  value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="pr-10 font-mono text-xs"
      />
      <Button
        type="button" variant="ghost" size="icon"
        className="absolute right-0 top-0 h-full w-10"
        onClick={() => setShow((s) => !s)}
      >
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </Button>
    </div>
  );
}

// ============================================================
// 1. CONTA CONECTADA
// ============================================================
function AccountSection({ tenantId }: { tenantId: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<IgAccount | null>(null);

  const { data: accounts = [], isLoading } = useQuery({
    queryKey: ["ig-accounts", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("instagram_business_accounts")
        .select("*")
        .eq("tenant_id", tenantId)
        .order("created_at");
      if (error) throw error;
      return (data || []) as IgAccount[];
    },
    enabled: !!tenantId,
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("instagram_business_accounts")
        .delete().eq("id", id).eq("tenant_id", tenantId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ig-accounts", tenantId] });
      toast({ title: "Conta removida" });
    },
    onError: (e: Error) => toast({ title: "Erro", description: e.message, variant: "destructive" }),
  });

  const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast({ title: `${label} copiado` });
  };

  return (
    <div className="space-y-4">
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Publique o app na Meta (Live) ANTES de testar</AlertTitle>
        <AlertDescription className="text-sm">
          Com o app em <strong>Development Mode</strong>, a API da Meta responde{" "}
          <strong>200 com corpo vazio</strong> pra tudo — sem mensagem de erro nenhuma.
          Você vai achar que é token, permissão ou endpoint e perder horas. Se algo
          "funciona mas não acontece nada", confira o modo do app primeiro.
        </AlertDescription>
      </Alert>

      <Alert>
        <Info className="h-4 w-4" />
        <AlertTitle>Use o flavor "Instagram API with Instagram Login"</AlertTitle>
        <AlertDescription className="space-y-1 text-sm">
          <p>
            Esse é o caminho que libera envio de DM da própria conta profissional
            <strong> sem App Review</strong> (Standard Access). O caminho antigo, via
            Página do Facebook, exige revisão da Meta.
          </p>
          <p className="text-muted-foreground">
            Você precisa de dois pares: <code>ig_login_token</code> + <code>ig_login_id</code> (envio
            de DM) e <code>access_token</code> + <code>instagram_business_id</code> (leitura de
            comentários e perfis).
          </p>
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Instagram className="h-5 w-5" /> Contas conectadas
              </CardTitle>
              <CardDescription>
                Cada conta do Instagram que o CRM opera (inbox, agente e campanhas).
              </CardDescription>
            </div>
            <Button onClick={() => { setEditing(null); setModalOpen(true); }}>
              <Plus className="mr-2 h-4 w-4" /> Conectar conta
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading && <Loader2 className="h-5 w-5 animate-spin" />}
          {!isLoading && accounts.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Nenhuma conta conectada ainda. Clique em "Conectar conta" e cole os tokens da Meta.
            </p>
          )}
          {accounts.map((a) => (
            <div key={a.id} className="flex items-center justify-between rounded-lg border p-3">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">@{a.instagram_username}</span>
                  {a.status === "connected"
                    ? <Badge variant="secondary" className="gap-1"><CheckCircle2 className="h-3 w-3" /> conectada</Badge>
                    : <Badge variant="outline" className="gap-1"><XCircle className="h-3 w-3" /> {a.status}</Badge>}
                  {a.ig_login_token && a.ig_login_id
                    ? <Badge variant="outline">envio: IG Login</Badge>
                    : a.page_access_token
                      ? <Badge variant="outline">envio: Página (fallback)</Badge>
                      : <Badge variant="destructive">sem token de envio</Badge>}
                </div>
                <p className="text-xs text-muted-foreground">{a.name}</p>
              </div>
              <div className="flex gap-1">
                <Button variant="ghost" size="icon" onClick={() => { setEditing(a); setModalOpen(true); }}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" onClick={() => {
                  if (confirm(`Remover @${a.instagram_username}? As conversas ficam no inbox.`)) del.mutate(a.id);
                }}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Webhook da Meta</CardTitle>
          <CardDescription>
            Cole essa URL no app da Meta e assine os campos <strong>comments</strong> e{" "}
            <strong>messages</strong>. Sem assinar os campos, a URL valida mas nada chega.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex gap-2">
            <Input readOnly value={WEBHOOK_URL} className="font-mono text-xs" />
            <Button variant="outline" size="icon" onClick={() => copy(WEBHOOK_URL, "URL")}>
              <Copy className="h-4 w-4" />
            </Button>
          </div>
          {accounts[0]?.webhook_verify_token && (
            <div className="flex gap-2">
              <Input readOnly value={accounts[0].webhook_verify_token} className="font-mono text-xs" />
              <Button variant="outline" size="icon"
                onClick={() => copy(accounts[0].webhook_verify_token!, "Verify token")}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <AccountModal
        open={modalOpen} onOpenChange={setModalOpen}
        account={editing} tenantId={tenantId}
        onSaved={() => qc.invalidateQueries({ queryKey: ["ig-accounts", tenantId] })}
      />
    </div>
  );
}

function AccountModal({ open, onOpenChange, account, tenantId, onSaved }: {
  open: boolean; onOpenChange: (v: boolean) => void;
  account: IgAccount | null; tenantId: string; onSaved: () => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    instagram_username: "", name: "", instagram_business_id: "", access_token: "",
    ig_login_id: "", ig_login_token: "", facebook_page_id: "", page_access_token: "",
    webhook_verify_token: "",
  });
  const [saving, setSaving] = useState(false);
  const [initialized, setInitialized] = useState(false);

  // Preenche o form ao abrir (edição) ou zera (criação)
  if (open && !initialized) {
    setForm({
      instagram_username: account?.instagram_username || "",
      name: account?.name || "",
      instagram_business_id: account?.instagram_business_id || "",
      access_token: account?.access_token || "",
      ig_login_id: account?.ig_login_id || "",
      ig_login_token: account?.ig_login_token || "",
      facebook_page_id: account?.facebook_page_id || "",
      page_access_token: account?.page_access_token || "",
      webhook_verify_token: account?.webhook_verify_token
        || `ig_verify_${Math.random().toString(36).slice(2, 12)}`,
    });
    setInitialized(true);
  }
  if (!open && initialized) setInitialized(false);

  const save = async () => {
    const username = form.instagram_username.replace(/^@/, "").trim();
    if (!username) return toast({ title: "Informe o @ da conta", variant: "destructive" });
    if (!form.access_token.trim()) return toast({ title: "access_token é obrigatório (leitura)", variant: "destructive" });
    if (!form.ig_login_token.trim() && !form.page_access_token.trim()) {
      return toast({
        title: "Falta o token de envio",
        description: "Preencha ig_login_token + ig_login_id (recomendado) ou page_access_token + facebook_page_id.",
        variant: "destructive",
      });
    }

    setSaving(true);
    try {
      const payload = {
        tenant_id: tenantId,
        instagram_username: username,
        name: form.name.trim() || username,
        instagram_business_id: form.instagram_business_id.trim() || null,
        access_token: form.access_token.trim(),
        ig_login_id: form.ig_login_id.trim() || null,
        ig_login_token: form.ig_login_token.trim() || null,
        facebook_page_id: form.facebook_page_id.trim() || null,
        page_access_token: form.page_access_token.trim() || null,
        webhook_verify_token: form.webhook_verify_token.trim() || null,
        status: "connected",
        updated_at: new Date().toISOString(),
      };
      const { error } = account
        ? await supabase.from("instagram_business_accounts")
            .update(payload).eq("id", account.id).eq("tenant_id", tenantId)
        : await supabase.from("instagram_business_accounts").insert(payload);
      if (error) throw error;
      toast({ title: account ? "Conta atualizada" : "Conta conectada" });
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast({ title: "Erro ao salvar", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{account ? "Editar conta" : "Conectar conta do Instagram"}</DialogTitle>
          <DialogDescription>
            Os tokens vêm do seu app na Meta. Eles ficam guardados por tenant, nunca no código.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>@ da conta *</Label>
              <Input value={form.instagram_username} placeholder="minhaconta"
                onChange={(e) => setForm({ ...form, instagram_username: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>Nome de exibição</Label>
              <Input value={form.name} placeholder="Minha Clínica"
                onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
          </div>

          <div className="space-y-3 rounded-lg border p-3">
            <p className="text-sm font-medium">Envio de DM (IG Login — recomendado)</p>
            <div className="space-y-1.5">
              <Label className="text-xs">ig_login_id</Label>
              <Input value={form.ig_login_id} className="font-mono text-xs"
                onChange={(e) => setForm({ ...form, ig_login_id: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">ig_login_token</Label>
              <SecretInput value={form.ig_login_token}
                onChange={(v) => setForm({ ...form, ig_login_token: v })} />
            </div>
          </div>

          <div className="space-y-3 rounded-lg border p-3">
            <p className="text-sm font-medium">Leitura (comentários, perfis, mídia) *</p>
            <div className="space-y-1.5">
              <Label className="text-xs">instagram_business_id</Label>
              <Input value={form.instagram_business_id} className="font-mono text-xs"
                onChange={(e) => setForm({ ...form, instagram_business_id: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">access_token</Label>
              <SecretInput value={form.access_token}
                onChange={(v) => setForm({ ...form, access_token: v })} />
            </div>
          </div>

          <div className="space-y-3 rounded-lg border border-dashed p-3">
            <p className="text-sm font-medium text-muted-foreground">
              Fallback: envio via Página do Facebook (opcional)
            </p>
            <div className="space-y-1.5">
              <Label className="text-xs">facebook_page_id</Label>
              <Input value={form.facebook_page_id} className="font-mono text-xs"
                onChange={(e) => setForm({ ...form, facebook_page_id: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">page_access_token</Label>
              <SecretInput value={form.page_access_token}
                onChange={(v) => setForm({ ...form, page_access_token: v })} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Verify token do webhook</Label>
            <Input value={form.webhook_verify_token} className="font-mono text-xs"
              onChange={(e) => setForm({ ...form, webhook_verify_token: e.target.value })} />
            <p className="text-xs text-muted-foreground">
              Cole esse mesmo valor no campo "Verify token" do webhook, na Meta.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// 2. MODO TESTE (allowlist) + material padrão
// ============================================================
function TestModeSection({ tenantId }: { tenantId: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [allowlist, setAllowlist] = useState<string | null>(null);
  const [materialBase, setMaterialBase] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const { data: cfg } = useQuery({
    queryKey: ["ig-config", tenantId],
    queryFn: async () => {
      const keys = ["ig_agent_test_allowlist", "ig_default_material_link"];
      const [{ data: overrides }, { data: globals }] = await Promise.all([
        supabase.from("tenant_integration_keys").select("key, value")
          .eq("tenant_id", tenantId).in("key", keys),
        supabase.from("config").select("key, value").in("key", keys),
      ]);
      const map: Record<string, string> = {};
      for (const row of globals || []) map[row.key] = row.value;
      for (const row of overrides || []) map[row.key] = row.value;
      return map;
    },
    enabled: !!tenantId,
  });

  const listValue = allowlist ?? (() => {
    try {
      const parsed = JSON.parse(cfg?.ig_agent_test_allowlist || "[]");
      return Array.isArray(parsed) ? parsed.join("\n") : "";
    } catch { return ""; }
  })();
  const baseValue = materialBase ?? (cfg?.ig_default_material_link || "");

  const save = async () => {
    setSaving(true);
    try {
      const usernames = listValue.split(/[\n,]/).map((u) => u.trim().replace(/^@/, "")).filter(Boolean);
      const rows = [
        { tenant_id: tenantId, key: "ig_agent_test_allowlist", value: JSON.stringify(usernames) },
        { tenant_id: tenantId, key: "ig_default_material_link", value: baseValue.trim() },
      ];
      const { error } = await supabase
        .from("tenant_integration_keys")
        .upsert(rows, { onConflict: "tenant_id,key" });
      if (error) throw error;
      qc.invalidateQueries({ queryKey: ["ig-config", tenantId] });
      toast({
        title: "Configuração salva",
        description: usernames.length
          ? `Modo teste ATIVO — o agente só fala com ${usernames.length} @(s).`
          : "Modo teste desligado — o agente fala com todos.",
      });
    } catch (e) {
      toast({ title: "Erro", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const activeCount = listValue.split(/[\n,]/).map((u) => u.trim()).filter(Boolean).length;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FlaskConical className="h-5 w-5" /> Modo teste (allowlist)
          </CardTitle>
          <CardDescription>
            Com a lista preenchida, o agente só conversa com esses @. Todo o resto vai
            pro inbox humano normalmente. Lista vazia = produção (fala com todos).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {activeCount > 0 ? (
            <Alert>
              <FlaskConical className="h-4 w-4" />
              <AlertTitle>Modo teste ativo</AlertTitle>
              <AlertDescription>
                O agente só responde {activeCount} @(s). Ninguém mais recebe DM automática.
              </AlertDescription>
            </Alert>
          ) : (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Produção — o agente fala com todos</AlertTitle>
              <AlertDescription>
                Antes de soltar geral, coloque seu próprio @ aqui e valide algumas conversas.
              </AlertDescription>
            </Alert>
          )}
          <div className="space-y-1.5">
            <Label>@ liberados (um por linha)</Label>
            <Textarea rows={4} value={listValue} placeholder="meuteste"
              onChange={(e) => setAllowlist(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Link padrão do material</CardTitle>
          <CardDescription>
            Usado quando a conversa não veio de campanha nenhuma. O CRM monta as UTMs
            em cima dele — o agente nunca inventa link. Deixe vazio para não oferecer nada.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input value={baseValue} placeholder="https://seusite.com/aula"
            onChange={(e) => setMaterialBase(e.target.value)} />
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Salvar configurações
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================
// TAB PRINCIPAL
// ============================================================
export function InstagramConfigTab() {
  const { tenantId } = useAuth();

  if (!tenantId) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Carregando...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Alert>
        <Megaphone className="h-4 w-4" />
        <AlertTitle>As campanhas ficam em Marketing</AlertTitle>
        <AlertDescription className="space-y-2">
          <p className="text-sm">
            Aqui é só a configuração da conta (tokens, webhook, modo teste). Campanhas
            comentário → DM e gatilhos de palavra-chave são operação do dia a dia e vivem
            em <strong>Marketing → Campanhas Instagram</strong>, com as métricas de cada uma.
          </p>
          <Button asChild size="sm" variant="outline">
            <Link to="/marketing/instagram">
              <Megaphone className="mr-2 h-4 w-4" /> Ir para as campanhas
            </Link>
          </Button>
        </AlertDescription>
      </Alert>

      <Tabs defaultValue="conta" className="space-y-4">
        <TabsList>
          <TabsTrigger value="conta" className="gap-1.5">
            <Instagram className="h-4 w-4" /> Conta
          </TabsTrigger>
          <TabsTrigger value="teste" className="gap-1.5">
            <FlaskConical className="h-4 w-4" /> Modo teste
          </TabsTrigger>
        </TabsList>

        <TabsContent value="conta"><AccountSection tenantId={tenantId} /></TabsContent>
        <TabsContent value="teste"><TestModeSection tenantId={tenantId} /></TabsContent>
      </Tabs>
    </div>
  );
}

export default InstagramConfigTab;
