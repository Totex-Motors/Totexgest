# Módulo Melhorias — botão flutuante de report + kanban interno (portável)

> **Pra quem é este arquivo:** uma sessão do Claude Code (ou dev) instalando este
> módulo em OUTRA aplicação. Ele é auto-contido: schema SQL, código completo de
> todos os arquivos, instruções de wiring, a rotina de análise automática e as
> armadilhas já resolvidas. Origem: Totexgest (CRM da Totex Motors), 2026-07-12.
> Inspiração: fluxo do Frank (IA na Prática) — vídeo "botão flutuante + kanban".

## 1. O que o módulo faz

1. **Botão flutuante 💡 móvel** na borda direita, em todas as telas da aplicação
   (badge = nº de reports na coluna "Novo"; arrastável verticalmente, posição
   salva em localStorage).
2. Clique → painel **"Reportar melhoria"**: o usuário descreve, escolhe
   **categoria** (Agente IA, UX/UI, Bug, Nova feature, Reunião/Call, Performance,
   Outro) e **severidade** (Baixa/Média/Alta/Crítica). O painel captura sozinho:
   rota, URL, resolução de tela/janela, browser e **os últimos 20 erros do
   console** (ring buffer global).
3. **Prints com anotação estilo Zoho Annotator**: captura de tela nativa
   (getDisplayMedia, pede permissão) ou upload; depois da captura abre um editor
   canvas com **retângulo, círculo, seta, texto e caneta livre** em 4 cores —
   as marcações são assadas no PNG final.
4. **Kanban** em `/gestao/melhorias`: colunas **Novo → Eu peguei → Resolvido →
   Não vai rolar**, drag & drop nativo, stats (Total/Novos/Em andamento),
   filtros por categoria/severidade. Arrastar pra "Eu peguei" atribui o card a
   quem arrastou. Detalhe do card: prints (signed URLs), contexto capturado,
   log de erros, **análise do Claude** e notas de resolução, com ações
   "Pegar pra mim" / "Não vai rolar" / "Resolvido".
5. **Rotina semi-automática (opcional)**: um trigger agendado acorda uma sessão
   do Claude Code de hora em hora; ela lê os cards em "Eu peguei" ainda não
   analisados, investiga no código, implementa a correção num branch, grava a
   análise no card (`ai_analysis`) e pede autorização antes do merge.

## 2. Pré-requisitos da aplicação destino

- React 18 + TypeScript + Vite + Tailwind CSS
- shadcn/ui com estes componentes: `sheet`, `dialog`, `button`, `textarea`,
  `badge`, `card`, `collapsible`, `input`
- TanStack Query v5 (`useQuery`/`useMutation`) com `QueryClientProvider` ativo
- Supabase (Postgres + Storage + Auth) com client em `@/lib/supabase`
- `sonner` (toast), `lucide-react` (ícones), `date-fns` (+ locale `ptBR`),
  helper `cn` em `@/lib/utils`
- Multi-tenant via RLS com função SQL `get_tenant_id()` (lê o tenant do JWT).
  **Se a aplicação destino NÃO for multi-tenant**, veja § 7.
- Um contexto de auth que exponha o membro do time logado com `id` e
  `tenant_id` (aqui: `useAuth().teamMember` de `@/contexts/AuthContext`)
- Função SQL `set_updated_at()` (trigger de updated_at). Se não existir:

```sql
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;
```

## 3. Instalação — ordem

1. Aplicar as **2 migrations** (§ 4, primeiros dois blocos) no banco.
2. Criar os **6 arquivos de frontend** (§ 4) — ajustar imports se os paths
   da aplicação destino forem diferentes.
3. Fazer o **wiring** (§ 5): entry point, layout, rota, sidebar.
4. Validar: `tsc --noEmit` + build + checklist (§ 8).
5. (Opcional) Montar a **rotina do Claude** (§ 6).

## 4. Código completo

### `supabase/migrations/20260712120000_melhorias_kanban.sql`

```sql
-- ════════════════════════════════════════════════════════════════════
-- Melhorias do sistema — report com botão flutuante + kanban interno
-- (feature do template v3 do Frank, portada pro Totexgest)
--
-- Fluxo: qualquer membro do time clica no botão flutuante em qualquer
-- tela → painel "Reportar melhoria" captura contexto (rota, URL, tela,
-- browser) + prints → card nasce na coluna NOVO do kanban em
-- /gestao/melhorias. Time arrasta: NOVO → EU PEGUEI → RESOLVIDO
-- (ou NÃO VAI ROLAR).
--
-- Idempotente: pode rodar mais de uma vez sem erro.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS melhoria_reports (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL,
  reported_by      UUID REFERENCES team_members(id) ON DELETE SET NULL,
  assigned_to      UUID REFERENCES team_members(id) ON DELETE SET NULL,

  description      TEXT NOT NULL,
  category         TEXT NOT NULL DEFAULT 'outro'
                     CHECK (category IN ('agente_ia','ux_ui','bug','nova_feature','reuniao_call','performance','outro')),
  severity         TEXT NOT NULL DEFAULT 'media'
                     CHECK (severity IN ('baixa','media','alta','critica')),
  status           TEXT NOT NULL DEFAULT 'novo'
                     CHECK (status IN ('novo','em_andamento','resolvido','descartado')),

  route            TEXT,                          -- rota do CRM onde o report nasceu (ex: /comercial/pipeline)
  context          JSONB NOT NULL DEFAULT '{}',   -- { url, screen, window, browser, extra }
  prints           JSONB NOT NULL DEFAULT '[]',   -- [{ path, width, height }] no bucket melhorias-prints

  resolution_notes TEXT,                          -- "o que você fez? que arquivo mudou? como ficou?"
  resolved_at      TIMESTAMPTZ,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_melhoria_reports_tenant  ON melhoria_reports (tenant_id);
CREATE INDEX IF NOT EXISTS idx_melhoria_reports_status  ON melhoria_reports (tenant_id, status);

-- updated_at automático (função set_updated_at já existe no schema base)
DO $$ BEGIN
  CREATE TRIGGER trg_melhoria_reports_updated_at
    BEFORE UPDATE ON melhoria_reports
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- RLS: todo o time do tenant vê e opera (report é colaborativo — qualquer
-- um reporta, qualquer um pode pegar/arrastar/resolver).
ALTER TABLE melhoria_reports ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  DROP POLICY IF EXISTS melhoria_reports_tenant ON melhoria_reports;
  CREATE POLICY melhoria_reports_tenant ON melhoria_reports
    FOR ALL TO authenticated
    USING (tenant_id = get_tenant_id())
    WITH CHECK (tenant_id = get_tenant_id());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ────────────────────────────────────────────────────────────────────
-- Bucket dos prints — PRIVADO (prints da tela do CRM contêm dados de
-- clientes; acesso via signed URLs geradas pelo client, igual call-recordings)
-- ────────────────────────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'melhorias-prints',
  'melhorias-prints',
  false,
  10485760, -- 10 MB por print
  ARRAY['image/png', 'image/jpeg', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Path convencionado pelo app: <tenant_id>/<uuid>.png — policy segmenta por tenant.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'melhorias_prints_tenant_all'
  ) THEN
    CREATE POLICY melhorias_prints_tenant_all
      ON storage.objects
      FOR ALL
      TO authenticated
      USING (bucket_id = 'melhorias-prints' AND (storage.foldername(name))[1] = get_tenant_id()::text)
      WITH CHECK (bucket_id = 'melhorias-prints' AND (storage.foldername(name))[1] = get_tenant_id()::text);
  END IF;
END $$;
```

### `supabase/migrations/20260712130000_melhorias_ai_analysis.sql`

```sql
-- Análise do Claude nos cards de melhoria (rotina 3x/dia).
-- A rotina lê os cards em "Eu peguei" (em_andamento) ainda não analisados,
-- investiga no código, grava a análise aqui e manda pro Marco autorizar.
-- ai_analyzed_at marca o card como processado (evita re-análise).

ALTER TABLE melhoria_reports ADD COLUMN IF NOT EXISTS ai_analysis TEXT;
ALTER TABLE melhoria_reports ADD COLUMN IF NOT EXISTS ai_analyzed_at TIMESTAMPTZ;
```

### `src/lib/errorBuffer.ts`

```ts
/**
 * errorBuffer — ring buffer global dos últimos erros do frontend.
 *
 * Instalado no main.tsx (antes do app montar). Captura:
 *  - window "error" (exceções não tratadas, erros de script)
 *  - window "unhandledrejection" (promises rejeitadas)
 *  - console.error (wrap não-destrutivo)
 *
 * Consumido pelo report de melhorias (MelhoriaReportSheet): quando alguém
 * reporta um problema, os erros recentes vão juntos no context.extra —
 * "já pega o log do erro" sem o usuário fazer nada.
 */

export interface CapturedError {
  ts: string;                                      // ISO timestamp
  type: 'error' | 'promise' | 'console';
  message: string;
}

const MAX_ENTRIES = 20;
const MAX_MSG_LEN = 300;

const buffer: CapturedError[] = [];
let installed = false;

function push(type: CapturedError['type'], message: string) {
  const msg = String(message || '').slice(0, MAX_MSG_LEN);
  if (!msg) return;
  buffer.push({ ts: new Date().toISOString(), type, message: msg });
  if (buffer.length > MAX_ENTRIES) buffer.shift();
}

function stringifyArg(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return `${a.name}: ${a.message}`;
  try { return JSON.stringify(a); } catch { return String(a); }
}

export function installErrorBuffer(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  window.addEventListener('error', (e) => {
    push('error', `${e.message}${e.filename ? ` @ ${e.filename.split('/').pop()}:${e.lineno}` : ''}`);
  });

  window.addEventListener('unhandledrejection', (e) => {
    const reason = (e as PromiseRejectionEvent).reason;
    push('promise', reason instanceof Error ? `${reason.name}: ${reason.message}` : stringifyArg(reason));
  });

  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    push('console', args.map(stringifyArg).join(' '));
    original(...args);
  };
}

/** Últimos erros capturados (mais antigo primeiro). */
export function getRecentErrors(): CapturedError[] {
  return [...buffer];
}
```

### `src/hooks/useMelhorias.ts`

```ts
/**
 * useMelhorias — reports de melhoria do sistema (botão flutuante + kanban).
 *
 * Tabela: melhoria_reports (RLS por tenant; todo o time vê e opera).
 * Prints: bucket privado `melhorias-prints` — exibição via signed URLs.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';

export type MelhoriaCategory =
  | 'agente_ia' | 'ux_ui' | 'bug' | 'nova_feature' | 'reuniao_call' | 'performance' | 'outro';
export type MelhoriaSeverity = 'baixa' | 'media' | 'alta' | 'critica';
export type MelhoriaStatus = 'novo' | 'em_andamento' | 'resolvido' | 'descartado';

export interface MelhoriaPrint {
  path: string;
  width?: number;
  height?: number;
}

export interface MelhoriaContext {
  url?: string;
  screen?: string;   // "3024x1792"
  window?: string;   // "1512x824"
  browser?: string;  // user agent resumido
  extra?: Record<string, unknown>;
}

export interface MelhoriaReport {
  id: string;
  tenant_id: string;
  reported_by: string | null;
  assigned_to: string | null;
  description: string;
  category: MelhoriaCategory;
  severity: MelhoriaSeverity;
  status: MelhoriaStatus;
  route: string | null;
  context: MelhoriaContext;
  prints: MelhoriaPrint[];
  resolution_notes: string | null;
  resolved_at: string | null;
  ai_analysis: string | null;
  ai_analyzed_at: string | null;
  created_at: string;
  updated_at: string;
  reporter?: { id: string; name: string } | null;
  assignee?: { id: string; name: string } | null;
}

export const CATEGORY_LABELS: Record<MelhoriaCategory, string> = {
  agente_ia: 'Agente IA',
  ux_ui: 'UX/UI',
  bug: 'Bug',
  nova_feature: 'Nova feature',
  reuniao_call: 'Reunião/Call',
  performance: 'Performance',
  outro: 'Outro',
};

export const SEVERITY_LABELS: Record<MelhoriaSeverity, string> = {
  baixa: 'Baixa',
  media: 'Média',
  alta: 'Alta',
  critica: 'Crítica',
};

const QK = ['melhoria-reports'];

export function useMelhorias() {
  return useQuery({
    queryKey: QK,
    queryFn: async (): Promise<MelhoriaReport[]> => {
      const { data, error } = await supabase
        .from('melhoria_reports')
        .select('*, reporter:team_members!melhoria_reports_reported_by_fkey(id, name), assignee:team_members!melhoria_reports_assigned_to_fkey(id, name)')
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data as unknown as MelhoriaReport[]) || [];
    },
    staleTime: 30_000,
  });
}

/** Contagem de NOVOS pro badge do botão flutuante (barata, só count). */
export function useMelhoriasNovasCount() {
  return useQuery({
    queryKey: [...QK, 'novas-count'],
    queryFn: async (): Promise<number> => {
      const { count, error } = await supabase
        .from('melhoria_reports')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'novo');
      if (error) return 0;
      return count ?? 0;
    },
    staleTime: 60_000,
  });
}

export interface CreateMelhoriaInput {
  description: string;
  category: MelhoriaCategory;
  severity: MelhoriaSeverity;
  route: string;
  context: MelhoriaContext;
  /** Blobs de print já capturados — o hook sobe pro bucket e grava os paths. */
  printBlobs: Array<{ blob: Blob; width?: number; height?: number }>;
}

export function useCreateMelhoria() {
  const qc = useQueryClient();
  const { teamMember } = useAuth();

  return useMutation({
    mutationFn: async (input: CreateMelhoriaInput) => {
      if (!teamMember) throw new Error('Sem membro do time logado');

      // 1. Sobe os prints pro bucket privado (path segmentado por tenant — RLS do storage)
      const prints: MelhoriaPrint[] = [];
      for (const p of input.printBlobs) {
        const path = `${teamMember.tenant_id}/${crypto.randomUUID()}.png`;
        const { error: upErr } = await supabase.storage
          .from('melhorias-prints')
          .upload(path, p.blob, { contentType: 'image/png' });
        if (upErr) throw new Error(`Falha subindo print: ${upErr.message}`);
        prints.push({ path, width: p.width, height: p.height });
      }

      // 2. Cria o report
      const { data, error } = await supabase
        .from('melhoria_reports')
        .insert({
          tenant_id: teamMember.tenant_id,
          reported_by: teamMember.id,
          description: input.description,
          category: input.category,
          severity: input.severity,
          route: input.route,
          context: input.context,
          prints,
        })
        .select('id')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QK });
      toast.success('Melhoria reportada! Já entrou na coluna Novo do kanban.');
    },
    onError: (e: Error) => toast.error(`Erro ao reportar: ${e.message}`),
  });
}

export function useUpdateMelhoria() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      id: string;
      status?: MelhoriaStatus;
      assigned_to?: string | null;
      resolution_notes?: string | null;
    }) => {
      const patch: Record<string, unknown> = {};
      if (input.status !== undefined) {
        patch.status = input.status;
        patch.resolved_at = input.status === 'resolvido' ? new Date().toISOString() : null;
      }
      if (input.assigned_to !== undefined) patch.assigned_to = input.assigned_to;
      if (input.resolution_notes !== undefined) patch.resolution_notes = input.resolution_notes;

      const { error } = await supabase
        .from('melhoria_reports')
        .update(patch)
        .eq('id', input.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: QK }),
    onError: (e: Error) => toast.error(`Erro atualizando: ${e.message}`),
  });
}

/** Signed URL de um print (bucket privado). Cache leve por path. */
export function usePrintUrl(path: string | null) {
  return useQuery({
    queryKey: ['melhoria-print-url', path],
    queryFn: async (): Promise<string | null> => {
      if (!path) return null;
      const { data } = await supabase.storage
        .from('melhorias-prints')
        .createSignedUrl(path, 3600);
      return data?.signedUrl ?? null;
    },
    enabled: !!path,
    staleTime: 50 * 60 * 1000, // renova antes de expirar (1h)
  });
}

/**
 * Captura um frame da tela via getDisplayMedia (mesma técnica do print nativo).
 * O browser mostra o seletor de tela/janela/aba; capturamos 1 frame e paramos o stream.
 * Retorna null se o usuário cancelar o seletor.
 */
export async function captureScreenPrint(): Promise<{ blob: Blob; width: number; height: number } | null> {
  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 1 },
      audio: false,
    });
    const track = stream.getVideoTracks()[0];
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    // 1 frame de folga pro compositor desenhar
    await new Promise((r) => setTimeout(r, 150));

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d indisponível');
    ctx.drawImage(video, 0, 0);
    track.stop();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/png'),
    );
    if (!blob) throw new Error('toBlob falhou');
    return { blob, width: canvas.width, height: canvas.height };
  } catch (e) {
    // NotAllowedError = usuário cancelou o seletor — não é erro
    if ((e as Error)?.name === 'NotAllowedError') return null;
    throw e;
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
  }
}
```

### `src/components/melhorias/FloatingMelhoriaButton.tsx`

```tsx
/**
 * FloatingMelhoriaButton — botão flutuante "Reportar melhoria".
 *
 * Ancorado na borda direita em TODAS as páginas do CRM (montado no AppLayout),
 * e MÓVEL: arrasta verticalmente pra onde quiser (pra não sobrepor uma call,
 * um painel etc). A posição fica salva no navegador. Badge mostra quantos
 * reports estão na coluna NOVO. Clique abre o MelhoriaReportSheet.
 */

import { useCallback, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Lightbulb } from 'lucide-react';
import { useMelhoriasNovasCount } from '@/hooks/useMelhorias';
import { MelhoriaReportSheet } from './MelhoriaReportSheet';

const POSITION_KEY = 'melhoria-btn-top-pct';
const DRAG_THRESHOLD_PX = 6; // abaixo disso é clique, não arrasto

function loadTopPct(): number {
  const saved = Number(localStorage.getItem(POSITION_KEY));
  return Number.isFinite(saved) && saved >= 8 && saved <= 92 ? saved : 50;
}

export function FloatingMelhoriaButton() {
  const [open, setOpen] = useState(false);
  const [topPct, setTopPct] = useState<number>(loadTopPct);
  const dragState = useRef<{ startY: number; startPct: number; moved: boolean } | null>(null);
  const { pathname } = useLocation();
  const { data: novas = 0 } = useMelhoriasNovasCount();

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragState.current = { startY: e.clientY, startPct: topPct, moved: false };
  }, [topPct]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const s = dragState.current;
    if (!s) return;
    const deltaY = e.clientY - s.startY;
    if (!s.moved && Math.abs(deltaY) < DRAG_THRESHOLD_PX) return;
    s.moved = true;
    const pct = Math.min(92, Math.max(8, s.startPct + (deltaY / window.innerHeight) * 100));
    setTopPct(pct);
  }, []);

  const onPointerUp = useCallback(() => {
    const s = dragState.current;
    dragState.current = null;
    if (!s) return;
    if (s.moved) {
      // Terminou um arrasto — persiste posição, NÃO abre o painel
      setTopPct((pct) => {
        localStorage.setItem(POSITION_KEY, String(Math.round(pct)));
        return pct;
      });
    } else {
      setOpen(true); // foi um clique
    }
  }, []);

  // No próprio kanban o botão não precisa aparecer (a página tem CTA próprio)
  if (pathname.startsWith('/gestao/melhorias')) return null;

  return (
    <>
      <button
        type="button"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        title="Reportar melhoria (arrasta pra mover)"
        style={{ top: `${topPct}%` }}
        className="fixed right-0 z-40 -translate-y-1/2 cursor-grab touch-none rounded-l-full border border-r-0 border-primary/30 bg-primary py-2.5 pl-2.5 pr-1.5 text-white shadow-lg transition-[padding] hover:pr-3 focus:outline-none active:cursor-grabbing"
      >
        <Lightbulb className="h-4 w-4" />
        {novas > 0 && (
          <span className="absolute -left-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[9px] font-bold text-white shadow">
            {novas > 99 ? '99+' : novas}
          </span>
        )}
      </button>

      <MelhoriaReportSheet open={open} onOpenChange={setOpen} />
    </>
  );
}
```

### `src/components/melhorias/MelhoriaReportSheet.tsx`

```tsx
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

export function MelhoriaReportSheet({ open, onOpenChange }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
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
```

### `src/components/melhorias/PrintAnnotator.tsx`

```tsx
/**
 * PrintAnnotator — editor de anotações em cima do print (estilo Zoho Annotator).
 *
 * Abre depois da captura de tela (ou pelo lápis na miniatura). Ferramentas:
 * retângulo, círculo, seta, texto e caneta livre, com 4 cores. As anotações
 * são "assadas" na imagem final (canvas → blob) — o que o time marca é
 * exatamente o que o Claude vê ao analisar o card.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  Square, Circle as CircleIcon, MoveUpRight, Type, Pencil, Undo2, Trash2, Check, Loader2,
} from 'lucide-react';

type Tool = 'rect' | 'ellipse' | 'arrow' | 'text' | 'pen';

interface Shape {
  type: Tool;
  color: string;
  x1: number; y1: number; x2: number; y2: number;
  text?: string;
  points?: Array<{ x: number; y: number }>;
}

const COLORS = ['#ef4444', '#f59e0b', '#3b82f6', '#22c55e'] as const;

const TOOLS: Array<{ id: Tool; icon: React.ElementType; label: string }> = [
  { id: 'rect',    icon: Square,      label: 'Retângulo' },
  { id: 'ellipse', icon: CircleIcon,  label: 'Círculo' },
  { id: 'arrow',   icon: MoveUpRight, label: 'Seta' },
  { id: 'text',    icon: Type,        label: 'Texto' },
  { id: 'pen',     icon: Pencil,      label: 'Caneta' },
];

export function PrintAnnotator({ image, open, onCancel, onConfirm }: {
  image: Blob | null;
  open: boolean;
  onCancel: () => void;
  onConfirm: (annotated: Blob, width: number, height: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const [tool, setTool] = useState<Tool>('rect');
  const [color, setColor] = useState<string>(COLORS[0]);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [current, setCurrent] = useState<Shape | null>(null);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  // Input de texto flutuante: posição em coords da IMAGEM
  const [textInput, setTextInput] = useState<{ x: number; y: number; value: string } | null>(null);

  // Carrega a imagem no canvas quando abre
  useEffect(() => {
    if (!open || !image) return;
    setShapes([]);
    setCurrent(null);
    setTextInput(null);
    setReady(false);
    const url = URL.createObjectURL(image);
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
      }
      setReady(true);
    };
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [open, image]);

  // Redesenha tudo (imagem + shapes + shape em andamento)
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);

    const lw = Math.max(3, Math.round(canvas.width / 400));
    const fontSize = Math.max(18, Math.round(canvas.width / 45));

    for (const s of [...shapes, ...(current ? [current] : [])]) {
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      ctx.lineWidth = lw;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      if (s.type === 'rect') {
        ctx.strokeRect(Math.min(s.x1, s.x2), Math.min(s.y1, s.y2), Math.abs(s.x2 - s.x1), Math.abs(s.y2 - s.y1));
      } else if (s.type === 'ellipse') {
        ctx.beginPath();
        ctx.ellipse((s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2, Math.abs(s.x2 - s.x1) / 2, Math.abs(s.y2 - s.y1) / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else if (s.type === 'arrow') {
        const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
        const head = lw * 4;
        ctx.beginPath();
        ctx.moveTo(s.x1, s.y1);
        ctx.lineTo(s.x2, s.y2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(s.x2, s.y2);
        ctx.lineTo(s.x2 - head * Math.cos(angle - Math.PI / 6), s.y2 - head * Math.sin(angle - Math.PI / 6));
        ctx.lineTo(s.x2 - head * Math.cos(angle + Math.PI / 6), s.y2 - head * Math.sin(angle + Math.PI / 6));
        ctx.closePath();
        ctx.fill();
      } else if (s.type === 'pen' && s.points?.length) {
        ctx.beginPath();
        ctx.moveTo(s.points[0].x, s.points[0].y);
        for (const p of s.points.slice(1)) ctx.lineTo(p.x, p.y);
        ctx.stroke();
      } else if (s.type === 'text' && s.text) {
        ctx.font = `bold ${fontSize}px system-ui, sans-serif`;
        // contorno branco pra ler em qualquer fundo
        ctx.lineWidth = Math.max(2, Math.round(fontSize / 8));
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.strokeText(s.text, s.x1, s.y1);
        ctx.fillText(s.text, s.x1, s.y1);
      }
    }
  }, [shapes, current]);

  useEffect(() => { if (ready) redraw(); }, [ready, redraw]);

  /** Converte coords do pointer (CSS) → coords da imagem (canvas natural). */
  const toImageCoords = (e: React.PointerEvent): { x: number; y: number } => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!ready) return;
    // Já tem um texto sendo digitado → clique no canvas confirma ele
    if (textInput) { commitText(); return; }
    const { x, y } = toImageCoords(e);
    if (tool === 'text') {
      // preventDefault: sem isso o mousedown move o foco pro canvas e o
      // input (que monta com autoFocus logo em seguida) perde o foco na hora
      e.preventDefault();
      setTextInput({ x, y, value: '' });
      return;
    }
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    setCurrent({
      type: tool, color, x1: x, y1: y, x2: x, y2: y,
      ...(tool === 'pen' ? { points: [{ x, y }] } : {}),
    });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!current) return;
    const { x, y } = toImageCoords(e);
    setCurrent((c) => c && {
      ...c, x2: x, y2: y,
      ...(c.type === 'pen' ? { points: [...(c.points || []), { x, y }] } : {}),
    });
  };

  const onPointerUp = () => {
    if (!current) return;
    // Ignora cliques sem arrasto (shape de tamanho zero)
    const tooSmall = current.type !== 'pen' && Math.abs(current.x2 - current.x1) < 4 && Math.abs(current.y2 - current.y1) < 4;
    if (!tooSmall) setShapes((prev) => [...prev, current]);
    setCurrent(null);
  };

  const commitText = () => {
    if (textInput?.value.trim()) {
      setShapes((prev) => [...prev, {
        type: 'text', color, text: textInput.value.trim(),
        x1: textInput.x, y1: textInput.y, x2: textInput.x, y2: textInput.y,
      }]);
    }
    setTextInput(null);
  };

  const handleConfirm = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (textInput) commitText(); // texto em digitação entra no print final
    setSaving(true);
    try {
      redraw(); // garante estado final desenhado
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
      if (blob) onConfirm(blob, canvas.width, canvas.height);
    } finally {
      setSaving(false);
    }
  };

  // Posição do input de texto em % (acompanha o scale CSS do canvas).
  // Clamp pra ele nunca cair fora da área visível (topo/bordas do print).
  const textInputStyle = (() => {
    const canvas = canvasRef.current;
    if (!textInput || !canvas) return undefined;
    return {
      left: `${Math.min(70, Math.max(1, (textInput.x / canvas.width) * 100))}%`,
      top: `${Math.min(90, Math.max(1, (textInput.y / canvas.height) * 100))}%`,
    };
  })();

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="text-base">Marcar no print</DialogTitle>
        </DialogHeader>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-1.5">
          {TOOLS.map((t) => (
            <Button
              key={t.id}
              type="button"
              variant={tool === t.id ? 'default' : 'outline'}
              size="sm"
              onClick={() => setTool(t.id)}
              title={t.label}
            >
              <t.icon className="h-3.5 w-3.5" />
            </Button>
          ))}
          <span className="mx-1 h-5 w-px bg-border" />
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              className={cn(
                'h-6 w-6 rounded-full border-2 transition-transform',
                color === c ? 'scale-110 border-foreground' : 'border-transparent',
              )}
              style={{ backgroundColor: c }}
              title="Cor"
            />
          ))}
          <span className="mx-1 h-5 w-px bg-border" />
          <Button type="button" variant="outline" size="sm" disabled={!shapes.length} onClick={() => setShapes((p) => p.slice(0, -1))} title="Desfazer">
            <Undo2 className="h-3.5 w-3.5" />
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={!shapes.length} onClick={() => setShapes([])} title="Limpar tudo">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Canvas */}
        <div ref={wrapRef} className="relative max-h-[60vh] overflow-auto rounded-md border bg-muted/30">
          <div className="relative">
            <canvas
              ref={canvasRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              className={cn('block max-w-full touch-none', tool === 'text' ? 'cursor-text' : 'cursor-crosshair')}
            />
            {textInput && (
              <input
                autoFocus
                value={textInput.value}
                onChange={(e) => setTextInput((t) => t && { ...t, value: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') commitText(); if (e.key === 'Escape') setTextInput(null); }}
                onPointerDown={(e) => e.stopPropagation()}
                placeholder="Digite e Enter…"
                style={{ ...textInputStyle, borderColor: color }}
                className="absolute z-10 w-48 rounded border-2 bg-white px-2 py-1 text-sm font-bold shadow-lg outline-none dark:bg-zinc-900"
              />
            )}
            {!ready && (
              <div className="flex h-40 items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>Cancelar</Button>
          <Button onClick={handleConfirm} disabled={!ready || saving}>
            {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1.5 h-3.5 w-3.5" />}
            Usar print
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

### `src/pages/GestaoMelhorias.tsx`

```tsx
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
```
## 5. Wiring (4 pontos)

### 5.1 Entry point (`src/main.tsx`) — instalar o buffer de erros ANTES do app montar

```tsx
import { installErrorBuffer } from "./lib/errorBuffer";
installErrorBuffer();
```

### 5.2 Layout global — montar o botão flutuante (aparece em toda tela)

No componente de layout que envolve todas as páginas (aqui `AppLayout.tsx`),
fora do fluxo de conteúdo (irmão do main), lazy pra não pesar o bundle inicial:

```tsx
const FloatingMelhoriaButton = React.lazy(() =>
  import("@/components/melhorias/FloatingMelhoriaButton").then((m) => ({ default: m.FloatingMelhoriaButton }))
);
// ...no JSX, junto de outros overlays globais:
<React.Suspense fallback={null}>
  <FloatingMelhoriaButton />
</React.Suspense>
```

### 5.3 Rota (`src/App.tsx` ou onde ficam as rotas)

```tsx
const GestaoMelhorias = React.lazy(() => import("./pages/GestaoMelhorias"));
// ...
<Route path="/gestao/melhorias" element={<ProtectedRoute><React.Suspense fallback={<div />}><GestaoMelhorias /></React.Suspense></ProtectedRoute>} />
```

Se mudar a rota, atualize também o guard no `FloatingMelhoriaButton`
(`pathname.startsWith('/gestao/melhorias')` — esconde o botão no próprio kanban).

### 5.4 Item no menu/sidebar

```tsx
{ title: "Melhorias", url: "/gestao/melhorias", icon: Lightbulb }
```

## 6. Rotina do Claude (opcional — o "analisa e corrige" semi-automático)

Numa sessão do Claude Code (remota) com acesso ao repo e ao MCP do Supabase,
criar um trigger agendado (cron de hora em hora: `0 * * * *`) que dispara
NA PRÓPRIA SESSÃO com este prompt (ajustar projeto/branch):

```text
[ROTINA MELHORIAS — análise semi-automática dos cards do kanban]

Execute o ciclo:
1. git fetch origin main e garanta que está no branch de trabalho rebasado.
2. Via MCP Supabase (projeto <PROJECT_ID>), busque os cards pendentes:
   SELECT id, description, category, severity, route, context, prints, created_at
   FROM melhoria_reports
   WHERE status='em_andamento' AND ai_analyzed_at IS NULL ORDER BY created_at;
3. Se não houver nenhum, NÃO mande mensagem — encerre silenciosamente.
4. Para cada card:
   a. Leia descrição, rota e context.extra.recent_errors (log capturado).
   b. Investigue no código a causa/o que precisa mudar.
   c. Pedido de PROCESSO/não-código: grave em ai_analysis explicando e pule.
   d. Código: implemente no branch de trabalho, valide (tsc + build), commite
      e faça push DO BRANCH. NÃO faça merge na main — o dono autoriza antes.
   e. UPDATE melhoria_reports SET ai_analysis='<resumo: causa, o que mudou,
      arquivos>', ai_analyzed_at=now() WHERE id='<id>';
5. Ao final, UMA mensagem resumindo cada card e pedindo autorização pro merge.
```

Regra de maturidade (do Frank): começa **semi-automático** (Claude prepara,
humano autoriza). Só liberar merge automático depois de confiança no processo.

## 7. Adaptações comuns

| Situação na aplicação destino | O que mudar |
|---|---|
| **Sem multi-tenant** | Remover `tenant_id` da tabela/insert, trocar as duas policies RLS por `USING (true)` p/ authenticated, e na policy do storage remover o check de foldername (usar só `bucket_id = 'melhorias-prints'`). No hook, remover `teamMember.tenant_id` do path do upload (usar só `crypto.randomUUID()`). |
| Contexto de auth com outro shape | Trocar `useAuth().teamMember` (precisa de `id` e `tenant_id`) pelo equivalente. A FK `reported_by/assigned_to → team_members(id)` deve apontar pra tabela de usuários/membros local — ajustar nomes de FK no select do hook (`team_members!melhoria_reports_reported_by_fkey`). |
| Toast diferente de sonner | Trocar os `toast.*` no hook e componentes. |
| Sem página de "detalhe por rota" | Nada a fazer — o módulo só grava `route` como texto. |
| Tabela de membros com outro nome | Ajustar as FKs na migration E os hints de embed no select do `useMelhorias`. |

## 8. Checklist de teste pós-instalação

1. Botão 💡 aparece em qualquer tela; arrastar pra cima/baixo persiste após F5.
2. Reportar com texto simples → card aparece na coluna "Novo" do kanban; badge
   do botão incrementa.
3. Botão "Tela" → permissão do browser → anotador abre → desenhar
   círculo/seta/texto → "Usar print" → miniatura com as marcações.
4. Lápis na miniatura reabre o anotador (edição adiciona por cima).
5. Forçar um erro no console → reportar → detalhe do card mostra "Log de erros".
6. Arrastar card pra "Eu peguei" → nome de quem arrastou aparece no card.
7. Detalhe: "Resolvido" com notas → card vai pra coluna Resolvido.
8. Print abre em nova aba via signed URL (bucket é privado — getPublicUrl NÃO
   funciona, tem que ser createSignedUrl).

## 9. Armadilhas já resolvidas (não reintroduzir)

- **Input de texto do anotador**: criar o input no `pointerdown` faz o canvas
  roubar o foco e fechar o campo na hora. Solução já no código: `preventDefault()`
  no pointerdown da ferramenta texto, commit no Enter/clique no canvas (SEM
  onBlur), posição clampada pra não sair da área visível.
- **Bucket privado**: prints da tela contêm dados de clientes → bucket
  `melhorias-prints` é privado com policy por tenant; exibição SEMPRE via
  `createSignedUrl` (o hook `usePrintUrl` já faz, com cache de 50min pra URL
  de 1h).
- **Captura de tela**: browsers exigem permissão explícita (getDisplayMedia) —
  não existe print automático silencioso. Cancelar o seletor retorna `null`
  sem erro (NotAllowedError tratado).
- **Turno vazio**: reports sem descrição são bloqueados no submit; contagem
  0/2000 no textarea.
- **Falha silenciosa**: qualquer erro de upload/insert vira toast (onError nos
  mutations) — nunca deixar o usuário clicando num botão que "não faz nada".
