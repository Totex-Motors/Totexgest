import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import { Clapperboard, Loader2, Mic, Share2, Download, ExternalLink } from "lucide-react";

/**
 * Vídeo do carro (9:16, ~18 s) gerado NO NAVEGADOR a partir das fotos da página:
 * efeito Ken Burns foto a foto + textos (título, preço, parcela, CTA) + narração opcional
 * na voz do agente (edge vehicle-page › narracao). Grava com MediaRecorder (MP4 quando o
 * Chrome suporta, senão WebM), sobe pro bucket público `vehicle-media` e registra na página.
 * Depois publica no TikTok / YouTube / Facebook pela Zernio (zernio-publish › publish_media).
 */
export interface VideoDados { headline?: string; subheadline?: string; pontos?: string[]; cta?: string; seo?: { title?: string; description?: string }; ano?: number | null; km?: number | null; preco?: number | null; parcela?: { prazo: number; valor: number } | null; fipe_dif?: number | null; loja?: string | null }
export interface VideoPage { id: string; titulo: string; fotos: string[]; url: string; video_dados: VideoDados | null; videos: { url: string; mime: string; criado_em: string; narracao: boolean }[] }
type Account = { id: string; platform: string; username: string; active: boolean; aceita_imagem: boolean };

const W = 1080, H = 1920, FPS = 30;
const brl = (n: number) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });

async function call<T = any>(fn: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) { let m = "Falha no servidor."; try { const d = await error.context?.json(); if (d?.error) m = d.error; } catch { /* offline */ } throw new Error(m); }
  if (data?.error) throw new Error(data.error);
  return data as T;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => { const i = new Image(); i.crossOrigin = "anonymous"; i.onload = () => res(i); i.onerror = () => rej(new Error("foto não carregou")); i.src = url; });
}

/** desenha a foto cobrindo o quadro com zoom/pan (Ken Burns) */
function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, t: number, dir: number) {
  const scale = 1.08 + 0.12 * t;
  const r = Math.max(W / img.width, H / img.height) * scale;
  const dw = img.width * r, dh = img.height * r;
  const dx = (W - dw) / 2 + dir * (dw - W) * 0.25 * (t - 0.5);
  const dy = (H - dh) / 2 + (dh - H) * 0.2 * (0.5 - t);
  ctx.drawImage(img, dx, dy, dw, dh);
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(/\s+/); const lines: string[] = []; let cur = "";
  for (const w of words) { const test = cur ? `${cur} ${w}` : w; if (ctx.measureText(test).width > maxW && cur) { lines.push(cur); cur = w; } else cur = test; }
  if (cur) lines.push(cur); return lines;
}

function pickMime(): string {
  const cands = ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  return cands.find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) || "";
}

export function VehicleVideoDialog({ page, tenantId, open, onOpenChange, onSaved }: { page: VideoPage; tenantId?: string; open: boolean; onOpenChange: (v: boolean) => void; onSaved?: () => void }) {
  const { teamMember } = useAuth();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [narrar, setNarrar] = useState(true);
  const [narracaoUrl, setNarracaoUrl] = useState<string | null>(null);
  const [narracaoTexto, setNarracaoTexto] = useState("");
  const [gerandoNarracao, setGerandoNarracao] = useState(false);
  const [gravando, setGravando] = useState(false);
  const [progresso, setProgresso] = useState(0);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(page.videos?.[0]?.url || null);
  const [selected, setSelected] = useState<string[]>([]);
  const [caption, setCaption] = useState("");
  const [publicando, setPublicando] = useState(false);
  const tenantArg = tenantId ? { tenant_id: tenantId } : {};
  const d = page.video_dados || {};

  useEffect(() => {
    const partes = [d.headline || page.titulo, d.subheadline || "", d.parcela ? `${d.parcela.prazo}x de ${brl(d.parcela.valor)}` : "", d.cta || "Chama no WhatsApp!", "", `#${(d.loja || "totexmotors").replace(/\s+/g, "").toLowerCase()} #carros #seminovos #${page.titulo.split(" ")[0].toLowerCase()}`];
    setCaption(partes.filter((x) => x !== undefined).join("\n").trim());
  }, [page.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const contas = useQuery({ queryKey: ["zernio-accounts", tenantId || "loja", "video"], enabled: open, retry: false, queryFn: () => call<{ configured: boolean; accounts?: Account[] }>("zernio-publish", { action: "accounts", vehicle_page_id: page.id, ...tenantArg }) });
  const redes = (contas.data?.accounts || []).filter((a) => a.active);

  async function gerarNarracao() {
    setGerandoNarracao(true);
    try {
      const r = await call<{ url: string; texto: string }>("vehicle-page", { action: "narracao", id: page.id, ...tenantArg });
      setNarracaoUrl(r.url); setNarracaoTexto(r.texto);
      toast.success("Narração pronta");
    } catch (e) { toast.error("Narração", { description: (e as Error).message }); setNarrar(false); }
    finally { setGerandoNarracao(false); }
  }

  async function gravar() {
    const canvas = canvasRef.current; if (!canvas) return;
    const mime = pickMime();
    if (!mime) { toast.error("Este navegador não grava vídeo. Use o Chrome no computador."); return; }
    setGravando(true); setProgresso(0); setBlob(null); setBlobUrl(null);
    try {
      const fotos = page.fotos.slice(0, 6);
      if (!fotos.length) throw new Error("A página não tem fotos.");
      const imgs = await Promise.all(fotos.map(loadImage));
      const ctx = canvas.getContext("2d")!;

      // áudio: narração (se tiver) misturada numa trilha do MediaRecorder
      let audioCtx: AudioContext | null = null; let dest: MediaStreamAudioDestinationNode | null = null; let narrDur = 0; let src: AudioBufferSourceNode | null = null;
      if (narrar && narracaoUrl) {
        audioCtx = new AudioContext(); dest = audioCtx.createMediaStreamDestination();
        const buf = await audioCtx.decodeAudioData(await (await fetch(narracaoUrl)).arrayBuffer());
        narrDur = buf.duration; src = audioCtx.createBufferSource(); src.buffer = buf; src.connect(dest);
      }
      const dur = Math.min(45, Math.max(16, narrDur ? narrDur + 1.5 : 18));
      const porFoto = dur / imgs.length;

      const stream = canvas.captureStream(FPS);
      if (dest) dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      const done = new Promise<void>((res) => { rec.onstop = () => res(); });
      rec.start(500);
      if (src) src.start();

      const t0 = performance.now();
      const titulo = d.headline || page.titulo;
      const pontos = (d.pontos || []).slice(0, 3);
      await new Promise<void>((resolve) => {
        const frame = () => {
          const t = (performance.now() - t0) / 1000;
          if (t >= dur) return resolve();
          const idx = Math.min(imgs.length - 1, Math.floor(t / porFoto));
          const local = (t - idx * porFoto) / porFoto;
          ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
          drawCover(ctx, imgs[idx], local, idx % 2 ? 1 : -1);
          // transição suave entre fotos
          if (local > 0.85 && idx < imgs.length - 1) { ctx.globalAlpha = (local - 0.85) / 0.15; drawCover(ctx, imgs[idx + 1], 0, (idx + 1) % 2 ? 1 : -1); ctx.globalAlpha = 1; }
          // véu escuro em cima e embaixo
          const g1 = ctx.createLinearGradient(0, 0, 0, 520); g1.addColorStop(0, "rgba(0,0,0,.75)"); g1.addColorStop(1, "rgba(0,0,0,0)"); ctx.fillStyle = g1; ctx.fillRect(0, 0, W, 520);
          const g2 = ctx.createLinearGradient(0, H - 760, 0, H); g2.addColorStop(0, "rgba(0,0,0,0)"); g2.addColorStop(1, "rgba(0,0,0,.85)"); ctx.fillStyle = g2; ctx.fillRect(0, H - 760, W, 760);
          // loja
          ctx.fillStyle = "#fff"; ctx.font = "600 34px system-ui, sans-serif"; ctx.textBaseline = "top";
          ctx.fillText((d.loja || "Totex Motors").toUpperCase(), 64, 90);
          // título (aparece nos 2 primeiros segundos com fade)
          ctx.globalAlpha = Math.min(1, t / 0.8);
          ctx.font = "800 62px system-ui, sans-serif";
          let y = 150; for (const ln of wrap(ctx, titulo, W - 128).slice(0, 3)) { ctx.fillText(ln, 64, y); y += 72; }
          ctx.globalAlpha = 1;
          // chips ano/km
          const chips = [d.ano && String(d.ano), d.km != null && `${d.km.toLocaleString("pt-BR")} km`].filter(Boolean) as string[];
          let cx = 64; ctx.font = "600 34px system-ui, sans-serif";
          for (const c of chips) { const w = ctx.measureText(c).width + 44; ctx.fillStyle = "rgba(255,255,255,.18)"; ctx.beginPath(); ctx.roundRect(cx, y + 10, w, 60, 30); ctx.fill(); ctx.fillStyle = "#fff"; ctx.fillText(c, cx + 22, y + 22); cx += w + 14; }
          // ponto forte rotativo (um por foto)
          const pf = pontos.length ? pontos[idx % pontos.length] : null;
          if (pf) { ctx.fillStyle = "#14b8a6"; ctx.font = "700 44px system-ui, sans-serif"; ctx.fillText("✓ " + pf, 64, H - 640); }
          // preço + parcela
          if (d.preco) { ctx.fillStyle = "#fff"; ctx.font = "500 38px system-ui, sans-serif"; ctx.fillText("Preço", 64, H - 540); ctx.font = "900 96px system-ui, sans-serif"; ctx.fillText(brl(d.preco), 64, H - 500); }
          if (d.parcela) { ctx.fillStyle = "#5eead4"; ctx.font = "700 48px system-ui, sans-serif"; ctx.fillText(`${d.parcela.prazo}x de ${brl(d.parcela.valor)}`, 64, H - 380); ctx.fillStyle = "rgba(255,255,255,.75)"; ctx.font = "400 30px system-ui, sans-serif"; ctx.fillText("estimativa do simulador · entrada e condição com a loja", 64, H - 320); }
          if (d.fipe_dif != null && d.fipe_dif <= 0) { ctx.fillStyle = "#86efac"; ctx.font = "700 40px system-ui, sans-serif"; ctx.fillText(`${Math.abs(d.fipe_dif).toFixed(0)}% abaixo da FIPE`, 64, H - 260); }
          // CTA (últimos 5 s pulsando)
          const cta = d.cta || "Chama no WhatsApp";
          const pulse = t > dur - 6 ? 1 + 0.03 * Math.sin(t * 6) : 1;
          ctx.save(); ctx.translate(W / 2, H - 150); ctx.scale(pulse, pulse);
          ctx.fillStyle = "#25d366"; ctx.beginPath(); ctx.roundRect(-440, -56, 880, 112, 56); ctx.fill();
          ctx.fillStyle = "#fff"; ctx.font = "800 44px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(cta.slice(0, 40), 0, 0); ctx.restore(); ctx.textAlign = "left"; ctx.textBaseline = "top";
          setProgresso(Math.round((t / dur) * 100));
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
      rec.stop(); await done;
      try { src?.stop(); await audioCtx?.close(); } catch { /* ok */ }
      const b = new Blob(chunks, { type: mime.split(";")[0] });
      setBlob(b); setBlobUrl(URL.createObjectURL(b));
      toast.success(`Vídeo pronto (${Math.round(dur)} s, ${(b.size / 1e6).toFixed(1)} MB)`);
    } catch (e) { toast.error("Não gravou", { description: (e as Error).message }); }
    finally { setGravando(false); setProgresso(0); }
  }

  async function salvar() {
    if (!blob) return;
    setSalvando(true);
    try {
      const ext = blob.type.includes("mp4") ? "mp4" : "webm";
      const tid = tenantId || teamMember?.tenant_id;
      if (!tid) throw new Error("Loja não identificada.");
      const path = `${tid}/${page.id}/video_${Date.now()}.${ext}`;
      const { error } = await supabase.storage.from("vehicle-media").upload(path, blob, { contentType: blob.type, upsert: true });
      if (error) throw new Error(error.message);
      const { data } = supabase.storage.from("vehicle-media").getPublicUrl(path);
      await call("vehicle-page", { action: "video_saved", id: page.id, url: data.publicUrl, formato: "9:16", narracao: narrar && !!narracaoUrl, mime: blob.type, ...tenantArg });
      setVideoUrl(data.publicUrl);
      toast.success("Vídeo salvo. Agora dá pra publicar nas redes.");
      onSaved?.();
    } catch (e) { toast.error("Não salvou", { description: (e as Error).message }); }
    finally { setSalvando(false); }
  }

  async function publicar() {
    if (!videoUrl || selected.length === 0) return;
    setPublicando(true);
    try {
      await call("zernio-publish", { action: "publish_media", media_url: videoUrl, media_type: "video", caption, titulo: (d.seo?.title || page.titulo).slice(0, 100), accountIds: selected, vehicle_page_id: page.id, ...tenantArg });
      toast.success("Enviado pra Zernio. Acompanhe em Marketing › Instagram › Outras redes ou aqui depois.");
      setSelected([]);
    } catch (e) { toast.error("Não publicou", { description: (e as Error).message }); }
    finally { setPublicando(false); }
  }

  const isMp4 = (u: string | null) => !!u && /\.mp4(\?|$)/i.test(u);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Clapperboard className="h-5 w-5 text-primary" /> Vídeo do carro — {page.titulo}</DialogTitle>
          <DialogDescription>Vídeo vertical (9:16) feito das fotos da página, com preço, parcela e narração na voz do agente. Gravado aqui no seu navegador (use o Chrome no computador).</DialogDescription>
        </DialogHeader>

        <div className="grid md:grid-cols-[300px_1fr] gap-5">
          <div className="space-y-2">
            <div className="rounded-xl overflow-hidden bg-black aspect-[9/16] relative">
              <canvas ref={canvasRef} width={W} height={H} className={`w-full h-full ${blobUrl ? "hidden" : ""}`} />
              {blobUrl && <video src={blobUrl} controls className="w-full h-full" />}
              {!gravando && !blobUrl && page.fotos[0] && <img src={page.fotos[0]} alt="" className="absolute inset-0 w-full h-full object-cover opacity-60" />}
              {gravando && <div className="absolute bottom-2 left-2 right-2 h-2 bg-white/20 rounded"><div className="h-2 bg-emerald-400 rounded" style={{ width: `${progresso}%` }} /></div>}
            </div>
            {blobUrl && <Button variant="outline" size="sm" asChild className="w-full"><a href={blobUrl} download={`video-${page.id.slice(0, 8)}.${blob?.type.includes("mp4") ? "mp4" : "webm"}`}><Download className="h-4 w-4 mr-1" /> Baixar</a></Button>}
          </div>

          <div className="space-y-4">
            <div className="rounded-lg border p-3 space-y-2">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-2"><Mic className="h-4 w-4" /> Narração na voz do agente</Label>
                <Switch checked={narrar} onCheckedChange={setNarrar} />
              </div>
              {narrar && (
                <div className="space-y-2">
                  <Button size="sm" variant="outline" onClick={gerarNarracao} disabled={gerandoNarracao}>{gerandoNarracao ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Mic className="h-4 w-4 mr-1" />} {narracaoUrl ? "Gerar de novo" : "Gerar narração"}</Button>
                  {narracaoUrl && <audio src={narracaoUrl} controls className="w-full h-8" />}
                  {narracaoTexto && <p className="text-xs text-muted-foreground">{narracaoTexto}</p>}
                </div>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button onClick={gravar} disabled={gravando || (narrar && !narracaoUrl)}>{gravando ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Clapperboard className="h-4 w-4 mr-1" />} {gravando ? `Gravando… ${progresso}%` : blobUrl ? "Gravar de novo" : "Gravar vídeo"}</Button>
              {blob && <Button variant="secondary" onClick={salvar} disabled={salvando}>{salvando ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null} Salvar na página</Button>}
              {narrar && !narracaoUrl && <span className="text-xs text-muted-foreground self-center">Gere a narração primeiro (ou desligue).</span>}
            </div>

            {videoUrl && (
              <div className="rounded-lg border p-3 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium flex items-center gap-2"><Share2 className="h-4 w-4" /> Publicar nas redes (Zernio)</p>
                  <a className="text-xs underline inline-flex items-center gap-1" href={videoUrl} target="_blank" rel="noreferrer">ver vídeo salvo <ExternalLink className="h-3 w-3" /></a>
                </div>
                {contas.isLoading && <p className="text-xs text-muted-foreground">Carregando redes…</p>}
                {contas.data && !contas.data.configured && <p className="text-xs text-muted-foreground">Cadastre a chave da Zernio em Configurações › Integrações › Redes sociais.</p>}
                {contas.data?.configured && redes.length === 0 && <p className="text-xs text-muted-foreground">Nenhuma rede conectada. Conecte em Marketing › Instagram › Outras redes.</p>}
                {redes.map((a) => {
                  const fbSemMp4 = a.platform === "facebook" && !isMp4(videoUrl);
                  return (
                    <label key={a.id} className={`flex items-center gap-2 text-sm ${fbSemMp4 ? "opacity-60" : ""}`}>
                      <Checkbox checked={selected.includes(a.id)} disabled={fbSemMp4} onCheckedChange={(v) => setSelected((s) => (v ? [...s, a.id] : s.filter((x) => x !== a.id)))} />
                      <span className="capitalize">{a.platform}</span> · {a.username}
                      {fbSemMp4 && <span className="text-xs text-muted-foreground">(Facebook só aceita MP4; este navegador gravou WebM)</span>}
                    </label>
                  );
                })}
                <div>
                  <Label className="text-xs">Legenda</Label>
                  <Textarea rows={5} value={caption} onChange={(e) => setCaption(e.target.value)} className="text-sm" />
                </div>
                <Button onClick={publicar} disabled={publicando || selected.length === 0}>{publicando ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Share2 className="h-4 w-4 mr-1" />} Publicar</Button>
              </div>
            )}

            {page.videos?.length > 0 && !videoUrl && <p className="text-xs text-muted-foreground">Esta página já tem {page.videos.length} vídeo(s) salvo(s).</p>}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
