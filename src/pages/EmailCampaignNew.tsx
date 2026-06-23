import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  ArrowLeft, ChevronLeft, ChevronRight, Loader2, Rocket, Save, Send,
  CheckCircle2, FileText, MessageSquare, Users, UserCheck, Clock,
  AlertCircle, Eye, Mail, Beaker, AtSign, Sparkles,
} from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';
import type {
  EmailAudienceFilters, EmailTemplate,
} from '@/types/email.types';
import {
  useCreateEmailCampaign,
  useStartEmailCampaign, useScheduleEmailCampaign,
  useSendEmailCampaignTest, useEmailAudienceCount,
  useEmailTemplates, useBrevoSettings,
} from '@/hooks/useEmailMarketing';
import EmailAudiencePicker from '@/components/email-marketing/EmailAudiencePicker';
import EmailPreviewModal from '@/components/email-marketing/EmailPreviewModal';
import MarketingPageHeader from '@/components/marketing/MarketingPageHeader';

type StepId = 'basic' | 'sender' | 'audience' | 'content' | 'send' | 'review';

interface StepDef {
  id: StepId;
  label: string;
  icon: any;
  description: string;
}

const STEPS: StepDef[] = [
  { id: 'basic',    label: 'Identidade', icon: FileText,      description: 'Nome e descrição' },
  { id: 'sender',   label: 'Remetente',  icon: AtSign,        description: 'De quem chega o email' },
  { id: 'audience', label: 'Audiência',  icon: Users,         description: 'Quem vai receber' },
  { id: 'content',  label: 'Conteúdo',   icon: MessageSquare, description: 'Template e assunto' },
  { id: 'send',     label: 'Envio',      icon: Clock,         description: 'Quando enviar' },
  { id: 'review',   label: 'Revisão',    icon: Eye,           description: 'Confira tudo antes' },
];

export default function EmailCampaignNew() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user } = useAuth();
  const { data: brevoSettings } = useBrevoSettings();
  const { data: templates = [] } = useEmailTemplates();

  const [currentStep, setCurrentStep] = useState<StepId>('basic');
  const [submitting, setSubmitting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  // Form state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [fromName, setFromName] = useState(brevoSettings?.sender_name || '');
  const [fromEmail, setFromEmail] = useState(brevoSettings?.sender_email || '');
  const [replyTo, setReplyTo] = useState('');
  const [filters, setFilters] = useState<EmailAudienceFilters>({});
  const [subject, setSubject] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState<EmailTemplate | null>(null);
  const [sendNow, setSendNow] = useState(true);
  const [scheduledAt, setScheduledAt] = useState('');
  const [testEmail, setTestEmail] = useState(user?.email || '');

  const createCampaign = useCreateEmailCampaign();
  const startCampaign = useStartEmailCampaign();
  const scheduleCampaign = useScheduleEmailCampaign();
  const sendTest = useSendEmailCampaignTest();
  const { data: audienceCount } = useEmailAudienceCount(filters);

  // Aplica defaults do brevoSettings quando carrega
  useMemo(() => {
    if (brevoSettings && !fromName && !fromEmail) {
      setFromName(brevoSettings.sender_name || '');
      setFromEmail(brevoSettings.sender_email || '');
    }
  }, [brevoSettings]);

  const stepIndex = STEPS.findIndex((s) => s.id === currentStep);
  const isLastStep = stepIndex === STEPS.length - 1;

  // Validações
  const stepValid: Record<StepId, boolean> = {
    basic: name.trim().length > 0,
    sender: fromName.trim().length > 0 && fromEmail.trim().includes('@'),
    audience: (audienceCount || 0) > 0,
    content: subject.trim().length > 0 && !!selectedTemplate,
    send: sendNow || !!scheduledAt,
    review: true,
  };

  const errors = useMemo(() => {
    const errs: string[] = [];
    if (!stepValid.basic) errs.push('Defina um nome pra campanha');
    if (!stepValid.sender) errs.push('Preencha nome e email do remetente');
    if (!stepValid.audience) errs.push('Selecione pelo menos 1 destinatário');
    if (!stepValid.content) errs.push('Selecione um template e defina o assunto');
    if (!stepValid.send) errs.push('Escolha "Enviar agora" ou agende uma data');
    return errs;
  }, [stepValid]);

  const canNext = stepValid[currentStep];
  const canSubmit = errors.length === 0;

  const goNext = () => {
    if (!canNext) return;
    const next = STEPS[stepIndex + 1];
    if (next) setCurrentStep(next.id);
  };
  const goBack = () => {
    const prev = STEPS[stepIndex - 1];
    if (prev) setCurrentStep(prev.id);
  };

  const handleSendTest = async () => {
    if (!testEmail.trim() || !testEmail.includes('@')) {
      toast({ title: 'Informe um email válido pra teste', variant: 'destructive' });
      return;
    }
    if (!selectedTemplate) {
      toast({ title: 'Selecione um template antes de enviar teste', variant: 'destructive' });
      return;
    }
    try {
      // Cria campanha rascunho efêmera apenas pra teste
      const draft = await createCampaign.mutateAsync({
        name: `[TESTE] ${name || 'Sem nome'}`,
        subject,
        from_name: fromName,
        from_email: fromEmail,
        reply_to: replyTo || null,
        template_id: selectedTemplate.id,
        html_content: selectedTemplate.html_content,
        audience_filters: { lead_ids: [] } as any,
      });
      await sendTest.mutateAsync({
        campaignId: draft.id,
        testEmail: testEmail.trim(),
        html: selectedTemplate.html_content,
      });
      toast({ title: `Teste enviado pra ${testEmail.trim()}` });
    } catch (err: any) {
      toast({ title: err.message || 'Erro ao enviar teste', variant: 'destructive' });
    }
  };

  const handleSaveDraft = async () => {
    if (!name.trim()) {
      toast({ title: 'Nome obrigatório pra salvar rascunho', variant: 'destructive' });
      return;
    }
    setSubmitting(true);
    try {
      await createCampaign.mutateAsync({
        name,
        description: description || null,
        subject,
        from_name: fromName || brevoSettings?.sender_name || '',
        from_email: fromEmail || brevoSettings?.sender_email || '',
        reply_to: replyTo || null,
        template_id: selectedTemplate?.id || null,
        html_content: selectedTemplate?.html_content || null,
        audience_filters: filters as any,
        status: 'draft',
      });
      toast({ title: 'Rascunho salvo' });
      navigate('/marketing/campanhas');
    } catch (err: any) {
      toast({ title: err.message || 'Erro ao salvar', variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async () => {
    setConfirmOpen(false);
    if (!canSubmit) {
      toast({ title: 'Preencha tudo antes de enviar', variant: 'destructive' });
      return;
    }
    setSubmitting(true);
    try {
      const campaign = await createCampaign.mutateAsync({
        name,
        description: description || null,
        subject,
        from_name: fromName,
        from_email: fromEmail,
        reply_to: replyTo || null,
        template_id: selectedTemplate!.id,
        html_content: selectedTemplate!.html_content,
        audience_filters: filters as any,
        status: 'draft',
      });

      if (sendNow) {
        await startCampaign.mutateAsync(campaign.id);
        toast({ title: 'Campanha iniciada!', description: `Enviando pra ${audienceCount} destinatários.` });
      } else {
        await scheduleCampaign.mutateAsync({ campaignId: campaign.id, scheduledAt });
        toast({ title: 'Campanha agendada', description: `Será enviada em ${new Date(scheduledAt).toLocaleString('pt-BR')}` });
      }
      navigate(`/marketing/campanhas/${campaign.id}`);
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
              <Button variant="ghost" size="sm" onClick={() => navigate('/marketing/campanhas')} className="-ml-2 shrink-0">
                <ArrowLeft className="h-4 w-4 mr-1.5" /> Voltar
              </Button>
              <div className="h-5 w-px bg-border shrink-0" />
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-medium">
                  Campanha Email
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
              <Button
                variant="ghost"
                size="sm"
                onClick={handleSaveDraft}
                disabled={submitting || !name.trim()}
                className="gap-1.5 text-muted-foreground"
              >
                <Save className="h-3.5 w-3.5" />
                Salvar rascunho
              </Button>
            </div>
          </div>
        </header>

        {/* Body 2-col: sidebar stepper + main */}
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
                const passed = stepValid[s.id];
                const Icon = s.icon;
                return (
                  <button
                    key={s.id}
                    onClick={() => (i <= stepIndex || passed) && setCurrentStep(s.id)}
                    disabled={i > stepIndex && !passed}
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

              {/* STEP CONTENT */}
              {currentStep === 'basic' && (
                <div className="space-y-4">
                  <div>
                    <Label className="text-xs text-muted-foreground">Nome da campanha</Label>
                    <Input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Ex: Newsletter Março, Reativação Q1, Black Friday…"
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

              {currentStep === 'sender' && (
                <div className="space-y-4">
                  <div className="rounded-lg border border-[#BAA05E]/20 bg-[#BAA05E]/[0.03] p-4 flex items-start gap-3">
                    <div className="w-8 h-8 rounded-lg bg-[#BAA05E]/15 flex items-center justify-center shrink-0">
                      <AtSign className="h-4 w-4 text-[#BAA05E]" />
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm font-medium">De quem o email vai chegar</p>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        O remetente aparece como "Fulano &lt;email&gt;" na caixa do destinatário. Use um nome reconhecível e um email no domínio verificado da Meta/Resend (ex: contato@empresa.com.br).
                      </p>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs text-muted-foreground">Nome do remetente</Label>
                      <Input
                        value={fromName}
                        onChange={(e) => setFromName(e.target.value)}
                        placeholder="Ex: Equipe Acme"
                        className="mt-1.5"
                      />
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">Email do remetente</Label>
                      <Input
                        type="email"
                        value={fromEmail}
                        onChange={(e) => setFromEmail(e.target.value)}
                        placeholder="contato@empresa.com.br"
                        className="mt-1.5 font-mono"
                      />
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Reply-to (opcional)</Label>
                    <Input
                      type="email"
                      value={replyTo}
                      onChange={(e) => setReplyTo(e.target.value)}
                      placeholder="respostas@empresa.com.br"
                      className="mt-1.5 font-mono"
                    />
                    <p className="text-[10px] text-muted-foreground mt-1">
                      Pra onde vão as respostas dos leads. Se vazio, usa o email do remetente.
                    </p>
                  </div>
                </div>
              )}

              {currentStep === 'audience' && (
                <EmailAudiencePicker filters={filters} onChange={setFilters} />
              )}

              {currentStep === 'content' && (
                <div className="space-y-4">
                  <div>
                    <Label className="text-xs text-muted-foreground">Assunto do email</Label>
                    <Input
                      value={subject}
                      onChange={(e) => setSubject(e.target.value)}
                      placeholder="Ex: Bem-vindo à nossa marca · Promoção exclusiva pra você"
                      className="mt-1.5"
                    />
                    <p className="text-[10px] text-muted-foreground mt-1">
                      Aparece na inbox. Você pode usar variáveis (ex: <code className="font-mono">{`{{primeiro_nome}}`}</code>).
                    </p>
                  </div>

                  <div>
                    <Label className="text-xs text-muted-foreground mb-2 block">Template</Label>
                    {selectedTemplate ? (
                      <Card className="border-[#BAA05E]/30 bg-[#BAA05E]/[0.03]">
                        <CardContent className="p-4 flex items-center gap-3">
                          <div className="w-16 h-16 bg-white rounded-md border overflow-hidden shrink-0">
                            {selectedTemplate.html_content ? (
                              <iframe
                                srcDoc={selectedTemplate.html_content}
                                title="Preview"
                                sandbox="allow-same-origin"
                                scrolling="no"
                                className="border-0 pointer-events-none"
                                style={{
                                  width: '400px',
                                  height: '400px',
                                  transform: 'scale(0.16)',
                                  transformOrigin: 'top left',
                                }}
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-[8px] text-muted-foreground">
                                Sem preview
                              </div>
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-sm truncate">{selectedTemplate.name}</p>
                            <p className="text-xs text-muted-foreground truncate">
                              {selectedTemplate.subject || 'Sem assunto padrão'}
                            </p>
                          </div>
                          <div className="flex gap-2 shrink-0">
                            <Button variant="outline" size="sm" onClick={() => setShowPreview(true)}>
                              <Eye className="h-3.5 w-3.5 mr-1" /> Ver
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => setSelectedTemplate(null)}>
                              Trocar
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    ) : templates.length === 0 ? (
                      <Card className="border-dashed">
                        <CardContent className="p-6 text-center">
                          <FileText className="h-8 w-8 mx-auto text-muted-foreground/40 mb-2" />
                          <p className="text-sm text-muted-foreground mb-3">Nenhum template ainda</p>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => navigate('/marketing/templates/novo')}
                          >
                            Criar template
                          </Button>
                        </CardContent>
                      </Card>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-[420px] overflow-y-auto pr-1">
                        {templates.map((t: EmailTemplate) => (
                          <Card
                            key={t.id}
                            className="cursor-pointer hover:border-[#BAA05E]/50 transition-all"
                            onClick={() => {
                              setSelectedTemplate(t);
                              if (!subject && t.subject) setSubject(t.subject);
                            }}
                          >
                            <CardContent className="p-3 space-y-2">
                              <div className="aspect-[16/9] bg-white rounded border overflow-hidden">
                                {t.html_content ? (
                                  <iframe
                                    srcDoc={t.html_content}
                                    title={t.name}
                                    sandbox="allow-same-origin"
                                    scrolling="no"
                                    className="border-0 pointer-events-none"
                                    style={{
                                      width: '600px',
                                      height: '340px',
                                      transform: 'scale(0.4)',
                                      transformOrigin: 'top left',
                                    }}
                                  />
                                ) : (
                                  <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground bg-muted">
                                    Sem preview
                                  </div>
                                )}
                              </div>
                              <div>
                                <p className="text-sm font-medium truncate">{t.name}</p>
                                <p className="text-xs text-muted-foreground truncate">
                                  {t.subject || 'Sem assunto'}
                                </p>
                              </div>
                            </CardContent>
                          </Card>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {currentStep === 'send' && (
                <div className="space-y-6">
                  {/* Quando enviar */}
                  <div>
                    <Label className="text-sm font-medium mb-2 block">Quando enviar</Label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={() => setSendNow(true)}
                        className={cn(
                          'p-4 rounded-lg border text-left transition-colors',
                          sendNow ? 'border-[#BAA05E] bg-[#BAA05E]/5 ring-1 ring-[#BAA05E]/20' : 'hover:bg-muted/40',
                        )}
                      >
                        <Rocket className={cn('h-4 w-4 mb-1.5', sendNow ? 'text-[#BAA05E]' : 'text-muted-foreground')} />
                        <p className="text-sm font-medium">Enviar agora</p>
                        <p className="text-[11px] text-muted-foreground mt-0.5">Dispara imediatamente após confirmação</p>
                      </button>
                      <button
                        onClick={() => setSendNow(false)}
                        className={cn(
                          'p-4 rounded-lg border text-left transition-colors',
                          !sendNow ? 'border-[#BAA05E] bg-[#BAA05E]/5 ring-1 ring-[#BAA05E]/20' : 'hover:bg-muted/40',
                        )}
                      >
                        <Clock className={cn('h-4 w-4 mb-1.5', !sendNow ? 'text-[#BAA05E]' : 'text-muted-foreground')} />
                        <p className="text-sm font-medium">Agendar</p>
                        <p className="text-[11px] text-muted-foreground mt-0.5">Define data e horário pra começar</p>
                      </button>
                    </div>
                    {!sendNow && (
                      <Input
                        type="datetime-local"
                        value={scheduledAt}
                        onChange={(e) => setScheduledAt(e.target.value)}
                        className="mt-2"
                      />
                    )}
                  </div>

                  {/* Enviar teste */}
                  <Card className="border-dashed">
                    <CardContent className="p-4 space-y-2.5">
                      <Label className="flex items-center gap-2 text-sm font-medium">
                        <Beaker className="h-4 w-4 text-[#BAA05E]" /> Enviar teste antes
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        Manda 1 email pra você conferir antes do disparo real. Variáveis viram valores fictícios.
                      </p>
                      <div className="flex gap-2">
                        <Input
                          type="email"
                          value={testEmail}
                          onChange={(e) => setTestEmail(e.target.value)}
                          placeholder="seu@email.com"
                          className="flex-1"
                        />
                        <Button
                          variant="outline"
                          onClick={handleSendTest}
                          disabled={sendTest.isPending || !selectedTemplate}
                          className="gap-1.5"
                        >
                          {sendTest.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                          Enviar teste
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              )}

              {currentStep === 'review' && (
                <ReviewPanel
                  name={name}
                  description={description}
                  audienceCount={audienceCount || 0}
                  filters={filters}
                  sampleLeads={[]}
                  fromName={fromName}
                  fromEmail={fromEmail}
                  replyTo={replyTo}
                  subject={subject}
                  template={selectedTemplate}
                  sendNow={sendNow}
                  scheduledAt={scheduledAt}
                  onPreview={() => setShowPreview(true)}
                />
              )}
            </div>

            {/* Footer sticky com navegação */}
            <footer className="sticky bottom-0 z-10 border-t bg-background/95 backdrop-blur-sm">
              <div className="max-w-3xl mx-auto px-8 py-3 flex items-center justify-between gap-3">
                <Button variant="ghost" size="sm" onClick={goBack} disabled={stepIndex === 0} className="gap-1">
                  <ChevronLeft className="h-4 w-4" /> Voltar
                </Button>
                <div className="text-[11px] text-muted-foreground">
                  Etapa {stepIndex + 1} de {STEPS.length}
                  {!canNext && currentStep !== 'review' && (
                    <span className="ml-2 text-amber-700">· complete pra avançar</span>
                  )}
                </div>
                {isLastStep ? (
                  <Button
                    size="sm"
                    className="bg-[#BAA05E] hover:bg-[#917D3D] text-white gap-1.5"
                    onClick={() => setConfirmOpen(true)}
                    disabled={submitting || !canSubmit}
                  >
                    {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : sendNow ? <Rocket className="h-3.5 w-3.5" /> : <Clock className="h-3.5 w-3.5" />}
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

      {/* Preview do template */}
      {selectedTemplate && (
        <EmailPreviewModal
          open={showPreview}
          onOpenChange={setShowPreview}
          html={selectedTemplate.html_content || ''}
          subject={subject || selectedTemplate.subject}
        />
      )}

      {/* Confirmação final */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              {sendNow ? <Rocket className="h-5 w-5 text-[#BAA05E]" /> : <Clock className="h-5 w-5 text-[#BAA05E]" />}
              {sendNow ? 'Confirmar envio?' : 'Confirmar agendamento?'}
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-3 pt-2">
              <span className="block">
                Vai disparar pra <strong className="text-foreground">{(audienceCount || 0).toLocaleString('pt-BR')} {audienceCount === 1 ? 'destinatário' : 'destinatários'}</strong> via email.
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
              onClick={handleSubmit}
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
// REVIEW PANEL — resumo final pra double-check
// ─────────────────────────────────────────────────────────────────

function ReviewPanel({
  name, description, audienceCount, filters, sampleLeads,
  fromName, fromEmail, replyTo, subject, template,
  sendNow, scheduledAt, onPreview,
}: {
  name: string;
  description: string;
  audienceCount: number;
  filters: EmailAudienceFilters;
  sampleLeads: any[];
  fromName: string;
  fromEmail: string;
  replyTo: string;
  subject: string;
  template: EmailTemplate | null;
  sendNow: boolean;
  scheduledAt: string;
  onPreview: () => void;
}) {
  const leadIds = ((filters as any).lead_ids || []) as string[];
  const isSpecific = leadIds.length > 0;

  const filterSummary = useMemo(() => {
    const lines: string[] = [];
    if (isSpecific) {
      lines.push(`${leadIds.length} lead${leadIds.length === 1 ? '' : 's'} selecionado${leadIds.length === 1 ? '' : 's'} manualmente`);
      return lines;
    }
    if (filters.pipeline_stage_ids?.length) lines.push(`${filters.pipeline_stage_ids.length} etapa(s) de pipeline`);
    if (filters.states?.length) lines.push(`Estados: ${filters.states.join(', ')}`);
    if (filters.cities?.length) lines.push(`Cidades: ${filters.cities.slice(0, 3).join(', ')}${filters.cities.length > 3 ? ` +${filters.cities.length - 3}` : ''}`);
    if (filters.utm_sources?.length) lines.push(`UTM: ${filters.utm_sources.join(', ')}`);
    if (filters.score_min !== undefined || filters.score_max !== undefined) lines.push(`Score ${filters.score_min ?? 0}-${filters.score_max ?? 100}`);
    if (filters.exclude_campaign_days) lines.push(`Excluindo quem recebeu nos últimos ${filters.exclude_campaign_days} dias`);
    if (lines.length === 0) lines.push('Sem filtros aplicados');
    return lines;
  }, [filters, isSpecific, leadIds.length]);

  return (
    <div className="space-y-4">
      {/* Big numbers no topo */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl border bg-gradient-to-br from-[#BAA05E]/5 to-transparent p-4">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1">Destinatários</p>
          <p className="text-3xl font-semibold tabular-nums">{audienceCount.toLocaleString('pt-BR')}</p>
        </div>
        <div className="rounded-xl border p-4">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1">Remetente</p>
          <p className="text-sm font-medium truncate flex items-center gap-1.5 mt-1">
            <AtSign className="h-3.5 w-3.5 text-muted-foreground" />
            {fromName || '—'}
          </p>
          <p className="text-[11px] text-muted-foreground mt-0.5 truncate font-mono">{fromEmail || '—'}</p>
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
        <CardContent className="p-4 space-y-2">
          <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-medium">Identidade</p>
          <h3 className="text-base font-semibold">{name || '(sem nome)'}</h3>
          {description && <p className="text-xs text-muted-foreground mt-1">{description}</p>}
        </CardContent>
      </Card>

      {/* Audiência */}
      <Card>
        <CardContent className="p-4 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-medium">Audiência</p>
            {isSpecific && (
              <Badge variant="outline" className="text-[10px]">
                <UserCheck className="h-2.5 w-2.5 mr-1" /> Manual
              </Badge>
            )}
          </div>
          <ul className="space-y-1 text-sm">
            {filterSummary.map((l, i) => (
              <li key={i} className="flex items-start gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 text-[#BAA05E] mt-0.5 shrink-0" />
                <span>{l}</span>
              </li>
            ))}
          </ul>
          {sampleLeads.length > 0 && (
            <div className="mt-2 pt-2 border-t border-border/60">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1.5">
                Exemplos · primeiros {Math.min(sampleLeads.length, 8)}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {sampleLeads.slice(0, 8).map((l: any) => (
                  <Badge key={l.id} variant="outline" className="text-xs font-normal">
                    {l.name || l.email || 'Lead'}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Conteúdo */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-medium">Conteúdo</p>
            {template && (
              <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={onPreview}>
                <Eye className="h-3 w-3" /> Ver email
              </Button>
            )}
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground mb-0.5">Assunto</p>
            <p className="text-sm font-medium">{subject || '(sem assunto)'}</p>
          </div>
          {template ? (
            <div>
              <p className="text-[10px] text-muted-foreground mb-0.5">Template</p>
              <p className="text-sm flex items-center gap-1.5">
                <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                {template.name}
              </p>
            </div>
          ) : (
            <p className="text-sm text-amber-700 flex items-center gap-1.5">
              <AlertCircle className="h-3.5 w-3.5" /> Template não selecionado
            </p>
          )}
        </CardContent>
      </Card>

      {/* Aviso final */}
      <div className="rounded-lg border border-amber-200 bg-amber-50/40 p-3 flex items-start gap-2.5">
        <Sparkles className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
        <p className="text-xs text-amber-900 leading-relaxed">
          Confira tudo acima. Ao clicar em <strong>{sendNow ? 'Enviar agora' : 'Agendar envio'}</strong>, abre confirmação final. A partir dali, o disparo começa e <strong>não pode ser desfeito</strong>.
        </p>
      </div>
    </div>
  );
}
