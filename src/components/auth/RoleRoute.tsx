import { Navigate, useLocation } from "react-router-dom";
import { useAuth, type TeamMember } from "@/contexts/AuthContext";

type Role = TeamMember["role"];

interface RoleRouteProps {
  children: React.ReactNode;
  /** Papéis que podem entrar. Vazio/undefined = qualquer membro logado. */
  allow?: Role[];
  /** Papéis explicitamente barrados (avaliado antes de `allow`). */
  deny?: Role[];
  /** Pra onde mandar quem não pode entrar. Default: home do papel. */
  redirectTo?: string;
}

/** Home de cada papel — pra onde ele cai quando bate numa URL proibida. */
function homeForRole(role?: Role | null): string {
  if (role === "promotora") return "/captacao";
  return "/comercial";
}

/**
 * Guarda de rota por PAPEL (team_members.role). Complementa o ProtectedRoute
 * (que só checa sessão): esconder item da sidebar não basta — a promotora
 * digitando /comercial/leads na URL precisa ser barrada aqui (e no banco via RLS).
 *
 * Enquanto o teamMember ainda não carregou, não decide (evita flash de redirect).
 */
export function RoleRoute({ children, allow, deny, redirectTo }: RoleRouteProps) {
  const { teamMember, loading, isSuperAdmin } = useAuth();
  const location = useLocation();

  if (loading || (!teamMember && !isSuperAdmin)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  const role = teamMember?.role;
  const denied = !!role && !!deny?.length && deny.includes(role);
  const notAllowed = !!allow?.length && (!role || !allow.includes(role)) && !isSuperAdmin;

  if (denied || notAllowed) {
    const target = redirectTo ?? homeForRole(role);
    // Evita loop se a home do papel também for proibida
    if (target === location.pathname) return <>{children}</>;
    return <Navigate to={target} replace />;
  }

  return <>{children}</>;
}
