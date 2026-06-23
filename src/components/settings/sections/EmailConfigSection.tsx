import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2, Mail, ShieldCheck } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useToast } from "@/hooks/use-toast";

// Config de envio de email (Resend) POR LOJA. Grava em tenant_email_config
// (1 row por tenant). As edge functions (send-email-campaign, process-email-event,
// email-automation-tick) leem essa config via _shared/tenant-email-config.ts.
interface EmailConfigForm {
  resend_api_key: string;
  resend_webhook_secret: string;
  from_email: string;
  from_name: string;
  reply_to: string;
  company_name: string;
  company_address: string;
  app_url: string;
  is_active: boolean;
  domain_verified: boolean;
}

const EMPTY: EmailConfigForm = {
  resend_api_key: "",
  resend_webhook_secret: "",
  from_email: "",
  from_name: "",
  reply_to: "",
  company_name: "",
  company_address: "",
  app_url: "",
  is_active: false,
  domain_verified: false,
};

async function getCurrentTenantId(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  const meta = data.session?.user?.app_metadata as { tenant_id?: string } | undefined;
  return meta?.tenant_id ?? null;
}

export function EmailConfigSection() {
  const { toast } = useToast();
  const [form, setForm] = useState<EmailConfigForm>(EMPTY);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const tid = await getCurrentTenantId();
      setTenantId(tid);
      if (!tid) {
        setLoading(false);
        return;
      }
      const { data } = await supabase
        .from("tenant_email_config")
        .select("*")
        .eq("tenant_id", tid)
        .maybeSingle();
      if (data) {
        setForm({
          resend_api_key: data.resend_api_key ?? "",
          resend_webhook_secret: data.resend_webhook_secret ?? "",
          from_email: data.from_email ?? "",
          from_name: data.from_name ?? "",
          reply_to: data.reply_to ?? "",
          company_name: data.company_name ?? "",
          company_address: data.company_address ?? "",
          app_url: data.app_url ?? "",
          is_active: data.is_active ?? false,
          domain_verified: data.domain_verified ?? false,
        });
      }
      setLoading(false);
    })();
  }, []);

  const set = <K extends keyof EmailConfigForm>(k: K, v: EmailConfigForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!tenantId) {
      toast({ title: "Sem tenant", description: "Não foi possível identificar a loja.", variant: "destructive" });
      return;
    }
    setSaving(true);
    const { error } = await supabase
      .from("tenant_email_config")
      .upsert(
        { tenant_id: tenantId, ...form },
        { onConflict: "tenant_id" },
      );
    setSaving(false);
    if (error) {
      toast({ title: "Erro ao salvar", description: error.message, variant: "destructive" });
      return;
    }
    toast({ title: "Config de email salva", description: "As campanhas usarão essas credenciais." });
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" /> Carregando...
      </div>
    );
  }

  return (
    <form onSubmit={handleSave} className="space-y-5 max-w-2xl">
      <p className="text-sm text-muted-foreground">
        Cada loja envia emails pela própria conta <strong>Resend</strong>. Crie a API key em
        resend.com, verifique seu domínio e cole as credenciais abaixo. O agente/campanhas
        só disparam quando o envio está <strong>ativo</strong>.
      </p>

      <div className="space-y-1.5">
        <Label htmlFor="resend_api_key">Resend API Key *</Label>
        <Input
          id="resend_api_key" type="password" value={form.resend_api_key}
          onChange={(e) => set("resend_api_key", e.target.value)}
          placeholder="re_..." autoComplete="off"
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="from_name">Nome do remetente *</Label>
          <Input
            id="from_name" value={form.from_name}
            onChange={(e) => set("from_name", e.target.value)} placeholder="Loja Totex"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="from_email">Email do remetente *</Label>
          <Input
            id="from_email" type="email" value={form.from_email}
            onChange={(e) => set("from_email", e.target.value)} placeholder="contato@sualoja.com.br"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="reply_to">Reply-To (opcional)</Label>
          <Input
            id="reply_to" type="email" value={form.reply_to}
            onChange={(e) => set("reply_to", e.target.value)} placeholder="vendas@sualoja.com.br"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="company_name">Nome da empresa</Label>
          <Input
            id="company_name" value={form.company_name}
            onChange={(e) => set("company_name", e.target.value)} placeholder="Sua Loja Ltda"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="company_address">Endereço da empresa (rodapé LGPD/CAN-SPAM)</Label>
        <Input
          id="company_address" value={form.company_address}
          onChange={(e) => set("company_address", e.target.value)}
          placeholder="Rua Exemplo, 123 - São Paulo/SP"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="app_url">URL do app (links de descadastro)</Label>
        <Input
          id="app_url" value={form.app_url}
          onChange={(e) => set("app_url", e.target.value)}
          placeholder="https://crm.sualoja.com.br"
        />
        <p className="text-xs text-muted-foreground">
          Sem isso os links de descadastro ficam vazios e as campanhas não disparam.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="resend_webhook_secret">Resend Webhook Secret (opcional)</Label>
        <Input
          id="resend_webhook_secret" type="password" value={form.resend_webhook_secret}
          onChange={(e) => set("resend_webhook_secret", e.target.value)}
          placeholder="whsec_..." autoComplete="off"
        />
        <p className="text-xs text-muted-foreground">
          Valida a assinatura dos eventos (aberturas, cliques, bounces) do webhook do Resend.
        </p>
      </div>

      <div className="flex items-center justify-between rounded-lg border p-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">Domínio verificado</p>
            <p className="text-xs text-muted-foreground">Marque após verificar o domínio no Resend.</p>
          </div>
        </div>
        <Switch checked={form.domain_verified} onCheckedChange={(v) => set("domain_verified", v)} />
      </div>

      <div className="flex items-center justify-between rounded-lg border p-3">
        <div className="flex items-center gap-2">
          <Mail className="h-4 w-4 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">Envio de email ativo</p>
            <p className="text-xs text-muted-foreground">Liga o disparo de campanhas e automações de email.</p>
          </div>
        </div>
        <Switch checked={form.is_active} onCheckedChange={(v) => set("is_active", v)} />
      </div>

      <Button type="submit" disabled={saving}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
        Salvar configuração
      </Button>
    </form>
  );
}
