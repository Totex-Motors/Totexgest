import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle, Ban, Building2, CheckCircle2, Eye, FileText, Info, Loader2, Lock, Pencil, Plus,
  RotateCcw, Save, Scale, Send, ShieldCheck, Star,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { maskCep, maskCnpj, maskCpf, maskUF } from "@/lib/brMasks";
import { maskPhoneBR, onlyDigits } from "@/lib/phone";
import { useAuth } from "@/contexts/AuthContext";
import { useTeamMembers } from "@/hooks/useTeamMembers";
import {
  useContractTemplates,
  useLegalEntities,
  usePoaSetDefault,
  usePoaSetStatus,
  usePoaUpsert,
  usePowersOfAttorney,
  useSaveContractTemplate,
  useSaveLegalEntity,
} from "@/hooks/useIntermediation";
import {
  CONTRACT_TEMPLATE_STATUS_LABEL,
  DOCUMENT_TYPE_LABEL,
  POA_ROLE,
  POA_SIGNATURE_MODE_LABEL,
  POA_STATUS_META,
  SIGNER_ROLE_OPTIONS,
  poaScopesLabel,
  type ContractDocumentType,
  type ContractTemplate,
  type ContractTemplateStatus,
  type LegalEntity,
  type LegalEntitySignerRole,
  type PoaRole,
  type PoaSignatureMode,
  type PowerOfAttorney,
  type PowerOfAttorneyInput,
} from "@/types/intermediation";

/**
 * Configurações › Comercial › Intermediação (fase 2 — docs/INTERMEDIACAO.md).
 *
 * (a) Entidade jurídica: razão social/CNPJ/endereço + quem assina pela empresa —
 *     entra nas variáveis `legal_entity.*` / `company_signer.*` do contrato. Admin salva.
 * (b) Templates de contrato: jurídico e versionado. Todo mundo lê; superadmin cria
 *     rascunho e publica (publicar aposenta a versão anterior e trava o texto).
 */

const fmtDate = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";

export function IntermediationSettingsSection() {
  return (
    <div className="space-y-6">
      <LegalEntityCard />
      <PowersOfAttorneyCard />
      <ContractTemplatesCard />
    </div>
  );
}

// ─── (c) Representação / procurações (Fase 5a) ──────────────────────────────

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const fmtBRL = (v?: number | null) => (v == null ? "—" : brl.format(Number(v)));
/** Converte "80.000,00" / "80000" → número (ou null). */
function parseMoney(raw: string): number | null {
  const clean = raw.replace(/[^\d,.]/g, "").replace(/\.(?=\d{3})/g, "").replace(",", ".");
  if (!clean) return null;
  const n = parseFloat(clean);
  return Number.isFinite(n) ? n : null;
}

const DOC_TYPES = Object.keys(DOCUMENT_TYPE_LABEL) as ContractDocumentType[];

interface PoaForm {
  id: string | null;
  signer_name: string;
  signer_cpf: string;
  signer_role: PoaRole;
  signature_mode: PoaSignatureMode;
  legal_entity_id: string; // "" = qualquer entidade
  member_id: string; // "" = nenhum
  doc_number: string;
  doc_url: string;
  all_scopes: boolean;
  scopes: ContractDocumentType[];
  max_value: string; // "" = ilimitada
  can_approve: boolean;
  valid_from: string;
  valid_until: string;
  notes: string;
}

function emptyPoaForm(): PoaForm {
  return {
    id: null, signer_name: "", signer_cpf: "", signer_role: "Procurador", signature_mode: "isolated",
    legal_entity_id: "", member_id: "", doc_number: "", doc_url: "", all_scopes: true, scopes: [],
    max_value: "", can_approve: false, valid_from: "", valid_until: "", notes: "",
  };
}

function toPoaForm(p: PowerOfAttorney): PoaForm {
  const all = !p.scopes || p.scopes.length === 0 || p.scopes.includes("*");
  return {
    id: p.id,
    signer_name: p.signer_name ?? "",
    signer_cpf: p.signer_cpf ? maskCpf(p.signer_cpf) : "",
    signer_role: p.signer_role ?? "Procurador",
    signature_mode: p.signature_mode ?? "isolated",
    legal_entity_id: p.legal_entity_id ?? "",
    member_id: p.member_id ?? "",
    doc_number: p.doc_number ?? "",
    doc_url: p.doc_url ?? "",
    all_scopes: all,
    scopes: all ? [] : (p.scopes.filter((s) => DOC_TYPES.includes(s as ContractDocumentType)) as ContractDocumentType[]),
    max_value: p.max_value == null ? "" : String(p.max_value).replace(".", ","),
    can_approve: !!p.can_approve,
    valid_from: p.valid_from ?? "",
    valid_until: p.valid_until ?? "",
    notes: p.notes ?? "",
  };
}

/** Procuração com can_approve/Administrador(a) mas sem CPF ou nº do ato — precisa completar (ex.: Renata). */
function poaNeedsInfo(p: PowerOfAttorney): boolean {
  if (p.status !== "active") return false;
  const authority = p.can_approve || p.signer_role === "Administradora" || p.signer_role === "Administrador";
  return authority && (!p.signer_cpf || !p.doc_number);
}

function PowersOfAttorneyCard() {
  const { isAdmin, isSuperAdmin } = useAuth();
  const canEdit = isAdmin || isSuperAdmin;
  const poasQ = usePowersOfAttorney();
  const entitiesQ = useLegalEntities();
  const membersQ = useTeamMembers();
  const upsert = usePoaUpsert();
  const setStatus = usePoaSetStatus();
  const setDefault = usePoaSetDefault();

  const poas = useMemo(() => poasQ.data ?? [], [poasQ.data]);
  const entities = useMemo(() => (entitiesQ.data ?? []).filter((e) => e.is_active), [entitiesQ.data]);
  const members = membersQ.data ?? [];
  const entityName = (id: string | null) => {
    if (!id) return "Qualquer entidade";
    const e = entities.find((x) => x.id === id);
    return e ? e.trade_name ?? e.legal_name : "Entidade";
  };

  const [form, setForm] = useState<PoaForm | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<PowerOfAttorney | null>(null);
  const needsInfo = useMemo(() => poas.filter(poaNeedsInfo), [poas]);

  const set = <K extends keyof PoaForm>(k: K, v: PoaForm[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const openNew = () => setForm(emptyPoaForm());
  const openEdit = (p: PowerOfAttorney) => setForm(toPoaForm(p));

  const toggleScope = (t: ContractDocumentType, checked: boolean) =>
    setForm((f) => (f ? { ...f, scopes: checked ? [...f.scopes, t] : f.scopes.filter((s) => s !== t) } : f));

  const save = async () => {
    if (!form) return;
    if (form.signer_name.trim().length < 3) { toast.error("Informe o nome de quem assina (mínimo 3 letras)."); return; }
    if (form.signer_cpf && onlyDigits(form.signer_cpf).length !== 11) { toast.error("CPF precisa ter 11 dígitos."); return; }
    if (!form.all_scopes && form.scopes.length === 0) { toast.error("Escolha ao menos um tipo de documento (ou marque “Todos”)."); return; }
    const maxValue = form.max_value.trim() ? parseMoney(form.max_value) : null;
    if (form.max_value.trim() && maxValue == null) { toast.error("Alçada de valor inválida."); return; }
    if (form.valid_from && form.valid_until && form.valid_until < form.valid_from) { toast.error("A validade final não pode ser antes do início."); return; }
    const input: PowerOfAttorneyInput = {
      id: form.id ?? undefined,
      signer_name: form.signer_name.trim(),
      signer_cpf: onlyDigits(form.signer_cpf) || null,
      signer_role: form.signer_role,
      signature_mode: form.signature_mode,
      legal_entity_id: form.legal_entity_id || null,
      member_id: form.member_id || null,
      doc_number: form.doc_number.trim() || null,
      doc_url: form.doc_url.trim() || null,
      scopes: form.all_scopes ? ["*"] : form.scopes,
      max_value: maxValue,
      can_approve: form.can_approve,
      valid_from: form.valid_from || null,
      valid_until: form.valid_until || null,
      notes: form.notes.trim() || null,
    };
    try {
      await upsert.mutateAsync(input);
      toast.success(form.id ? "Procuração atualizada." : "Procuração cadastrada.");
      setForm(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui salvar a procuração.");
    }
  };

  const makeDefault = async (p: PowerOfAttorney) => {
    try {
      await setDefault.mutateAsync(p.id);
      toast.success(`${p.signer_name} agora assina os contratos por padrão.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui definir o padrão.");
    }
  };

  const reactivate = async (p: PowerOfAttorney) => {
    try {
      await setStatus.mutateAsync({ id: p.id, status: "active" });
      toast.success("Procuração reativada.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui reativar.");
    }
  };

  const confirmRevoke = async () => {
    if (!revokeTarget) return;
    try {
      await setStatus.mutateAsync({ id: revokeTarget.id, status: "revoked" });
      toast.success("Procuração revogada.");
      setRevokeTarget(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui revogar.");
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-violet-600" /> Representação (procurações)</CardTitle>
            <CardDescription className="mt-1">
              Quem assina pela empresa e quem pode aprovar exceções (alçadas). A procuração <strong>padrão</strong> é a que assina os contratos; quem tem <strong>“pode aprovar”</strong> decide os pedidos que exigem alçada.
            </CardDescription>
          </div>
          {canEdit && (
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={openNew}>
              <Plus className="h-3.5 w-3.5 mr-1" /> Nova procuração
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!canEdit && (
          <p className="text-[11px] text-muted-foreground flex items-center gap-1"><Lock className="h-3 w-3" /> Só admin cadastra e altera procurações.</p>
        )}

        {needsInfo.length > 0 && (
          <div className="rounded-md border border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/30 px-3 py-2 space-y-1">
            <p className="text-xs font-medium text-amber-800 dark:text-amber-300 flex items-center gap-1.5"><AlertTriangle className="h-3.5 w-3.5" /> Falta preencher CPF e nº do ato</p>
            <ul className="text-[11px] text-amber-800 dark:text-amber-300">
              {needsInfo.map((p) => (
                <li key={p.id}>
                  <strong>{p.signer_name}</strong> ({POA_ROLE[p.signer_role]}) — {!p.signer_cpf && !p.doc_number ? "CPF e nº do ato" : !p.signer_cpf ? "CPF" : "nº do ato"}.
                  {canEdit && <button type="button" className="underline ml-1" onClick={() => openEdit(p)}>Preencher</button>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {poasQ.isLoading ? (
          <p className="text-xs text-muted-foreground flex items-center gap-1"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Carregando…</p>
        ) : poas.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nenhuma procuração cadastrada ainda.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border/60">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Quem assina</TableHead>
                  <TableHead className="text-xs">Papel</TableHead>
                  <TableHead className="text-xs">Escopo</TableHead>
                  <TableHead className="text-xs">Alçada de valor</TableHead>
                  <TableHead className="text-xs">Aprova</TableHead>
                  <TableHead className="text-xs">Validade</TableHead>
                  <TableHead className="text-xs">Status</TableHead>
                  <TableHead className="text-xs text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {poas.map((p) => {
                  const sm = POA_STATUS_META[p.status];
                  return (
                    <TableRow key={p.id} className={cn(poaNeedsInfo(p) && "bg-amber-50/40 dark:bg-amber-950/10")}>
                      <TableCell className="text-xs">
                        <div className="flex items-center gap-1.5 font-medium">
                          {p.is_default && p.status === "active" && <Star className="h-3.5 w-3.5 text-amber-500 fill-amber-500 shrink-0" aria-label="Padrão" />}
                          <span>{p.signer_name}</span>
                        </div>
                        <span className="text-[11px] text-muted-foreground">
                          {p.signer_cpf ? maskCpf(p.signer_cpf) : "sem CPF"} · {entityName(p.legal_entity_id)}
                          {p.doc_number ? ` · ato ${p.doc_number}` : ""}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs">
                        {POA_ROLE[p.signer_role]}
                        <span className="block text-[11px] text-muted-foreground">{POA_SIGNATURE_MODE_LABEL[p.signature_mode]}</span>
                      </TableCell>
                      <TableCell className="text-xs max-w-[180px] truncate" title={poaScopesLabel(p.scopes)}>{poaScopesLabel(p.scopes)}</TableCell>
                      <TableCell className="text-xs">{p.max_value == null ? "Ilimitada" : fmtBRL(p.max_value)}</TableCell>
                      <TableCell className="text-xs">
                        {p.can_approve
                          ? <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300 text-[10px] px-1.5 py-0">Sim</Badge>
                          : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {p.valid_from || p.valid_until
                          ? `${fmtDate(p.valid_from)} → ${p.valid_until ? fmtDate(p.valid_until) : "sem fim"}`
                          : "Sem prazo"}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-0.5">
                          <Badge variant="outline" className={cn("border text-[10px] px-1.5 py-0 w-fit", sm.cls)}>{sm.label}</Badge>
                          {p.is_default && p.status === "active" && <span className="text-[10px] text-amber-600 dark:text-amber-400">Padrão (assina)</span>}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        {canEdit && (
                          <div className="inline-flex flex-wrap justify-end gap-1">
                            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => openEdit(p)}><Pencil className="h-3.5 w-3.5 mr-1" /> Editar</Button>
                            {p.status === "active" && !p.is_default && (
                              <Button size="sm" variant="outline" className="h-7 text-xs" disabled={setDefault.isPending} onClick={() => makeDefault(p)}><Star className="h-3.5 w-3.5 mr-1" /> Tornar padrão</Button>
                            )}
                            {p.status === "active" ? (
                              <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground hover:text-destructive" disabled={setStatus.isPending} onClick={() => setRevokeTarget(p)}><Ban className="h-3.5 w-3.5 mr-1" /> Revogar</Button>
                            ) : (
                              <Button size="sm" variant="outline" className="h-7 text-xs" disabled={setStatus.isPending} onClick={() => reactivate(p)}><RotateCcw className="h-3.5 w-3.5 mr-1" /> Reativar</Button>
                            )}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      {/* Criar / editar procuração */}
      <Dialog open={!!form} onOpenChange={(o) => { if (!o && !upsert.isPending) setForm(null); }}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] flex flex-col">
          {form && (
            <>
              <DialogHeader>
                <DialogTitle>{form.id ? "Editar procuração" : "Nova procuração"}</DialogTitle>
                <DialogDescription>
                  Quem assina pela empresa (ou aprova exceções), com escopo, alçada de valor e validade.
                </DialogDescription>
              </DialogHeader>
              <div className="flex-1 min-h-0 overflow-auto space-y-3 pr-1">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <Field label="Nome de quem assina *" className="sm:col-span-2"><Input className="h-9" value={form.signer_name} placeholder="Nome completo" onChange={(e) => set("signer_name", e.target.value)} /></Field>
                  <Field label="CPF"><Input inputMode="numeric" className="h-9" value={form.signer_cpf} placeholder="000.000.000-00" onChange={(e) => set("signer_cpf", maskCpf(e.target.value))} /></Field>
                  <Field label="Papel *">
                    <Select value={form.signer_role} onValueChange={(v) => set("signer_role", v as PoaRole)}>
                      <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                      <SelectContent>{SIGNER_ROLE_OPTIONS.map((r) => <SelectItem key={r} value={r}>{POA_ROLE[r]}</SelectItem>)}</SelectContent>
                    </Select>
                  </Field>
                  <Field label="Modo de assinatura">
                    <Select value={form.signature_mode} onValueChange={(v) => set("signature_mode", v as PoaSignatureMode)}>
                      <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                      <SelectContent>{(Object.keys(POA_SIGNATURE_MODE_LABEL) as PoaSignatureMode[]).map((k) => <SelectItem key={k} value={k}>{POA_SIGNATURE_MODE_LABEL[k]}</SelectItem>)}</SelectContent>
                    </Select>
                  </Field>
                  <Field label="Entidade jurídica">
                    <Select value={form.legal_entity_id || "__any__"} onValueChange={(v) => set("legal_entity_id", v === "__any__" ? "" : v)}>
                      <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__any__">Qualquer entidade</SelectItem>
                        {entities.map((e) => <SelectItem key={e.id} value={e.id}>{e.trade_name ?? e.legal_name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Vincular a um membro (opcional)">
                    <Select value={form.member_id || "__none__"} onValueChange={(v) => set("member_id", v === "__none__" ? "" : v)}>
                      <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">Nenhum</SelectItem>
                        {members.map((m) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Nº da procuração / ato societário"><Input className="h-9" value={form.doc_number} placeholder="Ex.: 12ª alteração contratual" onChange={(e) => set("doc_number", e.target.value)} /></Field>
                  <Field label="Link do documento (opcional)" className="sm:col-span-2"><Input className="h-9" value={form.doc_url} placeholder="https://…" onChange={(e) => set("doc_url", e.target.value)} /></Field>
                  <Field label="Alçada de valor por ato (R$)" hint="Vazio = ilimitada."><Input inputMode="decimal" className="h-9" value={form.max_value} placeholder="Ex.: 150000" onChange={(e) => set("max_value", e.target.value)} /></Field>
                  <Field label="Válida de"><Input type="date" className="h-9" value={form.valid_from} onChange={(e) => set("valid_from", e.target.value)} /></Field>
                  <Field label="Válida até"><Input type="date" className="h-9" value={form.valid_until} onChange={(e) => set("valid_until", e.target.value)} /></Field>
                </div>

                <div className="rounded-md border border-border/60 p-3 space-y-2">
                  <label className="flex items-center gap-2 text-xs">
                    <Checkbox checked={form.all_scopes} onCheckedChange={(c) => set("all_scopes", c === true)} />
                    Pode assinar <strong>todos</strong> os tipos de documento
                  </label>
                  {!form.all_scopes && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 pt-1">
                      {DOC_TYPES.map((t) => (
                        <label key={t} className="flex items-center gap-2 text-xs">
                          <Checkbox checked={form.scopes.includes(t)} onCheckedChange={(c) => toggleScope(t, c === true)} />
                          {DOCUMENT_TYPE_LABEL[t]}
                        </label>
                      ))}
                    </div>
                  )}
                </div>

                <label className="flex items-center justify-between rounded-md border border-input px-3 h-10 text-xs">
                  <span className="flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5 text-violet-600" /> Pode aprovar exceções (alçadas)</span>
                  <Switch checked={form.can_approve} onCheckedChange={(v) => set("can_approve", v)} />
                </label>

                <Field label="Observações"><Textarea rows={2} value={form.notes} placeholder="Ex.: sócia-administradora — alteração societária formalizada" onChange={(e) => set("notes", e.target.value)} /></Field>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setForm(null)} disabled={upsert.isPending}>Cancelar</Button>
                <Button onClick={save} disabled={upsert.isPending}>
                  {upsert.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Save className="h-4 w-4 mr-1" />} Salvar
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Revogar */}
      <AlertDialog open={!!revokeTarget} onOpenChange={(o) => { if (!o && !setStatus.isPending) setRevokeTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revogar a procuração de {revokeTarget?.signer_name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Ela deixa de assinar e de aprovar exceções. Se era a padrão, escolha outra procuração como padrão depois. Dá pra reativar quando quiser.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={setStatus.isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); void confirmRevoke(); }} disabled={setStatus.isPending}>
              {setStatus.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Ban className="h-4 w-4 mr-1" />} Revogar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

// ─── (a) Entidade jurídica ──────────────────────────────────────────────────

interface EntityForm {
  legal_name: string; trade_name: string; cnpj: string; address: string; city_name: string; state: string; zip: string;
  phone: string; email: string; contract_city: string; signer_name: string; signer_cpf: string; signer_role: LegalEntitySignerRole | "";
  signer_email: string;
  /** só dígitos */
  signer_phone: string;
}

const emptyEntityForm = (): EntityForm => ({
  legal_name: "", trade_name: "", cnpj: "", address: "", city_name: "", state: "", zip: "", phone: "", email: "",
  contract_city: "", signer_name: "", signer_cpf: "", signer_role: "", signer_email: "", signer_phone: "",
});

function toEntityForm(e: LegalEntity | null): EntityForm {
  if (!e) return emptyEntityForm();
  return {
    legal_name: e.legal_name ?? "",
    trade_name: e.trade_name ?? "",
    cnpj: e.cnpj ? maskCnpj(e.cnpj) : "",
    address: e.address ?? "",
    city_name: e.city_name ?? "",
    state: e.state ?? "",
    zip: e.zip ? maskCep(e.zip) : "",
    phone: e.phone ?? "",
    email: e.email ?? "",
    contract_city: e.contract_city ?? "",
    signer_name: e.signer_name ?? "",
    signer_cpf: e.signer_cpf ? maskCpf(e.signer_cpf) : "",
    signer_role: e.signer_role ?? "",
    signer_email: e.signer_email ?? "",
    signer_phone: onlyDigits(e.signer_phone),
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function Field({ label, hint, className, children }: { label: string; hint?: string; className?: string; children: ReactNode }) {
  return (
    <div className={cn("space-y-1", className)}>
      <Label className="text-xs">{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function LegalEntityCard() {
  const { isAdmin, isSuperAdmin } = useAuth();
  const canEdit = isAdmin || isSuperAdmin;
  const entitiesQ = useLegalEntities();
  const save = useSaveLegalEntity();
  const entities = useMemo(() => (entitiesQ.data ?? []).filter((e) => e.is_active), [entitiesQ.data]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const entity = useMemo(
    () => entities.find((e) => e.id === selectedId) ?? entities.find((e) => e.is_default) ?? entities[0] ?? null,
    [entities, selectedId],
  );
  const [f, setF] = useState<EntityForm>(() => toEntityForm(entity));
  const [dirty, setDirty] = useState(false);

  useEffect(() => { if (!dirty) setF(toEntityForm(entity)); }, [entity, dirty]);

  const set = (k: keyof EntityForm, v: string) => { setF((p) => ({ ...p, [k]: v })); setDirty(true); };
  const readOnly = !canEdit;

  const onSave = async () => {
    if (!f.legal_name.trim()) { toast.error("Informe a razão social."); return; }
    if (f.cnpj && f.cnpj.replace(/\D/g, "").length !== 14) { toast.error("CNPJ precisa ter 14 dígitos."); return; }
    if (f.signer_cpf && f.signer_cpf.replace(/\D/g, "").length !== 11) { toast.error("CPF de quem assina precisa ter 11 dígitos."); return; }
    if (f.signer_name && !f.signer_role) { toast.error("Informe em que qualidade a pessoa assina (Administradora, Procurador…)."); return; }
    if (f.signer_email && !EMAIL_RE.test(f.signer_email.trim())) { toast.error("E-mail de quem assina parece inválido."); return; }
    if (f.signer_phone && (f.signer_phone.length < 10 || f.signer_phone.length > 13)) { toast.error("Telefone de quem assina precisa ter DDD + número (10 ou 11 dígitos)."); return; }
    try {
      const saved = await save.mutateAsync({
        id: entity?.id,
        legal_name: f.legal_name,
        trade_name: f.trade_name,
        cnpj: f.cnpj,
        address: f.address,
        city_name: f.city_name,
        state: f.state,
        zip: f.zip,
        phone: f.phone,
        email: f.email,
        contract_city: f.contract_city,
        signer_name: f.signer_name,
        signer_cpf: f.signer_cpf,
        signer_role: f.signer_role || null,
        signer_email: f.signer_email,
        signer_phone: f.signer_phone,
      });
      setDirty(false);
      setSelectedId(saved.id);
      toast.success("Entidade jurídica salva. Os contratos novos já usam esses dados.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui salvar a entidade jurídica.");
    }
  };

  const signerMissing = !f.signer_name || !f.signer_cpf || !f.signer_role;
  const signerContactMissing = !signerMissing && !f.signer_email && !f.signer_phone;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base flex items-center gap-2"><Building2 className="h-4 w-4 text-sky-600" /> Entidade jurídica</CardTitle>
            <CardDescription className="mt-1">
              Razão social, CNPJ e endereço que aparecem como INTERMEDIADORA no contrato, e quem assina pela empresa.
            </CardDescription>
          </div>
          {entities.length > 1 && (
            <Select value={entity?.id ?? ""} onValueChange={(v) => { setSelectedId(v); setDirty(false); }}>
              <SelectTrigger className="h-8 w-[220px]"><SelectValue placeholder="Entidade" /></SelectTrigger>
              <SelectContent>
                {entities.map((e) => <SelectItem key={e.id} value={e.id}>{e.trade_name ?? e.legal_name}{e.is_default ? " (padrão)" : ""}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {entitiesQ.isLoading ? (
          <p className="text-xs text-muted-foreground flex items-center gap-1"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Carregando…</p>
        ) : (
          <>
            {!entity && (
              <p className="text-xs rounded-md border border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 px-3 py-2">
                Nenhuma entidade cadastrada ainda. Sem ela o contrato não sai — preencha e salve.
              </p>
            )}
            {readOnly && (
              <p className="text-[11px] text-muted-foreground flex items-center gap-1"><Lock className="h-3 w-3" /> Só admin altera esses dados.</p>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Razão social *"><Input className="h-9" value={f.legal_name} disabled={readOnly} placeholder="Ex.: Totex Digital Mídia Ltda" onChange={(e) => set("legal_name", e.target.value)} /></Field>
              <Field label="Nome fantasia (marca)"><Input className="h-9" value={f.trade_name} disabled={readOnly} placeholder="Ex.: TotexMotors" onChange={(e) => set("trade_name", e.target.value)} /></Field>
              <Field label="CNPJ"><Input inputMode="numeric" className="h-9" value={f.cnpj} disabled={readOnly} placeholder="00.000.000/0000-00" onChange={(e) => set("cnpj", maskCnpj(e.target.value))} /></Field>
              <Field label="CEP"><Input inputMode="numeric" className="h-9" value={f.zip} disabled={readOnly} placeholder="00000-000" onChange={(e) => set("zip", maskCep(e.target.value))} /></Field>
              <Field label="Endereço completo" className="sm:col-span-2"><Input className="h-9" value={f.address} disabled={readOnly} placeholder="Rua, número, complemento, bairro" onChange={(e) => set("address", e.target.value)} /></Field>
              <div className="grid grid-cols-[1fr_72px] gap-2">
                <Field label="Cidade"><Input className="h-9" value={f.city_name} disabled={readOnly} placeholder="Ex.: Barueri" onChange={(e) => set("city_name", e.target.value)} /></Field>
                <Field label="UF"><Input className="h-9 uppercase" value={f.state} disabled={readOnly} placeholder="SP" maxLength={2} onChange={(e) => set("state", maskUF(e.target.value))} /></Field>
              </div>
              <Field label="Cidade do contrato" hint="Aparece em “Local e data” na assinatura. Vazio = mesma cidade acima."><Input className="h-9" value={f.contract_city} disabled={readOnly} placeholder="Ex.: Barueri" onChange={(e) => set("contract_city", e.target.value)} /></Field>
              <Field label="Telefone"><Input inputMode="tel" className="h-9" value={f.phone} disabled={readOnly} placeholder="(11) 0000-0000" onChange={(e) => set("phone", e.target.value)} /></Field>
              <Field label="E-mail"><Input type="email" className="h-9" value={f.email} disabled={readOnly} placeholder="contato@empresa.com.br" onChange={(e) => set("email", e.target.value)} /></Field>
            </div>

            <div className="rounded-md border border-border/60 p-3 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium flex items-center gap-1.5"><Scale className="h-4 w-4 text-violet-600" /> Quem assina pela empresa</p>
                {signerMissing ? (
                  <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300 text-[11px]">Incompleto — o contrato não gera</Badge>
                ) : signerContactMissing ? (
                  <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300 text-[11px]">Sem e-mail/telefone — não recebe convite de assinatura</Badge>
                ) : (
                  <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300 text-[11px]"><CheckCircle2 className="h-3 w-3 mr-1" /> Completo</Badge>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Field label="Nome *"><Input className="h-9" value={f.signer_name} disabled={readOnly} placeholder="Nome completo" onChange={(e) => set("signer_name", e.target.value)} /></Field>
                <Field label="CPF *"><Input inputMode="numeric" className="h-9" value={f.signer_cpf} disabled={readOnly} placeholder="000.000.000-00" onChange={(e) => set("signer_cpf", maskCpf(e.target.value))} /></Field>
                <Field label="Qualidade *">
                  <Select value={f.signer_role || "__none__"} disabled={readOnly} onValueChange={(v) => set("signer_role", v === "__none__" ? "" : v)}>
                    <SelectTrigger className="h-9"><SelectValue placeholder="Selecione" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Selecione…</SelectItem>
                      {SIGNER_ROLE_OPTIONS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="E-mail de quem assina" hint="Recebe o convite da assinatura eletrônica (Clicksign)." className="sm:col-span-2">
                  <Input type="email" className="h-9" value={f.signer_email} disabled={readOnly} placeholder="nome@empresa.com.br" onChange={(e) => set("signer_email", e.target.value.trim().toLowerCase())} />
                </Field>
                <Field label="Telefone/WhatsApp de quem assina" hint="Pra convite por WhatsApp/SMS.">
                  <Input type="tel" inputMode="tel" className="h-9" maxLength={19} value={maskPhoneBR(f.signer_phone)} disabled={readOnly} placeholder="(11) 99999-9999" onChange={(e) => set("signer_phone", onlyDigits(e.target.value))} />
                </Field>
              </div>
              <p className="text-[11px] text-muted-foreground flex items-start gap-1"><Info className="h-3 w-3 shrink-0 mt-0.5" /> Administrador(a) = sócio com poderes no contrato social. Procurador(a) = tem procuração vigente. Na fase de alçadas isso passa a ser validado automaticamente. E-mail/telefone daqui viram o contato do signatário da empresa nos contratos gerados a partir de agora.</p>
            </div>

            {canEdit && (
              <div className="flex items-center justify-end gap-2">
                {dirty && <span className="text-[11px] text-muted-foreground">Alterações não salvas</span>}
                <Button size="sm" onClick={onSave} disabled={save.isPending}>
                  {save.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Save className="h-4 w-4 mr-1" />} Salvar entidade
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── (b) Templates de contrato ──────────────────────────────────────────────

const TEMPLATE_STATUS_CLS: Record<ContractTemplateStatus, string> = {
  draft: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900",
  published: "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900",
  retired: "bg-muted text-muted-foreground border-border",
};

interface NewVersionForm {
  document_type: ContractDocumentType;
  name: string;
  body: string;
  required_variables: string;
  notes: string;
  /** true = global (Totex); false = do tenant atual */
  global: boolean;
  version: number;
}

function ContractTemplatesCard() {
  const { isSuperAdmin, tenantId } = useAuth();
  const templatesQ = useContractTemplates();
  const saveTemplate = useSaveContractTemplate();
  const templates = useMemo(() => templatesQ.data ?? [], [templatesQ.data]);
  const [viewing, setViewing] = useState<ContractTemplate | null>(null);
  const [draft, setDraft] = useState<NewVersionForm | null>(null);
  const [publishTarget, setPublishTarget] = useState<ContractTemplate | null>(null);

  // Agrupa por tipo, versão mais nova primeiro (a query já ordena)
  const byType = useMemo(() => {
    const m = new Map<ContractDocumentType, ContractTemplate[]>();
    templates.forEach((t) => { const arr = m.get(t.document_type) ?? []; arr.push(t); m.set(t.document_type, arr); });
    return Array.from(m.entries());
  }, [templates]);

  const scopeOf = (t: ContractTemplate) => (t.tenant_id == null ? "Totex (global)" : "Sua loja");

  const startNewVersion = (type: ContractDocumentType, global: boolean) => {
    const sameScope = templates.filter((t) => t.document_type === type && (global ? t.tenant_id == null : t.tenant_id === tenantId));
    const current = sameScope.find((t) => t.status === "published") ?? sameScope[0] ?? null;
    const maxVersion = sameScope.reduce((acc, t) => Math.max(acc, t.version), 0);
    setDraft({
      document_type: type,
      name: current?.name ?? DOCUMENT_TYPE_LABEL[type],
      body: current?.body ?? "",
      required_variables: (current?.required_variables ?? []).join(", "),
      notes: "",
      global,
      version: maxVersion + 1,
    });
  };

  const saveDraft = async () => {
    if (!draft) return;
    if (!draft.name.trim()) { toast.error("Dê um nome ao template."); return; }
    if (draft.body.trim().length < 50) { toast.error("O texto do contrato está curto demais."); return; }
    const vars = draft.required_variables.split(",").map((s) => s.trim()).filter(Boolean);
    try {
      await saveTemplate.mutateAsync({
        action: "create_draft",
        document_type: draft.document_type,
        name: draft.name.trim(),
        body: draft.body,
        required_variables: vars,
        notes: draft.notes.trim() || null,
        tenant_id: draft.global ? null : tenantId,
        version: draft.version,
      });
      toast.success(`Rascunho v${draft.version} salvo. Revise e publique quando estiver pronto.`);
      setDraft(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui salvar o rascunho.");
    }
  };

  const publish = async () => {
    if (!publishTarget) return;
    try {
      await saveTemplate.mutateAsync({ action: "publish", id: publishTarget.id });
      toast.success(`Template v${publishTarget.version} publicado. A versão anterior foi aposentada.`);
      setPublishTarget(null);
      setViewing(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui publicar o template.");
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2"><FileText className="h-4 w-4 text-emerald-600" /> Templates de contrato</CardTitle>
        <CardDescription className="mt-1">
          Templates são jurídicos: quem opera preenche variáveis, não edita cláusulas. Cada publicação vira uma versão imutável e aposenta a anterior.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {templatesQ.isLoading ? (
          <p className="text-xs text-muted-foreground flex items-center gap-1"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Carregando…</p>
        ) : byType.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nenhum template disponível ainda.</p>
        ) : (
          byType.map(([type, list]) => {
            const current = list.find((t) => t.status === "published" && t.tenant_id === tenantId) ?? list.find((t) => t.status === "published" && t.tenant_id == null) ?? null;
            return (
              <div key={type} className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">
                    {DOCUMENT_TYPE_LABEL[type] ?? type}
                    {current && <span className="text-xs text-muted-foreground font-normal"> · vigente: v{current.version} ({scopeOf(current)})</span>}
                  </p>
                  {isSuperAdmin && (
                    <div className="flex gap-1.5">
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => startNewVersion(type, true)}>
                        <Plus className="h-3.5 w-3.5 mr-1" /> Nova versão (global)
                      </Button>
                      {tenantId && (
                        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => startNewVersion(type, false)}>
                          <Plus className="h-3.5 w-3.5 mr-1" /> Nova versão (esta loja)
                        </Button>
                      )}
                    </div>
                  )}
                </div>
                <div className="overflow-x-auto rounded-md border border-border/60">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-xs">Versão</TableHead>
                        <TableHead className="text-xs">Nome</TableHead>
                        <TableHead className="text-xs">Escopo</TableHead>
                        <TableHead className="text-xs">Status</TableHead>
                        <TableHead className="text-xs">Vigente desde</TableHead>
                        <TableHead className="text-xs text-right">Ações</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {list.map((t) => (
                        <TableRow key={t.id}>
                          <TableCell className="text-xs font-mono">v{t.version}</TableCell>
                          <TableCell className="text-xs max-w-[260px] truncate" title={t.name}>{t.name}</TableCell>
                          <TableCell className="text-xs">{scopeOf(t)}</TableCell>
                          <TableCell><Badge variant="outline" className={cn("border text-[11px]", TEMPLATE_STATUS_CLS[t.status])}>{CONTRACT_TEMPLATE_STATUS_LABEL[t.status]}</Badge></TableCell>
                          <TableCell className="text-xs text-muted-foreground">{t.status === "retired" ? `${fmtDate(t.effective_from)} → ${fmtDate(t.retired_at)}` : fmtDate(t.effective_from ?? (t.status === "draft" ? null : t.created_at))}</TableCell>
                          <TableCell className="text-right">
                            <div className="inline-flex gap-1">
                              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setViewing(t)}><Eye className="h-3.5 w-3.5 mr-1" /> Ver</Button>
                              {isSuperAdmin && t.status === "draft" && (
                                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setPublishTarget(t)}><Send className="h-3.5 w-3.5 mr-1" /> Publicar</Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            );
          })
        )}

        {!isSuperAdmin && (
          <p className="text-[11px] text-muted-foreground flex items-center gap-1"><Lock className="h-3 w-3" /> Só o superadmin cria e publica versões. Aqui você consulta o texto vigente e o histórico.</p>
        )}
      </CardContent>

      {/* Ver versão (somente leitura) */}
      <Dialog open={!!viewing} onOpenChange={(o) => { if (!o) setViewing(null); }}>
        <DialogContent className="sm:max-w-3xl max-h-[85vh] flex flex-col">
          {viewing && (
            <>
              <DialogHeader>
                <DialogTitle className="flex flex-wrap items-center gap-2">
                  {viewing.name} <span className="font-mono text-sm text-muted-foreground">v{viewing.version}</span>
                  <Badge variant="outline" className={cn("border text-[11px]", TEMPLATE_STATUS_CLS[viewing.status])}>{CONTRACT_TEMPLATE_STATUS_LABEL[viewing.status]}</Badge>
                </DialogTitle>
                <DialogDescription>
                  {DOCUMENT_TYPE_LABEL[viewing.document_type] ?? viewing.document_type} · {scopeOf(viewing)}
                  {viewing.effective_from ? ` · vigente desde ${fmtDate(viewing.effective_from)}` : ""}
                  {viewing.retired_at ? ` · aposentado em ${fmtDate(viewing.retired_at)}` : ""}
                </DialogDescription>
              </DialogHeader>
              {viewing.notes && <p className="text-xs text-muted-foreground rounded-md bg-muted/50 px-3 py-2">{viewing.notes}</p>}
              <div className="text-[11px] text-muted-foreground">
                Variáveis obrigatórias ({viewing.required_variables.length}): <code className="break-all">{viewing.required_variables.join(", ") || "—"}</code>
              </div>
              <div className="flex-1 min-h-0 overflow-auto rounded-md border border-border/60 bg-muted/30 p-3">
                <pre className="text-xs whitespace-pre-wrap break-words font-mono leading-relaxed">{viewing.body}</pre>
              </div>
              <DialogFooter>
                {isSuperAdmin && viewing.status === "draft" && (
                  <Button variant="outline" onClick={() => setPublishTarget(viewing)}><Send className="h-4 w-4 mr-1" /> Publicar v{viewing.version}</Button>
                )}
                <Button onClick={() => setViewing(null)}>Fechar</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Nova versão (superadmin) */}
      <Dialog open={!!draft} onOpenChange={(o) => { if (!o && !saveTemplate.isPending) setDraft(null); }}>
        <DialogContent className="sm:max-w-3xl max-h-[90vh] flex flex-col">
          {draft && (
            <>
              <DialogHeader>
                <DialogTitle>Nova versão — {DOCUMENT_TYPE_LABEL[draft.document_type]} v{draft.version} ({draft.global ? "global" : "esta loja"})</DialogTitle>
                <DialogDescription>
                  Começa como <strong>rascunho</strong> (o texto abaixo é uma cópia da versão vigente). Só passa a valer quando você publicar.
                </DialogDescription>
              </DialogHeader>
              <div className="flex-1 min-h-0 overflow-auto space-y-3 pr-1">
                <Field label="Nome *"><Input className="h-9" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
                <Field label="Variáveis obrigatórias (separadas por vírgula)" hint="Se alguma dessas ficar vazia na intermediação, o contrato não gera e a tela mostra “Falta: …”.">
                  <Textarea rows={2} className="font-mono text-xs" value={draft.required_variables} onChange={(e) => setDraft({ ...draft, required_variables: e.target.value })} />
                </Field>
                <Field label="Texto do contrato *" hint="Markdown-lite: # títulos, **negrito**, - listas, {{variavel}} e [[signature:owner]] / [[signature:company]] nos blocos de assinatura.">
                  <Textarea rows={18} className="font-mono text-xs leading-relaxed" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
                </Field>
                <Field label="Notas da versão (o que mudou)"><Textarea rows={2} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} placeholder="Ex.: revisão da cláusula 8.1 pelo jurídico" /></Field>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDraft(null)} disabled={saveTemplate.isPending}>Cancelar</Button>
                <Button onClick={saveDraft} disabled={saveTemplate.isPending}>
                  {saveTemplate.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Save className="h-4 w-4 mr-1" />} Salvar rascunho
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Publicar (imutável) */}
      <AlertDialog open={!!publishTarget} onOpenChange={(o) => { if (!o && !saveTemplate.isPending) setPublishTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Publicar v{publishTarget?.version} de "{publishTarget?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              A versão vigente de <strong>{publishTarget ? DOCUMENT_TYPE_LABEL[publishTarget.document_type] : ""}</strong> ({publishTarget ? scopeOf(publishTarget) : ""}) é aposentada na hora e os contratos novos passam a usar este texto.
              Depois de publicado o texto fica <strong>imutável</strong> — pra mudar qualquer cláusula é preciso criar outra versão.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saveTemplate.isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); void publish(); }} disabled={saveTemplate.isPending}>
              {saveTemplate.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Send className="h-4 w-4 mr-1" />} Publicar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
