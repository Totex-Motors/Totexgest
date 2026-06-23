import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Plus, Search, Workflow, MoreVertical, Pencil, Trash2, Zap, Users, Target,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  useEmailAutomations,
  useDeleteEmailAutomation,
  useToggleEmailAutomation,
  type EmailAutomation,
  type TriggerEvent,
} from '@/hooks/useEmailAutomations';
import { cn } from '@/lib/utils';
import MarketingPageHeader from '@/components/marketing/MarketingPageHeader';

const TRIGGER_META: Record<string, { label: string; icon: any; color: string }> = {
  lead_created:         { label: 'Lead criado',           icon: Users,    color: 'text-blue-500 bg-blue-500/10' },
  lead_stage_changed:   { label: 'Lead mudou de etapa',   icon: Target,   color: 'text-cyan-500 bg-cyan-500/10' },
  deal_created:         { label: 'Deal criado',           icon: Target,   color: 'text-blue-500 bg-blue-500/10' },
  deal_won:             { label: 'Deal fechado (ganho)',  icon: Target,   color: 'text-emerald-500 bg-emerald-500/10' },
  deal_lost:            { label: 'Deal perdido',          icon: Target,   color: 'text-red-500 bg-red-500/10' },
  organization_created: { label: 'Cliente novo',          icon: Users,    color: 'text-amber-500 bg-amber-500/10' },
  custom:               { label: 'Customizado',           icon: Zap,      color: 'text-purple-500 bg-purple-500/10' },
};

const FALLBACK_META = { label: 'Desconhecido', icon: Zap, color: 'text-gray-500 bg-gray-500/10' };

export default function MarketingAutomations() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');

  const { data: automations = [], isLoading } = useEmailAutomations();
  const deleteAutomation = useDeleteEmailAutomation();
  const toggleAutomation = useToggleEmailAutomation();

  const filtered = automations.filter((a) => !search || a.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <AppLayout>
      <div className="space-y-6 p-6 max-w-[1400px] mx-auto">
        <MarketingPageHeader
          eyebrow="Marketing · Email"
          title="Automações"
          description={
            <>Fluxos visuais disparados por gatilhos: <span className="italic">lead novo → email + espera 2 dias → outro email</span>.</>
          }
          action={
            <Button
              size="sm"
              className="bg-[#BAA05E] hover:bg-[#917D3D] text-white gap-1.5"
              onClick={() => navigate('/marketing/automacoes/nova')}
            >
              <Plus className="h-3.5 w-3.5" /> Nova automação
            </Button>
          }
        />

        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar automação..."
            className="pl-9"
          />
        </div>

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2].map((i) => <div key={i} className="h-24 rounded-xl bg-muted/30 animate-pulse" />)}
          </div>
        ) : filtered.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="py-16 text-center space-y-4">
              <div className="w-14 h-14 rounded-2xl bg-[#BAA05E]/10 flex items-center justify-center mx-auto">
                <Workflow className="h-7 w-7 text-[#BAA05E]" />
              </div>
              <div>
                <p className="font-semibold">
                  {search ? 'Nenhuma automação encontrada' : 'Nenhuma automação ainda'}
                </p>
                <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
                  Monte fluxos visuais que rodam sozinhos. Ideal pra welcome series, follow-up, reativação, etc.
                </p>
              </div>
              {!search && (
                <Button
                  onClick={() => navigate('/marketing/automacoes/nova')}
                  className="bg-[#BAA05E] hover:bg-[#917D3D] gap-2"
                >
                  <Plus className="h-4 w-4" />
                  Criar primeira automação
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {filtered.map((a) => {
              const meta = TRIGGER_META[a.trigger_event] || FALLBACK_META;
              const Icon = meta.icon;
              const stepsCount = a.flow_json?.nodes?.length || 0;
              return (
                <Card
                  key={a.id}
                  className="group hover:border-[#BAA05E]/50 hover:shadow-md transition-all cursor-pointer"
                  onClick={() => navigate(`/marketing/automacoes/${a.id}`)}
                >
                  <CardContent className="p-5 flex items-center gap-4">
                    <div className={cn('w-12 h-12 rounded-xl flex items-center justify-center', meta.color)}>
                      <Icon className="h-5 w-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
                          Quando: {meta.label}
                        </Badge>
                        {a.is_active ? (
                          <Badge className="text-[10px] bg-emerald-500/10 text-emerald-600 border-emerald-500/20">
                            Ativa
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="text-[10px]">Pausada</Badge>
                        )}
                      </div>
                      <h3 className="font-semibold truncate">{a.name}</h3>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {stepsCount} {stepsCount === 1 ? 'passo' : 'passos'} ·{' '}
                        Atualizado {formatDistanceToNow(new Date(a.updated_at), { addSuffix: true, locale: ptBR })}
                      </p>
                    </div>
                    <Switch
                      checked={a.is_active}
                      onCheckedChange={(v) => toggleAutomation.mutate({ id: a.id, isActive: v })}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); navigate(`/marketing/automacoes/${a.id}`); }}>
                          <Pencil className="h-3.5 w-3.5 mr-2" /> Editar
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (confirm(`Remover "${a.name}"?`)) deleteAutomation.mutate(a.id);
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5 mr-2" /> Remover
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
