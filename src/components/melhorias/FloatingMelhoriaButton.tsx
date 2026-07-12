/**
 * FloatingMelhoriaButton — botão flutuante "Reportar melhoria".
 *
 * Fica ancorado na borda direita da tela (meio), em TODAS as páginas do CRM
 * (montado no AppLayout). Badge mostra quantos reports estão na coluna NOVO.
 * Clique abre o MelhoriaReportSheet.
 */

import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Lightbulb } from 'lucide-react';
import { useMelhoriasNovasCount } from '@/hooks/useMelhorias';
import { MelhoriaReportSheet } from './MelhoriaReportSheet';

export function FloatingMelhoriaButton() {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const { data: novas = 0 } = useMelhoriasNovasCount();

  // No próprio kanban o botão não precisa aparecer (a página tem CTA próprio)
  if (pathname.startsWith('/gestao/melhorias')) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Reportar melhoria"
        className="fixed right-0 top-1/2 z-40 -translate-y-1/2 rounded-l-full border border-r-0 border-primary/30 bg-primary py-2.5 pl-2.5 pr-1.5 text-white shadow-lg transition-all hover:pr-3 focus:outline-none"
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
