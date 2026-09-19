import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Users, Loader2, ChevronRight, TrendingUp, Briefcase } from "lucide-react";

const brl = (n: number) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const initials = (name?: string) => (name || "?").trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() || "").join("") || "?";
const roleLabel: Record<string, string> = { admin: "Admin", comercial: "Comercial", closer: "Closer", sdr: "SDR", promotora: "Promotora", geral: "Vendedor" };

export default function SalesTeamView() {
  const navigate = useNavigate();

  const { data: members = [], isLoading } = useQuery({
    queryKey: ["team-view-members"],
    queryFn: async () => {
      const { data } = await supabase
        .from("team_members")
        .select("id, name, role, team, avatar_url, is_active")
        .eq("is_active", true)
        .order("name");
      return (data || []) as { id: string; name: string; role: string; team: string | null; avatar_url: string | null }[];
    },
  });

  const { data: deals = [] } = useQuery({
    queryKey: ["team-view-deals"],
    queryFn: async () => {
      const { data } = await supabase
        .from("deals")
        .select("id, sales_rep_id, negotiated_price, status")
        .not("sales_rep_id", "is", null)
        .not("status", "in", '("won","lost")');
      return (data || []) as { sales_rep_id: string; negotiated_price: number | null; status: string }[];
    },
  });

  const { data: commissions = [] } = useQuery({
    queryKey: ["team-view-commissions"],
    queryFn: async () => {
      const first = new Date();
      first.setDate(1); first.setHours(0, 0, 0, 0);
      const { data } = await supabase
        .from("commissions")
        .select("sales_rep_id, commission_amount, created_at")
        .gte("created_at", first.toISOString());
      return (data || []) as { sales_rep_id: string; commission_amount: number | null }[];
    },
  });

  const byRep = useMemo(() => {
    const m: Record<string, { count: number; value: number; commission: number }> = {};
    for (const d of deals) {
      const r = (m[d.sales_rep_id] ||= { count: 0, value: 0, commission: 0 });
      r.count++; r.value += Number(d.negotiated_price) || 0;
    }
    for (const c of commissions) {
      const r = (m[c.sales_rep_id] ||= { count: 0, value: 0, commission: 0 });
      r.commission += Number(c.commission_amount) || 0;
    }
    return m;
  }, [deals, commissions]);

  // Ordena por nº de negociações ativas (mais movimentado primeiro)
  const ordered = useMemo(
    () => [...members].sort((a, b) => (byRep[b.id]?.count || 0) - (byRep[a.id]?.count || 0)),
    [members, byRep]
  );

  return (
    <AppLayout>
      <div className="space-y-4 animate-fade-in">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-primary" />
          <h1 className="text-2xl font-bold text-foreground">Vendedores</h1>
        </div>
        <p className="text-sm text-muted-foreground -mt-2">
          Cada pessoa do time com os leads ativos e a comissão do mês. Clique para ver os leads dela no funil.
        </p>

        {isLoading ? (
          <div className="flex items-center justify-center py-20 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>
        ) : ordered.length === 0 ? (
          <Card><CardContent className="py-16 text-center text-muted-foreground">Nenhum vendedor ativo.</CardContent></Card>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {ordered.map((m) => {
              const s = byRep[m.id] || { count: 0, value: 0, commission: 0 };
              return (
                <button
                  key={m.id}
                  onClick={() => navigate(`/comercial/pipeline?rep=${m.id}`)}
                  className="text-left"
                >
                  <Card className="hover:shadow-md hover:border-primary/40 transition-all h-full">
                    <CardContent className="p-4">
                      <div className="flex items-center gap-3">
                        <Avatar className="h-11 w-11">
                          <AvatarImage src={m.avatar_url || undefined} />
                          <AvatarFallback className="bg-primary/10 text-primary font-semibold">{initials(m.name)}</AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold truncate">{m.name}</p>
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 mt-0.5">{roleLabel[m.role] || m.role}</Badge>
                        </div>
                        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                      </div>
                      <div className="grid grid-cols-2 gap-2 mt-4">
                        <div className="rounded-lg bg-muted/50 p-2.5">
                          <p className="text-[11px] text-muted-foreground flex items-center gap-1"><Briefcase className="h-3 w-3" /> Leads ativos</p>
                          <p className="text-lg font-bold leading-tight">{s.count}</p>
                          <p className="text-[11px] text-muted-foreground">{brl(s.value)} em aberto</p>
                        </div>
                        <div className="rounded-lg bg-emerald-500/10 p-2.5">
                          <p className="text-[11px] text-emerald-700 dark:text-emerald-400 flex items-center gap-1"><TrendingUp className="h-3 w-3" /> Comissão do mês</p>
                          <p className="text-lg font-bold leading-tight text-emerald-600">{brl(s.commission)}</p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
