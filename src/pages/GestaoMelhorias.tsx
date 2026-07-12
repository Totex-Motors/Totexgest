/**
 * GestaoMelhorias — kanban de melhorias reportadas pelo time (/gestao/melhorias).
 *
 * Colunas: NOVO → EU PEGUEI → RESOLVIDO → NÃO VAI ROLAR.
 * Drag & drop nativo (mesmo padrão do PipelineKanban). Filtros por
 * categoria/severidade. Detalhe do card em dialog com prints (signed URLs),
 * contexto capturado e notas de resolução.
 */

import { useMemo, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  Lightbulb, Loader2, Hand, Check, Ban, Undo2, ImageIcon,
} from 'lucide-react';
import {
  useMelhorias, useUpdateMelhoria, usePrintUrl,
  CATEGORY_LABELS, SEVERITY_LABELS,
  type MelhoriaReport, type MelhoriaStatus, type MelhoriaCategory, type MelhoriaSeverity,
} from '@/hooks/useMelhorias';

const COLUMNS: Array<{ status: MelhoriaStatus; title: string; emoji: string; accent: string }> = [
  { status: 'novo',         title: 'Novo',         emoji: '✨', accent: 'border-t-blue-500' },
  { status: 'em_andamento', title: 'Eu peguei',    emoji: '✊', accent: 'border-t-amber-500' },
  { status: 'resolvido',    title: 'Resolvido',    emoji: '✅', accent: 'border-t-emerald-500' },
  { status: 'descartado',   title: 'Não vai rolar', emoji: '🚫', accent: 'border-t-zinc-400' },
];

const SEVERITY_TONE: Record<MelhoriaSeverity, string> = {
  baixa:   'bg-zinc-500/10 text-zinc-600 dark:text-zinc-400',
  media:   'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  alta:    'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  critica: 'bg-red-500/10 text-red-600 dark:text-red-400',
};

export default function GestaoMelhorias() {
  const { data: reports = [], isLoading } = useMelhorias();
  const update = useUpdateMelhoria();
  const { teamMember } = useAuth();

  const [catFilter, setCatFilter] = useState<MelhoriaCategory | 'todas'>('todas');
  const [sevFilter, setSevFilter] = useState<MelhoriaSeverity | 'todas'>('todas');
  const [selected, setSelected] = useState<MelhoriaReport | null>(null);
  const [dragged, setDragged] = useState<MelhoriaReport | null>(null);
  const [dragOverCol, setDragOverCol] = useState<MelhoriaStatus | null>(null);

  const filtered = useMemo(
    () => reports.filter((r) =>
      (catFilter === 'todas' || r.category === catFilter) &&
      (sevFilter === 'todas' || r.severity === sevFilter)),
    [reports, catFilter, sevFilter],
  );

  const byStatus = useMemo(() => {
    const map: Record<MelhoriaStatus, MelhoriaReport[]> = {
      novo: [], em_andamento: [], resolvido: [], descartado: [],
    };
    for (const r of filtered) map[r.status]?.push(r);
    return map;
  }, [filtered]);

  const stats = useMemo(() => ({
    total: reports.length,
    novos: reports.filter((r) => r.status === 'novo').length,
    andamento: reports.filter((r) => r.status === 'em_andamento').length,
  }), [reports]);

  const moveTo = (report: MelhoriaReport, status: MelhoriaStatus) => {
    if (report.status === status) return;
    update.mutate({
      id: report.id,
      status,
      // Arrastar pra "Eu peguei" já atribui a quem arrastou
      ...(status === 'em_andamento' && !report.assigned_to && teamMember
        ? { assigned_to: teamMember.id }
        : {}),
    });
  };

  const handleDrop = (e: React.DragEvent, status: MelhoriaStatus) => {
    e.preventDefault();
    setDragOverCol(null);
    if (dragged) moveTo(dragged, status);
    setDragged(null);
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <Lightbulb className="h-5 w-5" />
        </span>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Melhorias</h1>
          <p className="text-sm text-muted-foreground">
            Reportadas pelo time. Arrasta os cards entre colunas pra mover.
          </p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 sm:max-w-md">
        {[
          ['Total', stats.total, ''],
          ['Novos', stats.novos, 'text-blue-600 dark:text-blue-400'],
          ['Em andamento', stats.andamento, 'text-amber-600 dark:text-amber-400'],
        ].map(([label, value, tone]) => (
          <Card key={label as string}>
            <CardContent className="p-3">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
              <div className={cn('text-2xl font-semibold', tone as string)}>{value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filtros */}
      <div className="space-y-2">
        <FilterRow
          label="Categoria"
          value={catFilter}
          options={[['todas', 'Todas'], ...Object.entries(CATEGORY_LABELS)] as Array<[string, string]>}
          onChange={(v) => setCatFilter(v as MelhoriaCategory | 'todas')}
        />
        <FilterRow
          label="Severidade"
          value={sevFilter}
          options={[['todas', 'Todas'], ...Object.entries(SEVERITY_LABELS)] as Array<[string, string]>}
          onChange={(v) => setSevFilter(v as MelhoriaSeverity | 'todas')}
        />
      </div>

      {/* Kanban */}
      {isLoading ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          {COLUMNS.map((col) => (
            <div
              key={col.status}
              onDragOver={(e) => { e.preventDefault(); setDragOverCol(col.status); }}
              onDragLeave={() => setDragOverCol((c) => (c === col.status ? null : c))}
              onDrop={(e) => handleDrop(e, col.status)}
              className={cn(
                'flex min-h-[200px] flex-col rounded-lg border border-t-4 bg-muted/30 transition-colors',
                col.accent,
                dragOverCol === col.status && 'bg-primary/5 ring-2 ring-primary/30',
              )}
            >
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {col.emoji} {col.title}
                </span>
                <Badge variant="secondary" className="text-[10px]">{byStatus[col.status].length}</Badge>
              </div>
              <div className="flex-1 space-y-2 overflow-y-auto px-2 pb-2">
                {byStatus[col.status].map((r) => (
                  <MelhoriaCard
                    key={r.id}
                    report={r}
                    onDragStart={() => setDragged(r)}
                    onClick={() => setSelected(r)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <MelhoriaDetailDialog
        report={selected}
        onClose={() => setSelected(null)}
        onMove={(status) => {
          if (selected) { moveTo(selected, status); setSelected(null); }
        }}
      />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────

function FilterRow({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-20 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
      {options.map(([key, lbl]) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          className={cn(
            'rounded-full border px-2.5 py-0.5 text-xs transition-colors',
            value === key
              ? 'border-primary bg-primary/10 font-medium text-primary'
              : 'border-border text-muted-foreground hover:bg-muted',
          )}
        >
          {lbl}
        </button>
      ))}
    </div>
  );
}

function MelhoriaCard({ report, onDragStart, onClick }: {
  report: MelhoriaReport;
  onDragStart: () => void;
  onClick: () => void;
}) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onClick={onClick}
      className="cursor-pointer rounded-md border bg-background p-2.5 shadow-sm transition-shadow hover:shadow-md active:cursor-grabbing"
    >
      <div className="mb-1.5 flex flex-wrap gap-1">
        <Badge variant="outline" className="text-[9px] uppercase">{CATEGORY_LABELS[report.category]}</Badge>
        <Badge className={cn('border-0 text-[9px] uppercase', SEVERITY_TONE[report.severity])}>
          {SEVERITY_LABELS[report.severity]}
        </Badge>
        {report.prints.length > 0 && (
          <span className="ml-auto flex items-center gap-0.5 text-[10px] text-muted-foreground">
            <ImageIcon className="h-3 w-3" />{report.prints.length}
          </span>
        )}
      </div>
      <p className="line-clamp-2 text-[13px] leading-snug">{report.description}</p>
      <div className="mt-1.5 flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{report.reporter?.name || '—'}</span>
        <span>{formatDistanceToNow(new Date(report.created_at), { addSuffix: true, locale: ptBR })}</span>
      </div>
      {report.assignee && report.status === 'em_andamento' && (
        <div className="mt-1 text-[10px] font-medium text-amber-600 dark:text-amber-400">
          ✊ {report.assignee.name}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────

function MelhoriaDetailDialog({ report, onClose, onMove }: {
  report: MelhoriaReport | null;
  onClose: () => void;
  onMove: (status: MelhoriaStatus) => void;
}) {
  const update = useUpdateMelhoria();
  const [notes, setNotes] = useState('');

  // Sincroniza notas quando muda o report selecionado
  const [lastId, setLastId] = useState<string | null>(null);
  if (report && report.id !== lastId) {
    setLastId(report.id);
    setNotes(report.resolution_notes || '');
  }

  const saveNotesAndResolve = () => {
    if (!report) return;
    update.mutate(
      { id: report.id, status: 'resolvido', resolution_notes: notes.trim() || null },
      { onSuccess: onClose },
    );
  };

  return (
    <Dialog open={!!report} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        {report && (
          <>
            <DialogHeader>
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="outline" className="text-[10px] uppercase">{CATEGORY_LABELS[report.category]}</Badge>
                <Badge className={cn('border-0 text-[10px] uppercase', SEVERITY_TONE[report.severity])}>
                  {SEVERITY_LABELS[report.severity]}
                </Badge>
              </div>
              <DialogTitle className="text-base leading-snug">{report.description}</DialogTitle>
              <DialogDescription>
                {report.reporter?.name || 'Alguém do time'} ·{' '}
                {formatDistanceToNow(new Date(report.created_at), { addSuffix: true, locale: ptBR })}
                {report.route && <> · <span className="font-mono text-xs">{report.route}</span></>}
              </DialogDescription>
            </DialogHeader>

            {/* Prints */}
            {report.prints.length > 0 && (
              <div>
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Prints · {report.prints.length}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {report.prints.map((p) => <PrintThumb key={p.path} path={p.path} />)}
                </div>
              </div>
            )}

            {/* Contexto */}
            {report.context && Object.keys(report.context).length > 0 && (
              <div>
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Contexto da captura
                </div>
                <dl className="space-y-1 rounded-md border bg-muted/40 p-3 text-xs">
                  {Object.entries({
                    Tela: report.context.screen,
                    URL: report.context.url,
                    Janela: report.context.window,
                    Browser: report.context.browser,
                  }).filter(([, v]) => v).map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-3">
                      <dt className="shrink-0 text-muted-foreground">{k}</dt>
                      <dd className="truncate font-mono">{String(v)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}

            {/* Log de erros capturado junto com o report */}
            <CapturedErrorsBlock context={report.context} />

            {/* Análise do Claude (rotina 3x/dia analisa os cards em "Eu peguei") */}
            {report.ai_analysis && (
              <div>
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  🤖 Análise do Claude
                  {report.ai_analyzed_at && (
                    <span className="ml-1 font-normal normal-case tracking-normal">
                      · {formatDistanceToNow(new Date(report.ai_analyzed_at), { addSuffix: true, locale: ptBR })}
                    </span>
                  )}
                </div>
                <div className="whitespace-pre-wrap rounded-md border border-violet-500/20 bg-violet-500/5 p-3 text-xs leading-relaxed">
                  {report.ai_analysis}
                </div>
              </div>
            )}

            {/* Notas de resolução */}
            <div>
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Notas de resolução
              </div>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="O que você fez? Que arquivo mudou? Como ficou? (opcional)"
                rows={3}
                className="resize-none text-sm"
              />
            </div>

            {/* Ações por status */}
            <div className="flex flex-wrap justify-end gap-2 border-t pt-3">
              {report.status !== 'novo' && (
                <Button variant="ghost" size="sm" onClick={() => onMove('novo')}>
                  <Undo2 className="mr-1.5 h-3.5 w-3.5" /> Voltar pra Novo
                </Button>
              )}
              {report.status === 'novo' && (
                <Button variant="outline" size="sm" onClick={() => onMove('em_andamento')}>
                  <Hand className="mr-1.5 h-3.5 w-3.5" /> Pegar pra mim
                </Button>
              )}
              {report.status !== 'descartado' && (
                <Button variant="outline" size="sm" onClick={() => onMove('descartado')}>
                  <Ban className="mr-1.5 h-3.5 w-3.5" /> Não vai rolar
                </Button>
              )}
              {report.status !== 'resolvido' && (
                <Button size="sm" onClick={saveNotesAndResolve} disabled={update.isPending}>
                  {update.isPending
                    ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    : <Check className="mr-1.5 h-3.5 w-3.5" />}
                  Resolvido
                </Button>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Erros do console capturados no momento do report (context.extra.recent_errors). */
function CapturedErrorsBlock({ context }: { context: MelhoriaReport['context'] }) {
  const errors = (context?.extra as { recent_errors?: Array<{ ts: string; type: string; message: string }> } | undefined)
    ?.recent_errors;
  if (!errors?.length) return null;
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Log de erros · {errors.length}
      </div>
      <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border bg-red-500/5 p-3">
        {errors.map((e, i) => (
          <div key={i} className="font-mono text-[10px] leading-snug text-red-700 dark:text-red-400">
            <span className="text-muted-foreground">{e.ts.slice(11, 19)}</span>{' '}
            <span className="uppercase">[{e.type}]</span> {e.message}
          </div>
        ))}
      </div>
    </div>
  );
}

function PrintThumb({ path }: { path: string }) {
  const { data: url } = usePrintUrl(path);
  if (!url) {
    return <div className="flex h-24 items-center justify-center rounded-md border bg-muted/40">
      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
    </div>;
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-md border">
      <img src={url} alt="print" className="h-24 w-full object-cover transition-transform hover:scale-105" />
    </a>
  );
}
