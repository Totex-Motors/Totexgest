import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Plus, Building2, Copy, CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import {
  useSuperAdminTenants,
  useProvisionTenant,
  useSetTenantStatus,
  useSetTenantModule,
} from "@/hooks/useSuperAdminTenants";

function formatDate(iso?: string) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

// ─── Formulário de nova loja ───────────────────────────────────────────────────

function NewTenantDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const provision = useProvisionTenant();
  const [tradeName, setTradeName] = useState("");
  const [cnpj, setCnpj] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPhone, setAdminPhone] = useState("");
  const [credere, setCredere] = useState(false);
  const [done, setDone] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  function reset() {
    setTradeName(""); setCnpj(""); setWhatsapp("");
    setAdminName(""); setAdminEmail(""); setAdminPhone("");
    setCredere(false); setDone(false); setInviteUrl(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!tradeName.trim()) return;
    const hasAdmin = !!(adminName.trim() && adminEmail.trim());
    const res = await provision.mutateAsync({
      trade_name: tradeName.trim(),
      cnpj: cnpj.trim() || undefined,
      whatsapp: whatsapp.trim() || undefined,
      modules: { comercial: true, gestao: true, marketplace: true, credere },
      admin: hasAdmin
        ? { name: adminName.trim(), email: adminEmail.trim(), phone: adminPhone.trim() || undefined }
        : undefined,
    });
    setInviteUrl(res.invite_url ?? null);
    setDone(true);
  }

  function handleClose() {
    reset();
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Nova loja (tenant)</DialogTitle>
          <DialogDescription>
            Cria um tenant isolado com pipeline e agente de IA padrão, e convida o administrador da loja.
          </DialogDescription>
        </DialogHeader>

        {done ? (
          // Estado de sucesso
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-2 text-emerald-600">
              <CheckCircle2 className="h-5 w-5" />
              <span className="font-medium">Loja criada com sucesso!</span>
            </div>
            {inviteUrl ? (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  Link de convite do admin (válido por tempo limitado — envie para o lojista):
                </Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-xs bg-muted rounded px-2 py-2 truncate">{inviteUrl}</code>
                  <Button
                    type="button" size="icon" variant="outline" className="h-9 w-9 shrink-0"
                    onClick={() => { navigator.clipboard.writeText(inviteUrl); toast.success("Link copiado"); }}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Tenant criado sem administrador. Você pode convidar o admin da loja depois,
                quando o CRM estiver pronto para os lojistas.
              </p>
            )}
            <DialogFooter>
              <Button type="button" onClick={handleClose}>Concluir</Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="tradeName">Nome da loja *</Label>
              <Input id="tradeName" value={tradeName} onChange={(e) => setTradeName(e.target.value)} placeholder="Ex: Auto Premium SP" required />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="cnpj">CNPJ</Label>
                <Input id="cnpj" value={cnpj} onChange={(e) => setCnpj(e.target.value)} placeholder="00.000.000/0001-00" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="whatsapp">WhatsApp</Label>
                <Input id="whatsapp" value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} placeholder="(11) 99999-9999" />
              </div>
            </div>

            <div className="flex items-center justify-between rounded-lg border border-border/50 px-3 py-2.5">
              <div>
                <p className="text-sm font-medium">Módulo Credere</p>
                <p className="text-xs text-muted-foreground">Simulação de financiamento (módulo pago opcional).</p>
              </div>
              <Switch checked={credere} onCheckedChange={setCredere} />
            </div>

            <div className="pt-2 border-t border-border/40">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Administrador da loja (opcional)</p>
              <p className="text-xs text-muted-foreground mb-2">
                Deixe em branco para criar a loja sem admin agora — você convida depois.
              </p>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="adminName">Nome</Label>
                  <Input id="adminName" value={adminName} onChange={(e) => setAdminName(e.target.value)} placeholder="Nome do responsável" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="adminEmail">Email</Label>
                    <Input id="adminEmail" type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} placeholder="admin@loja.com.br" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="adminPhone">Telefone</Label>
                    <Input id="adminPhone" value={adminPhone} onChange={(e) => setAdminPhone(e.target.value)} placeholder="(11) 99999-9999" />
                  </div>
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={handleClose}>Cancelar</Button>
              <Button type="submit" disabled={provision.isPending}>
                {provision.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Criar loja"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Seção principal ────────────────────────────────────────────────────────────

export function SuperAdminTenantsSection() {
  const { data: tenants = [], isLoading } = useSuperAdminTenants();
  const setStatus = useSetTenantStatus();
  const setModule = useSetTenantModule();
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {tenants.length} {tenants.length === 1 ? "loja" : "lojas"} cadastrada(s) no CRM.
        </p>
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" /> Nova loja
        </Button>
      </div>

      <div className="border rounded-lg overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Loja</TableHead>
              <TableHead>Slug</TableHead>
              <TableHead>Membros</TableHead>
              <TableHead>Credere</TableHead>
              <TableHead>Criada</TableHead>
              <TableHead>Ativa</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-10 text-muted-foreground">Carregando...</TableCell>
              </TableRow>
            ) : tenants.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-10 text-muted-foreground">Nenhuma loja cadastrada.</TableCell>
              </TableRow>
            ) : (
              tenants.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      {t.is_super_admin ? <ShieldCheck className="h-4 w-4 text-primary" /> : <Building2 className="h-4 w-4 text-muted-foreground/60" />}
                      <span>{t.name}</span>
                      {t.is_super_admin && (
                        <Badge variant="secondary" className="text-[10px]">super-admin</Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell><code className="text-xs text-muted-foreground">{t.slug}</code></TableCell>
                  <TableCell className="text-sm">{t.members_active}/{t.members_total}</TableCell>
                  <TableCell>
                    <Switch
                      checked={t.enabled_modules?.credere === true}
                      disabled={setModule.isPending}
                      onCheckedChange={(v) => setModule.mutate({ tenant_id: t.id, module: "credere", enabled: v })}
                    />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{formatDate(t.created_at)}</TableCell>
                  <TableCell>
                    <Switch
                      checked={t.is_active}
                      disabled={t.is_super_admin || setStatus.isPending}
                      onCheckedChange={(v) => setStatus.mutate({ tenant_id: t.id, is_active: v })}
                      title={t.is_super_admin ? "Tenant super-admin não pode ser desativado" : undefined}
                    />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <NewTenantDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </div>
  );
}
