import { NavLink, Outlet, useLocation } from "react-router-dom";
import { Home, PlusCircle, Users, Car, Gift, GraduationCap, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";

/**
 * Layout do workspace de CAPTAÇÃO (promotoras) — ferramenta de campo, não
 * software administrativo. Mobile-first: coluna única, bottom-nav com 5 itens,
 * botão "Captar" em destaque no centro. No desktop a mesma coluna fica
 * centralizada (máx. 520px) — sem a sidebar completa do CRM.
 *
 * Folgista (team_members.capture_profile): sem incentivos financeiros — o 5º
 * item vira "Treino" em vez de "Prêmios".
 */

const NAV_BASE = [
  { to: "/captacao", label: "Hoje", icon: Home, end: true },
  { to: "/captacao/leads", label: "Meus Leads", icon: Users },
  { to: "/captacao/novo", label: "Captar", icon: PlusCircle, primary: true },
  { to: "/captacao/carros", label: "Intermediações", icon: Car },
] as const;

const NAV_PRIZES = { to: "/captacao/premios", label: "Prêmios", icon: Gift } as const;
const NAV_TRAINING = { to: "/captacao/premios?tab=treino", label: "Treino", icon: GraduationCap } as const;

export function CaptureLayout() {
  const { isPromotora, isFolgista } = useAuth();
  const location = useLocation();
  const onNewLead = location.pathname.startsWith("/captacao/novo");
  const NAV = [...NAV_BASE, isFolgista ? NAV_TRAINING : NAV_PRIZES] as const;

  return (
    <div className="min-h-[100dvh] bg-muted/40 flex flex-col">
      <div className="mx-auto w-full max-w-[520px] flex-1 flex flex-col bg-background sm:border-x sm:border-border/60 sm:shadow-sm">
        {/* Topo compacto — logo + nome do modo. Gestor/admin ganha link de volta pro CRM. */}
        <header className="h-12 px-4 flex items-center justify-between border-b border-border/60 bg-card sticky top-0 z-20">
          <div className="flex items-center gap-2 min-w-0">
            <img src="/logo_totex1.png" alt="Totex" className="h-7 w-auto object-contain" />
            <span className="text-sm font-semibold tracking-tight truncate">Captação</span>
          </div>
          {!isPromotora && (
            <NavLink
              to="/comercial"
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> CRM
            </NavLink>
          )}
        </header>

        {/* Conteúdo — padding inferior reserva espaço pro bottom-nav */}
        <main className={cn("flex-1 overflow-y-auto px-4 pt-4", onNewLead ? "pb-28" : "pb-24")}>
          <Outlet />
        </main>

        {/* Bottom-nav fixo */}
        <nav
          aria-label="Navegação da captação"
          className="fixed bottom-0 inset-x-0 z-30 border-t border-border/60 bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80"
        >
          <ul className="mx-auto max-w-[520px] grid grid-cols-5 items-end h-16 pb-[env(safe-area-inset-bottom)]">
            {NAV.map((item) => {
              const Icon = item.icon;
              const primary = "primary" in item && item.primary;
              return (
                <li key={item.to} className="flex justify-center">
                  <NavLink
                    to={item.to}
                    end={"end" in item ? item.end : false}
                    className={({ isActive }) =>
                      cn(
                        "flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors w-full py-2",
                        primary
                          ? "text-emerald-700 dark:text-emerald-400"
                          : isActive
                            ? "text-primary"
                            : "text-muted-foreground hover:text-foreground",
                      )
                    }
                  >
                    {({ isActive }) =>
                      primary ? (
                        <>
                          <span
                            className={cn(
                              "-mt-6 h-14 w-14 rounded-full flex items-center justify-center shadow-lg ring-4 ring-background",
                              "bg-emerald-600 text-white",
                              isActive && "bg-emerald-700",
                            )}
                          >
                            <Icon className="h-7 w-7" />
                          </span>
                          <span>{item.label}</span>
                        </>
                      ) : (
                        <>
                          <Icon className={cn("h-5 w-5", isActive && "stroke-[2.5]")} />
                          <span>{item.label}</span>
                        </>
                      )
                    }
                  </NavLink>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
    </div>
  );
}

export default CaptureLayout;
