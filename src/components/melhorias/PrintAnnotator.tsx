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
    if (!ready || textInput) return;
    const { x, y } = toImageCoords(e);
    if (tool === 'text') {
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
    setSaving(true);
    try {
      redraw(); // garante estado final desenhado
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
      if (blob) onConfirm(blob, canvas.width, canvas.height);
    } finally {
      setSaving(false);
    }
  };

  // Posição do input de texto em % (acompanha o scale CSS do canvas)
  const textInputStyle = (() => {
    const canvas = canvasRef.current;
    if (!textInput || !canvas) return undefined;
    return {
      left: `${(textInput.x / canvas.width) * 100}%`,
      top: `${(textInput.y / canvas.height) * 100}%`,
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
                onBlur={commitText}
                placeholder="Digite e Enter…"
                style={textInputStyle}
                className="absolute z-10 -translate-y-full rounded border-2 bg-white px-2 py-1 text-sm font-bold shadow-lg outline-none dark:bg-zinc-900"
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
