import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AppLayout } from "@/components/layout/AppLayout";
import { ShoppingBag, Store, Search, Plus, Pencil, Trash2, ExternalLink, CircleDot, CheckCircle2, MessageCircle, FileText } from "lucide-react";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/contexts/AuthContext";
import {
  useMarketplaceLeads,
  useMarketplaceMappings,
  useCreateMarketplaceMapping,
  useUpdateMarketplaceMapping,
  useDeleteMarketplaceMapping,
  type MarketplaceStoreMapping,
  type MarketplaceOrigin,
} from "@/hooks/useMarketplace";

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function OriginBadge({ origin }: { origin?: MarketplaceOrigin }) {
  if (origin === "WHATSAPP_CLICK") {
    return (
      <Badge variant="secondary" className="gap-1 bg-emerald-500/15 text-emerald-700 border-emerald-200">
        <MessageCircle className="h-3 w-3" /> WhatsApp
      </Badge>
    );
  }
  // Default: FORM_INTERESSE (também cobre leads antigos sem o campo)
  return (
    <Badge variant="secondary" className="gap-1">
      <FileText className="h-3 w-3" /> Formulário
    </Badge>
  );
}

// ─── Formulário de mapeamento ─────────────────────────────────────────────────

interface MappingFormProps {
  open: boolean;
  onClose: () => void;
  initial?: MarketplaceStoreMapping;
}

function MappingForm({ open, onClose, initial }: MappingFormProps) {
  const isEdit = !!initial;
  const create = useCreateMarketplaceMapping();
  const update = useUpdateMarketplaceMapping();

  const [marketplaceStoreId, setMarketplaceStoreId] = useState(initial?.marketplace_store_id ?? "");
  const [storeName, setStoreName] = useState(initial?.store_name ?? "");
  const [tenantId, setTenantId] = useState(initial?.tenant_id ?? "");
  const [active, setActive] = useState(initial?.active ?? true);

  const isPending = create.isPending || update.isPending;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!marketplaceStoreId.trim() || !storeName.trim() || !tenantId.trim()) return;

    if (isEdit && initial) {
      await update.mutateAsync({
        id: initial.id,
        marketplace_store_id: marketplaceStoreId.trim(),
        store_name: storeName.trim(),
        tenant_id: tenantId.trim(),
        active,
      });
    } else {
      await create.mutateAsync({
        marketplace_store_id: marketplaceStoreId.trim(),
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
              placeholder="Ex: Auto Premium SP"
              value={storeName}
              onChange={(e) => setStoreName(e.target.value)}
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="marketplaceStoreId">ID da loja no marketplace</Label>
            <Input
              id="marketplaceStoreId"
              placeholder="Ex: cmnyn67e100025iyb9mj0vaxz"
              value={marketplaceStoreId}
              onChange={(e) => setMarketplaceStoreId(e.target.value)}
              required
            />
            <p className="text-xs text-muted-foreground">
              Valor que aparece no campo <code>loja.id</code> do payload enviado pelo marketplace.
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
              Faça login na conta da loja e consulte Configurações → Perfil, ou busque no Supabase.
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

const STORE_ALL = "__all__";

function LeadsTab() {
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const [search, setSearch] = useState("");
  const [storeId, setStoreId] = useState<string>(STORE_ALL);

  // Lojas para o filtro (só admin precisa). Vem dos mapeamentos cadastrados.
  const { data: mappings = [] } = useMarketplaceMappings();

  const { data: leads = [], isLoading } = useMarketplaceLeads({
    search,
    storeId: storeId !== STORE_ALL ? storeId : undefined,
  });

  const hasFilters = !!search || storeId !== STORE_ALL;

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

        {isAdmin && (
          <Select value={storeId} onValueChange={setStoreId}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="Todas as lojas" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={STORE_ALL}>Todas as lojas</SelectItem>
              {mappings.map((m) => (
                <SelectItem key={m.id} value={m.marketplace_store_id}>
                  {m.store_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Badge variant="secondary">{leads.length} lead{leads.length !== 1 ? "s" : ""}</Badge>
      </div>

      {/* Mobile: cartões */}
      <div className="md:hidden space-y-2.5">
        {isLoading ? (
          <p className="text-center py-10 text-sm text-muted-foreground">Carregando...</p>
        ) : leads.length === 0 ? (
          <p className="text-center py-10 text-sm text-muted-foreground">
            {hasFilters
              ? "Nenhum lead encontrado para esses filtros."
              : "Nenhum lead recebido ainda via marketplace."}
          </p>
        ) : (
          leads.map((lead) => {
            const v = lead.metadata?.vehicle;
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
                  <OriginBadge origin={lead.metadata?.marketplace_origin} />
                </div>
                {v?.brand && v?.model && (
                  <div className="mt-2 text-sm">
                    {v.brand} {v.model}
                    {v.year ? ` · ${v.year}` : ""}
                  </div>
                )}
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {v?.price_formatted ?? formatCurrency(v?.price)}
                  </span>
                  {lead.metadata?.marketplace_store_name && (
                    <span className="truncate">{lead.metadata.marketplace_store_name}</span>
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
              <TableHead>Origem</TableHead>
              <TableHead>Veículo</TableHead>
              <TableHead>Preço</TableHead>
              <TableHead>Loja</TableHead>
              <TableHead>Mensagem</TableHead>
              <TableHead>Cidade</TableHead>
              <TableHead>Data</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-10 text-muted-foreground">
                  Carregando...
                </TableCell>
              </TableRow>
            ) : leads.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-10 text-muted-foreground">
                  {hasFilters
              ? "Nenhum lead encontrado para esses filtros."
              : "Nenhum lead recebido ainda via marketplace."}
                </TableCell>
              </TableRow>
            ) : (
              leads.map((lead) => {
                const v = lead.metadata?.vehicle;
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
                      <OriginBadge origin={lead.metadata?.marketplace_origin} />
                    </TableCell>
                    <TableCell>
                      <div className="text-sm font-medium">
                        {v?.brand && v?.model ? `${v.brand} ${v.model}` : "—"}
                      </div>
                      {v?.version && (
                        <div className="text-xs text-muted-foreground truncate max-w-[180px]">
                          {v.version}
                        </div>
                      )}
                      {v?.year && (
                        <div className="text-xs text-muted-foreground">{v.year}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">{v?.price_formatted ?? formatCurrency(v?.price)}</div>
                      {v?.mileage != null && (
                        <div className="text-xs text-muted-foreground">
                          {v.mileage.toLocaleString("pt-BR")} km
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">{lead.metadata?.marketplace_store_name ?? "—"}</div>
                    </TableCell>
                    <TableCell>
                      {lead.context ? (
                        <div className="text-sm text-muted-foreground truncate max-w-[200px]" title={lead.context}>
                          {lead.context}
                        </div>
                      ) : "—"}
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
  const { data: mappings = [], isLoading } = useMarketplaceMappings();
  const deleteMapping = useDeleteMarketplaceMapping();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<MarketplaceStoreMapping | undefined>();
  const [deletingId, setDeletingId] = useState<string | null>(null);

  function openCreate() {
    setEditing(undefined);
    setFormOpen(true);
  }

  function openEdit(m: MarketplaceStoreMapping) {
    setEditing(m);
    setFormOpen(true);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Cada loja cadastrada aqui recebe automaticamente os leads do marketplace no CRM.
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
              <TableHead>ID no marketplace</TableHead>
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
                      {m.marketplace_store_id}
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

      <div className="rounded-lg border bg-muted/30 p-4 text-sm space-y-2">
        <p className="font-medium">Configuração do webhook no marketplace:</p>
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">URL do webhook:</p>
          <code className="block text-xs bg-background border rounded px-3 py-2 select-all break-all">
            {`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/marketplace-lead-webhook`}
          </code>
        </div>
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground break-words">
            Header de autenticação: <code className="break-all">Authorization: Bearer &lt;MARKETPLACE_WEBHOOK_SECRET&gt;</code>
          </p>
          <p className="text-xs text-muted-foreground">
            Configure o secret em <strong>Configurações → Integrações → API Keys</strong> (chave: MARKETPLACE_WEBHOOK_SECRET).
          </p>
        </div>
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

export default function MarketplaceLeads() {
  return (
    <AppLayout>
      <div>
        <div className="mb-4">
          <h1 className="text-xl sm:text-2xl font-bold text-foreground">Marketplace Digital</h1>
          <p className="text-sm text-muted-foreground">Leads do totexmotors.com</p>
        </div>
        <Tabs defaultValue="leads">
          <TabsList className="mb-6">
            <TabsTrigger value="leads" className="gap-2">
              <ShoppingBag className="h-4 w-4" />
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
