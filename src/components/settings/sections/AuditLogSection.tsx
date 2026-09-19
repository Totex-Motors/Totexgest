import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LogIn, UserPlus, ArrowLeftRight, Trophy, Activity, Loader2, Search } from "lucide-react";

type Row = {
  id: string; tenant_id: string | null; actor_member_id: string | null;
  actor_name: string | null; action: string; entity_type: string | null;
  entity_id: string | null; summary: string | null; created_at: string;
};

const ACTIONS: Record<string, { label: string; icon: React.ElementType; cls: string }> = {
  login: { label: "Entrou no sistema", icon: LogIn, cls: "bg-sky-500/15 text-sky-600" },
  lead_created: { label: "Criou lead", icon: UserPlus, cls: "bg-emerald-500/15 text-emerald-600" },
  deal_stage_changed: { label: "Moveu lead", icon: ArrowLeftRight, cls: "bg-violet-500/15 text-violet-600" },
  deal_won: { label: "Marcou venda (Ganho)", icon: Trophy, cls: "bg-amber-500/15 text-amber-600" },
};

function initials(name?: string | null) {
  const n = (name || "?").trim();
  return n.split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() || "").join("") || "?";
}
function timeAgo(iso: string) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "agora";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  const d = Math.floor(s / 86400);
  if (d < 7) return `${d} d`;
  return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

export function AuditLogSection() {
  const [store, setStore] = useState("all");
  const [action, setAction] = useState("all");
  const [q, setQ] = useState("");

  const { data: tenants = [] } = useQuery({
    queryKey: ["audit-tenants"],
    queryFn: async () => {
      const { data } = await supabase.from("tenants").select("id, name").order("name");
      return (data || []) as { id: string; name: string }[];
    },
  });
  const tenantName = useMemo(() => Object.fromEntries(tenants.map((t) => [t.id, t.name])), [tenants]);

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["audit-log", store, action],
    queryFn: async () => {
      let query = supabase.from("audit_log").select("*").order("created_at", { ascending: false }).limit(300);
      if (store !== "all") query = query.eq("tenant_id", store);
      if (action !== "all") query = query.eq("action", action);
      const { data } = await query;
      return (data || []) as Row[];
    },
    refetchInterval: 30000,
  });

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) =>
      (r.actor_name || "").toLowerCase().includes(needle) ||
      (r.summary || "").toLowerCase().includes(needle));
  }, [rows, q]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Quem fez o quê, quando — em todas as lojas. Login, leads criados, negociações movidas e vendas marcadas.
        Atualiza sozinho a cada 30s.
      </p>

      {/* Filtros */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por pessoa ou item…" className="pl-9" />
        </div>
        <Select value={store} onValueChange={setStore}>
          <SelectTrigger className="w-full sm:w-[190px]"><SelectValue placeholder="Loja" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas as lojas</SelectItem>
            {tenants.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={action} onValueChange={setAction}>
          <SelectTrigger className="w-full sm:w-[190px]"><SelectValue placeholder="Ação" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas as ações</SelectItem>
            {Object.entries(ACTIONS).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Activity className="h-9 w-9 mx-auto mb-2 opacity-30" />
              <p className="text-sm">Nenhuma atividade registrada ainda.</p>
            </div>
          ) : (
            <ul className="divide-y divide-border/60">
              {filtered.map((r) => {
                const cfg = ACTIONS[r.action] || { label: r.action, icon: Activity, cls: "bg-muted text-foreground" };
                const Icon = cfg.icon;
                return (
                  <li key={r.id} className="flex items-center gap-3 px-4 py-3">
                    <div className={`h-9 w-9 rounded-full flex items-center justify-center shrink-0 ${cfg.cls}`}>
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm">
                        <span className="font-semibold">{r.actor_name || "—"}</span>{" "}
                        <span className="text-muted-foreground">{cfg.label.toLowerCase()}</span>
                        {r.summary && r.action !== "login" ? <span className="text-muted-foreground">: </span> : null}
                        {r.summary && r.action !== "login" ? <span>{r.summary}</span> : null}
                      </p>
                      <div className="flex items-center gap-2 mt-0.5">
                        {r.tenant_id && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-medium">
                            {tenantName[r.tenant_id] || "loja"}
                          </Badge>
                        )}
                        <span className="text-xs text-muted-foreground">{new Date(r.created_at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                      </div>
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0 tabular-nums">{timeAgo(r.created_at)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">Mostrando as {Math.min(filtered.length, 300)} atividades mais recentes.</p>
    </div>
  );
}
