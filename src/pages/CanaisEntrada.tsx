import { useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { useDistributionConfigs } from "@/hooks/useLeadDistribution";
import { usePipelines } from "@/hooks/usePipelineConfig";
import {
  FileText, Zap, Globe, Pencil, Users, Plus, ExternalLink,
  ArrowRight, Copy, Settings, Link2, Radio, Sparkles, MessageCircle, Building2, Phone,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { WhatsAppRoutingDialog } from "@/components/sales/distribution/WhatsAppRoutingDialog";
import { useAvailableWhatsAppInstances } from "@/hooks/useSendWhatsAppMessage";
import MarketingPageHeader from "@/components/marketing/MarketingPageHeader";

interface MarketingForm {
  id: string;
  name: string;
  is_active: boolean;
  submissions_count: number;
  distribution_config_id: string | null;
  tenant_id: string;
}

export default function CanaisEntrada() {
  const navigate = useNavigate();
  const { tenantId } = useAuth();
  const { toast } = useToast();
  const { data: distributions } = useDistributionConfigs();
  const { data: pipelines } = usePipelines();
  const { data: instances = [] } = useAvailableWhatsAppInstances();
  const [activeTab, setActiveTab] = useState("canais");
  const [routingDialogConfigId, setRoutingDialogConfigId] = useState<string | null>(null);

  const getInstanceName = (id: string | null) => {
    if (!id) return null;
    const inst = (instances as any[]).find(i => i.id === id);
    return inst?.name || null;
  };

  // Fetch forms
  const { data: forms } = useQuery({
    queryKey: ['marketing-forms-channels', tenantId],
    queryFn: async () => {
      const { data } = await supabase
        .from('marketing_forms')
        .select('id, name, is_active, submissions_count, distribution_config_id, tenant_id')
        .order('created_at', { ascending: false });
      return (data || []) as MarketingForm[];
    },
    enabled: !!tenantId,
  });

  // Stats: leads received per distribution in last 30 days
  const { data: stats } = useQuery({
    queryKey: ['channel-stats-30d', tenantId],
    queryFn: async () => {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const { data } = await supabase
        .from('lead_distribution_log')
        .select('config_id, source')
        .gte('created_at', since);

      const byConfig: Record<string, number> = {};
      const bySource: Record<string, number> = {};
      (data || []).forEach((row: any) => {
        byConfig[row.config_id] = (byConfig[row.config_id] || 0) + 1;
        if (row.source) bySource[row.source] = (bySource[row.source] || 0) + 1;
      });
      return { byConfig, bySource };
    },
    enabled: !!tenantId,
  });

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast({ title: `${label} copiado!` });
  };

  const getPipelineName = (pipelineId: string | null | undefined) =>
    pipelines?.find(p => p.id === pipelineId)?.name || "—";

  const getDistributionName = (configId: string | null) =>
    distributions?.find(d => d.id === configId)?.name || null;

  return (
    <AppLayout>
      <div className="max-w-[1400px] mx-auto space-y-6 p-6">
        <MarketingPageHeader
          eyebrow="Marketing · Captura"
          title="Canais de Entrada"
          description="De onde vêm os leads e pra quem são distribuídos."
        />

        {/* Visual Flow Summary */}
        <Card className="bg-gradient-to-r from-slate-50 to-white border-slate-200">
          <CardContent className="py-4">
            <div className="flex items-center justify-between gap-4 text-sm">
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1 px-3 py-1.5 bg-white rounded-md border">
                  <FileText className="h-3.5 w-3.5 text-blue-500" />
                  <span className="font-medium">{forms?.length || 0} Canais</span>
                </div>
                <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                <div className="flex items-center gap-1 px-3 py-1.5 bg-white rounded-md border">
                  <Users className="h-3.5 w-3.5 text-accent" />
                  <span className="font-medium">{distributions?.filter(d => d.is_active).length || 0} Distribuições</span>
                </div>
                <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                <div className="flex items-center gap-1 px-3 py-1.5 bg-white rounded-md border">
                  <Sparkles className="h-3.5 w-3.5 text-green-500" />
                  <span className="font-medium">Pipeline</span>
                </div>
              </div>
              <div className="text-xs text-muted-foreground">
                Últimos 30 dias: <strong className="text-slate-900">{Object.values(stats?.byConfig || {}).reduce((a, b) => a + b, 0)} leads</strong>
              </div>
            </div>
          </CardContent>
        </Card>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="canais" className="gap-2">
              <FileText className="h-3.5 w-3.5" />
              Canais ({(forms?.length || 0)})
            </TabsTrigger>
            <TabsTrigger value="distribuicoes" className="gap-2">
              <Users className="h-3.5 w-3.5" />
              Distribuições ({distributions?.length || 0})
            </TabsTrigger>
          </TabsList>

          {/* CANAIS TAB */}
          <TabsContent value="canais" className="space-y-4 mt-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Cada canal representa uma origem de leads.
              </p>
              <Button onClick={() => navigate('/comercial/configuracoes?tab=forms')}>
                <Plus className="h-4 w-4 mr-1.5" />
                Novo Canal
              </Button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {/* Manual channel (always exists) */}
              <Card className="border-dashed">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Pencil className="h-4 w-4 text-slate-500" />
                    Manual (CRM)
                    <Badge variant="secondary" className="ml-auto text-[10px]">Sempre ativo</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-xs text-muted-foreground">
                  <p>Vendedor cria lead direto no pipeline pelo botão "Criar".</p>
                  <div className="flex items-center gap-1 text-slate-600">
                    <ArrowRight className="h-3 w-3" />
                    <span>Pipeline escolhido pelo vendedor</span>
                  </div>
                </CardContent>
              </Card>

              {/* API channels (each distribution config with api_key) */}
              {(distributions || []).map(dist => (
                <Card key={`api-${dist.id}`} className={!dist.is_active ? "opacity-60" : ""}>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Zap className="h-4 w-4 text-amber-500" />
                      API: {dist.name}
                      {!dist.is_active && <Badge variant="outline" className="ml-auto text-[10px]">Inativo</Badge>}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 text-xs">
                    <p className="text-muted-foreground">Webhook direto via API key.</p>
                    <div className="flex items-center gap-1">
                      <Badge variant="outline" className="gap-1 text-[10px]">
                        <Link2 className="h-3 w-3" />
                        {dist.name}
                      </Badge>
                      <ArrowRight className="h-3 w-3 text-muted-foreground" />
                      <span className="text-muted-foreground">{getPipelineName(dist.pipeline_id)}</span>
                    </div>
                    <div className="flex items-center gap-2 pt-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs flex-1"
                        onClick={() => copyToClipboard(dist.api_key, "API key")}
                      >
                        <Copy className="h-3 w-3 mr-1" />
                        Copiar API key
                      </Button>
                      <span className="text-xs text-muted-foreground">
                        📊 {stats?.byConfig[dist.id] || 0} / 30d
                      </span>
                    </div>
                  </CardContent>
                </Card>
              ))}

              {/* Form channels */}
              {(forms || []).map(form => {
                const distName = getDistributionName(form.distribution_config_id);
                return (
                  <Card key={`form-${form.id}`} className={!form.is_active ? "opacity-60" : ""}>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <FileText className="h-4 w-4 text-blue-500" />
                        Form: {form.name}
                        {!form.is_active && <Badge variant="outline" className="ml-auto text-[10px]">Inativo</Badge>}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2 text-xs">
                      <p className="text-muted-foreground">Formulário embeddável em site.</p>
                      <div className="flex items-center gap-1 flex-wrap">
                        {distName ? (
                          <>
                            <Badge variant="outline" className="gap-1 text-[10px]">
                              <Users className="h-3 w-3" />
                              {distName}
                            </Badge>
                            <ArrowRight className="h-3 w-3 text-muted-foreground" />
                            <span className="text-muted-foreground">
                              {getPipelineName(distributions?.find(d => d.id === form.distribution_config_id)?.pipeline_id)}
                            </span>
                          </>
                        ) : (
                          <Badge variant="destructive" className="text-[10px]">⚠️ Sem distribuição configurada</Badge>
                        )}
                      </div>
                      <div className="flex items-center justify-between pt-1">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => navigate(`/comercial/configuracoes?tab=forms&id=${form.id}`)}
                        >
                          <Settings className="h-3 w-3 mr-1" />
                          Editar
                        </Button>
                        <span className="text-xs text-muted-foreground">
                          📊 {form.submissions_count || 0} total
                        </span>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}

              {(!forms || forms.length === 0) && (!distributions || distributions.length === 0) && (
                <Card className="col-span-full">
                  <CardContent className="py-12 text-center">
                    <Radio className="h-10 w-10 mx-auto text-muted-foreground/30 mb-3" />
                    <p className="text-sm text-muted-foreground">Nenhum canal configurado ainda.</p>
                    <p className="text-xs text-muted-foreground mt-1">Crie um formulário ou uma distribuição API.</p>
                  </CardContent>
                </Card>
              )}
            </div>
          </TabsContent>

          {/* DISTRIBUIÇÕES TAB */}
          <TabsContent value="distribuicoes" className="space-y-4 mt-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Grupos de vendedores que recebem os leads dos canais.
              </p>
              <Button onClick={() => navigate('/comercial/configuracoes?tab=distribution')}>
                <Plus className="h-4 w-4 mr-1.5" />
                Nova Distribuição
              </Button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {(distributions || []).map(dist => {
                const linkedForms = (forms || []).filter(f => f.distribution_config_id === dist.id);
                const leadsCount = stats?.byConfig[dist.id] || 0;
                return (
                  <Card key={dist.id} className={!dist.is_active ? "opacity-60" : ""}>
                    <CardHeader>
                      <CardTitle className="text-base flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Users className="h-4 w-4 text-accent" />
                          {dist.name}
                        </div>
                        <div className="flex items-center gap-2">
                          <Switch checked={dist.is_active} disabled className="scale-75" />
                        </div>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="flex items-center justify-between text-xs">
                        <div className="flex items-center gap-1 text-muted-foreground">
                          <Sparkles className="h-3 w-3" />
                          <span>Pipeline: <strong className="text-slate-900">{getPipelineName(dist.pipeline_id)}</strong></span>
                        </div>
                        <span className="text-muted-foreground">📊 {leadsCount} / 30d</span>
                      </div>

                      {/* Linked channels */}
                      <div className="space-y-1.5 pt-2 border-t">
                        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                          Canais Conectados
                        </span>
                        <div className="flex flex-wrap gap-1">
                          <Badge variant="outline" className="gap-1 text-[10px]">
                            <Zap className="h-3 w-3" /> API
                          </Badge>
                          {linkedForms.map(f => (
                            <Badge key={f.id} variant="outline" className="gap-1 text-[10px]">
                              <FileText className="h-3 w-3" /> {f.name}
                            </Badge>
                          ))}
                          {linkedForms.length === 0 && (
                            <span className="text-[10px] text-muted-foreground italic">Só API direto</span>
                          )}
                        </div>
                      </div>

                      {/* Regras WhatsApp — quando aplicar essa distribuição em msgs recebidas */}
                      <div className="space-y-1.5 pt-2 border-t">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider inline-flex items-center gap-1">
                            <MessageCircle className="h-3 w-3" />
                            Regras WhatsApp
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 text-[10px] px-1.5"
                            onClick={() => setRoutingDialogConfigId(dist.id)}
                          >
                            <Pencil className="h-3 w-3 mr-1" />
                            Editar
                          </Button>
                        </div>
                        <div className="flex flex-wrap items-center gap-1 text-[11px]">
                          {dist.match_instance_id ? (
                            <Badge variant="outline" className="gap-1 text-[10px]">
                              {(instances as any[]).find(i => i.id === dist.match_instance_id)?.provider === 'meta_cloud' ? (
                                <Building2 className="h-3 w-3 text-blue-600" />
                              ) : (
                                <Phone className="h-3 w-3 text-emerald-600" />
                              )}
                              {getInstanceName(dist.match_instance_id) || 'Instância'}
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-[10px] text-muted-foreground">qualquer canal</Badge>
                          )}
                          {dist.match_keywords && dist.match_keywords.length > 0 ? (
                            <>
                              <span className="text-muted-foreground">·</span>
                              <span className="text-muted-foreground">
                                {dist.match_type === 'none' ? 'sem' : dist.match_type === 'all' ? 'todas:' : ''}
                              </span>
                              {dist.match_keywords.slice(0, 3).map(kw => (
                                <Badge key={kw} variant="secondary" className="text-[10px]">{kw}</Badge>
                              ))}
                              {dist.match_keywords.length > 3 && (
                                <span className="text-[10px] text-muted-foreground">+{dist.match_keywords.length - 3}</span>
                              )}
                            </>
                          ) : (
                            <>
                              <span className="text-muted-foreground">·</span>
                              <span className="text-[10px] text-muted-foreground">qualquer mensagem</span>
                            </>
                          )}
                          <span className="ml-auto text-[10px] text-muted-foreground">pri: {dist.priority ?? 100}</span>
                        </div>
                      </div>

                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full h-7 text-xs"
                        onClick={() => navigate(`/comercial/configuracoes?tab=distribution`)}
                      >
                        <Settings className="h-3 w-3 mr-1" />
                        Configurar Vendedores & Pesos
                      </Button>
                    </CardContent>
                  </Card>
                );
              })}

              {(!distributions || distributions.length === 0) && (
                <Card className="col-span-full">
                  <CardContent className="py-12 text-center">
                    <Users className="h-10 w-10 mx-auto text-muted-foreground/30 mb-3" />
                    <p className="text-sm text-muted-foreground">Nenhuma distribuição criada ainda.</p>
                  </CardContent>
                </Card>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </div>

      {/* Dialog de regras WhatsApp pra distribuição selecionada */}
      {routingDialogConfigId && (() => {
        const cfg = (distributions || []).find(d => d.id === routingDialogConfigId);
        if (!cfg) return null;
        return (
          <WhatsAppRoutingDialog
            open={!!routingDialogConfigId}
            onOpenChange={(o) => !o && setRoutingDialogConfigId(null)}
            config={cfg}
          />
        );
      })()}
    </AppLayout>
  );
}
