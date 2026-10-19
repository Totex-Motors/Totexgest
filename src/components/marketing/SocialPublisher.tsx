import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Loader2, Share2, Link2, ExternalLink, RefreshCw } from 'lucide-react';

/**
 * Outras redes (Zernio): espelha o carrossel do Studio no Facebook, TikTok, Threads…
 * Instagram continua pelo InstagramPublisher (direto na Meta).
 */
type Account = { id: string; platform: string; username: string; picture: string | null; url: string | null; active: boolean; needs_reconnection: boolean; aceita_imagem: boolean };
type PlatformDef = { label: string; aceitaImagem: boolean; nota?: string };
type Pub = { id: string; zernio_post_id: string | null; status: string; platforms: { platform: string; account_id: string; username: string | null; status: string | null; url: string | null; error: string | null }[]; media_count: number; scheduled_for: string | null; created_at: string };
type Result = { configured: boolean; accounts?: Account[]; platforms?: Record<string, PlatformDef>; history?: Pub[]; error?: string };

const STATUS_PT: Record<string, string> = { pending: 'Enviando', publishing: 'Publicando', scheduled: 'Agendado', published: 'Publicado', partial: 'Parcial', failed: 'Falhou', cancelled: 'Cancelado', draft: 'Rascunho' };
const CONECTAVEIS = ['facebook', 'tiktok', 'threads', 'youtube'];

export function SocialPublisher({ campaignId, tenantId, canPublish }: { campaignId: string; tenantId: string; canPublish: boolean }) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  async function call(action: string, extra: Record<string, unknown> = {}): Promise<Result & { authUrl?: string; publication?: Pub }> {
    const { data, error } = await supabase.functions.invoke('zernio-publish', { body: { action, campaignId, ...extra } });
    if (error) { let m = 'Não foi possível falar com a Zernio.'; try { const d = await error.context?.json(); if (d?.error) m = d.error; } catch { /* offline */ } throw Error(m); }
    if (data?.error) throw Error(data.error);
    return data;
  }

  const q = useQuery({ queryKey: ['zernio-accounts', tenantId, campaignId], queryFn: () => call('accounts'), retry: false });
  const accounts = q.data?.accounts || [];
  const platforms = q.data?.platforms || {};
  const history = q.data?.history || [];

  // Volta da conexão (?zernio=connected) → recarrega
  useEffect(() => {
    const u = new URL(window.location.href);
    if (u.searchParams.get('zernio')) { u.searchParams.delete('zernio'); window.history.replaceState({}, '', u.toString()); void q.refetch(); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function connect(platform: string) {
    setBusy(true); setNotice('');
    try {
      const u = new URL(window.location.href); u.searchParams.set('zernio', 'connected');
      const r = await call('connect', { platform, redirect_url: u.toString() });
      if (r.authUrl) window.location.href = r.authUrl;
    } catch (e) { setNotice((e as Error).message); } finally { setBusy(false); }
  }

  async function publish() {
    if (selected.length === 0) return;
    const nomes = accounts.filter((a) => selected.includes(a.id)).map((a) => `${platforms[a.platform]?.label || a.platform} (${a.username})`).join(', ');
    if (!window.confirm(`Publicar agora o carrossel do Studio em: ${nomes}?`)) return;
    setBusy(true); setNotice('Enviando pra Zernio…');
    try {
      await call('publish', { accountIds: selected });
      setNotice('Enviado. A Zernio publica em instantes; o estado atualiza abaixo.');
      setSelected([]);
      await q.refetch();
      setTimeout(() => void refresh(), 8000);
    } catch (e) { setNotice((e as Error).message); await q.refetch(); } finally { setBusy(false); }
  }

  async function refresh() {
    try {
      const r = await call('status');
      qc.setQueryData(['zernio-accounts', tenantId, campaignId], (old: Result | undefined) => ({ ...(old || { configured: true }), history: r.history || [] }));
    } catch { /* silencioso */ }
  }

  if (q.isLoading) return <section className="rounded-lg border p-3 text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Carregando outras redes…</section>;
  if (q.isError) return <section className="rounded-lg border p-3 text-sm text-destructive">{(q.error as Error).message}</section>;
  if (q.data && !q.data.configured) return (
    <section className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
      <p className="font-medium text-foreground flex items-center gap-2"><Share2 className="h-4 w-4" /> Outras redes (Facebook, TikTok…)</p>
      <p className="mt-1">Cadastre a chave da Zernio em Configurações › Integrações › Redes sociais pra publicar o mesmo carrossel nas outras redes.</p>
    </section>
  );

  const ativas = accounts.filter((a) => a.active && a.aceita_imagem);
  const faltando = CONECTAVEIS.filter((p) => !accounts.some((a) => a.platform === p));

  return (
    <section className="space-y-3 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium flex items-center gap-2"><Share2 className="h-4 w-4" /> Outras redes (via Zernio)</p>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void q.refetch(); void refresh(); }}><RefreshCw className="h-3.5 w-3.5 mr-1" /> Atualizar</Button>
      </div>

      {accounts.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma rede conectada ainda. Conecte abaixo (o plano grátis da Zernio cobre 2 contas).</p>}

      {accounts.length > 0 && (
        <div className="space-y-2">
          {accounts.map((a) => {
            const def = platforms[a.platform];
            const disabled = !a.active || !a.aceita_imagem || !canPublish;
            return (
              <label key={a.id} className={`flex items-start gap-2 rounded-md border p-2 ${disabled ? 'opacity-70' : 'cursor-pointer'}`}>
                <Checkbox checked={selected.includes(a.id)} disabled={disabled} onCheckedChange={(v) => setSelected((s) => (v ? [...s, a.id] : s.filter((x) => x !== a.id)))} className="mt-0.5" />
                {a.picture && <img src={a.picture} alt="" className="h-6 w-6 rounded-full object-cover" />}
                <span className="text-sm flex-1">
                  <span className="font-medium">{def?.label || a.platform}</span> · {a.username}
                  {a.needs_reconnection && <Badge variant="destructive" className="ml-2 text-[10px]">reconectar</Badge>}
                  {!a.active && !a.needs_reconnection && <Badge variant="secondary" className="ml-2 text-[10px]">inativa</Badge>}
                  {def?.nota && <span className="block text-xs text-muted-foreground">{def.nota}</span>}
                </span>
                {a.needs_reconnection && <Button variant="outline" size="sm" disabled={busy} onClick={(e) => { e.preventDefault(); void connect(a.platform); }}>Reconectar</Button>}
              </label>
            );
          })}
        </div>
      )}

      {faltando.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Conectar:</span>
          {faltando.map((p) => (
            <Button key={p} variant="outline" size="sm" disabled={busy} onClick={() => void connect(p)}>
              <Link2 className="h-3.5 w-3.5 mr-1" /> {platforms[p]?.label || p}
            </Button>
          ))}
        </div>
      )}

      {ativas.length > 0 && (
        <Button disabled={busy || selected.length === 0 || !canPublish} onClick={() => void publish()}>
          {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null} Publicar nas redes selecionadas
        </Button>
      )}
      {!canPublish && accounts.length > 0 && <p className="text-xs text-muted-foreground">Devolva as artes do Studio ao Totexgest pra liberar a publicação.</p>}

      {history.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Envios desta campanha</p>
          {history.map((h) => (
            <div key={h.id} className="rounded-md bg-muted/40 p-2 text-sm">
              <div className="flex items-center justify-between">
                <span>{new Date(h.created_at).toLocaleString('pt-BR')} · {h.media_count} arte(s)</span>
                <Badge variant={h.status === 'published' ? 'default' : h.status === 'failed' ? 'destructive' : 'secondary'} className="text-[10px]">{STATUS_PT[h.status] || h.status}</Badge>
              </div>
              <ul className="mt-1 space-y-0.5">
                {h.platforms.map((p) => (
                  <li key={p.account_id} className="text-xs flex items-center gap-1">
                    <span className="font-medium">{platforms[p.platform]?.label || p.platform}</span>
                    {p.username && <span className="text-muted-foreground">· {p.username}</span>}
                    <span>· {STATUS_PT[p.status || ''] || p.status || '—'}</span>
                    {p.url && <a href={p.url} target="_blank" rel="noreferrer" className="underline inline-flex items-center gap-0.5">ver <ExternalLink className="h-3 w-3" /></a>}
                    {p.error && <span className="text-destructive">· {p.error}</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {notice && <p role="status" className="text-sm">{notice}</p>}
    </section>
  );
}
