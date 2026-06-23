import { useState, useMemo, useMemo as useMemoLib } from 'react';
import { useWhatsAppTemplates } from '@/hooks/useWhatsAppTemplates';
import { useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  ArrowLeft, ChevronLeft, ChevronRight, Loader2, Rocket, Save,
  CheckCircle2, FileText, MessageSquare, Users, Send, UserCheck, Zap,
  Clock, AlertCircle, Eye, Shield, Sparkles,
} from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import type {
  AudienceFilters, AssignmentMode, CampaignProvider, CloudTemplateParam,
  CampaignTemplate,
} from '@/types/campaign.types';
import {
  useCreateCampaign, useStartCampaign, useScheduleCampaign,
  useAudienceCount,
} from '@/hooks/useCampaigns';
import ChannelPicker from '@/components/campaigns/ChannelPicker';
import AudiencePicker from '@/components/campaigns/AudiencePicker';
import CloudTemplatePicker from '@/components/campaigns/CloudTemplatePicker';
import TemplateEditor from '@/components/campaigns/TemplateEditor';
import TemplatePicker from '@/components/campaigns/TemplatePicker';
import InstanceSelector from '@/components/campaigns/InstanceSelector';
import AntiBlockConfig from '@/components/campaigns/AntiBlockConfig';
import AssignmentRuleConfig from '@/components/campaigns/AssignmentRuleConfig';
import MarketingPageHeader from '@/components/marketing/MarketingPageHeader';
import { useWhatsAppInstances } from '@/hooks/useCampaigns';

type StepId = 'basic' | 'channel' | 'audience' | 'message' | 'send' | 'assignment' | 'review';

interface StepDef {
  id: StepId;
  label: string;
  icon: any;
  description: string;
}

const STEPS: StepDef[] = [
  { id: 'basic',      label: 'Identidade',     icon: FileText,       description: 'Nome e descrição' },
  { id: 'channel',    label: 'Canal',          icon: Zap,            description: 'API Oficial ou Não Oficial' },
  { id: 'audience',   label: 'Audiência',      icon: Users,          description: 'Quem vai receber' },
  { id: 'message',    label: 'Mensagem',       icon: MessageSquare,  description: 'Template ou texto' },
  { id: 'assignment', label: 'Quem responde',  icon: UserCheck,      description: 'Pra quem vai a conversa quando o lead responder' },
  { id: 'send',       label: 'Envio',          icon: Clock,          description: 'Quando começar e ritmo do disparo' },
  { id: 'review',     label: 'Revisão',        icon: Eye,            description: 'Confira tudo antes de disparar' },
];

export default function SalesCampaignNew() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [currentStep, setCurrentStep] = useState<StepId>('basic');
  const [submitting, setSubmitting] = useState(false);

  // Form state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [provider, setProvider] = useState<CampaignProvider>('cloud_api');
  const [filters, setFilters] = useState<AudienceFilters>({});
  const [instanceIds, setInstanceIds] = useState<string[]>([]);

  // UAZAPI (texto livre)
  const [messageContents, setMessageContents] = useState<string[]>(['']);
  const [activeVariation, setActiveVariation] = useState(0);

  // Cloud API (template)
  const [cloudTemplateId, setCloudTemplateId] = useState<string | null>(null);
  const [cloudTemplateParams, setCloudTemplateParams] = useState<CloudTemplateParam[]>([]);

  // Envio
  const [sendNow, setSendNow] = useState(true);
  const [scheduledAt, setScheduledAt] = useState('');
  const [businessHoursStart, setBusinessHoursStart] = useState('08:00');
  const [businessHoursEnd, setBusinessHoursEnd] = useState('20:00');
  const [antiBlockConfig, setAntiBlockConfig] = useState({
    delay_min_seconds: 45,
    delay_max_seconds: 90,
    batch_size: 20,
    batch_pause_min_seconds: 180,
    batch_pause_max_seconds: 300,
    hourly_limit_per_instance: 40,
    daily_limit_per_instance: 500,
  });

  // Atribuição
  const [assignmentMode, setAssignmentMode] = useState<AssignmentMode>('keep_current');
  const [assignmentTargetId, setAssignmentTargetId] = useState<string | null>(null);
  const [distributionConfigId, setDistributionConfigId] = useState<string | null>(null);

  const createCampaign = useCreateCampaign();
  const startCampaign = useStartCampaign();
  const scheduleCampaign = useScheduleCampaign();
  const { data: audienceCount } = useAudienceCount(filters);

  const stepIndex = STEPS.findIndex((s) => s.id === currentStep);

  // Validações por step
  const stepValid: Record<StepId, boolean> = {
    basic: name.trim().length > 0,
    channel: !!provider,
    audience: (audienceCount || 0) > 0 || ((filters as any).lead_ids?.length || 0) > 0,
    message: provider === 'cloud_api'
      ? !!cloudTemplateId
      : messageContents.some((m) => m.trim().length > 0),
    send: instanceIds.length > 0 && (sendNow || !!scheduledAt),
    assignment: true,
    review: true,
  };

  const [confirmOpen, setConfirmOpen] = useState(false);

  const canNext = stepValid[currentStep];
  const isLastStep = stepIndex === STEPS.length - 1;

  const goNext = () => {
    if (!canNext) return;
    const next = STEPS[stepIndex + 1];
    if (next) setCurrentStep(next.id);
  };
  const goBack = () => {
    const prev = STEPS[stepIndex - 1];
    if (prev) setCurrentStep(prev.id);
  };

  const handleSubmit = async (action: 'draft' | 'start' | 'schedule') => {
    if (!name.trim()) {
      toast({ title: 'Nome obrigatório', variant: 'destructive' });
      return;
    }
    if (provider === 'cloud_api' && !cloudTemplateId) {
      toast({ title: 'Selecione um template aprovado', variant: 'destructive' });
      return;
    }
    if (instanceIds.length === 0) {
      toast({ title: 'Selecione ao menos uma instância', variant: 'destructive' });
      return;
    }

    setSubmitting(true);
    try {
      const cleanedMessages = messageContents.map((m) => m.trim()).filter(Boolean);
      const isUazapi = provider === 'uazapi';

      const campaign = await createCampaign.mutateAsync({
        name,
        description: description || null,
        provider,
        status: 'draft',
        audience_filters: filters,
        instance_ids: instanceIds,
        // UAZAPI
        message_content: isUazapi ? cleanedMessages[0] || '' : '',
        message_contents: isUazapi ? cleanedMessages : [],
        // Cloud API
        cloud_template_id: !isUazapi ? cloudTemplateId : null,
        cloud_template_params: !isUazapi ? cloudTemplateParams : [],
        // Anti-block + janela só pra UAZAPI; Cloud API zera/usa defaults relaxados.
        ...(isUazapi
          ? {
              business_hours_start: businessHoursStart,
              business_hours_end: businessHoursEnd,
              ...antiBlockConfig,
            }
          : {
              business_hours_start: '00:00',
              business_hours_end: '23:59',
              delay_min_seconds: 0,
              delay_max_seconds: 0,
              batch_size: 50,
              batch_pause_min_seconds: 0,
              batch_pause_max_seconds: 0,
              hourly_limit_per_instance: 100000,
              daily_limit_per_instance: 1000000,
            }),
        // Atribuição
        assignment_mode: assignmentMode,
        assignment_target_id: assignmentTargetId,
        assignment_distribution_config_id: distributionConfigId,
      } as any);

      if (action === 'start') {
        await startCampaign.mutateAsync(campaign.id);
        toast({ title: 'Campanha iniciada!', description: `Enviando para ${audienceCount} leads.` });
      } else if (action === 'schedule') {
        await scheduleCampaign.mutateAsync({ campaignId: campaign.id, scheduledAt });
        toast({ title: 'Campanha agendada', description: `Será enviada em ${new Date(scheduledAt).toLocaleString('pt-BR')}` });
      } else {
        toast({ title: 'Salva como rascunho' });
      }
      navigate(`/comercial/campanhas/${campaign.id}`);
    } catch (err: any) {
      toast({ title: 'Erro ao criar campanha', description: err.message, variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AppLayout>
      <div className="flex flex-col h-[calc(100vh-4rem)]">
        {/* Topbar slim */}
        <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-10">
          <div className="px-6 py-3 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <Button variant="ghost" size="sm" onClick={() => navigate('/comercial/campanhas')} className="-ml-2 shrink-0">
                <ArrowLeft className="h-4 w-4 mr-1.5" /> Voltar
              </Button>
              <div className="h-5 w-px bg-border shrink-0" />
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-medium">
                  Campanha WhatsApp
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-[#BAA05E]/10 text-[#BAA05E] font-medium uppercase tracking-wider">
                  Nova
                </span>
              </div>
              <div className="h-5 w-px bg-border shrink-0" />
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Sem título"
                className="h-9 text-sm font-semibold border-none shadow-none px-2 hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-1 focus-visible:ring-[#BAA05E]/30 max-w-md"
              />
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {/* Atalho rápido: salvar rascunho a qualquer momento */}
              <Button variant="ghost" size="sm" onClick={() => handleSubmit('draft')} disabled={submitting || !name.trim()} className="gap-1.5 text-muted-foreground">
                <Save className="h-3.5 w-3.5" />
                Salvar rascunho
              </Button>
            </div>
          </div>
        </header>

        {/* Body 2-col: stepper + main */}
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-[280px_1fr] overflow-hidden">
          {/* Stepper lateral */}
          <aside className="border-r overflow-y-auto p-5 bg-background/40">
            <Label className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-medium mb-3 block">
              Etapas
            </Label>
            <nav className="space-y-1">
              {STEPS.map((s, i) => {
                const isCurrent = s.id === currentStep;
                const isPast = i < stepIndex;
                const isFuture = i > stepIndex;
                const passed = stepValid[s.id];
                const Icon = s.icon;
                return (
                  <button
                    key={s.id}
                    onClick={() => (i <= stepIndex || passed) && setCurrentStep(s.id)}
                    disabled={isFuture && !passed}
                    className={cn(
                      'w-full flex items-start gap-3 px-3 py-2.5 rounded-lg text-left transition-colors',
                      isCurrent && 'bg-[#BAA05E]/10 text-foreground',
                      !isCurrent && isPast && 'text-foreground hover:bg-muted/60',
                      !isCurrent && !isPast && 'text-muted-foreground hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-60',
                    )}
                  >
                    <div className={cn(
                      'w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5',
                      isCurrent && 'bg-[#BAA05E] text-white',
                      !isCurrent && isPast && 'bg-emerald-500/15 text-emerald-700',
                      !isCurrent && !isPast && 'bg-muted text-muted-foreground',
                    )}>
                      {isPast ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className={cn('text-sm font-medium leading-tight', isCurrent && 'text-[#917D3D]')}>
                        {String(i + 1).padStart(2, '0')} · {s.label}
                      </p>
                      <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">
                        {s.description}
                      </p>
                    </div>
                  </button>
                );
              })}
            </nav>
          </aside>

          {/* Main */}
          <main className="overflow-y-auto flex flex-col">
            <div className="max-w-3xl mx-auto p-8 space-y-6 flex-1 w-full">
              <MarketingPageHeader
                eyebrow={`Etapa ${stepIndex + 1} de ${STEPS.length}`}
                title={STEPS[stepIndex].label}
                description={STEPS[stepIndex].description}
                noBorder
              />

              {/* Conteúdo por step */}
              {currentStep === 'basic' && (
                <div className="space-y-4">
                  <div>
                    <Label className="text-xs text-muted-foreground">Nome da campanha</Label>
                    <Input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Ex: Reativação Fev/26"
                      className="mt-1.5"
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Descrição (opcional)</Label>
                    <Textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="Objetivo, contexto, lembretes pra equipe…"
                      rows={3}
                      className="mt-1.5 resize-none"
                    />
                  </div>
                </div>
              )}

              {currentStep === 'channel' && (
                <ChannelPicker value={provider} onChange={(p) => {
                  setProvider(p);
                  // Reset instances/mensagem quando troca de canal
                  setInstanceIds([]);
                  if (p === 'cloud_api') setMessageContents(['']);
                  else { setCloudTemplateId(null); setCloudTemplateParams([]); }
                }} />
              )}

              {currentStep === 'audience' && (
                <AudiencePicker
                  filters={filters}
                  onChange={setFilters}
                  channelHint={provider}
                />
              )}

              {currentStep === 'message' && (
                <div className="space-y-4">
                  {provider === 'cloud_api' ? (
                    <CloudTemplatePicker
                      selectedTemplateId={cloudTemplateId}
                      params={cloudTemplateParams}
                      onChange={(id, params) => {
                        setCloudTemplateId(id);
                        setCloudTemplateParams(params);
                      }}
                    />
                  ) : (
                    <UazapiMessageEditor
                      messages={messageContents}
                      onChange={setMessageContents}
                      activeIdx={activeVariation}
                      setActiveIdx={setActiveVariation}
                    />
                  )}
                </div>
              )}

              {currentStep === 'send' && (
                <div className="space-y-6">
                  {/* Quando enviar */}
                  <Card>
                    <CardContent className="p-4 space-y-3">
                      <Label className="text-sm font-medium">Quando enviar</Label>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          onClick={() => setSendNow(true)}
                          className={cn(
                            'p-3 rounded-md border text-left transition-colors',
                            sendNow ? 'border-[#BAA05E] bg-[#BAA05E]/5' : 'hover:bg-muted/40',
                          )}
                        >
                          <p className="text-sm font-medium">Iniciar agora</p>
                          <p className="text-xs text-muted-foreground mt-0.5">Começa o envio imediatamente após criar</p>
                        </button>
                        <button
                          onClick={() => setSendNow(false)}
                          className={cn(
                            'p-3 rounded-md border text-left transition-colors',
                            !sendNow ? 'border-[#BAA05E] bg-[#BAA05E]/5' : 'hover:bg-muted/40',
                          )}
                        >
                          <p className="text-sm font-medium">Agendar</p>
                          <p className="text-xs text-muted-foreground mt-0.5">Define data e horário pra começar</p>
                        </button>
                      </div>
                      {!sendNow && (
                        <Input
                          type="datetime-local"
                          value={scheduledAt}
                          onChange={(e) => setScheduledAt(e.target.value)}
                        />
                      )}
                    </CardContent>
                  </Card>

                  {/* Instâncias */}
                  <div>
                    <Label className="text-xs uppercase tracking-wider text-muted-foreground font-medium mb-2 block">
                      {provider === 'cloud_api' ? 'Conta Cloud API' : 'Instâncias UAZAPI'}
                    </Label>
                    <ProviderAwareInstanceSelector
                      provider={provider}
                      value={instanceIds}
                      onChange={setInstanceIds}
                    />
                  </div>

                  {/* Janela e anti-block só fazem sentido pra UAZAPI */}
                  {provider === 'uazapi' ? (
                    <>
                      <Card>
                        <CardContent className="p-4 space-y-3">
                          <Label className="text-sm font-medium">Janela de horário</Label>
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <Label className="text-xs text-muted-foreground">Início</Label>
                              <Input type="time" value={businessHoursStart} onChange={(e) => setBusinessHoursStart(e.target.value)} className="mt-1" />
                            </div>
                            <div>
                              <Label className="text-xs text-muted-foreground">Fim</Label>
                              <Input type="time" value={businessHoursEnd} onChange={(e) => setBusinessHoursEnd(e.target.value)} className="mt-1" />
                            </div>
                          </div>
                          <p className="text-[11px] text-muted-foreground">
                            Mensagens só serão enviadas neste intervalo (horário de Brasília).
                          </p>
                        </CardContent>
                      </Card>
                      <AntiBlockConfig value={antiBlockConfig} onChange={setAntiBlockConfig as any} />
                    </>
                  ) : (
                    /* Cloud API: Meta tem rate-limiting próprio. Sem delays nem limites manuais. */
                    <Card className="bg-emerald-50/40 border-emerald-200">
                      <CardContent className="p-4 flex items-start gap-3">
                        <Shield className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                        <div className="space-y-1">
                          <p className="text-sm font-medium">Sem limites manuais</p>
                          <p className="text-xs text-muted-foreground leading-relaxed">
                            API Oficial (Meta) gerencia rate-limiting, qualidade da conta e janela de envio automaticamente. Não precisa configurar delays, batches ou janela de horário. A Meta libera o ritmo conforme o tier da sua conta WhatsApp Business.
                          </p>
                        </div>
                      </CardContent>
                    </Card>
                  )}
                </div>
              )}

              {currentStep === 'assignment' && (
                <div className="space-y-4">
                  {/* Card explicativo */}
                  <div className="rounded-lg border border-[#BAA05E]/20 bg-[#BAA05E]/[0.03] p-4 flex items-start gap-3">
                    <div className="w-8 h-8 rounded-lg bg-[#BAA05E]/15 flex items-center justify-center shrink-0">
                      <UserCheck className="h-4 w-4 text-[#BAA05E]" />
                    </div>
                    <div className="space-y-1.5">
                      <p className="text-sm font-medium">Quando o lead responder, pra quem vai a conversa?</p>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        Toda mensagem disparada pode ser respondida. Aqui você define <strong>quem assume o lead a partir dessa resposta</strong> — pode manter o vendedor atual, distribuir entre o time de SDR/Closer no esquema round-robin, ou direcionar pra uma pessoa específica.
                      </p>
                    </div>
                  </div>

                  <AssignmentRuleConfig
                    mode={assignmentMode}
                    targetId={assignmentTargetId}
                    distributionConfigId={distributionConfigId}
                    onModeChange={setAssignmentMode}
                    onTargetChange={setAssignmentTargetId}
                    onDistributionConfigChange={setDistributionConfigId}
                  />
                </div>
              )}

              {currentStep === 'review' && (
                <ReviewPanel
                  name={name}
                  description={description}
                  provider={provider}
                  audienceCount={audienceCount || 0}
                  filters={filters}
                  cloudTemplateId={cloudTemplateId}
                  messageContents={messageContents}
                  instanceIdsCount={instanceIds.length}
                  sendNow={sendNow}
                  scheduledAt={scheduledAt}
                  assignmentMode={assignmentMode}
                />
              )}
            </div>

            {/* Footer sticky com navegação do wizard */}
            <footer className="sticky bottom-0 z-10 border-t bg-background/95 backdrop-blur-sm">
              <div className="max-w-3xl mx-auto px-8 py-3 flex items-center justify-between gap-3">
                <Button variant="ghost" size="sm" onClick={goBack} disabled={stepIndex === 0} className="gap-1">
                  <ChevronLeft className="h-4 w-4" /> Voltar
                </Button>
                <div className="text-[11px] text-muted-foreground">
                  Etapa {stepIndex + 1} de {STEPS.length}
                  {!canNext && currentStep !== 'assignment' && (
                    <span className="ml-2 text-amber-700">· complete pra avançar</span>
                  )}
                </div>
                {isLastStep ? (
                  <Button
                    size="sm"
                    className="bg-[#BAA05E] hover:bg-[#917D3D] text-white gap-1.5"
                    onClick={() => setConfirmOpen(true)}
                    disabled={submitting || !stepValid.message || !stepValid.audience || !stepValid.send || (!sendNow && !scheduledAt)}
                  >
                    {submitting ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : sendNow ? (
                      <Rocket className="h-3.5 w-3.5" />
                    ) : (
                      <Clock className="h-3.5 w-3.5" />
                    )}
                    {sendNow ? 'Enviar agora' : 'Agendar envio'}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    className="bg-[#BAA05E] hover:bg-[#917D3D] text-white gap-1"
                    onClick={goNext}
                    disabled={!canNext}
                  >
                    Próximo <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </footer>
          </main>
        </div>
      </div>

      {/* Confirmação final — última chance de revisar */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              {sendNow ? <Rocket className="h-5 w-5 text-[#BAA05E]" /> : <Clock className="h-5 w-5 text-[#BAA05E]" />}
              {sendNow ? 'Confirmar envio?' : 'Confirmar agendamento?'}
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-3 pt-2">
              <span className="block">
                Vai disparar pra <strong className="text-foreground">{(audienceCount || 0).toLocaleString('pt-BR')} {audienceCount === 1 ? 'lead' : 'leads'}</strong> via{' '}
                <strong className="text-foreground">
                  {provider === 'cloud_api' ? 'API Oficial (Meta)' : 'UAZAPI'}
                </strong>.
              </span>
              {sendNow ? (
                <span className="block text-amber-700">
                  O envio começa imediatamente após confirmar.
                </span>
              ) : (
                <span className="block">
                  Agendada para <strong className="text-foreground">{new Date(scheduledAt).toLocaleString('pt-BR')}</strong>.
                </span>
              )}
              <span className="block text-xs">
                Essa ação não pode ser desfeita depois que começar.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Revisar de novo</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmOpen(false);
                handleSubmit(sendNow ? 'start' : 'schedule');
              }}
              disabled={submitting}
              className="bg-[#BAA05E] hover:bg-[#917D3D] text-white"
            >
              {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
              {sendNow ? 'Sim, enviar agora' : 'Sim, agendar'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}

// ─────────────────────────────────────────────────────────────────
// UAZAPI Message editor (variações)
// ─────────────────────────────────────────────────────────────────

function UazapiMessageEditor({
  messages, onChange, activeIdx, setActiveIdx,
}: {
  messages: string[];
  onChange: (messages: string[]) => void;
  activeIdx: number;
  setActiveIdx: (i: number) => void;
}) {
  const MAX = 5;
  const add = () => {
    if (messages.length >= MAX) return;
    onChange([...messages, '']);
    setActiveIdx(messages.length);
  };
  const remove = (i: number) => {
    if (messages.length <= 1) return;
    const next = messages.filter((_, idx) => idx !== i);
    onChange(next);
    if (activeIdx >= next.length) setActiveIdx(next.length - 1);
  };
  const update = (i: number, v: string) => {
    const next = [...messages];
    next[i] = v;
    onChange(next);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <Label className="text-sm font-medium">Variações de mensagem</Label>
          <p className="text-xs text-muted-foreground mt-0.5">
            Se houver mais de uma, alterna automaticamente (round-robin) pra parecer mais natural.
          </p>
        </div>
        <Badge variant="outline" className="text-[10px]">
          {messages.length}/{MAX}
        </Badge>
      </div>

      <div className="flex items-center gap-1 flex-wrap">
        {messages.map((m, i) => (
          <button
            key={i}
            onClick={() => setActiveIdx(i)}
            className={cn(
              'flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
              i === activeIdx
                ? 'bg-[#BAA05E] text-white'
                : 'bg-muted text-muted-foreground hover:bg-muted/80',
            )}
          >
            Msg {i + 1}
            {m.trim() === '' && <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />}
          </button>
        ))}
        {messages.length < MAX && (
          <button
            onClick={add}
            className="px-3 py-1.5 rounded-md text-xs font-medium text-muted-foreground hover:bg-muted/80 border border-dashed"
          >
            + variação
          </button>
        )}
        {messages.length > 1 && (
          <button
            onClick={() => remove(activeIdx)}
            className="px-3 py-1.5 rounded-md text-xs font-medium text-destructive hover:bg-destructive/10"
          >
            remover
          </button>
        )}
      </div>

      <TemplateEditor
        value={messages[activeIdx] || ''}
        onChange={(val) => update(activeIdx, val)}
        sampleLeads={[]}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Instance selector ciente do provider
// ─────────────────────────────────────────────────────────────────

function ProviderAwareInstanceSelector({
  provider, value, onChange,
}: { provider: CampaignProvider; value: string[]; onChange: (ids: string[]) => void }) {
  const { data: instances = [], isLoading } = useWhatsAppInstances(provider);
  const connected = instances.filter((i: any) => i.status === 'connected');

  if (isLoading) {
    return <div className="p-4 text-sm text-muted-foreground text-center">Carregando…</div>;
  }
  if (connected.length === 0) {
    return (
      <Card className="border-amber-200 bg-amber-50/40">
        <CardContent className="p-4 text-sm">
          {provider === 'cloud_api'
            ? 'Nenhuma instância Cloud API conectada. Configure em Configurações → Integrações → WhatsApp Cloud.'
            : 'Nenhuma instância UAZAPI dedicada a campanha. Crie uma em Configurações → WhatsApp Campanhas.'}
        </CardContent>
      </Card>
    );
  }

  const toggle = (id: string) => {
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  };

  return (
    <div className="space-y-1.5">
      {connected.map((inst: any) => {
        const checked = value.includes(inst.id);
        return (
          <label
            key={inst.id}
            className={cn(
              'flex items-center gap-3 p-3 rounded-md border cursor-pointer transition-colors',
              checked ? 'border-[#BAA05E] bg-[#BAA05E]/5' : 'hover:bg-muted/40',
            )}
          >
            <input
              type="checkbox"
              checked={checked}
              onChange={() => toggle(inst.id)}
              className="h-4 w-4"
            />
            <div className="flex-1">
              <p className="text-sm font-medium">{inst.name}</p>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                {inst.provider === 'meta_cloud' ? 'Cloud API · Meta oficial' : 'UAZAPI'}
              </p>
            </div>
            <span className="text-[10px] px-2 py-0.5 rounded-sm bg-emerald-50 text-emerald-700 font-medium">
              CONECTADO
            </span>
          </label>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// REVIEW PANEL — resumo final pra double-check
// ─────────────────────────────────────────────────────────────────

function ReviewPanel({
  name, description, provider, audienceCount, filters,
  cloudTemplateId, messageContents, instanceIdsCount,
  sendNow, scheduledAt, assignmentMode,
}: {
  name: string;
  description: string;
  provider: CampaignProvider;
  audienceCount: number;
  filters: AudienceFilters;
  cloudTemplateId: string | null;
  messageContents: string[];
  instanceIdsCount: number;
  sendNow: boolean;
  scheduledAt: string;
  assignmentMode: AssignmentMode;
}) {
  const { data: templates = [] } = useWhatsAppTemplates();
  const selectedTemplate = templates.find((t: any) => t.id === cloudTemplateId);
  const [showLeadList, setShowLeadList] = useState(false);

  const assignmentLabel = {
    keep_current: 'Mantém o vendedor atual',
    sdr_round_robin: 'Round-robin entre SDRs',
    specific_sdr: 'SDR específico',
    closer_round_robin: 'Round-robin entre closers',
    specific_closer: 'Closer específico',
  }[assignmentMode] || assignmentMode;

  const filterSummary = useMemoLib(() => {
    const lines: string[] = [];
    const lead_ids = (filters as any).lead_ids as string[] | undefined;
    if (lead_ids && lead_ids.length > 0) {
      lines.push(`${lead_ids.length} lead${lead_ids.length === 1 ? '' : 's'} selecionado${lead_ids.length === 1 ? '' : 's'} manualmente`);
      return lines;
    }
    if (filters.pipeline_stage_ids?.length) lines.push(`${filters.pipeline_stage_ids.length} etapa(s) de pipeline`);
    if (filters.states?.length) lines.push(`Estados: ${filters.states.join(', ')}`);
    if (filters.cities?.length) lines.push(`Cidades: ${filters.cities.slice(0, 3).join(', ')}${filters.cities.length > 3 ? ` +${filters.cities.length - 3}` : ''}`);
    if (filters.utm_sources?.length) lines.push(`UTM: ${filters.utm_sources.join(', ')}`);
    if (filters.score_min !== undefined || filters.score_max !== undefined) lines.push(`Score ${filters.score_min ?? 0}-${filters.score_max ?? 100}`);
    if (filters.bant_budget || filters.bant_authority || filters.bant_need || filters.bant_timeline) lines.push('Com BANT preenchido');
    if (filters.exclude_campaign_days) lines.push(`Excluindo quem recebeu nos últimos ${filters.exclude_campaign_days} dias`);
    if (lines.length === 0) lines.push('Sem filtros aplicados');
    return lines;
  }, [filters]);

  return (
    <div className="space-y-4">
      {/* Big numbers no topo */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl border bg-gradient-to-br from-[#BAA05E]/5 to-transparent p-4">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1">Destinatários</p>
          <p className="text-3xl font-semibold tabular-nums">{audienceCount.toLocaleString('pt-BR')}</p>
        </div>
        <div className="rounded-xl border p-4">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1">Canal</p>
          <p className="text-sm font-medium flex items-center gap-1.5 mt-1">
            {provider === 'cloud_api' ? (
              <><Shield className="h-3.5 w-3.5 text-emerald-600" /> API Oficial</>
            ) : (
              <><Zap className="h-3.5 w-3.5 text-amber-600" /> UAZAPI</>
            )}
          </p>
          <p className="text-[11px] text-muted-foreground mt-1">{instanceIdsCount} {instanceIdsCount === 1 ? 'instância' : 'instâncias'}</p>
        </div>
        <div className="rounded-xl border p-4">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1">Quando</p>
          <p className="text-sm font-medium mt-1">{sendNow ? 'Imediatamente' : 'Agendado'}</p>
          {!sendNow && scheduledAt && (
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {new Date(scheduledAt).toLocaleString('pt-BR')}
            </p>
          )}
        </div>
      </div>

      {/* Identidade */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-medium mb-0.5">Identidade</p>
              <h3 className="text-base font-semibold">{name || '(sem nome)'}</h3>
              {description && <p className="text-xs text-muted-foreground mt-1">{description}</p>}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Audiência */}
      <Card>
        <CardContent className="p-4 space-y-2">
          <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-medium">
            Audiência
          </p>
          <ul className="space-y-1 text-sm">
            {filterSummary.map((l, i) => (
              <li key={i} className="flex items-start gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 text-[#BAA05E] mt-0.5 shrink-0" />
                <span>{l}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* Mensagem */}
      <Card>
        <CardContent className="p-4 space-y-2">
          <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-medium">
            Mensagem
          </p>
          {provider === 'cloud_api' ? (
            selectedTemplate ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-[10px] gap-1 text-emerald-700 border-emerald-200">
                    <CheckCircle2 className="h-2.5 w-2.5" /> APPROVED
                  </Badge>
                  <span className="text-sm font-medium">{selectedTemplate.name}</span>
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                    {selectedTemplate.category} · {selectedTemplate.language}
                  </span>
                </div>
                <div className="bg-muted/30 border rounded-md p-3 text-sm whitespace-pre-wrap">
                  {(selectedTemplate.components || []).find((c: any) => c.type === 'BODY')?.text || '—'}
                </div>
              </div>
            ) : (
              <p className="text-sm text-amber-700 flex items-center gap-1.5">
                <AlertCircle className="h-3.5 w-3.5" /> Template não selecionado
              </p>
            )
          ) : (
            <div className="space-y-2">
              {messageContents.filter((m) => m.trim()).map((m, i) => (
                <div key={i}>
                  {messageContents.filter((x) => x.trim()).length > 1 && (
                    <p className="text-[10px] text-muted-foreground mb-1">Variação {i + 1}</p>
                  )}
                  <div className="bg-muted/30 border rounded-md p-3 text-sm whitespace-pre-wrap">{m}</div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Atribuição */}
      <Card>
        <CardContent className="p-4 space-y-2">
          <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-medium">
            Atribuição do retorno
          </p>
          <p className="text-sm flex items-center gap-2">
            <UserCheck className="h-3.5 w-3.5 text-muted-foreground" />
            {assignmentLabel}
          </p>
        </CardContent>
      </Card>

      <div className="rounded-lg border border-amber-200 bg-amber-50/40 p-3 flex items-start gap-2.5">
        <Sparkles className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
        <p className="text-xs text-amber-900 leading-relaxed">
          Confira tudo acima. Quando clicar em <strong>{sendNow ? 'Enviar agora' : 'Agendar envio'}</strong> no rodapé, vai abrir uma confirmação. A partir da confirmação, a campanha começa e <strong>não pode ser desfeita</strong>.
        </p>
      </div>
    </div>
  );
}
