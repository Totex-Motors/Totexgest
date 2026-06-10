import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Pencil, Save, X, ShoppingBag, CreditCard, Banknote, RefreshCw } from "lucide-react";
import { useUpdateLeadMetadata } from "@/hooks/useSalesLeads";
import { toast } from "sonner";

export interface BuyerProfile {
  faixa_preco_min?: number | null;
  faixa_preco_max?: number | null;
  precisa_financiar?: boolean | null;
  entrada_disponivel?: number | null;
  tem_veiculo_troca?: boolean | null;
  forma_pagamento?: string | null;
}

function formatCurrency(v?: number | null) {
  if (v == null) return "";
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function parseCurrencyInput(raw: string): number | null {
  const clean = raw.replace(/[^\d,]/g, "").replace(",", ".");
  const n = parseFloat(clean);
  return isNaN(n) ? null : n;
}

export function BuyerProfileCard({
  leadId,
  profile,
}: {
  leadId: string;
  profile?: BuyerProfile | null;
}) {
  const [editing, setEditing] = useState(false);
  const updateMeta = useUpdateLeadMetadata();

  const [form, setForm] = useState<{
    faixa_preco_min: string;
    faixa_preco_max: string;
    precisa_financiar: string;
    entrada_disponivel: string;
    tem_veiculo_troca: string;
    forma_pagamento: string;
  }>({
    faixa_preco_min: profile?.faixa_preco_min != null ? String(profile.faixa_preco_min) : "",
    faixa_preco_max: profile?.faixa_preco_max != null ? String(profile.faixa_preco_max) : "",
    precisa_financiar: profile?.precisa_financiar != null ? String(profile.precisa_financiar) : "",
    entrada_disponivel: profile?.entrada_disponivel != null ? String(profile.entrada_disponivel) : "",
    tem_veiculo_troca: profile?.tem_veiculo_troca != null ? String(profile.tem_veiculo_troca) : "",
    forma_pagamento: profile?.forma_pagamento ?? "",
  });

  const isEmpty =
    !profile?.faixa_preco_min &&
    !profile?.faixa_preco_max &&
    profile?.precisa_financiar == null &&
    !profile?.entrada_disponivel &&
    profile?.tem_veiculo_troca == null &&
    !profile?.forma_pagamento;

  function openEdit() {
    setForm({
      faixa_preco_min: profile?.faixa_preco_min != null ? String(profile.faixa_preco_min) : "",
      faixa_preco_max: profile?.faixa_preco_max != null ? String(profile.faixa_preco_max) : "",
      precisa_financiar: profile?.precisa_financiar != null ? String(profile.precisa_financiar) : "",
      entrada_disponivel: profile?.entrada_disponivel != null ? String(profile.entrada_disponivel) : "",
      tem_veiculo_troca: profile?.tem_veiculo_troca != null ? String(profile.tem_veiculo_troca) : "",
      forma_pagamento: profile?.forma_pagamento ?? "",
    });
    setEditing(true);
  }

  async function handleSave() {
    const patch: BuyerProfile = {
      faixa_preco_min: parseCurrencyInput(form.faixa_preco_min),
      faixa_preco_max: parseCurrencyInput(form.faixa_preco_max),
      precisa_financiar: form.precisa_financiar === "" ? null : form.precisa_financiar === "true",
      entrada_disponivel: parseCurrencyInput(form.entrada_disponivel),
      tem_veiculo_troca: form.tem_veiculo_troca === "" ? null : form.tem_veiculo_troca === "true",
      forma_pagamento: form.forma_pagamento || null,
    };
    try {
      await updateMeta.mutateAsync({ leadId, patch });
      toast.success("Perfil de compra salvo");
      setEditing(false);
    } catch {
      toast.error("Erro ao salvar perfil de compra");
    }
  }

  if (!editing && isEmpty) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <ShoppingBag className="h-4 w-4 text-primary" /> Perfil de Compra
            </span>
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={openEdit}>
              <Pencil className="h-3 w-3" />
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">Nenhum perfil preenchido.</p>
        </CardContent>
      </Card>
    );
  }

  if (editing) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <ShoppingBag className="h-4 w-4 text-primary" /> Perfil de Compra
            </span>
            <div className="flex gap-1">
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setEditing(false)}>
                <X className="h-3 w-3" />
              </Button>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleSave} disabled={updateMeta.isPending}>
                <Save className="h-3 w-3" />
              </Button>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Orçamento mín (R$)</Label>
              <Input
                className="h-7 text-xs"
                placeholder="ex: 30000"
                value={form.faixa_preco_min}
                onChange={(e) => setForm((f) => ({ ...f, faixa_preco_min: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Orçamento máx (R$)</Label>
              <Input
                className="h-7 text-xs"
                placeholder="ex: 60000"
                value={form.faixa_preco_max}
                onChange={(e) => setForm((f) => ({ ...f, faixa_preco_max: e.target.value }))}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Precisa financiar?</Label>
              <Select value={form.precisa_financiar} onValueChange={(v) => setForm((f) => ({ ...f, precisa_financiar: v }))}>
                <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="—" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">Sim</SelectItem>
                  <SelectItem value="false">Não</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Tem veículo na troca?</Label>
              <Select value={form.tem_veiculo_troca} onValueChange={(v) => setForm((f) => ({ ...f, tem_veiculo_troca: v }))}>
                <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="—" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">Sim</SelectItem>
                  <SelectItem value="false">Não</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Entrada disponível (R$)</Label>
            <Input
              className="h-7 text-xs"
              placeholder="ex: 10000"
              value={form.entrada_disponivel}
              onChange={(e) => setForm((f) => ({ ...f, entrada_disponivel: e.target.value }))}
            />
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Forma de pagamento preferida</Label>
            <Select value={form.forma_pagamento} onValueChange={(v) => setForm((f) => ({ ...f, forma_pagamento: v }))}>
              <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="—" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="a_vista">À vista</SelectItem>
                <SelectItem value="financiamento">Financiamento</SelectItem>
                <SelectItem value="consorcio">Consórcio</SelectItem>
                <SelectItem value="leasing">Leasing</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>
    );
  }

  // View mode
  const formaLabels: Record<string, string> = {
    a_vista: "À vista",
    financiamento: "Financiamento",
    consorcio: "Consórcio",
    leasing: "Leasing",
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <ShoppingBag className="h-4 w-4 text-primary" /> Perfil de Compra
          </span>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={openEdit}>
            <Pencil className="h-3 w-3" />
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        {(profile?.faixa_preco_min != null || profile?.faixa_preco_max != null) && (
          <div className="flex items-center gap-2">
            <Banknote className="h-3 w-3 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground">Orçamento:</span>
            <span className="font-medium">
              {profile.faixa_preco_min != null ? formatCurrency(profile.faixa_preco_min) : "—"}
              {" — "}
              {profile.faixa_preco_max != null ? formatCurrency(profile.faixa_preco_max) : "—"}
            </span>
          </div>
        )}
        {profile?.precisa_financiar != null && (
          <div className="flex items-center gap-2">
            <CreditCard className="h-3 w-3 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground">Financia:</span>
            <span className="font-medium">{profile.precisa_financiar ? "Sim" : "Não"}</span>
          </div>
        )}
        {profile?.entrada_disponivel != null && (
          <div className="flex items-center gap-2">
            <Banknote className="h-3 w-3 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground">Entrada:</span>
            <span className="font-medium">{formatCurrency(profile.entrada_disponivel)}</span>
          </div>
        )}
        {profile?.tem_veiculo_troca != null && (
          <div className="flex items-center gap-2">
            <RefreshCw className="h-3 w-3 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground">Troca:</span>
            <span className="font-medium">{profile.tem_veiculo_troca ? "Sim" : "Não"}</span>
          </div>
        )}
        {profile?.forma_pagamento && (
          <div className="flex items-center gap-2">
            <CreditCard className="h-3 w-3 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground">Pagamento:</span>
            <span className="font-medium">{formaLabels[profile.forma_pagamento] ?? profile.forma_pagamento}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
