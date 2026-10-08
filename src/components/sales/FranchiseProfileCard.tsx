import { Store, MapPin, Wallet, Megaphone, Clock, Building2, StickyNote } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

/**
 * Perfil do FRANQUEADO (lead_kind='franchise') no detalhe do lead.
 * Só leitura: junta o que as portas gravam (receive-lead campanha de franquia,
 * marketplace LOJISTA, cadastro manual em /comercial/franqueados).
 */
export interface FranchiseProfileLead {
  city_name?: string | null;
  state?: string | null;
  capital_disponivel?: string | null;
  pode_completar_capital?: boolean | string | null;
  timing_negocio?: string | null;
  regiao_interesse?: string | null;
  business_type?: string | null;
  revenue_range?: string | null;
  company_name?: string | null;
  job_title?: string | null;
  melhor_horario_contato?: string | null;
  franchise_member_name?: string | null;
  metadata?: Record<string, unknown> | null;
}

function Row({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-2 text-sm">
      <Icon className="h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0" />
      <span className="text-muted-foreground w-28 shrink-0">{label}</span>
      <span className="font-medium break-words">{value}</span>
    </div>
  );
}

export function FranchiseProfileCard({ lead }: { lead: FranchiseProfileLead }) {
  const md = (lead.metadata || {}) as Record<string, unknown>;
  const str = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));
  const cidade = [lead.city_name || str(md.cidade), lead.state || str(md.uf)].filter(Boolean).join(" / ");
  const capital = lead.capital_disponivel || str(md.capital_disponivel);
  const completa = lead.pode_completar_capital;
  const completaTxt = completa === true || completa === "sim" ? "Pode completar o capital" : completa === false || completa === "nao" || completa === "não" ? "Não completa o capital" : null;
  const campanha = str(md.franchise_campaign_name);
  const obs = str(md.observacoes);

  return (
    <Card className="border-violet-200/70 dark:border-violet-900/60">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Store className="h-4 w-4 text-violet-600" />
          Perfil do franqueado
          <Badge variant="outline" className="ml-auto text-[10px] bg-violet-100 text-violet-800 border-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:border-violet-900">
            Recrutamento
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5">
        <Row icon={MapPin} label="Cidade" value={cidade || null} />
        <Row icon={Building2} label="Empresa" value={[lead.company_name, lead.job_title].filter(Boolean).join(" — ") || null} />
        <Row icon={Building2} label="Tipo de negócio" value={lead.business_type} />
        <Row icon={Wallet} label="Capital" value={[capital, completaTxt].filter(Boolean).join(" · ") || null} />
        <Row icon={Wallet} label="Faturamento" value={lead.revenue_range} />
        <Row icon={Clock} label="Quando" value={lead.timing_negocio} />
        <Row icon={MapPin} label="Região" value={lead.regiao_interesse} />
        <Row icon={Clock} label="Melhor horário" value={lead.melhor_horario_contato} />
        <Row icon={Megaphone} label="Campanha" value={campanha} />
        <Row icon={Megaphone} label="Franqueado resp." value={lead.franchise_member_name} />
        <Row icon={StickyNote} label="Observações" value={obs} />
        {!cidade && !capital && !lead.business_type && !campanha && !obs && (
          <p className="text-xs text-muted-foreground">Sem dados de perfil ainda — preencha na conversa.</p>
        )}
      </CardContent>
    </Card>
  );
}
