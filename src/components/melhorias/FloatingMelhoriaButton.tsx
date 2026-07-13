/**
 * FloatingMelhoriaButton — botão flutuante "Reportar melhoria".
 *
 * Ancorado na borda direita em TODAS as páginas do CRM (montado no AppLayout),
 * e MÓVEL: arrasta verticalmente pra onde quiser (pra não sobrepor uma call,
 * um painel etc). A posição fica salva no navegador. Badge mostra quantos
 * reports estão na coluna NOVO. Clique abre o MelhoriaReportSheet.
 *
 * Atalho Alt+M: captura a tela ANTES de abrir o painel — é o único jeito de
 * printar com dropdown/menu aberto (qualquer clique, inclusive no botão,
 * fecharia o menu; teclado não fecha).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Lightbulb } from 'lucide-react';
import { toast } from 'sonner';
import { useMelhoriasNovasCount, captureScreenPrint } from '@/hooks/useMelhorias';
import { MelhoriaReportSheet, type InitialShot } from './MelhoriaReportSheet';

const POSITION_KEY = 'melhoria-btn-top-pct';
const DRAG_THRESHOLD_PX = 6; // abaixo disso é clique, não arrasto

function loadTopPct(): number {
  const saved = Number(localStorage.getItem(POSITION_KEY));
  return Number.isFinite(saved) && saved >= 8 && saved <= 92 ? saved : 50;
}

export function FloatingMelhoriaButton() {
  const [open, setOpen] = useState(false);
  const [topPct, setTopPct] = useState<number>(loadTopPct);
  // Print capturado ANTES do painel abrir (fluxo Alt+M) — entra direto no anotador
  const [initialShot, setInitialShot] = useState<InitialShot | null>(null);
  const capturingRef = useRef(false);
  const dragState = useRef<{ startY: number; startPct: number; moved: boolean } | null>(null);
  const { pathname } = useLocation();
  const { data: novas = 0 } = useMelhoriasNovasCount();

  // Alt+M: captura primeiro (dropdown continua aberto — nada foi clicado na
  // página; o seletor de captura é UI do browser), depois abre o painel com
  // o print já no anotador. keydown é gesto de usuário → getDisplayMedia ok.
  useEffect(() => {
    const onKeyDown = async (e: KeyboardEvent) => {
      if (!e.altKey || e.key.toLowerCase() !== 'm' || e.ctrlKey || e.metaKey) return;
      if (open || capturingRef.current) return;
      e.preventDefault();
      capturingRef.current = true;
      try {
        const shot = await captureScreenPrint();
        setInitialShot(shot); // null = usuário cancelou o seletor → painel abre sem print
        document.body.style.pointerEvents = '';
        setOpen(true);
      } catch (err) {
        toast.error(`Captura falhou: ${(err as Error).message}`);
      } finally {
        capturingRef.current = false;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

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
      // Foi um clique. Se havia um dropdown/select Radix aberto, ele está
      // fechando NESTE mesmo clique — abrir o Sheet (modal) no mesmo tick
      // disputa o lock de pointer-events do body e a página fica travada.
      // Espera o layer fechar e garante o body destravado antes de abrir.
      setTimeout(() => {
        document.body.style.pointerEvents = '';
        setOpen(true);
      }, 150);
    }
  }, []);

  const handleOpenChange = useCallback((v: boolean) => {
    setOpen(v);
    if (!v) {
      setInitialShot(null);
      // Safety: se o cleanup do Radix perder a corrida (dropdown + sheet
      // modais fechando em sequência), o body ficaria pointer-events:none
      // pra sempre — página inteira morta. Destrava após a animação.
      setTimeout(() => {
        document.body.style.pointerEvents = '';
      }, 350);
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
        title="Reportar melhoria (arrasta pra mover) · Alt+M captura a tela com menus abertos"
        style={{ top: `${topPct}%` }}
        // pointer-events-auto: dropdowns/selects Radix abertos colocam
        // pointer-events:none no body — sem isso o 1º clique no botão só
        // fechava o menu e era preciso clicar de novo.
        className="pointer-events-auto fixed right-0 z-40 -translate-y-1/2 cursor-grab touch-none rounded-l-full border border-r-0 border-primary/30 bg-primary py-2.5 pl-2.5 pr-1.5 text-white shadow-lg transition-[padding] hover:pr-3 focus:outline-none active:cursor-grabbing"
      >
        <Lightbulb className="h-4 w-4" />
        {novas > 0 && (
          <span className="absolute -left-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[9px] font-bold text-white shadow">
            {novas > 99 ? '99+' : novas}
          </span>
        )}
      </button>

      <MelhoriaReportSheet open={open} onOpenChange={handleOpenChange} initialShot={initialShot} />
    </>
  );
}
