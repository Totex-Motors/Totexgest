import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, Link2, Loader2, Search, Store, User, AlertTriangle, Clock } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { PhoneInput } from "@/components/ui/phone-input";
import { cn } from "@/lib/utils";
import { useMarketplaceStores } from "@/hooks/useMarketplaceStores";
import {
  useFindAttendance,
  useLinkAttendance,
  type AttendanceCandidate,
  type LinkAttendanceResult,
} from "@/hooks/useVincularAtendimento";

/**
 * VINCULAR ATENDIMENTO — a promotora atendeu o cliente no stand, o cliente
 * escaneou o QR da loja e já virou lead no "cérebro". Em vez de recadastrar
 * (que duplica), ela escolhe a loja + telefone, acha o atendimento e se vincula.
 * O crédito (R$150 na venda) passa a contar pra ela, sem lead duplicado.
 */

function relDate(iso: string): string {
  const d = new Date(iso);
  const mins = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (mins < 60) return `há ${Math.max(1, mins)} min`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `há ${h} h`;
  const days = Math.floor(h / 24);
  if (days < 30) return `há ${days} d`;
  return d.toLocaleDateString("pt-BR");
}

export default function CaptureLinkAttendance() {
  const navigate = useNavigate();
  const stores = useMarketplaceStores();
  const find = useFindAttendance();
  const link = useLinkAttendance();

  const [storeId, setStoreId] = useState("");
  const [phone, setPhone] = useState("");
  const [results, setResults] = useState<AttendanceCandidate[] | null>(null);
  const [selected, setSelected] = useState<AttendanceCandidate | null>(null);
  const [observacao, setObservacao] = useState("");
  const [done, setDone] = useState<LinkAttendanceResult | null>(null);

  const phoneOk = phone.replace(/\D/g, "").length >= 10;
  const canSearch = !!storeId && phoneOk;

  const buscar = async () => {
    if (!canSearch) return;
    setResults(null);
    setSelected(null);
    try {
      const rows = await find.mutateAsync({ tenantId: storeId, phone });
      setResults(rows);
      if (rows.length === 0) {
        toast.info("Nenhum atendimento com esse telefone nessa loja ainda.");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui buscar. Tenta de novo.");
    }
  };

  const vincular = async () => {
    if (!selected) return;
    try {
      const res = await link.mutateAsync({ storeLeadId: selected.lead_id, observacao: observacao.trim() || null });
      setDone(res);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui vincular. Tenta de novo.");
    }
  };

  const reset = () => {
    setPhone("");
    setResults(null);
    setSelected(null);
    setObservacao("");
    setDone(null);
  };

  // ── Sucesso ──
  if (done) {
    return (
      <div className="space-y-5 pt-6 text-center">
        <div className="mx-auto h-16 w-16 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center">
          {done.already ? <Check className="h-9 w-9" /> : <Link2 className="h-9 w-9" />}
        </div>
        <div>
          <h1 className="text-xl font-bold">
            {done.already ? "Esse atendimento já estava vinculado" : "Atendimento vinculado!"}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {done.already
              ? <>Já havia uma promotora {done.promoter_name ? <>(<strong>{done.promoter_name}</strong>)</> : null} nesse cliente da <strong>{done.store_name ?? "loja"}</strong>. Vale quem chegou primeiro.</>
              : <>Pronto — o cliente da <strong>{done.store_name ?? "loja"}</strong> agora está no seu nome, sem duplicar o cadastro.</>}
          </p>
        </div>
        {!done.already && (
          <p className="text-sm text-emerald-700 flex items-center justify-center gap-1">
            <Check className="h-4 w-4" /> Indicação no seu nome {done.veiculo ? `· ${done.veiculo}` : ""}
          </p>
        )}
        <div className="grid gap-2">
          <Button size="lg" className="h-12 bg-emerald-600 hover:bg-emerald-700 text-white" onClick={reset}>
            + Vincular outro atendimento
          </Button>
          <Button size="lg" variant="outline" className="h-12" onClick={() => navigate("/captacao/leads")}>
            Ver meus leads
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-bold leading-tight">Vincular atendimento</h1>
        <p className="text-xs text-muted-foreground">
          Atendeu alguém que escaneou o QR da loja? Ache o cliente pelo telefone e coloque no seu nome — sem recadastrar.
        </p>
      </div>

      {/* Loja */}
      <div className="space-y-1.5">
        <Label htmlFor="link-store">Em qual loja o cliente foi atendido?</Label>
        <div className="relative">
          <Store className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <select
            id="link-store"
            className="h-12 w-full rounded-md border border-input bg-background pl-9 pr-3 text-base disabled:opacity-60"
            value={storeId}
            disabled={stores.isLoading}
            onChange={(e) => { setStoreId(e.target.value); setResults(null); setSelected(null); }}
          >
            <option value="">{stores.isLoading ? "Carregando lojas…" : "Escolha a loja"}</option>
            {(stores.data ?? []).map((s) => <option key={s.tenant_id} value={s.tenant_id}>{s.name}</option>)}
          </select>
        </div>
      </div>

      {/* Telefone */}
      <div className="space-y-1.5">
        <Label htmlFor="link-phone">WhatsApp do cliente</Label>
        <div className="flex gap-2">
          <PhoneInput
            id="link-phone"
            className="h-12 text-base flex-1"
            value={phone}
            onChange={(p) => { setPhone(p); setResults(null); setSelected(null); }}
          />
          <Button type="button" variant="secondary" className="h-12 shrink-0" disabled={!canSearch || find.isPending} onClick={buscar}>
            {find.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            <span className="ml-1">Buscar</span>
          </Button>
        </div>
      </div>

      {/* Resultados */}
      {results && results.length > 0 && (
        <div className="space-y-2">
          <Label>Qual é o cliente?</Label>
          <div className="space-y-2">
            {results.map((c) => {
              const isSel = selected?.lead_id === c.lead_id;
              return (
                <button
                  key={c.lead_id}
                  type="button"
                  onClick={() => setSelected(isSel ? null : c)}
                  className={cn(
                    "w-full flex items-center gap-3 rounded-lg border p-3 text-left transition-colors active:scale-[0.99]",
                    isSel ? "border-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 dark:border-emerald-800" : "border-input hover:bg-muted",
                  )}
                >
                  <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center shrink-0">
                    <User className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{c.name || "Cliente"}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {c.phone_tail ? `•••• ${c.phone_tail}` : ""}
                      {c.veiculo ? ` · ${c.veiculo}` : ""}
                    </p>
                    <p className="text-[11px] text-muted-foreground flex items-center gap-1 mt-0.5">
                      <Clock className="h-3 w-3" /> {relDate(c.created_at)}
                      {c.already_linked && (
                        <span className="ml-1 text-amber-700 dark:text-amber-400 flex items-center gap-0.5">
                          <AlertTriangle className="h-3 w-3" /> já vinculado{c.linked_promoter ? ` (${c.linked_promoter})` : ""}
                        </span>
                      )}
                    </p>
                  </div>
                  {isSel && <Check className="h-5 w-5 text-emerald-600 shrink-0" />}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {results && results.length === 0 && (
        <Card className="bg-muted/40 border-dashed">
          <CardContent className="pt-4 pb-4 text-sm text-muted-foreground">
            Não achei nenhum atendimento com esse telefone nessa loja. Confere o número, ou talvez o cliente ainda não tenha falado no WhatsApp da loja.
          </CardContent>
        </Card>
      )}

      {/* Observação + confirmação */}
      {selected && (
        <>
          {selected.already_linked && (
            <p className="text-xs text-amber-700 dark:text-amber-400 flex items-start gap-1.5">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              Esse cliente já parece ter uma promotora vinculada{selected.linked_promoter ? ` (${selected.linked_promoter})` : ""}. Vale quem chegou primeiro — pode seguir, mas talvez não entre no seu nome.
            </p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="link-obs">Observação <span className="text-muted-foreground font-normal">(opcional)</span></Label>
            <Textarea id="link-obs" rows={2}
              placeholder="Ex.: atendi no stand, mostrei o Onix, ficou de voltar amanhã"
              value={observacao}
              onChange={(e) => setObservacao(e.target.value)} />
          </div>
        </>
      )}

      {/* Rodapé de ação */}
      <div className="fixed bottom-16 inset-x-0 z-20 pointer-events-none">
        <div className="mx-auto max-w-[520px] px-4 pb-3 pt-6 bg-gradient-to-t from-background via-background/95 to-transparent pointer-events-auto">
          <Button
            size="lg"
            className="w-full h-12 text-base bg-emerald-600 hover:bg-emerald-700 text-white"
            disabled={!selected || link.isPending}
            onClick={vincular}
          >
            {link.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Link2 className="h-4 w-4 mr-2" />}
            {selected ? "Vincular a mim" : "Escolha o cliente"}
          </Button>
        </div>
      </div>
    </div>
  );
}
