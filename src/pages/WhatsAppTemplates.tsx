import { useMemo, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  RefreshCw, Search, Tag as TagIcon, Loader2, Eye, Trash2, ExternalLink,
  CheckCircle2, Clock, XCircle, AlertCircle, Plus,
} from "lucide-react";
import {
  useWhatsAppTemplates, useWhatsAppTemplateTags,
  useSyncWhatsAppTemplates, useUpdateTemplateTags, useDeleteTemplate,
  WhatsAppTemplate, WhatsAppTemplateTag,
} from "@/hooks/useWhatsAppTemplates";
import MarketingPageHeader from "@/components/marketing/MarketingPageHeader";

const STATUS_META: Record<string, { label: string; color: string; icon: any }> = {
  APPROVED: { label: "Aprovado", color: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30", icon: CheckCircle2 },
  PENDING: { label: "Em análise", color: "bg-amber-500/15 text-amber-700 border-amber-500/30", icon: Clock },
  REJECTED: { label: "Rejeitado", color: "bg-rose-500/15 text-rose-700 border-rose-500/30", icon: XCircle },
  PAUSED: { label: "Pausado", color: "bg-slate-500/15 text-slate-700 border-slate-500/30", icon: AlertCircle },
  DISABLED: { label: "Desativado", color: "bg-slate-500/15 text-slate-700 border-slate-500/30", icon: AlertCircle },
};

const CATEGORY_META: Record<string, { label: string; color: string }> = {
  MARKETING: { label: "Marketing", color: "bg-purple-500/10 text-purple-700 border-purple-500/30" },
  UTILITY: { label: "Utility", color: "bg-blue-500/10 text-blue-700 border-blue-500/30" },
  AUTHENTICATION: { label: "Autenticação", color: "bg-orange-500/10 text-orange-700 border-orange-500/30" },
};

function getBodyText(t: WhatsAppTemplate): string {
  const body = (t.components || []).find((c: any) => c.type === "BODY");
  return body?.text || "";
}

export default function WhatsAppTemplates() {
  const { toast } = useToast();
  const { data: templates = [], isLoading } = useWhatsAppTemplates();
  const { data: tags = [] } = useWhatsAppTemplateTags();
  const syncMutation = useSyncWhatsAppTemplates();
  const deleteMutation = useDeleteTemplate();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set());
  const [categoryFilter, setCategoryFilter] = useState<Set<string>>(new Set());
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set());
  const [previewOf, setPreviewOf] = useState<WhatsAppTemplate | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<WhatsAppTemplate | null>(null);

  const tagBySlug = useMemo(() => {
    const map: Record<string, WhatsAppTemplateTag> = {};
    tags.forEach(t => { map[t.slug] = t; });
    return map;
  }, [tags]);

  const counts = useMemo(() => {
    const byStatus: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    const byTag: Record<string, number> = {};
    templates.forEach(t => {
      byStatus[t.status] = (byStatus[t.status] || 0) + 1;
      byCategory[t.category] = (byCategory[t.category] || 0) + 1;
      (t.internal_tags || []).forEach(slug => {
        byTag[slug] = (byTag[slug] || 0) + 1;
      });
    });
    return { byStatus, byCategory, byTag };
  }, [templates]);

  const filtered = useMemo(() => {
    return templates.filter(t => {
      if (statusFilter.size > 0 && !statusFilter.has(t.status)) return false;
      if (categoryFilter.size > 0 && !categoryFilter.has(t.category)) return false;
      if (tagFilter.size > 0) {
        const has = (t.internal_tags || []).some(s => tagFilter.has(s));
        if (!has) return false;
      }
      if (search) {
        const q = search.toLowerCase();
        const matchName = t.name.toLowerCase().includes(q);
        const matchBody = getBodyText(t).toLowerCase().includes(q);
        if (!matchName && !matchBody) return false;
      }
      return true;
    });
  }, [templates, statusFilter, categoryFilter, tagFilter, search]);

  const toggleSet = (set: Set<string>, value: string, fn: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    fn(next);
  };

  const handleSync = async () => {
    try {
      const res = await syncMutation.mutateAsync();
      toast({
        title: "Sincronização concluída",
        description: `${res.upserted} de ${res.total} templates atualizados.`,
      });
    } catch (e: any) {
      toast({ title: "Erro ao sincronizar", description: e.message, variant: "destructive" });
    }
  };

  const handleDelete = async () => {
    if (!deleteConfirm) return;
    try {
      await deleteMutation.mutateAsync(deleteConfirm.id);
      toast({ title: "Template removido" });
      setDeleteConfirm(null);
    } catch (e: any) {
      toast({ title: "Erro ao remover", description: e.message, variant: "destructive" });
    }
  };

  return (
    <AppLayout>
    <div className="container mx-auto px-4 py-6 space-y-6 max-w-[1400px]">
      <MarketingPageHeader
        eyebrow="Marketing · WhatsApp"
        title="Templates"
        description="Modelos aprovados pela Meta. Use templates pra iniciar conversas fora da janela de 24h."
        rightAccessory={
          <>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={handleSync} disabled={syncMutation.isPending}>
              {syncMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Sincronizar
            </Button>
            <Button asChild variant="ghost" size="sm" className="gap-1 text-muted-foreground">
              <a href="https://business.facebook.com/wa/manage/message-templates/" target="_blank" rel="noreferrer">
                Business Manager
                <ExternalLink className="h-3 w-3" />
              </a>
            </Button>
          </>
        }
        action={
          <Button
            size="sm"
            className="bg-[#BAA05E] hover:bg-[#917D3D] text-white gap-1.5"
            onClick={() => window.location.assign('/marketing/whatsapp-templates/novo')}
          >
            <Plus className="h-3.5 w-3.5" />
            Novo template
          </Button>
        }
      />

      <div className="grid grid-cols-12 gap-6">
        {/* Filtros */}
        <aside className="col-span-12 lg:col-span-3 space-y-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Buscar template..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>

          <FilterGroup title="Status Meta">
            {Object.entries(STATUS_META).map(([key, meta]) => (
              <FilterCheck
                key={key}
                checked={statusFilter.has(key)}
                onChange={() => toggleSet(statusFilter, key, setStatusFilter)}
                label={meta.label}
                count={counts.byStatus[key] || 0}
                color={meta.color}
              />
            ))}
          </FilterGroup>

          <FilterGroup title="Categoria Meta">
            {Object.entries(CATEGORY_META).map(([key, meta]) => (
              <FilterCheck
                key={key}
                checked={categoryFilter.has(key)}
                onChange={() => toggleSet(categoryFilter, key, setCategoryFilter)}
                label={meta.label}
                count={counts.byCategory[key] || 0}
                color={meta.color}
              />
            ))}
          </FilterGroup>

          <FilterGroup
            title="Etiquetas internas"
            action={
              <a href="/comercial/configuracoes?tab=whatsapp-template-tags" className="text-xs text-primary hover:underline">
                Gerenciar
              </a>
            }
          >
            {tags.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nenhuma etiqueta criada</p>
            ) : (
              tags.map(tag => (
                <FilterCheck
                  key={tag.slug}
                  checked={tagFilter.has(tag.slug)}
                  onChange={() => toggleSet(tagFilter, tag.slug, setTagFilter)}
                  label={tag.label}
                  count={counts.byTag[tag.slug] || 0}
                  customDot={tag.color}
                />
              ))
            )}
          </FilterGroup>
        </aside>

        {/* Grid */}
        <main className="col-span-12 lg:col-span-9">
          {isLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState onSync={handleSync} hasTemplates={templates.length > 0} />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {filtered.map(t => (
                <TemplateCard
                  key={t.id}
                  template={t}
                  tagBySlug={tagBySlug}
                  onPreview={() => setPreviewOf(t)}
                  onDelete={() => setDeleteConfirm(t)}
                />
              ))}
            </div>
          )}
        </main>
      </div>

      {/* Preview modal */}
      <Dialog open={!!previewOf} onOpenChange={open => !open && setPreviewOf(null)}>
        <DialogContent className="max-w-2xl">
          {previewOf && <TemplatePreview template={previewOf} />}
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={!!deleteConfirm} onOpenChange={open => !open && setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remover template?</DialogTitle>
            <DialogDescription>
              Isso só remove a referência local. O template continua existindo na Meta. Pra deletar de verdade, use o
              Meta WhatsApp Manager.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>Cancelar</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteMutation.isPending}>
              {deleteMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Remover
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </AppLayout>
  );
}

// ===================== COMPONENTES =====================

function FilterGroup({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{title}</h3>
        {action}
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function FilterCheck({
  checked, onChange, label, count, color, customDot,
}: {
  checked: boolean; onChange: () => void; label: string; count: number; color?: string; customDot?: string;
}) {
  return (
    <label className="flex items-center gap-2 px-2 py-1 rounded hover:bg-muted/50 cursor-pointer text-sm">
      <Checkbox checked={checked} onCheckedChange={onChange} />
      {customDot && <span className="w-2 h-2 rounded-full" style={{ background: customDot }} />}
      <span className="flex-1">{label}</span>
      <span className="text-xs text-muted-foreground">{count}</span>
    </label>
  );
}

function TemplateCard({
  template, tagBySlug, onPreview, onDelete,
}: {
  template: WhatsAppTemplate;
  tagBySlug: Record<string, WhatsAppTemplateTag>;
  onPreview: () => void;
  onDelete: () => void;
}) {
  const status = STATUS_META[template.status] || STATUS_META.PENDING;
  const category = CATEGORY_META[template.category] || { label: template.category, color: "bg-muted" };
  const StatusIcon = status.icon;
  const body = getBodyText(template);

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Badge variant="outline" className={status.color}>
            <StatusIcon className="h-3 w-3 mr-1" />
            {status.label}
          </Badge>
          <div className="flex items-center gap-1.5">
            <Badge variant="outline" className={category.color}>{category.label}</Badge>
            <Badge variant="outline" className="text-[10px] uppercase">{template.language}</Badge>
          </div>
        </div>

        <CardTitle className="font-mono text-sm leading-tight">{template.name}</CardTitle>

        {(template.internal_tags || []).length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {(template.internal_tags || []).map(slug => {
              const tag = tagBySlug[slug];
              if (!tag) return null;
              return (
                <Badge
                  key={slug}
                  variant="outline"
                  className="text-[10px] py-0 px-1.5 h-5"
                  style={{ borderColor: `${tag.color}40`, color: tag.color, backgroundColor: `${tag.color}10` }}
                >
                  {tag.label}
                </Badge>
              );
            })}
          </div>
        )}
      </CardHeader>
      <CardContent className="flex-1 flex flex-col">
        <p className="text-sm text-foreground/80 line-clamp-3 flex-1 whitespace-pre-line">
          {body || <em className="text-muted-foreground">Template sem corpo</em>}
        </p>

        {template.status === "REJECTED" && template.rejection_reason && (
          <p className="text-xs text-rose-600 mt-2 px-2 py-1 bg-rose-50 rounded">
            Motivo: {template.rejection_reason}
          </p>
        )}

        <div className="flex items-center gap-1 mt-3 pt-3 border-t">
          <Button size="sm" variant="ghost" onClick={onPreview} className="flex-1">
            <Eye className="h-3.5 w-3.5 mr-1" />
            Visualizar
          </Button>
          <TagPickerPopover template={template} />
          <Button size="sm" variant="ghost" onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function TagPickerPopover({ template }: { template: WhatsAppTemplate }) {
  const { data: tags = [] } = useWhatsAppTemplateTags();
  const updateTags = useUpdateTemplateTags();
  const [open, setOpen] = useState(false);
  const selected = new Set(template.internal_tags || []);

  const toggle = async (slug: string) => {
    const next = new Set(selected);
    if (next.has(slug)) next.delete(slug);
    else next.add(slug);
    await updateTags.mutateAsync({ id: template.id, internal_tags: Array.from(next) });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost">
          <TagIcon className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-2" align="end">
        <p className="text-xs font-medium text-muted-foreground mb-2 px-1">Etiquetas</p>
        {tags.length === 0 ? (
          <p className="text-xs text-muted-foreground px-1">Nenhuma etiqueta criada</p>
        ) : (
          <div className="space-y-0.5 max-h-60 overflow-y-auto">
            {tags.map(tag => (
              <label
                key={tag.id}
                className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted cursor-pointer text-sm"
              >
                <Checkbox
                  checked={selected.has(tag.slug)}
                  onCheckedChange={() => toggle(tag.slug)}
                />
                <span className="w-2 h-2 rounded-full" style={{ background: tag.color }} />
                <span className="flex-1">{tag.label}</span>
              </label>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function TemplatePreview({ template }: { template: WhatsAppTemplate }) {
  const header = (template.components || []).find((c: any) => c.type === "HEADER");
  const body = (template.components || []).find((c: any) => c.type === "BODY");
  const footer = (template.components || []).find((c: any) => c.type === "FOOTER");
  const buttons = (template.components || []).find((c: any) => c.type === "BUTTONS");

  return (
    <>
      <DialogHeader>
        <DialogTitle className="font-mono">{template.name}</DialogTitle>
        <DialogDescription>
          {template.category} · {template.language} · {template.variables_count} variável(eis)
        </DialogDescription>
      </DialogHeader>

      <div className="bg-[#E5DDD5] rounded-lg p-6 my-4 max-h-[480px] overflow-y-auto">
        <div className="bg-white rounded-lg p-3 max-w-sm shadow-sm">
          {header?.text && (
            <p className="font-semibold text-sm mb-1.5">{header.text}</p>
          )}
          {body?.text && (
            <p className="text-sm whitespace-pre-line text-gray-800">{body.text}</p>
          )}
          {footer?.text && (
            <p className="text-xs text-gray-500 mt-2">{footer.text}</p>
          )}
          {buttons?.buttons && (
            <div className="mt-3 -mx-3 -mb-3 border-t">
              {buttons.buttons.map((btn: any, i: number) => (
                <div
                  key={i}
                  className="text-center text-sm text-blue-600 py-2.5 border-b last:border-b-0 last:rounded-b-lg cursor-pointer"
                >
                  {btn.text}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function EmptyState({ onSync, hasTemplates }: { onSync: () => void; hasTemplates: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mb-4">
        <Search className="h-8 w-8 text-muted-foreground" />
      </div>
      <h3 className="text-lg font-medium mb-2">
        {hasTemplates ? "Nenhum template encontrado" : "Você ainda não tem templates"}
      </h3>
      <p className="text-sm text-muted-foreground max-w-sm mb-4">
        {hasTemplates
          ? "Tente ajustar os filtros ou a busca."
          : "Crie templates no Meta WhatsApp Manager e clique em sincronizar."}
      </p>
      {!hasTemplates && (
        <Button onClick={onSync}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Sincronizar com Meta
        </Button>
      )}
    </div>
  );
}
