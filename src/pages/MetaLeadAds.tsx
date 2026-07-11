import { useState } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Facebook,
  Plus,
  RefreshCw,
  Trash2,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Loader2,
  ChevronDown,
  ChevronRight,
  FileText,
  Users,
  Clock,
  Zap,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import MarketingPageHeader from '@/components/marketing/MarketingPageHeader';
import {
  useMetaPages,
  useAddMetaPage,
  useToggleMetaPage,
  useDeleteMetaPage,
  useMetaForms,
  useSyncMetaForms,
  useToggleMetaForm,
  useMetaLeadLogs,
} from '@/hooks/useMetaLeadAds';

export default function MetaLeadAds() {
  const { toast } = useToast();
  const { data: pages, isLoading: pagesLoading } = useMetaPages();
  const { data: forms } = useMetaForms();
  const { data: logs } = useMetaLeadLogs(100);
  const addPage = useAddMetaPage();
  const togglePage = useToggleMetaPage();
  const deletePage = useDeleteMetaPage();
  const syncForms = useSyncMetaForms();
  const toggleForm = useToggleMetaForm();

  const [showAddPage, setShowAddPage] = useState(false);
  const [newPageToken, setNewPageToken] = useState('');
  const [expandedPage, setExpandedPage] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  const handleAddPage = async () => {
    if (!newPageToken.trim()) {
      toast({ title: 'Cole o Page Access Token', variant: 'destructive' });
      return;
    }

    setVerifying(true);
    try {
      // Verify token with Meta
      const resp = await fetch(`https://graph.facebook.com/v19.0/me?access_token=${newPageToken}`);
      const data = await resp.json();

      if (data.error) {
        toast({ title: 'Token inválido', description: data.error.message, variant: 'destructive' });
        return;
      }

      // Subscribe to leadgen webhook
      const subResp = await fetch(
        `https://graph.facebook.com/v19.0/${data.id}/subscribed_apps?subscribed_fields=leadgen&access_token=${newPageToken}`,
        { method: 'POST' }
      );
      const subData = await subResp.json();

      if (!subData.success) {
        toast({ title: 'Erro ao assinar webhook', description: 'Verifique as permissões do token', variant: 'destructive' });
        return;
      }

      await addPage.mutateAsync({
        pageId: data.id,
        pageName: data.name,
        pageAccessToken: newPageToken,
      });

      // Sync forms
      await syncForms.mutateAsync({ pageId: data.id, pageAccessToken: newPageToken });

      toast({ title: `${data.name} conectada!`, description: 'Formulários sincronizados' });
      setShowAddPage(false);
      setNewPageToken('');
      setExpandedPage(data.id);
    } catch (err: any) {
      toast({ title: 'Erro', description: err.message, variant: 'destructive' });
    } finally {
      setVerifying(false);
    }
  };

  const handleSyncForms = async (page: any) => {
    try {
      const result = await syncForms.mutateAsync({
        pageId: page.page_id,
        pageAccessToken: page.page_access_token,
      });
      toast({ title: `${result.synced} formulários sincronizados` });
    } catch (err: any) {
      toast({ title: 'Erro ao sincronizar', description: err.message, variant: 'destructive' });
    }
  };

  const handleDeletePage = async (page: any) => {
    try {
      await deletePage.mutateAsync(page.id);
      toast({ title: `${page.page_name} removida` });
    } catch {
      toast({ title: 'Erro ao remover', variant: 'destructive' });
    }
  };

  const pageForms = (pageId: string) => (forms || []).filter(f => f.page_id === pageId);
  const enabledFormsCount = (pageId: string) => pageForms(pageId).filter(f => f.is_enabled).length;

  const statusBadge = (status: string) => {
    if (status === 'success') return <Badge className="bg-emerald-100 text-emerald-700 text-[10px]">Sincronizado</Badge>;
    if (status === 'error') return <Badge className="bg-red-100 text-red-700 text-[10px]">Erro</Badge>;
    if (status === 'skipped_disabled') return <Badge className="bg-slate-100 text-slate-600 text-[10px]">Desativado</Badge>;
    return <Badge variant="secondary" className="text-[10px]">{status}</Badge>;
  };

  return (
    <AppLayout>
      <div className="p-6 space-y-6 max-w-[1400px] mx-auto">
        <MarketingPageHeader
          eyebrow="Marketing · Captura"
          title="Lead Ads"
          description="Receba leads diretamente dos formulários do Meta (Instagram e Facebook)."
          action={
            <Button size="sm" className="bg-[#BAA05E] hover:bg-[#917D3D] text-white gap-1.5" onClick={() => setShowAddPage(true)}>
              <Plus className="h-3.5 w-3.5" /> Conectar página
            </Button>
          }
        />

        {/* Stats Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-blue-50 flex items-center justify-center">
                  <Facebook className="h-5 w-5 text-blue-600" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{(pages || []).filter(p => p.is_active).length}</p>
                  <p className="text-xs text-muted-foreground">Páginas conectadas</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-violet-50 flex items-center justify-center">
                  <FileText className="h-5 w-5 text-violet-600" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{(forms || []).filter(f => f.is_enabled).length}</p>
                  <p className="text-xs text-muted-foreground">Formulários ativos</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-emerald-50 flex items-center justify-center">
                  <Users className="h-5 w-5 text-emerald-600" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{(logs || []).filter(l => l.status === 'success').length}</p>
                  <p className="text-xs text-muted-foreground">Leads recebidos</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-red-50 flex items-center justify-center">
                  <AlertTriangle className="h-5 w-5 text-red-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{(logs || []).filter(l => l.status === 'error').length}</p>
                  <p className="text-xs text-muted-foreground">Erros</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Connected Pages */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Zap className="h-4 w-4" /> Páginas Conectadas
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {pagesLoading ? (
              <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            ) : !pages?.length ? (
              <div className="text-center py-8">
                <Facebook className="h-12 w-12 mx-auto text-muted-foreground/30 mb-3" />
                <p className="text-muted-foreground text-sm">Nenhuma página conectada</p>
                <Button variant="outline" className="mt-3" onClick={() => setShowAddPage(true)} size="sm">
                  <Plus className="h-4 w-4 mr-1" /> Conectar primeira página
                </Button>
              </div>
            ) : (
              pages.map(page => {
                const isExpanded = expandedPage === page.page_id;
                const pForms = pageForms(page.page_id);
                const enabledCount = enabledFormsCount(page.page_id);

                return (
                  <div key={page.id} className="border rounded-lg overflow-hidden">
                    {/* Page Header */}
                    <div
                      className="flex items-center justify-between p-4 cursor-pointer hover:bg-muted/30 transition-colors"
                      onClick={() => setExpandedPage(isExpanded ? null : page.page_id)}
                    >
                      <div className="flex items-center gap-3">
                        {isExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                        <div className="h-9 w-9 rounded-lg bg-blue-100 flex items-center justify-center text-blue-700 font-bold text-sm">
                          {page.page_name[0]}
                        </div>
                        <div>
                          <p className="font-medium text-sm">{page.page_name}</p>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-[10px] text-muted-foreground">{enabledCount}/{pForms.length} formulários ativos</span>
                            {page.total_leads_synced > 0 && (
                              <span className="text-[10px] text-muted-foreground">• {page.total_leads_synced} leads</span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 px-2"
                          onClick={() => handleSyncForms(page)}
                          disabled={syncForms.isPending}
                        >
                          <RefreshCw className={`h-3.5 w-3.5 ${syncForms.isPending ? 'animate-spin' : ''}`} />
                        </Button>
                        <Switch
                          checked={page.is_active}
                          onCheckedChange={(v) => togglePage.mutate({ id: page.id, isActive: v })}
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 px-2 text-destructive hover:text-destructive"
                          onClick={() => handleDeletePage(page)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>

                    {/* Forms List */}
                    {isExpanded && (
                      <div className="border-t bg-muted/10">
                        {pForms.length === 0 ? (
                          <div className="p-4 text-center">
                            <p className="text-xs text-muted-foreground">Nenhum formulário. Clique em sincronizar.</p>
                          </div>
                        ) : (
                          <div className="divide-y">
                            {pForms.map(form => (
                              <div key={form.id} className="flex items-center justify-between px-4 py-2.5 pl-14">
                                <div className="flex items-center gap-2 flex-1 min-w-0">
                                  <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                  <span className="text-sm truncate">{form.form_name}</span>
                                  {form.leads_count > 0 && (
                                    <Badge variant="secondary" className="text-[10px] shrink-0">{form.leads_count} leads</Badge>
                                  )}
                                </div>
                                <Switch
                                  checked={form.is_enabled}
                                  onCheckedChange={(v) => toggleForm.mutate({ id: form.id, isEnabled: v })}
                                />
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>

        {/* Lead Logs */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Clock className="h-4 w-4" /> Últimos Leads via Lead Ads
              </CardTitle>
              <Badge variant="outline" className="text-xs">{(logs || []).length} registros</Badge>
            </div>
          </CardHeader>
          <CardContent>
            {!logs?.length ? (
              <p className="text-sm text-muted-foreground text-center py-6">Nenhum lead recebido ainda via Lead Ads</p>
            ) : (
              <ScrollArea className="max-h-[400px]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">Hora</TableHead>
                      <TableHead className="text-xs">Lead</TableHead>
                      <TableHead className="text-xs">Formulário</TableHead>
                      <TableHead className="text-xs">Vendedor</TableHead>
                      <TableHead className="text-xs">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {logs.map(log => (
                      <TableRow key={log.id}>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                          {format(new Date(log.created_at), 'dd/MM HH:mm', { locale: ptBR })}
                        </TableCell>
                        <TableCell>
                          <div>
                            <p className="text-xs font-medium">{log.lead_name || '-'}</p>
                            <p className="text-[10px] text-muted-foreground">{log.lead_email || log.lead_phone || '-'}</p>
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground truncate max-w-[150px]">
                          {log.form_name || '-'}
                        </TableCell>
                        <TableCell className="text-xs">{log.assigned_to_name || '-'}</TableCell>
                        <TableCell>{statusBadge(log.status)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Add Page Dialog */}
      <Dialog open={showAddPage} onOpenChange={setShowAddPage}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Facebook className="h-5 w-5 text-blue-600" />
              Conectar Página
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Page Access Token</Label>
              <Input
                value={newPageToken}
                onChange={e => setNewPageToken(e.target.value)}
                placeholder="Cole o token aqui..."
                className="mt-1 font-mono text-xs"
              />
              <p className="text-[10px] text-muted-foreground mt-1.5">
                Gere no Graph API Explorer: selecione o App UFCRM → Page Token → escolha a página
              </p>
            </div>
            <Button
              className="w-full"
              onClick={handleAddPage}
              disabled={verifying || addPage.isPending}
            >
              {verifying ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Verificando...</>
              ) : (
                <><CheckCircle className="h-4 w-4 mr-2" /> Conectar e Sincronizar</>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
