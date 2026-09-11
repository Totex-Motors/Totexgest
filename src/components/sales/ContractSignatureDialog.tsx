import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Building2, Loader2, Send, Settings2, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { maskPhoneBR, onlyDigits } from "@/lib/phone";
import { ContractSendError, useContractSend, type ContractSendSignerInput } from "@/hooks/useIntermediation";
import {
  SIGNER_AUTH_LABEL,
  SIGNER_CHANNEL_LABEL,
  SIGNER_PARTY_LABEL,
  type ContractDocument,
  type ContractSigner,
  type ContractSignerAuthMethod,
  type ContractSignerChannel,
} from "@/types/intermediation";

/**
 * "Enviar para assinatura" (fase 3 — Clicksign). Lista os signatários previstos do
 * documento (proprietário + quem assina pela empresa) com contato editável, canal do
 * convite, forma de autenticação, prazo e mensagem. A edge fn `contract-send`
 * (action `send`) cria o envelope e marca o doc como `sent`.
 */

interface SignerForm {
  signer_id: string;
  party_type: ContractSigner["party_type"];
  name: string;
  cpf_cnpj: string | null;
  email: string;
  /** só dígitos */
  phone: string;
  channel: ContractSignerChannel;
  auth_method: ContractSignerAuthMethod;
}

const CHANNELS = Object.keys(SIGNER_CHANNEL_LABEL) as ContractSignerChannel[];
const AUTHS = Object.keys(SIGNER_AUTH_LABEL) as ContractSignerAuthMethod[];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const needsEmail = (s: Pick<SignerForm, "channel" | "auth_method">) => s.channel === "email" || s.auth_method === "email";
const needsPhone = (s: Pick<SignerForm, "channel" | "auth_method">) =>
  s.channel === "whatsapp" || s.channel === "sms" || s.auth_method === "whatsapp" || s.auth_method === "sms";

/** Canal padrão: WhatsApp se tiver telefone, senão e-mail. Autenticação acompanha o canal. */
function defaultChannel(s: ContractSigner): ContractSignerChannel {
  if (s.channel) return s.channel;
  return onlyDigits(s.phone) ? "whatsapp" : "email";
}

function toForm(s: ContractSigner): SignerForm {
  const channel = defaultChannel(s);
  const auth: ContractSignerAuthMethod = s.auth_method ?? (channel === "sms" ? "sms" : channel);
  return {
    signer_id: s.id,
    party_type: s.party_type,
    name: s.name,
    cpf_cnpj: s.cpf_cnpj,
    email: (s.email ?? "").trim().toLowerCase(),
    phone: onlyDigits(s.phone),
    channel,
    auth_method: auth,
  };
}

/** Erros de validação por signatário (vazio = ok). */
function validate(s: SignerForm): string[] {
  const errs: string[] = [];
  if (wordCount(s.name) < 2) errs.push("nome precisa ter nome e sobrenome");
  if (needsEmail(s) && !EMAIL_RE.test(s.email)) errs.push("e-mail válido é obrigatório pra esse canal/autenticação");
  if (needsPhone(s)) {
    const d = s.phone;
    const national = d.startsWith("55") && d.length >= 12 ? d.slice(2) : d;
    if (national.length < 10 || national.length > 11) errs.push("telefone com DDD é obrigatório pra WhatsApp/SMS");
  }
  return errs;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  doc: ContractDocument;
  intermediationCode: string;
  leadId: string;
  onSent?: (doc: ContractDocument) => void;
}

export function ContractSignatureDialog({ open, onOpenChange, doc, intermediationCode, leadId, onSent }: Props) {
  const send = useContractSend();
  const baseSigners = useMemo(
    () => [...(doc.contract_signers ?? [])].sort((a, b) => a.signing_order - b.signing_order),
    [doc.contract_signers],
  );
  const [signers, setSigners] = useState<SignerForm[]>(() => baseSigners.map(toForm));
  const [deadlineDays, setDeadlineDays] = useState("7");
  const [message, setMessage] = useState("");
  const [touched, setTouched] = useState(false);

  // Só ao ABRIR recomeça do que está no banco — refetch em segundo plano (React Query)
  // não pode apagar o que o usuário está digitando.
  const openedRef = useRef(false);
  useEffect(() => {
    if (open && !openedRef.current) {
      openedRef.current = true;
      setSigners(baseSigners.map(toForm));
      setDeadlineDays("7");
      setMessage("");
      setTouched(false);
    } else if (!open) {
      openedRef.current = false;
    }
  }, [open, baseSigners]);

  const setSigner = (id: string, patch: Partial<SignerForm>) =>
    setSigners((prev) => prev.map((s) => (s.signer_id === id ? { ...s, ...patch } : s)));

  const errors = useMemo(() => Object.fromEntries(signers.map((s) => [s.signer_id, validate(s)])), [signers]);
  const days = Number(deadlineDays);
  const daysOk = Number.isInteger(days) && days >= 1 && days <= 30;
  const hasErrors = signers.length === 0 || Object.values(errors).some((e) => e.length > 0) || !daysOk;

  const companyMissingContact = signers.some((s) => s.party_type === "company" && !s.email && !s.phone);

  const confirm = async () => {
    setTouched(true);
    if (!daysOk) { toast.error("Prazo precisa ficar entre 1 e 30 dias."); return; }
    if (hasErrors) { toast.error("Confira os dados dos signatários antes de enviar."); return; }
    const payload: ContractSendSignerInput[] = signers.map((s) => ({
      signer_id: s.signer_id,
      channel: s.channel,
      auth_method: s.auth_method,
      ...(s.email ? { email: s.email } : {}),
      ...(s.phone ? { phone: s.phone } : {}),
    }));
    try {
      const r = await send.mutateAsync({ documentId: doc.id, leadId, signers: payload, deadlineDays: days, message });
      toast.success(`Contrato v${doc.version} enviado pra assinatura. Os convites saem pelos canais escolhidos.`);
      onSent?.(r.document);
      onOpenChange(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Não consegui enviar o contrato pra assinatura.";
      const hint = e instanceof ContractSendError && e.status === 412 ? "Confira a chave da Clicksign em Configurações › Integrações." : undefined;
      toast.error(msg, hint ? { description: hint } : undefined);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!send.isPending) onOpenChange(o); }}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Enviar para assinatura — {intermediationCode}</DialogTitle>
          <DialogDescription>
            O contrato <strong>v{doc.version}</strong> vai pra Clicksign e cada signatário recebe um convite pelo canal escolhido.
            Quando todos assinarem, o PDF assinado é baixado, conferido (hash) e a intermediação é <strong>formalizada automaticamente</strong>.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-auto space-y-3 pr-1">
          {signers.length === 0 && (
            <p className="text-xs rounded-md border border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 px-3 py-2">
              Esse documento não tem signatários previstos. Regenere o contrato pra recriar a lista.
            </p>
          )}
          {companyMissingContact && (
            <p className="text-xs rounded-md border border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 px-3 py-2 flex items-start gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>
                Quem assina pela empresa está sem e-mail/telefone. Preencha em{" "}
                <a href="/configuracoes?s=intermediacao" className="underline inline-flex items-center gap-0.5"><Settings2 className="h-3 w-3" /> Configurações › Intermediação › Entidade jurídica</a>{" "}
                (ou informe abaixo só pra este envio).
              </span>
            </p>
          )}

          {signers.map((s) => {
            const errs = errors[s.signer_id] ?? [];
            const showErr = touched && errs.length > 0;
            const Icon = s.party_type === "company" ? Building2 : UserRound;
            return (
              <div key={s.signer_id} className={cn("rounded-md border p-3 space-y-2.5", showErr ? "border-red-300 dark:border-red-900" : "border-border/60")}>
                <p className="text-xs font-medium flex items-center gap-1.5 text-muted-foreground">
                  <Icon className="h-3.5 w-3.5" /> {SIGNER_PARTY_LABEL[s.party_type] ?? s.party_type}
                  {s.cpf_cnpj ? <span className="font-normal">· {s.cpf_cnpj}</span> : <span className="font-normal text-amber-700 dark:text-amber-300">· sem CPF (assina sem validação de documento)</span>}
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="space-y-1 sm:col-span-3">
                    <Label className="text-xs">Nome completo *</Label>
                    <Input className="h-9" value={s.name} onChange={(e) => setSigner(s.signer_id, { name: e.target.value })} placeholder="Nome e sobrenome" />
                  </div>
                  <div className="space-y-1 sm:col-span-2">
                    <Label className="text-xs">E-mail{needsEmail(s) ? " *" : ""}</Label>
                    <Input type="email" className="h-9" value={s.email} onChange={(e) => setSigner(s.signer_id, { email: e.target.value.trim().toLowerCase() })} placeholder="nome@email.com" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Telefone / WhatsApp{needsPhone(s) ? " *" : ""}</Label>
                    <Input
                      type="tel"
                      inputMode="tel"
                      className="h-9"
                      maxLength={19}
                      value={maskPhoneBR(s.phone)}
                      onChange={(e) => setSigner(s.signer_id, { phone: onlyDigits(e.target.value) })}
                      placeholder="(11) 99999-9999"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Convite por</Label>
                    <Select
                      value={s.channel}
                      onValueChange={(v) => {
                        const channel = v as ContractSignerChannel;
                        // autenticação acompanha o canal, a menos que o usuário tenha escolhido PIX
                        setSigner(s.signer_id, { channel, auth_method: s.auth_method === "pix" ? "pix" : channel });
                      }}
                    >
                      <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {CHANNELS.map((c) => <SelectItem key={c} value={c}>{SIGNER_CHANNEL_LABEL[c]}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1 sm:col-span-2">
                    <Label className="text-xs">Autenticação na assinatura</Label>
                    <Select value={s.auth_method} onValueChange={(v) => setSigner(s.signer_id, { auth_method: v as ContractSignerAuthMethod })}>
                      <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {AUTHS.map((a) => <SelectItem key={a} value={a} disabled={a === "pix" && !s.cpf_cnpj}>{SIGNER_AUTH_LABEL[a]}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {showErr && <p className="text-[11px] text-red-700 dark:text-red-300">Falta: {errs.join(" · ")}.</p>}
              </div>
            );
          })}

          <div className="grid grid-cols-1 sm:grid-cols-[140px_1fr] gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Prazo pra assinar (dias) *</Label>
              <Input type="number" inputMode="numeric" min={1} max={30} className="h-9" value={deadlineDays} onChange={(e) => setDeadlineDays(e.target.value)} />
              <p className="text-[11px] text-muted-foreground">De 1 a 30 dias. Depois disso o envio expira.</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Mensagem no convite (opcional)</Label>
              <Textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Ex.: Olá! Segue o contrato de intermediação do seu carro pra assinatura. Qualquer dúvida, é só chamar." />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={send.isPending}>Cancelar</Button>
          <Button onClick={confirm} disabled={send.isPending || signers.length === 0}>
            {send.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Send className="h-4 w-4 mr-1" />} Enviar convites
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
