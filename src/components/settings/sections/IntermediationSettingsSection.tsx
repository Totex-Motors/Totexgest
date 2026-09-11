import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Building2, CheckCircle2, Eye, FileText, Info, Loader2, Lock, Plus, Save, Scale, Send,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { useAuth } from "@/contexts/AuthContext";
import { useContractTemplates, useLegalEntities, useSaveContractTemplate, useSaveLegalEntity } from "@/hooks/useIntermediation";
import {
  CONTRACT_TEMPLATE_STATUS_LABEL,
  DOCUMENT_TYPE_LABEL,
  SIGNER_ROLE_OPTIONS,
  type ContractDocumentType,
  type ContractTemplate,
  type ContractTemplateStatus,
  type LegalEntity,
  type LegalEntitySignerRole,
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
      <ContractTemplatesCard />
    </div>
  );
}

// ─── (a) Entidade jurídica ──────────────────────────────────────────────────

interface EntityForm {
  legal_name: string; trade_name: string; cnpj: string; address: string; city_name: string; state: string; zip: string;
  phone: string; email: string; contract_city: string; signer_name: string; signer_cpf: string; signer_role: LegalEntitySignerRole | "";
}

const emptyEntityForm = (): EntityForm => ({
  legal_name: "", trade_name: "", cnpj: "", address: "", city_name: "", state: "", zip: "", phone: "", email: "",
  contract_city: "", signer_name: "", signer_cpf: "", signer_role: "",
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
  };
}

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
      });
      setDirty(false);
      setSelectedId(saved.id);
      toast.success("Entidade jurídica salva. Os contratos novos já usam esses dados.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui salvar a entidade jurídica.");
    }
  };

  const signerMissing = !f.signer_name || !f.signer_cpf || !f.signer_role;

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
              </div>
              <p className="text-[11px] text-muted-foreground flex items-start gap-1"><Info className="h-3 w-3 shrink-0 mt-0.5" /> Administrador(a) = sócio com poderes no contrato social. Procurador(a) = tem procuração vigente. Na fase de alçadas isso passa a ser validado automaticamente.</p>
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
