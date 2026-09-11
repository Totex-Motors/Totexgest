import { useEffect, useState } from "react";
import { HandCoins, Loader2, RefreshCw, Save, Store, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { useAllTeamMembers } from "@/hooks/useTeamMembers";
import {
  DEFAULT_HANDOFF_CONFIG,
  useCaptureHandoffConfig,
  useMarketplaceDealerships,
  useSaveCaptureHandoffConfig,
  useSetCaptureProfile,
  useSyncCaptureListings,
  type CaptureHandoffConfig,
} from "@/hooks/useCaptureHandoff";

/**
 * Configurações › Comercial › Captação (promotoras).
 * Quem recebe os leads captados (rodízio), SLA por temperatura, escalonamento
 * e canal de aviso (instância UAZAPI + grupo). Vazio = herda da Torre de Controle.
 * Também: perfil de captação de cada promotora (padrão | folgista).
 */

const NONE = "__none__";

type CaptureProfile = "padrao" | "folgista";

/** Card "Promotoras": perfil de captação por membro (RPC set_capture_profile, admin). */
function PromotorasCard({ members }: { members: { id: string; name: string; role: string | null; is_active: boolean; capture_profile?: CaptureProfile }[] }) {
  const setProfile = useSetCaptureProfile();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const promotoras = members.filter((m) => m.role === "promotora");

  const change = async (m: { id: string; name: string }, profile: CaptureProfile) => {
    setPendingId(m.id);
    try {
      await setProfile.mutateAsync({ memberId: m.id, profile });
      toast.success(`${m.name}: perfil ${profile === "folgista" ? "Folgista" : "Padrão"}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao trocar o perfil");
    } finally {
      setPendingId(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Users className="h-4 w-4" /> Promotoras</CardTitle>
        <CardDescription>
          Folgista = esporádica; não entra nos valores em pecúnia nem vouchers, salvo regra marcada "vale pra folgista".
          Ela capta e treina normalmente — só vê o painel simples, sem carteira.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {promotoras.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhuma promotora cadastrada no time.</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {promotoras.map((m) => {
              const busy = pendingId === m.id;
              return (
                <li key={m.id} className="py-2 flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{m.name}</p>
                    {!m.is_active && <p className="text-[11px] text-muted-foreground">inativa</p>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                    <Select
                      value={m.capture_profile ?? "padrao"}
                      disabled={busy}
                      onValueChange={(v) => change(m, v as CaptureProfile)}
                    >
                      <SelectTrigger className="w-[130px] h-9"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="padrao">Padrão</SelectItem>
                        <SelectItem value="folgista">Folgista</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function useUazapiInstances(tenantId: string | null) {
  return useQuery({
    queryKey: ["capture-handoff-instances", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data } = await supabase
        .from("whatsapp_instances")
        .select("id, name, status, provider")
        .eq("tenant_id", tenantId!)
        .order("name");
      return ((data ?? []) as { id: string; name: string; status: string | null; provider: string | null }[])
        .filter((i) => i.provider !== "meta_cloud");
    },
  });
}

export function CaptureHandoffSection() {
  const { tenantId } = useAuth();
  const { data: cfg, isLoading } = useCaptureHandoffConfig();
  const save = useSaveCaptureHandoffConfig();
  const { data: members = [] } = useAllTeamMembers();
  const { data: instances = [] } = useUazapiInstances(tenantId);
  const dealerships = useMarketplaceDealerships();
  const sync = useSyncCaptureListings();

  const [form, setForm] = useState<Omit<CaptureHandoffConfig, "tenant_id">>(DEFAULT_HANDOFF_CONFIG);
  useEffect(() => {
    if (cfg) {
      const { tenant_id: _t, ...rest } = cfg;
      setForm({ ...DEFAULT_HANDOFF_CONFIG, ...rest });
    }
  }, [cfg]);

  const sellers = members.filter((m) => m.is_active && ["comercial", "closer", "admin", "sdr"].includes(m.role ?? ""));
  const toggleSpecialist = (id: string) =>
    setForm((f) => ({
      ...f,
      specialist_member_ids: f.specialist_member_ids.includes(id)
        ? f.specialist_member_ids.filter((x) => x !== id)
        : [...f.specialist_member_ids, id],
    }));

  const onSave = async () => {
    try {
      await save.mutateAsync({ ...form, last_assigned_member_id: cfg?.last_assigned_member_id ?? null });
      toast.success("Configuração de captação salva");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao salvar");
    }
  };

  if (isLoading) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Carregando…</div>;

  return (
    <div className="space-y-4 max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><HandCoins className="h-4 w-4" /> Handoff da captação</CardTitle>
          <CardDescription>
            Quando a promotora capta um proprietário, o lead vai automaticamente pra um especialista
            (rodízio), vira tarefa e dispara aviso no WhatsApp. Se ninguém fizer o 1º contato dentro do
            SLA, o sistema re-avisa e depois escala.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <Label>Handoff automático</Label>
              <p className="text-xs text-muted-foreground">Desligado = lead fica no funil sem vendedor, sem aviso.</p>
            </div>
            <Switch checked={form.enabled} onCheckedChange={(enabled) => setForm({ ...form, enabled })} />
          </div>

          <div className="space-y-2">
            <Label>Especialistas que recebem os leads (rodízio na ordem marcada)</Label>
            <p className="text-xs text-muted-foreground">Nenhum marcado = todos os vendedores ativos (comercial/closer).</p>
            <div className="grid sm:grid-cols-2 gap-2">
              {sellers.map((m) => {
                const checked = form.specialist_member_ids.includes(m.id);
                const pos = form.specialist_member_ids.indexOf(m.id);
                return (
                  <label key={m.id} className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-sm cursor-pointer">
                    <Checkbox checked={checked} onCheckedChange={() => toggleSpecialist(m.id)} />
                    <span className="flex-1 truncate">{m.name}</span>
                    {!m.phone && <span className="text-[10px] text-amber-600">sem telefone</span>}
                    {checked && <span className="text-[10px] text-muted-foreground">#{pos + 1}</span>}
                  </label>
                );
              })}
              {sellers.length === 0 && <p className="text-sm text-muted-foreground">Nenhum vendedor ativo no time.</p>}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Meta diária de leads válidos (anel "Hoje" da promotora)</Label>
            <Input type="number" min={1} max={200} value={form.daily_goal ?? ""} placeholder="vazio = meta semanal ÷ 5"
              onChange={(e) => setForm({ ...form, daily_goal: e.target.value ? Math.max(1, Number(e.target.value)) : null })} />
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>SLA lead quente (min)</Label>
              <Input type="number" min={5} max={1440} value={form.sla_minutes_quente}
                onChange={(e) => setForm({ ...form, sla_minutes_quente: Number(e.target.value) || 30 })} />
            </div>
            <div className="space-y-1.5">
              <Label>SLA lead morno (min)</Label>
              <Input type="number" min={5} max={4320} value={form.sla_minutes_morno}
                onChange={(e) => setForm({ ...form, sla_minutes_morno: Number(e.target.value) || 240 })} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Escalar para (2× SLA sem contato)</Label>
            <Select value={form.escalate_to_member_id ?? NONE} onValueChange={(v) => setForm({ ...form, escalate_to_member_id: v === NONE ? null : v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Admins do tenant (com telefone) + grupo</SelectItem>
                {members.filter((m) => m.is_active).map((m) => (
                  <SelectItem key={m.id} value={m.id}>{m.name}{m.phone ? "" : " (sem telefone)"}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Canal de aviso (WhatsApp)</CardTitle>
          <CardDescription>
            Deixe em branco pra usar a mesma instância e grupo da Torre de Controle (Configurações › Automações › Alertas).
            Só instâncias UAZAPI — o número oficial (Cloud API) exige template aprovado.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>Avisar o grupo da operação (com @menção do especialista)</Label>
              <p className="text-xs text-muted-foreground">Canal recomendado. Coloque os vendedores no grupo — eles recebem o lead marcados pelo @.</p>
            </div>
            <Switch checked={form.notify_group} onCheckedChange={(v) => setForm({ ...form, notify_group: v })} />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label>Avisar também no privado do especialista (número OFICIAL, template)</Label>
              <p className="text-xs text-muted-foreground">Vai pelo Cloud API com template aprovado pela Meta. A API não oficial nunca manda no privado.</p>
            </div>
            <Switch checked={form.notify_specialist} onCheckedChange={(v) => setForm({ ...form, notify_specialist: v })} />
          </div>
          <div className="space-y-1.5">
            <Label>Nome do template (Cloud API)</Label>
            <Input value={form.specialist_template_name} onChange={(e) => setForm({ ...form, specialist_template_name: e.target.value.trim() })} placeholder="captacao_lead_especialista" />
            <p className="text-xs text-muted-foreground">Variáveis na ordem: 1 nome do especialista · 2 cliente + telefone · 3 carro · 4 prazo · 5 minutos do SLA. Só envia quando o template estiver APROVADO.</p>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label>Resumo da captação no grupo</Label>
              <p className="text-xs text-muted-foreground">Por promotora, quentes, quem está sem contato, meta/prêmio da semana.</p>
            </div>
            <Switch checked={form.summary_enabled} onCheckedChange={(v) => setForm({ ...form, summary_enabled: v })} />
          </div>
          <div className="space-y-1.5">
            <Label>Horários do resumo (horas, separadas por vírgula)</Label>
            <Input
              value={form.summary_hours.join(", ")}
              onChange={(e) => setForm({
                ...form,
                summary_hours: Array.from(new Set(e.target.value.split(/[,\s]+/).map((s) => Number(s)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 23))),
              })}
              placeholder="13, 19"
            />
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Instância</Label>
              <Select value={form.whatsapp_instance_id ?? NONE} onValueChange={(v) => setForm({ ...form, whatsapp_instance_id: v === NONE ? null : v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Herdar da Torre de Controle</SelectItem>
                  {instances.map((i) => (
                    <SelectItem key={i.id} value={i.id}>{i.name}{i.status === "connected" ? "" : ` (${i.status ?? "?"})`}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>JID do grupo</Label>
              <Input placeholder="1203634…@g.us (vazio = herdar)" value={form.whatsapp_group_jid ?? ""}
                onChange={(e) => setForm({ ...form, whatsapp_group_jid: e.target.value.trim() || null })} />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Store className="h-4 w-4" /> Anúncio no marketplace (etapa "Anunciado")</CardTitle>
          <CardDescription>
            A etapa <strong>Anunciado</strong> da jornada do carro não é marcada na mão: 2× por dia (8h e 18h) o sistema
            confere o estoque da loja no site totexmotors.com. Carro captado que aparece lá vira Anunciado com link e preço.
            Se sumir do estoque, o especialista recebe uma tarefa ("vendeu ou tirou?").
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>Conferir o estoque automaticamente</Label>
              <p className="text-xs text-muted-foreground">Desligado = Anunciado só na mão, pelo detalhe do lead.</p>
            </div>
            <Switch checked={form.listing_sync_enabled} onCheckedChange={(v) => setForm({ ...form, listing_sync_enabled: v })} />
          </div>
          <div className="space-y-1.5">
            <Label>Loja no marketplace</Label>
            <Select
              value={form.marketplace_store_id ?? NONE}
              onValueChange={(v) => setForm({ ...form, marketplace_store_id: v === NONE ? null : v })}
            >
              <SelectTrigger><SelectValue placeholder={dealerships.isLoading ? "Carregando lojas…" : "Escolha a loja"} /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Nenhuma (usa o vínculo do marketplace, se houver)</SelectItem>
                {(dealerships.data ?? []).map((d) => (
                  <SelectItem key={d.id} value={d.id}>{d.name} ({d.vehicles} carro{d.vehicles === 1 ? "" : "s"})</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {dealerships.isError && <p className="text-xs text-amber-600">Não consegui listar as lojas do marketplace agora. Tente de novo mais tarde.</p>}
            {!dealerships.isLoading && !dealerships.isError && (dealerships.data ?? []).length > 0
              && !(dealerships.data ?? []).some((d) => d.id === form.marketplace_store_id) && form.marketplace_store_id && (
              <p className="text-xs text-amber-600">A loja salva não aparece mais na lista do marketplace.</p>
            )}
            <p className="text-xs text-muted-foreground">
              Só o estoque dessa loja é conferido — um Civic de outra loja da rede nunca é casado com o seu carro captado.
              Se a loja ainda não está no marketplace, a etapa fica manual até ela entrar.
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 px-3 py-2">
            <div className="text-xs text-muted-foreground min-w-0">
              {cfg?.listing_last_sync_at ? (
                <>
                  Última conferência: {new Date(cfg.listing_last_sync_at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                  {cfg.listing_last_sync_result ? <> · {cfg.listing_last_sync_result}</> : null}
                </>
              ) : (
                "Ainda não conferiu o estoque."
              )}
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={sync.isPending || !form.listing_sync_enabled}
              onClick={async () => {
                if (JSON.stringify({ ...cfg, tenant_id: undefined }) !== JSON.stringify({ ...cfg, ...form, tenant_id: undefined })) {
                  toast.info("Salve as alterações antes de sincronizar.");
                  return;
                }
                try {
                  const r = await sync.mutateAsync();
                  if (r.error) toast.error(r.error);
                  else toast.success(r.result ?? "Sincronizado");
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Erro ao sincronizar");
                }
              }}
            >
              {sync.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
              Sincronizar agora
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={onSave} disabled={save.isPending}>
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
          Salvar
        </Button>
      </div>

      {/* Perfil de captação — salva na hora (RPC), independente do botão Salvar acima */}
      <PromotorasCard members={members} />
    </div>
  );
}
