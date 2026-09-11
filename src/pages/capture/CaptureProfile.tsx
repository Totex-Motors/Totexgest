import { LogOut, Trophy, Target, Sparkles, Store } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/contexts/AuthContext";
import { useCaptureHomeStats } from "@/hooks/useCaptureLeads";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

/** Nome da loja/franquia do membro logado (tenants.name). */
function useTenantName(tenantId: string | null) {
  return useQuery({
    queryKey: ["tenant-name", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data } = await supabase.from("tenants").select("name").eq("id", tenantId!).maybeSingle();
      return (data as { name?: string } | null)?.name ?? null;
    },
    staleTime: 5 * 60_000,
  });
}

/**
 * "Perfil" — meta semanal, pontos e evolução da promotora. Sem configurações
 * do tenant. Pontos/nível são placeholder até performance_goals (Fase 5).
 */
const META_SEMANAL_PLACEHOLDER = 40;

const ROLE_LABEL: Record<string, string> = {
  promotora: "Promotora de captação",
  admin: "Administrador",
  comercial: "Comercial",
  closer: "Closer",
  sdr: "SDR",
};

export default function CaptureProfile() {
  const { teamMember, signOut, tenantId } = useAuth();
  const stats = useCaptureHomeStats();
  const { data: tenantName } = useTenantName(tenantId);

  const initials = (teamMember?.name ?? "?").split(/\s+/).map((n) => n[0]).join("").slice(0, 2).toUpperCase();
  const semana = stats.data?.semana ?? 0;
  const quentes = stats.data?.quentes_semana ?? 0;
  // Pontuação simples e transparente: 10 por lead + 20 extra por quente
  const pontos = semana * 10 + quentes * 20;
  const pct = Math.min(100, Math.round((semana / META_SEMANAL_PLACEHOLDER) * 100));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Avatar className="h-14 w-14">
          <AvatarFallback className="bg-primary/10 text-primary text-lg font-semibold">{initials}</AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <h1 className="text-lg font-bold truncate">{teamMember?.name}</h1>
          <p className="text-xs text-muted-foreground">{ROLE_LABEL[teamMember?.role ?? ""] ?? teamMember?.role}</p>
          {tenantName && (
            <p className="text-xs text-muted-foreground flex items-center gap-1"><Store className="h-3 w-3" /> {tenantName}</p>
          )}
        </div>
      </div>

      <Card>
        <CardContent className="pt-4 pb-4">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-sm font-medium flex items-center gap-1.5"><Target className="h-4 w-4" /> Meta da semana</span>
            {stats.isLoading ? <Skeleton className="h-4 w-12" /> : <span className="text-xs tabular-nums">{semana}/{META_SEMANAL_PLACEHOLDER}</span>}
          </div>
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div className="h-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-3 gap-2">
        <Stat icon={Trophy} label="Pontos" value={pontos} loading={stats.isLoading} />
        <Stat icon={Sparkles} label="Quentes" value={quentes} loading={stats.isLoading} />
        <Stat icon={Target} label="No mês" value={stats.data?.mes ?? 0} loading={stats.isLoading} />
      </div>

      <Card className="bg-muted/40">
        <CardContent className="pt-4 pb-4 text-xs text-muted-foreground space-y-1">
          <p><strong className="text-foreground">Como ganho pontos?</strong></p>
          <p>10 pontos por cliente captado · +20 se ficar quente (prazo curto, aceita avaliação e autoriza contato).</p>
          <p>Qualidade vale mais que volume: lead com telefone errado ou sem autorização não pontua no ranking.</p>
        </CardContent>
      </Card>

      <Button variant="outline" className="w-full h-11" onClick={signOut}>
        <LogOut className="h-4 w-4 mr-2" /> Sair
      </Button>
    </div>
  );
}

function Stat({ icon: Icon, label, value, loading }: { icon: typeof Trophy; label: string; value: number; loading: boolean }) {
  return (
    <Card>
      <CardContent className="pt-3 pb-3 text-center">
        <Icon className="h-4 w-4 mx-auto text-muted-foreground mb-1" />
        {loading ? <Skeleton className="h-6 w-8 mx-auto" /> : <p className="text-xl font-bold tabular-nums">{value}</p>}
        <p className="text-[11px] text-muted-foreground">{label}</p>
      </CardContent>
    </Card>
  );
}
