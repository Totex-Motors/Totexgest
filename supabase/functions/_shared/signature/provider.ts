// INTERMEDIAÇÃO — Fase 3: contrato do provedor de assinatura eletrônica.
//
// Toda edge function fala com o provedor SÓ por esta interface. A implementação
// atual é a Clicksign (clicksign.ts); trocar de provedor = nova classe aqui,
// sem tocar em contract-send / clicksign-webhook / contract-reconcile.
//
// Regras que valem pra qualquer implementação:
//   • nunca logar token, secret, HMAC ou conteúdo do PDF — só ids, status e tamanhos;
//   • "completed" do provedor NÃO formaliza nada: quem formaliza é a rotina de
//     reconciliação (reconcile.ts), depois de baixar e conferir o PDF assinado.

export type SignerChannel = "email" | "whatsapp" | "sms";
export type SignerAuth = "email" | "whatsapp" | "sms" | "pix";
export type EnvelopeStatus = "draft" | "running" | "closed" | "canceled";
export type ProviderEventType =
  | "created" | "sent" | "viewed" | "signed" | "refused" | "completed" | "canceled" | "expired" | "error" | "info";

export interface EnvelopeSignerInput {
  /** Referência local (contract_signers.id) — volta em CreateEnvelopeResult.signers[].ref */
  ref: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  cpf?: string | null;
  channel: SignerChannel;
  auth: SignerAuth;
}

export interface CreateEnvelopeInput {
  name: string;
  /** ISO 8601 */
  deadlineAt: string;
  pdfBytes: Uint8Array;
  filename: string;
  signers: EnvelopeSignerInput[];
  message?: string | null;
}

export interface CreateEnvelopeResult {
  envelopeId: string;
  documentId: string;
  signers: { ref: string; providerSignerId: string }[];
  /** Avisos não fatais (ex.: notificação falhou mas o envelope está ativo) */
  warnings: string[];
}

export interface EnvelopeSignerStatus {
  providerSignerId: string;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  /** unknown = provedor não expôs status por signatário */
  status: "pending" | "viewed" | "signed" | "refused" | "unknown";
  signedAt?: string | null;
  refusedAt?: string | null;
  refusalReason?: string | null;
}

export interface EnvelopeStatusResult {
  status: EnvelopeStatus;
  updatedAt?: string | null;
  deadlineAt?: string | null;
  documentId?: string | null;
  documentStatus?: string | null;
  signers: EnvelopeSignerStatus[];
  /** URL do PDF assinado (só quando closed). Pode ser presigned (S3) ou relativa ao provedor. */
  signedFileUrl?: string | null;
  raw: unknown;
}

export interface ParsedWebhook {
  providerEventId?: string;
  eventType: ProviderEventType;
  rawEventName: string;
  /** provider_signer_id, e-mail ou telefone do signatário afetado */
  signerRef?: string;
  signerEmail?: string;
  signerPhone?: string;
  signerKey?: string;
  occurredAt?: string;
  /** id/key do documento no provedor */
  documentRef?: string;
  envelopeRef?: string;
  providerStatus?: string;
  signedFileUrl?: string;
  /** motivo (recusa / cancelamento) já extraído */
  reason?: string;
  /** payload compacto que vai pra contract_events.payload (sem PDF, sem secret) */
  payload: Record<string, unknown>;
}

export interface WebhookRegistration {
  webhookId: string;
  secret: string;
  endpoint: string;
  events: string[];
}

export interface SignatureProvider {
  readonly name: string;
  readonly env: "sandbox" | "production";
  createEnvelope(input: CreateEnvelopeInput): Promise<CreateEnvelopeResult>;
  getStatus(envelopeId: string, documentId?: string | null): Promise<EnvelopeStatusResult>;
  cancel(envelopeId: string, reason?: string | null): Promise<void>;
  notify(envelopeId: string, message?: string | null): Promise<{ notified: number }>;
  registerWebhook(endpoint: string): Promise<WebhookRegistration>;
  verifyWebhook(rawBody: string, headers: Headers, secret: string): Promise<boolean>;
  parseWebhook(body: unknown): ParsedWebhook;
  /** Baixa o PDF assinado (URL presigned ou relativa ao provedor). */
  downloadFile(url: string): Promise<Uint8Array>;
  testConnection(): Promise<{ ok: boolean; env: string; detail?: string }>;
}

/** Erro vindo do provedor: status HTTP + corpo resumido (sem token). */
export class SignatureProviderError extends Error {
  constructor(message: string, readonly status: number = 0, readonly body: string = "", readonly code: string = "provider_error") {
    super(message);
    this.name = "SignatureProviderError";
  }
}

/** Erro de configuração (chave ausente etc.) — mensagem já pronta pra UI. */
export class SignatureConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignatureConfigError";
  }
}
