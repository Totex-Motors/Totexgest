import { useState, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  ArrowLeft, Save, Loader2, Plus, X, AlertCircle, CheckCircle2, Info,
  MessageSquare, Megaphone, Link2, Phone, MousePointerClick, Sparkles,
} from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import {
  useCreateCloudTemplate, type CloudTemplateCategory, type CloudTemplateButton,
} from '@/hooks/useWhatsAppTemplates';
import MarketingPageHeader from '@/components/marketing/MarketingPageHeader';

const LANGUAGES = [
  { value: 'pt_BR', label: 'Português (Brasil)' },
  { value: 'en_US', label: 'Inglês (EUA)' },
  { value: 'es_ES', label: 'Espanhol' },
  { value: 'fr_FR', label: 'Francês' },
];

const CATEGORIES: Array<{ value: CloudTemplateCategory; label: string; description: string; icon: any; accent: string }> = [
  {
    value: 'MARKETING',
    label: 'Marketing',
    description: 'Promoções, ofertas, novidades. Pode ter call-to-action.',
    icon: Megaphone,
    accent: 'amber',
  },
  {
    value: 'UTILITY',
    label: 'Utilidade',
    description: 'Atualizações de pedido, notificações, lembretes. Conteúdo transacional.',
    icon: MessageSquare,
    accent: 'sky',
  },
  {
    value: 'AUTHENTICATION',
    label: 'Autenticação',
    description: 'Códigos OTP, verificação. Não suporta variáveis customizadas.',
    icon: CheckCircle2,
    accent: 'emerald',
  },
];

const HEADER_FORMATS = [
  { value: 'NONE', label: 'Sem cabeçalho' },
  { value: 'TEXT', label: 'Texto' },
  { value: 'IMAGE', label: 'Imagem' },
  { value: 'VIDEO', label: 'Vídeo' },
  { value: 'DOCUMENT', label: 'Documento' },
];

// Conta variáveis no formato {{1}}, {{2}}...
function countVars(text: string): number {
  const matches = text.match(/\{\{\s*(\d+)\s*\}\}/g) || [];
  return new Set(matches).size;
}

function highlightVariables(text: string) {
  return text.replace(/(\{\{\s*\d+\s*\}\})/g, '<span class="text-[#917D3D] font-medium bg-[#BAA05E]/15 px-0.5 rounded">$1</span>');
}

/**
 * Renderiza texto com {{N}} substituído pelo exemplo (se preenchido) com highlight.
 * Quando exemplo está vazio, mantém `{{N}}` destacado pra usuário ver que falta preencher.
 */
function renderWithExamples(text: string, examples: string[]): string {
  return text.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => {
    const idx = parseInt(n, 10) - 1;
    const example = examples[idx];
    if (example && example.trim()) {
      return `<span class="text-[#917D3D] font-medium bg-[#BAA05E]/15 px-0.5 rounded">${escapeHtml(example)}</span>`;
    }
    return `<span class="text-[#917D3D] font-medium bg-[#BAA05E]/15 px-0.5 rounded font-mono">{{${n}}}</span>`;
  });
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[c]);
}

export default function WhatsAppTemplateNew() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const createTpl = useCreateCloudTemplate();
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const headerRef = useRef<HTMLInputElement | null>(null);

  // Form state
  const [name, setName] = useState('');
  const [category, setCategory] = useState<CloudTemplateCategory>('MARKETING');
  const [language, setLanguage] = useState('pt_BR');

  // Header
  const [headerFormat, setHeaderFormat] = useState<'NONE' | 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT'>('NONE');
  const [headerText, setHeaderText] = useState('');

  // Body
  const [bodyText, setBodyText] = useState('');
  const [bodyExamples, setBodyExamples] = useState<string[]>([]);

  // Footer
  const [footerText, setFooterText] = useState('');

  // Buttons
  const [buttons, setButtons] = useState<CloudTemplateButton[]>([]);

  const [confirmOpen, setConfirmOpen] = useState(false);

  const bodyVarCount = countVars(bodyText);
  const headerVarCount = headerFormat === 'TEXT' ? countVars(headerText) : 0;

  // Auto-ajusta exemplos quando muda contagem de variáveis
  const handleBodyChange = (v: string) => {
    setBodyText(v);
    const n = countVars(v);
    setBodyExamples((prev) => {
      const next = [...prev];
      while (next.length < n) next.push('');
      return next.slice(0, n);
    });
  };

  // Insere {{N}} na posição do cursor (próximo número não usado)
  const insertVariableInBody = () => {
    const ta = bodyRef.current;
    const current = bodyText;
    // Próximo número: maior {{N}} atual + 1
    const used = new Set<number>();
    (current.match(/\{\{\s*(\d+)\s*\}\}/g) || []).forEach((m) => {
      const n = parseInt(m.replace(/[^\d]/g, ''), 10);
      if (!isNaN(n)) used.add(n);
    });
    let nextN = 1;
    while (used.has(nextN)) nextN++;
    const token = `{{${nextN}}}`;

    if (!ta) {
      handleBodyChange(current + token);
      return;
    }
    const start = ta.selectionStart ?? current.length;
    const end = ta.selectionEnd ?? current.length;
    const newText = current.slice(0, start) + token + current.slice(end);
    handleBodyChange(newText);
    // Move cursor pra depois do token
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + token.length;
      ta.setSelectionRange(pos, pos);
    });
  };

  const insertVariableInHeader = () => {
    const inp = headerRef.current;
    const current = headerText;
    if (countVars(current) > 0) return; // Meta permite só 1 variável no header
    const token = '{{1}}';
    if (!inp) {
      setHeaderText(current + token);
      return;
    }
    const start = inp.selectionStart ?? current.length;
    const end = inp.selectionEnd ?? current.length;
    const newText = current.slice(0, start) + token + current.slice(end);
    setHeaderText(newText);
    requestAnimationFrame(() => {
      inp.focus();
      const pos = start + token.length;
      inp.setSelectionRange(pos, pos);
    });
  };

  const updateBodyExample = (idx: number, val: string) => {
    setBodyExamples((prev) => {
      const next = [...prev];
      next[idx] = val;
      return next;
    });
  };

  const addButton = (type: CloudTemplateButton['type']) => {
    if (buttons.length >= 3) return;
    const defaultButton: CloudTemplateButton = type === 'URL'
      ? { type: 'URL', text: '', url: 'https://' }
      : type === 'PHONE_NUMBER'
      ? { type: 'PHONE_NUMBER', text: '', phone_number: '+55' }
      : { type: 'QUICK_REPLY', text: '' };
    setButtons([...buttons, defaultButton]);
  };

  const updateButton = (idx: number, updates: Partial<CloudTemplateButton>) => {
    setButtons((prev) => prev.map((b, i) => i === idx ? { ...b, ...updates } : b));
  };

  const removeButton = (idx: number) => {
    setButtons((prev) => prev.filter((_, i) => i !== idx));
  };

  // Validações
  const errors = useMemo(() => {
    const errs: string[] = [];
    if (!name.trim()) errs.push('Nome obrigatório');
    else if (!/^[a-z0-9_]+$/.test(name)) errs.push('Nome só pode ter lowercase, números e underscore (ex: boas_vindas_v2)');
    if (!bodyText.trim()) errs.push('Corpo da mensagem é obrigatório');
    if (bodyText.length > 1024) errs.push(`Corpo muito longo (${bodyText.length}/1024)`);
    if (footerText.length > 60) errs.push(`Footer muito longo (${footerText.length}/60)`);
    if (headerFormat === 'TEXT' && headerText.length > 60) errs.push(`Header texto muito longo (${headerText.length}/60)`);
    if (bodyVarCount > 0 && bodyExamples.some((e) => !e.trim())) {
      errs.push(`Preencha um exemplo pra cada variável do corpo (${bodyExamples.filter(e => !e.trim()).length} faltando)`);
    }
    if (buttons.some((b) => !b.text.trim())) errs.push('Todos os botões precisam de texto');
    if (buttons.some((b) => b.type === 'URL' && !b.url?.startsWith('http'))) errs.push('Botão URL precisa começar com http://');
    if (buttons.some((b) => b.type === 'PHONE_NUMBER' && !b.phone_number?.startsWith('+'))) errs.push('Telefone precisa começar com + (ex: +5511999999999)');
    return errs;
  }, [name, bodyText, bodyVarCount, bodyExamples, headerFormat, headerText, footerText, buttons]);

  const canSubmit = errors.length === 0;

  const buildComponents = () => {
    const components: any[] = [];

    if (headerFormat !== 'NONE') {
      const headerComp: any = { type: 'HEADER', format: headerFormat };
      if (headerFormat === 'TEXT') {
        headerComp.text = headerText;
        if (headerVarCount > 0) {
          headerComp.example = { header_text: Array(headerVarCount).fill('exemplo') };
        }
      }
      components.push(headerComp);
    }

    const bodyComp: any = { type: 'BODY', text: bodyText };
    if (bodyVarCount > 0) {
      bodyComp.example = { body_text: [bodyExamples] };
    }
    components.push(bodyComp);

    if (footerText.trim()) {
      components.push({ type: 'FOOTER', text: footerText });
    }

    if (buttons.length > 0) {
      components.push({
        type: 'BUTTONS',
        buttons: buttons.map((b) => {
          const out: any = { type: b.type, text: b.text };
          if (b.type === 'URL') out.url = b.url;
          if (b.type === 'PHONE_NUMBER') out.phone_number = b.phone_number;
          return out;
        }),
      });
    }

    return components;
  };

  const handleSubmit = async () => {
    setConfirmOpen(false);
    try {
      const result = await createTpl.mutateAsync({
        name,
        category,
        language,
        components: buildComponents(),
      });
      toast({
        title: 'Template enviado pra Meta',
        description: result.message || `Status: ${result.status}. A aprovação leva de minutos a 24h.`,
      });
      navigate('/marketing/whatsapp-templates');
    } catch (err: any) {
      toast({ title: 'Erro ao criar template', description: err.message, variant: 'destructive' });
    }
  };

  return (
    <AppLayout>
      <TooltipProvider delayDuration={300}>
        <div className="flex flex-col h-[calc(100vh-4rem)]">
          {/* Topbar */}
          <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-10">
            <div className="px-6 py-3 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <Button variant="ghost" size="sm" onClick={() => navigate('/marketing/whatsapp-templates')} className="-ml-2 shrink-0">
                  <ArrowLeft className="h-4 w-4 mr-1.5" /> Voltar
                </Button>
                <div className="h-5 w-px bg-border shrink-0" />
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-medium">
                    Template WhatsApp
                  </span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-emerald-500/10 text-emerald-700 font-medium uppercase tracking-wider">
                    Novo
                  </span>
                  {name && (
                    <>
                      <div className="h-5 w-px bg-border" />
                      <span className="text-sm font-mono text-muted-foreground">{name}</span>
                    </>
                  )}
                </div>
              </div>
            </div>
          </header>

          {/* Body 2-col: form esquerda + preview direita */}
          <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_360px] overflow-hidden">
            {/* Form */}
            <main className="overflow-y-auto flex flex-col">
              <div className="max-w-3xl mx-auto p-8 space-y-6 flex-1 w-full">
                <MarketingPageHeader
                  eyebrow="Marketing · WhatsApp"
                  title="Criar template Meta"
                  description="Templates passam por aprovação da Meta (minutos a 24h). Use linguagem clara, evite promessas exageradas e siga as regras de cada categoria."
                  noBorder
                />

                {/* Categoria */}
                <section className="space-y-2">
                  <Label className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-medium">
                    Categoria
                  </Label>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    {CATEGORIES.map((c) => {
                      const Icon = c.icon;
                      const selected = category === c.value;
                      return (
                        <button
                          key={c.value}
                          type="button"
                          onClick={() => setCategory(c.value)}
                          className={cn(
                            'p-3 rounded-lg border text-left transition-all',
                            selected ? 'border-[#BAA05E] bg-[#BAA05E]/5 ring-1 ring-[#BAA05E]/20' : 'hover:bg-muted/40',
                          )}
                        >
                          <Icon className={cn('h-4 w-4 mb-1.5', selected ? 'text-[#BAA05E]' : 'text-muted-foreground')} />
                          <p className="text-sm font-medium">{c.label}</p>
                          <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">{c.description}</p>
                        </button>
                      );
                    })}
                  </div>
                </section>

                {/* Nome + Idioma */}
                <section className="grid grid-cols-1 sm:grid-cols-[1fr_220px] gap-3">
                  <div className="space-y-2">
                    <Label className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-medium">
                      Nome do template
                    </Label>
                    <Input
                      autoFocus
                      value={name}
                      onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
                      placeholder="boas_vindas_v2"
                      className="font-mono"
                    />
                    <p className="text-[10px] text-muted-foreground">
                      Identificador único na Meta. Use lowercase, números e underscore. Não pode editar depois.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-medium">
                      Idioma
                    </Label>
                    <Select value={language} onValueChange={setLanguage}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {LANGUAGES.map((l) => (
                          <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </section>

                {/* Header */}
                <section className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-medium flex items-center gap-1.5">
                      Cabeçalho
                      <Badge variant="outline" className="text-[10px] font-normal">opcional</Badge>
                    </Label>
                  </div>
                  <Select value={headerFormat} onValueChange={(v) => setHeaderFormat(v as any)}>
                    <SelectTrigger className="h-9 max-w-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {HEADER_FORMATS.map((h) => (
                        <SelectItem key={h.value} value={h.value}>{h.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {headerFormat === 'TEXT' && (
                    <div className="mt-1.5">
                      <div className="flex items-center gap-2">
                        <Input
                          ref={headerRef}
                          value={headerText}
                          onChange={(e) => setHeaderText(e.target.value)}
                          placeholder="Título curto (até 60 chars)"
                          maxLength={60}
                          className="flex-1"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-9 text-xs gap-1 border-[#BAA05E]/30 text-[#917D3D] hover:bg-[#BAA05E]/10 hover:text-[#917D3D] shrink-0"
                          onClick={insertVariableInHeader}
                          disabled={headerVarCount > 0}
                        >
                          <Plus className="h-3 w-3" /> Variável
                        </Button>
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-1">
                        {headerText.length}/60 · Cabeçalho aceita no máximo 1 variável
                      </p>
                    </div>
                  )}
                  {headerFormat !== 'NONE' && headerFormat !== 'TEXT' && (
                    <p className="text-[11px] text-amber-700 bg-amber-50/40 border border-amber-200 rounded px-2 py-1.5 flex items-start gap-1.5">
                      <Info className="h-3 w-3 mt-0.5 shrink-0" />
                      Cabeçalho de mídia ({headerFormat.toLowerCase()}) será preenchido na hora do envio. Pra o template ser aprovado, a Meta usa um placeholder genérico.
                    </p>
                  )}
                </section>

                {/* Body */}
                <section className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm font-medium flex items-center gap-1.5">
                      Corpo da mensagem
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="h-3 w-3 text-muted-foreground cursor-help" />
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          Use o botão <strong>Inserir variável</strong> ou digite <code className="bg-muted px-1 rounded">{`{{1}}`}</code> manualmente. Pra cada variável você precisa dar 1 exemplo abaixo.
                        </TooltipContent>
                      </Tooltip>
                    </Label>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs gap-1 border-[#BAA05E]/30 text-[#917D3D] hover:bg-[#BAA05E]/10 hover:text-[#917D3D]"
                        onClick={insertVariableInBody}
                      >
                        <Plus className="h-3 w-3" /> Inserir variável
                      </Button>
                      <span className="text-[10px] text-muted-foreground">{bodyText.length}/1024</span>
                    </div>
                  </div>
                  <Textarea
                    ref={bodyRef}
                    value={bodyText}
                    onChange={(e) => handleBodyChange(e.target.value)}
                    placeholder="Olá {{1}}, tudo bem? Aqui é da {{2}}, vi que você se interessou pela nossa solução…"
                    rows={6}
                    maxLength={1024}
                    className="resize-none font-medium"
                  />
                  {bodyVarCount > 0 && (
                    <div className="rounded-md border bg-muted/30 p-3 space-y-2">
                      <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                        <Sparkles className="h-3 w-3" />
                        Exemplos pras {bodyVarCount} variável{bodyVarCount > 1 ? 'is' : ''} (obrigatório pra Meta aprovar)
                      </p>
                      <div className="space-y-1.5">
                        {Array.from({ length: bodyVarCount }, (_, i) => (
                          <div key={i} className="flex items-center gap-2">
                            <Badge variant="outline" className="font-mono text-[10px] shrink-0">{`{{${i + 1}}}`}</Badge>
                            <Input
                              value={bodyExamples[i] || ''}
                              onChange={(e) => updateBodyExample(i, e.target.value)}
                              placeholder={i === 0 ? 'João' : 'exemplo'}
                              className="h-8 text-xs"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </section>

                {/* Footer */}
                <section className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-medium flex items-center gap-1.5">
                      Rodapé
                      <Badge variant="outline" className="text-[10px] font-normal">opcional</Badge>
                    </Label>
                    <span className="text-[10px] text-muted-foreground">{footerText.length}/60</span>
                  </div>
                  <Input
                    value={footerText}
                    onChange={(e) => setFooterText(e.target.value)}
                    placeholder="Ex: Equipe Sua Empresa"
                    maxLength={60}
                  />
                  <p className="text-[10px] text-muted-foreground">Sem variáveis. Até 60 caracteres.</p>
                </section>

                {/* Buttons */}
                <section className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-medium flex items-center gap-1.5">
                      Botões
                      <Badge variant="outline" className="text-[10px] font-normal">opcional · até 3</Badge>
                    </Label>
                    {buttons.length < 3 && (
                      <div className="flex items-center gap-1">
                        <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={() => addButton('QUICK_REPLY')}>
                          <MousePointerClick className="h-3 w-3" /> Resposta
                        </Button>
                        <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={() => addButton('URL')}>
                          <Link2 className="h-3 w-3" /> Link
                        </Button>
                        <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={() => addButton('PHONE_NUMBER')}>
                          <Phone className="h-3 w-3" /> Ligar
                        </Button>
                      </div>
                    )}
                  </div>
                  {buttons.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground italic">Nenhum botão adicionado. Os botões aparecem abaixo da mensagem no WhatsApp.</p>
                  ) : (
                    <div className="space-y-2">
                      {buttons.map((b, i) => (
                        <div key={i} className="flex items-center gap-2 p-2 rounded-md border bg-muted/20">
                          <Badge variant="outline" className="text-[10px] font-medium shrink-0">
                            {b.type === 'QUICK_REPLY' && <MousePointerClick className="h-2.5 w-2.5 mr-1" />}
                            {b.type === 'URL' && <Link2 className="h-2.5 w-2.5 mr-1" />}
                            {b.type === 'PHONE_NUMBER' && <Phone className="h-2.5 w-2.5 mr-1" />}
                            {b.type === 'QUICK_REPLY' ? 'Resposta' : b.type === 'URL' ? 'Link' : 'Ligar'}
                          </Badge>
                          <Input
                            value={b.text}
                            onChange={(e) => updateButton(i, { text: e.target.value })}
                            placeholder="Texto do botão"
                            maxLength={25}
                            className="h-8 text-xs flex-1"
                          />
                          {b.type === 'URL' && (
                            <Input
                              value={b.url || ''}
                              onChange={(e) => updateButton(i, { url: e.target.value })}
                              placeholder="https://…"
                              className="h-8 text-xs flex-[2]"
                            />
                          )}
                          {b.type === 'PHONE_NUMBER' && (
                            <Input
                              value={b.phone_number || ''}
                              onChange={(e) => updateButton(i, { phone_number: e.target.value })}
                              placeholder="+5511999999999"
                              className="h-8 text-xs flex-[2]"
                            />
                          )}
                          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => removeButton(i)}>
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                {/* Validação resumida */}
                {errors.length > 0 && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50/40 p-3 flex items-start gap-2">
                    <AlertCircle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-xs font-medium text-amber-900 mb-1">Antes de enviar, corrija:</p>
                      <ul className="space-y-0.5">
                        {errors.map((e, i) => (
                          <li key={i} className="text-[11px] text-amber-900">· {e}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                )}
              </div>

              {/* Footer sticky */}
              <footer className="sticky bottom-0 z-10 border-t bg-background/95 backdrop-blur-sm">
                <div className="max-w-3xl mx-auto px-8 py-3 flex items-center justify-between gap-3">
                  {errors.length > 0 ? (
                    <p className="text-[11px] text-amber-700 flex items-center gap-1.5">
                      <AlertCircle className="h-3.5 w-3.5" />
                      {errors.length} {errors.length === 1 ? 'pendência' : 'pendências'} antes de enviar
                      {errors[0] && <span className="text-muted-foreground">· {errors[0]}</span>}
                    </p>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">
                      Tudo certo. Após enviar, fica em <span className="font-medium text-amber-700">PENDING</span> até a Meta aprovar.
                    </p>
                  )}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className={cn(!canSubmit && 'cursor-not-allowed')}>
                        <Button
                          size="sm"
                          className="bg-[#BAA05E] hover:bg-[#917D3D] text-white gap-1.5"
                          onClick={() => setConfirmOpen(true)}
                          disabled={!canSubmit || createTpl.isPending}
                        >
                          {createTpl.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                          Enviar pra aprovação
                        </Button>
                      </span>
                    </TooltipTrigger>
                    {!canSubmit && errors.length > 0 && (
                      <TooltipContent side="top" className="max-w-xs">
                        <p className="font-medium mb-1">Resolva antes de enviar:</p>
                        <ul className="space-y-0.5 text-[11px]">
                          {errors.slice(0, 3).map((e, i) => <li key={i}>· {e}</li>)}
                          {errors.length > 3 && <li className="opacity-70">+ {errors.length - 3} pendências</li>}
                        </ul>
                      </TooltipContent>
                    )}
                  </Tooltip>
                </div>
              </footer>
            </main>

            {/* Preview WhatsApp */}
            <aside className="hidden lg:flex flex-col border-l bg-[#0a141a]/[0.04] overflow-y-auto">
              <div className="p-6 space-y-4 sticky top-0">
                <div>
                  <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-medium mb-1">Preview</p>
                  <p className="text-xs text-muted-foreground">Como o lead vai ver no WhatsApp</p>
                </div>

                <WhatsAppPreview
                  headerFormat={headerFormat}
                  headerText={headerText}
                  bodyText={bodyText}
                  bodyExamples={bodyExamples}
                  footerText={footerText}
                  buttons={buttons}
                />

                <div className="text-[10px] text-muted-foreground space-y-1 pt-2 border-t">
                  <p><span className="font-mono bg-[#BAA05E]/15 text-[#917D3D] px-1 rounded">{`{{N}}`}</span> = variável que o vendedor preenche na hora do envio</p>
                  <p>Categoria: <span className="text-foreground font-medium">{CATEGORIES.find(c => c.value === category)?.label}</span></p>
                </div>
              </div>
            </aside>
          </div>
        </div>
      </TooltipProvider>

      {/* Confirmação */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Enviar template pra aprovação?</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2 pt-2">
              <span className="block">
                Vai criar o template <strong className="text-foreground font-mono">{name}</strong> na sua conta WhatsApp Business da Meta.
              </span>
              <span className="block text-amber-700">
                A Meta analisa templates em até 24h. Você não pode editar depois — só duplicar e criar outro com nome diferente.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={createTpl.isPending}>Revisar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleSubmit}
              disabled={createTpl.isPending}
              className="bg-[#BAA05E] hover:bg-[#917D3D] text-white"
            >
              {createTpl.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
              Sim, enviar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}

// ─────────────────────────────────────────────────────────────────
// Preview estilo WhatsApp
// ─────────────────────────────────────────────────────────────────

function WhatsAppPreview({
  headerFormat, headerText, bodyText, bodyExamples, footerText, buttons,
}: {
  headerFormat: string;
  headerText: string;
  bodyText: string;
  bodyExamples: string[];
  footerText: string;
  buttons: CloudTemplateButton[];
}) {
  return (
    <div className="rounded-2xl bg-[#e5ddd5] p-4">
      <div className="bg-white rounded-lg shadow-sm max-w-[280px]">
        {/* Header */}
        {headerFormat !== 'NONE' && (
          <div className="px-3 pt-3">
            {headerFormat === 'TEXT' && headerText && (
              <p className="text-sm font-bold" dangerouslySetInnerHTML={{ __html: highlightVariables(headerText) }} />
            )}
            {headerFormat === 'IMAGE' && (
              <div className="aspect-video bg-muted rounded-md flex items-center justify-center text-[10px] text-muted-foreground">
                Imagem (preenchida no envio)
              </div>
            )}
            {headerFormat === 'VIDEO' && (
              <div className="aspect-video bg-muted rounded-md flex items-center justify-center text-[10px] text-muted-foreground">
                Vídeo (preenchido no envio)
              </div>
            )}
            {headerFormat === 'DOCUMENT' && (
              <div className="aspect-[2/1] bg-muted rounded-md flex items-center justify-center text-[10px] text-muted-foreground">
                📄 Documento
              </div>
            )}
          </div>
        )}

        {/* Body */}
        <div className="px-3 py-2.5">
          {bodyText ? (
            <p
              className="text-sm whitespace-pre-wrap leading-snug"
              dangerouslySetInnerHTML={{ __html: renderWithExamples(bodyText, bodyExamples) }}
            />
          ) : (
            <p className="text-sm text-muted-foreground italic">Seu texto aparece aqui…</p>
          )}
        </div>

        {/* Footer */}
        {footerText && (
          <div className="px-3 pb-2">
            <p className="text-[11px] text-muted-foreground italic">{footerText}</p>
          </div>
        )}

        {/* Timestamp */}
        <div className="px-3 pb-2 flex justify-end">
          <span className="text-[10px] text-muted-foreground">{new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
        </div>

        {/* Buttons */}
        {buttons.length > 0 && (
          <div className="border-t divide-y">
            {buttons.map((b, i) => (
              <button
                key={i}
                type="button"
                className="w-full px-3 py-2 text-center text-sm text-[#00a884] font-medium hover:bg-muted/40 transition-colors flex items-center justify-center gap-1.5"
              >
                {b.type === 'URL' && <Link2 className="h-3 w-3" />}
                {b.type === 'PHONE_NUMBER' && <Phone className="h-3 w-3" />}
                {b.type === 'QUICK_REPLY' && <MousePointerClick className="h-3 w-3" />}
                {b.text || '(texto)'}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
