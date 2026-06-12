import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AppLayout } from "@/components/layout/AppLayout";
import { Car, Store, Search, Plus, Pencil, Trash2, ExternalLink, CircleDot, CheckCircle2 } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  useCredereLeads,
  useCredereMappings,
  useCreateCredereMapping,
  useUpdateCredereMapping,
  useDeleteCredereMapping,
  type CredereStoreMapping,
} from "@/hooks/useCredere";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatCurrency(value?: number) {
  if (value == null) return "—";
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatDate(iso?: string) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

// ─── Formulário de mapeamento ─────────────────────────────────────────────────

interface MappingFormProps {
  open: boolean;
  onClose: () => void;
  initial?: CredereStoreMapping;
}

function MappingForm({ open, onClose, initial }: MappingFormProps) {
  const isEdit = !!initial;
  const create = useCreateCredereMapping();
  const update = useUpdateCredereMapping();

  const [credereStoreId, setCredereStoreId] = useState(initial?.credere_store_id ?? "");
  const [storeName, setStoreName] = useState(initial?.store_name ?? "");
  const [tenantId, setTenantId] = useState(initial?.tenant_id ?? "");
  const [active, setActive] = useState(initial?.active ?? true);

  const isPending = create.isPending || update.isPending;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!credereStoreId.trim() || !storeName.trim() || !tenantId.trim()) return;

    if (isEdit && initial) {
      await update.mutateAsync({
        id: initial.id,
        credere_store_id: credereStoreId.trim(),
        store_name: storeName.trim(),
        tenant_id: tenantId.trim(),
        active,
      });
    } else {
      await create.mutateAsync({
        credere_store_id: credereStoreId.trim(),
        store_name: storeName.trim(),
        tenant_id: tenantId.trim(),
      });
    }
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Editar loja" : "Adicionar loja"}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="storeName">Nome da loja</Label>
            <Input
              id="storeName"
              placeholder="Ex: AutoFácil Veículos"
              value={storeName}
              onChange={(e) => setStoreName(e.target.value)}
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="credereStoreId">ID da loja na Credere</Label>
            <Input
              id="credereStoreId"
              placeholder="Ex: 1234"
              value={credereStoreId}
              onChange={(e) => setCredereStoreId(e.target.value)}
              required
            />
            <p className="text-xs text-muted-foreground">
              O dev da Credere fornece esse ID. Ele aparece no campo <code>store.id</code> do payload.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="tenantId">Tenant ID no CRM</Label>
            <Input
              id="tenantId"
              placeholder="UUID da conta da loja no CRM"
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              required
            />
            <p className="text-xs text-muted-foreground">
              Faça login na conta da loja e veja o UUID em Configurações → Perfil, ou consulte o Supabase.
            </p>
          </div>

          {isEdit && (
            <div className="flex items-center gap-3">
              <Switch id="active" checked={active} onCheckedChange={setActive} />
              <Label htmlFor="active">Mapeamento ativo</Label>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Salvando..." : isEdit ? "Salvar" : "Adicionar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Aba de Leads ─────────────────────────────────────────────────────────────

function LeadsTab() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const { data: leads = [], isLoading } = useCredereLeads(search);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por nome, email ou telefone..."
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Badge variant="secondary">{leads.length} lead{leads.length !== 1 ? "s" : ""}</Badge>
      </div>

      {/* Mobile: cartões */}
      <div className="md:hidden space-y-2.5">
        {isLoading ? (
          <p className="text-center py-10 text-sm text-muted-foreground">Carregando...</p>
        ) : leads.length === 0 ? (
          <p className="text-center py-10 text-sm text-muted-foreground">
            {search ? "Nenhum lead encontrado para essa busca." : "Nenhum lead recebido ainda via Credere."}
          </p>
        ) : (
          leads.map((lead) => {
            const v = lead.metadata?.vehicle;
            const f = lead.metadata?.financing;
            return (
              <button
                key={lead.id}
                onClick={() => navigate(`/comercial/leads/${lead.id}`)}
                className="w-full text-left rounded-lg border bg-card p-3 active:bg-muted/50 transition-colors"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium truncate">{lead.name}</div>
                    {lead.phone && (
                      <div className="text-xs text-muted-foreground">{lead.phone}</div>
                    )}
                  </div>
                  <span className="text-xs font-medium text-foreground whitespace-nowrap">
                    {formatCurrency(v?.assets_value)}
                  </span>
                </div>
                {v?.description && (
                  <div className="mt-2 text-sm">{v.description}</div>
                )}
                {f && (
                  <div className="mt-1 text-xs text-muted-foreground">
                    {f.bank || "—"}
                    {f.installments && f.financed_amount
                      ? ` · ${f.installments}x de ${formatCurrency(f.financed_amount / f.installments)}`
                      : ""}
                  </div>
                )}
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  {lead.metadata?.credere_store_name && (
                    <span className="truncate">{lead.metadata.credere_store_name}</span>
                  )}
                  {lead.city_name && (
                    <span>
                      {lead.city_name}
                      {lead.state ? ` / ${lead.state}` : ""}
                    </span>
                  )}
                  <span className="ml-auto">{formatDate(lead.created_at)}</span>
                </div>
              </button>
            );
          })
        )}
      </div>

      {/* Desktop: tabela */}
      <div className="hidden md:block border rounded-lg overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nome</TableHead>
              <TableHead>Veículo</TableHead>
              <TableHead>Loja</TableHead>
              <TableHead>Valor do veículo</TableHead>
              <TableHead>Melhor condição</TableHead>
              <TableHead>Cidade</TableHead>
              <TableHead>Data</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-10 text-muted-foreground">
                  Carregando...
                </TableCell>
              </TableRow>
            ) : leads.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-10 text-muted-foreground">
                  {search ? "Nenhum lead encontrado para essa busca." : "Nenhum lead recebido ainda via Credere."}
                </TableCell>
              </TableRow>
            ) : (
              leads.map((lead) => {
                const v = lead.metadata?.vehicle;
                const f = lead.metadata?.financing;
                return (
                  <TableRow
                    key={lead.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => navigate(`/comercial/leads/${lead.id}`)}
                  >
                    <TableCell className="font-medium">
                      <div>{lead.name}</div>
                      {lead.phone && (
                        <div className="text-xs text-muted-foreground">{lead.phone}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">{v?.description || "—"}</div>
                      {v?.licensing_uf && (
                        <div className="text-xs text-muted-foreground">UF: {v.licensing_uf}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">{lead.metadata?.credere_store_name || "—"}</div>
                    </TableCell>
                    <TableCell>{formatCurrency(v?.assets_value)}</TableCell>
                    <TableCell>
                      {f ? (
                        <div className="text-sm">
                          <div>{f.bank || "—"}</div>
                          {f.installments && f.financed_amount && (
                            <div className="text-xs text-muted-foreground">
                              {f.installments}x · {formatCurrency(f.financed_amount / f.installments)}
                            </div>
                          )}
                        </div>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell>
                      {lead.city_name
                        ? `${lead.city_name}${lead.state ? ` / ${lead.state}` : ""}`
                        : "—"}
                    </TableCell>
                    <TableCell>{formatDate(lead.created_at)}</TableCell>
                    <TableCell>
                      <ExternalLink className="h-4 w-4 text-muted-foreground" />
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ─── Aba de Lojas ─────────────────────────────────────────────────────────────

function LojasTab() {
  const { data: mappings = [], isLoading } = useCredereMappings();
  const deleteMapping = useDeleteCredereMapping();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<CredereStoreMapping | undefined>();
  const [deletingId, setDeletingId] = useState<string | null>(null);

  function openCreate() {
    setEditing(undefined);
    setFormOpen(true);
  }

  function openEdit(m: CredereStoreMapping) {
    setEditing(m);
    setFormOpen(true);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Cada loja cadastrada aqui recebe os leads da Credere automaticamente no CRM.
        </p>
        <Button size="sm" onClick={openCreate}>
          <Plus className="h-4 w-4 mr-2" />
          Adicionar loja
        </Button>
      </div>

      <div className="border rounded-lg overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nome da loja</TableHead>
              <TableHead>ID na Credere</TableHead>
              <TableHead>Tenant ID (CRM)</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-10 text-muted-foreground">
                  Carregando...
                </TableCell>
              </TableRow>
            ) : mappings.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-10 text-muted-foreground">
                  Nenhuma loja configurada. Clique em "Adicionar loja" para começar.
                </TableCell>
              </TableRow>
            ) : (
              mappings.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="font-medium">{m.store_name}</TableCell>
                  <TableCell>
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                      {m.credere_store_id}
                    </code>
                  </TableCell>
                  <TableCell>
                    <code className="text-xs text-muted-foreground">{m.tenant_id}</code>
                  </TableCell>
                  <TableCell>
                    {m.active ? (
                      <Badge variant="default" className="gap-1 bg-emerald-500/15 text-emerald-700 border-emerald-200">
                        <CheckCircle2 className="h-3 w-3" /> Ativo
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="gap-1">
                        <CircleDot className="h-3 w-3" /> Inativo
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1 justify-end">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        onClick={() => openEdit(m)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        onClick={() => setDeletingId(m.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="rounded-lg border bg-muted/30 p-4 text-sm space-y-1">
        <p className="font-medium">URL do webhook para a Credere:</p>
        <code className="block text-xs bg-background border rounded px-3 py-2 select-all overflox-x-auto">
          {`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/credere-webhook`}
        </code>
        <p className="text-xs text-muted-foreground">
          Passe essa URL para o dev da Credere configurar em todas as lojas.
        </p>
      </div>

      <MappingForm
        open={formOpen}
        onClose={() => setFormOpen(false)}
        initial={editing}
      />

      <AlertDialog open={!!deletingId} onOpenChange={(v) => !v && setDeletingId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover loja?</AlertDialogTitle>
            <AlertDialogDescription>
              Leads futuros dessa loja não serão mais roteados para o CRM. Leads já recebidos não são afetados.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={() => {
                if (deletingId) deleteMapping.mutate(deletingId);
                setDeletingId(null);
              }}
            >
              Remover
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── Página principal ─────────────────────────────────────────────────────────

export default function CredereLeads() {
  return (
    <AppLayout>
      <div>
        <div className="mb-4">
          <h1 className="text-xl sm:text-2xl font-bold text-foreground">Credere</h1>
          <p className="text-sm text-muted-foreground">Leads de simulação de financiamento</p>
        </div>
        <Tabs defaultValue="leads">
          <TabsList className="mb-6">
            <TabsTrigger value="leads" className="gap-2">
              <Car className="h-4 w-4" />
              Leads
            </TabsTrigger>
            <TabsTrigger value="lojas" className="gap-2">
              <Store className="h-4 w-4" />
              Lojas
            </TabsTrigger>
          </TabsList>

          <TabsContent value="leads">
            <LeadsTab />
          </TabsContent>

          <TabsContent value="lojas">
            <LojasTab />
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
