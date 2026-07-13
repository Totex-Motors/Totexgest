/**
 * MelhoriaReportSheet — painel "Reportar melhoria" (abre pelo botão flutuante).
 *
 * Captura o contexto sozinho (rota, URL, resolução, browser) — o usuário só
 * descreve, escolhe categoria/severidade e anexa prints (captura de tela
 * nativa via getDisplayMedia ou upload de arquivo).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { getRecentErrors, type CapturedError } from '@/lib/errorBuffer';
import { Camera, ChevronRight, Loader2, Monitor, Paperclip, Pencil, X } from 'lucide-react';
import { PrintAnnotator } from './PrintAnnotator';
import {
  CATEGORY_LABELS, SEVERITY_LABELS,
  useCreateMelhoria, captureScreenPrint,
  type MelhoriaCategory, type MelhoriaSeverity,
} from '@/hooks/useMelhorias';

const MAX_PRINTS = 5;
const MAX_CHARS = 2000;

interface PendingPrint {
  blob: Blob;
  previewUrl: string;
  width?: number;
  height?: number;
}

/** Print capturado ANTES do painel abrir (atalho Alt+M — pega dropdowns abertos). */
export interface InitialShot {
  blob: Blob;
  width: number;
  height: number;
}

export function MelhoriaReportSheet({ open, onOpenChange, initialShot }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initialShot?: InitialShot | null;
}) {
  const { pathname } = useLocation();
  const create = useCreateMelhoria();

  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<MelhoriaCategory>('outro');
  const [severity, setSeverity] = useState<MelhoriaSeverity>('media');
  const [prints, setPrints] = useState<PendingPrint[]>([]);
  const [capturing, setCapturing] = useState(false);
  // Anotador (estilo Zoho Annotator): abre logo após a captura de tela, ou
  // pelo lápis na miniatura (replaceIndex = qual print está sendo editado)
  const [annotating, setAnnotating] = useState<{ blob: Blob; replaceIndex: number | null } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Contexto capturado no momento da abertura — inclui os erros recentes do
  // console ("já pega o log do erro", sem o usuário fazer nada)
  const context = useMemo(() => {
    const recentErrors = getRecentErrors();
    const ctx: {
      url: string; screen: string; window: string; browser: string;
      extra?: { recent_errors: CapturedError[] };
    } = {
      url: window.location.href,
      screen: `${window.screen.width * (window.devicePixelRatio || 1)}x${window.screen.height * (window.devicePixelRatio || 1)}`,
      window: `${window.innerWidth}x${window.innerHeight}`,
      browser: navigator.userAgent.match(/(Chrome|Firefox|Safari|Edg)\/[\d.]+/)?.[0] ?? navigator.userAgent.slice(0, 60),
    };
    if (recentErrors.length > 0) ctx.extra = { recent_errors: recentErrors };
    return ctx;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Limpa previews ao fechar (evita vazar object URLs)
  useEffect(() => {
    if (!open) {
      setPrints((prev) => {
        prev.forEach((p) => URL.revokeObjectURL(p.previewUrl));
        return [];
      });
      setDescription('');
      setCategory('outro');
      setSeverity('media');
    }
  }, [open]);

  // Print pré-capturado via Alt+M (com dropdown aberto) → direto no anotador
  const consumedShotRef = useRef<InitialShot | null>(null);
  useEffect(() => {
    if (open && initialShot && consumedShotRef.current !== initialShot) {
      consumedShotRef.current = initialShot;
      setAnnotating({ blob: initialShot.blob, replaceIndex: null });
    }
    if (!open) consumedShotRef.current = null;
  }, [open, initialShot]);

  const addPrint = (blob: Blob, width?: number, height?: number) => {
    setPrints((prev) => {
      if (prev.length >= MAX_PRINTS) {
        toast.warning(`Máximo de ${MAX_PRINTS} prints`);
        return prev;
      }
      return [...prev, { blob, previewUrl: URL.createObjectURL(blob), width, height }];
    });
  };

  const handleCaptureScreen = async () => {
    if (prints.length >= MAX_PRINTS) { toast.warning(`Máximo de ${MAX_PRINTS} prints`); return; }
    setCapturing(true);
    try {
      const shot = await captureScreenPrint();
      // Capturou → abre o anotador (marca com círculo/quadrado/seta/texto antes de anexar)
      if (shot) setAnnotating({ blob: shot.blob, replaceIndex: null });
    } catch (e) {
      toast.error(`Captura falhou: ${(e as Error).message}`);
    } finally {
      setCapturing(false);
    }
  };

  const handleAnnotated = (blob: Blob, width: number, height: number) => {
    const idx = annotating?.replaceIndex;
    setAnnotating(null);
    if (idx != null) {
      // Editou um print existente → substitui no lugar
      setPrints((prev) => {
        if (!prev[idx]) return prev;
        URL.revokeObjectURL(prev[idx].previewUrl);
        const next = [...prev];
        next[idx] = { blob, previewUrl: URL.createObjectURL(blob), width, height };
        return next;
      });
    } else {
      addPrint(blob, width, height);
    }
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    for (const f of files) {
      if (!f.type.startsWith('image/')) { toast.warning(`${f.name}: só imagens`); continue; }
      addPrint(f);
    }
    e.target.value = '';
  };

  const removePrint = (idx: number) => {
    setPrints((prev) => {
      URL.revokeObjectURL(prev[idx].previewUrl);
      return prev.filter((_, i) => i !== idx);
    });
  };

  const handleSubmit = async () => {
    if (!description.trim()) { toast.warning('Descreve a melhoria primeiro 😉'); return; }
    await create.mutateAsync({
      description: description.trim(),
      category,
      severity,
      route: pathname,
      context,
      printBlobs: prints.map((p) => ({ blob: p.blob, width: p.width, height: p.height })),
    });
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 text-primary">💡</span>
            Reportar melhoria
          </SheetTitle>
          <SheetDescription className="font-mono text-xs">{pathname}</SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-5">
          {/* Descrição */}
          <div>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value.slice(0, MAX_CHARS))}
              placeholder="Ex: IA respondeu sobre preço errado pra lead Hot na tela do inbox…"
              rows={4}
              className="resize-none"
            />
            <div className="mt-1 text-right text-[10px] text-muted-foreground">
              {description.length}/{MAX_CHARS}
            </div>
          </div>

          {/* Categoria */}
          <div>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Categoria</div>
            <div className="flex flex-wrap gap-1.5">
              {(Object.keys(CATEGORY_LABELS) as MelhoriaCategory[]).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCategory(c)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-xs transition-colors',
                    category === c
                      ? 'border-primary bg-primary/10 font-medium text-primary'
                      : 'border-border text-muted-foreground hover:bg-muted',
                  )}
                >
                  {CATEGORY_LABELS[c]}
                </button>
              ))}
            </div>
          </div>

          {/* Severidade */}
          <div>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Severidade</div>
            <div className="flex flex-wrap gap-1.5">
              {(Object.keys(SEVERITY_LABELS) as MelhoriaSeverity[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSeverity(s)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-xs transition-colors',
                    severity === s
                      ? 'border-primary bg-primary/10 font-medium text-primary'
                      : 'border-border text-muted-foreground hover:bg-muted',
                  )}
                >
                  {SEVERITY_LABELS[s]}
                </button>
              ))}
            </div>
          </div>

          {/* Prints */}
          <div>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Prints · {prints.length}/{MAX_PRINTS}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {prints.map((p, i) => (
                <div key={p.previewUrl} className="group relative overflow-hidden rounded-md border">
                  <img src={p.previewUrl} alt={`print ${i + 1}`} className="h-24 w-full object-cover" />
                  {p.width && (
                    <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1 text-[9px] text-white">
                      {p.width}×{p.height}
                    </span>
                  )}
                  <div className="absolute right-1 top-1 hidden gap-1 group-hover:flex">
                    <button
                      type="button"
                      title="Marcar no print (círculo, seta, texto…)"
                      onClick={() => setAnnotating({ blob: p.blob, replaceIndex: i })}
                      className="rounded-full bg-black/60 p-0.5 text-white hover:bg-black/80"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      title="Remover"
                      onClick={() => removePrint(i)}
                      className="rounded-full bg-black/60 p-0.5 text-white hover:bg-black/80"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-2 flex gap-2">
              <Button
                type="button" variant="outline" size="sm"
                onClick={handleCaptureScreen}
                disabled={capturing || prints.length >= MAX_PRINTS}
              >
                {capturing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Monitor className="mr-1.5 h-3.5 w-3.5" />}
                Tela
              </Button>
              <Button
                type="button" variant="outline" size="sm"
                onClick={() => fileRef.current?.click()}
                disabled={prints.length >= MAX_PRINTS}
              >
                <Paperclip className="mr-1.5 h-3.5 w-3.5" />
                Arquivo
              </Button>
              <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={handleFile} />
            </div>
            <p className="mt-1.5 text-[10px] text-muted-foreground">
              Depois de capturar, dá pra marcar com círculo, quadrado, seta ou texto — igual anotador de print.
              <br />
              💡 Pra printar com um dropdown/menu ABERTO: deixa ele aberto e aperta <kbd className="rounded border bg-muted px-1 font-mono">Alt+M</kbd> — a captura acontece antes deste painel abrir.
            </p>
          </div>

          {/* Aviso visível do que vai junto sozinho (não fica escondido no collapsible) */}
          <div className="rounded-md border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-[11px] leading-relaxed text-emerald-700 dark:text-emerald-400">
            ✓ Vai junto automaticamente: a tela onde você está ({pathname}), seu navegador
            {context.extra?.recent_errors?.length
              ? ` e os últimos ${context.extra.recent_errors.length} erros do console — não precisa copiar erro nenhum.`
              : '. Se houver erros no console, eles também vão.'}
          </div>

          {/* Contexto capturado */}
          <Collapsible>
            <CollapsibleTrigger className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground [&[data-state=open]>svg]:rotate-90">
              <ChevronRight className="h-3 w-3 transition-transform" />
              Contexto capturado
            </CollapsibleTrigger>
            <CollapsibleContent>
              <dl className="mt-2 space-y-1 rounded-md border bg-muted/40 p-3 text-xs">
                {[
                  ['Rota', pathname],
                  ['URL', context.url],
                  ['Tela', context.screen],
                  ['Janela', context.window],
                  ['Browser', context.browser],
                  ['Erros recentes', String(context.extra?.recent_errors?.length ?? 0)],
                ].map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-3">
                    <dt className="shrink-0 text-muted-foreground">{k}</dt>
                    <dd className="truncate font-mono">{v}</dd>
                  </div>
                ))}
              </dl>
            </CollapsibleContent>
          </Collapsible>

          {/* Ações */}
          <div className="flex justify-end gap-2 border-t pt-4">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancelar</Button>
            <Button onClick={handleSubmit} disabled={create.isPending || !description.trim()}>
              {create.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              <Camera className="mr-1.5 h-3.5 w-3.5" />
              Reportar
            </Button>
          </div>
        </div>

        {/* Editor de anotações (abre após capturar, ou pelo lápis na miniatura) */}
        <PrintAnnotator
          image={annotating?.blob ?? null}
          open={!!annotating}
          onCancel={() => setAnnotating(null)}
          onConfirm={handleAnnotated}
        />
      </SheetContent>
    </Sheet>
  );
}
