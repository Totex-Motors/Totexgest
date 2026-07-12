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
