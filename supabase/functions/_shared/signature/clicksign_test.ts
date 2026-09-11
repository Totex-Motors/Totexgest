// Testes puros do adapter Clicksign (sem banco, sem rede).
//   deno run --allow-all supabase/functions/_shared/signature/clicksign_test.ts
// Cobre: mapeamento de eventos, parseWebhook (legado e JSON:API), HMAC, telefone, CPF.

import {
  describeJsonApiError, extractSignature, formatCpf, hasTwoWords, hmacSha256Hex, mapClicksignEvent, mapEnvelopeStatus,
  normalizePhoneBR, parseClicksignWebhook, sha256Hex, timingSafeEqual, verifyClicksignWebhook,
} from "./clicksign.ts";

let failures = 0;
function check(cond: boolean, label: string) {
  console.log(`${cond ? "ok " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

// ── 1) mapeamento de eventos ──
check(mapClicksignEvent("sign") === "signed", "sign → signed");
check(mapClicksignEvent("refusal") === "refused", "refusal → refused");
check(mapClicksignEvent("cancel") === "canceled", "cancel → canceled");
check(mapClicksignEvent("deadline") === "expired", "deadline → expired");
check(mapClicksignEvent("auto_close") === "completed" && mapClicksignEvent("close") === "completed" && mapClicksignEvent("document_closed") === "completed", "auto_close/close/document_closed → completed");
check(mapClicksignEvent("signature_started") === "viewed", "signature_started → viewed");
check(["upload", "add_signer", "update_deadline", "custom", "remove_signer", "xyz", ""].every((n) => mapClicksignEvent(n) === "info"), "demais → info");
check(mapEnvelopeStatus("running") === "running" && mapEnvelopeStatus("cancelled") === "canceled" && mapEnvelopeStatus(undefined) === "draft", "mapEnvelopeStatus tolerante");

// ── 2) parseWebhook — formato legado (event + document) ──
const legacySign = {
  event: {
    name: "sign",
    data: { signer: { key: "916487c8-9939-0000-0000-4cd7ffd8785b", email: "Maria@Empresa.com", phone_number: "11999999999", name: "Maria da Silva" }, account: { key: "acc" } },
    occurred_at: "2026-09-13T10:00:00.000-03:00",
  },
  document: {
    key: "db4a2cf7-0a48-481f-b669-54f2a2260ac2", status: "running", deadline_at: "2026-09-20T10:00:00.000-03:00",
    downloads: { original_file_url: "/2026/09/13/x.pdf", signed_file_url: null },
  },
};
const p1 = parseClicksignWebhook(legacySign);
check(p1.eventType === "signed" && p1.rawEventName === "sign", "legado sign: tipo");
check(p1.documentRef === "db4a2cf7-0a48-481f-b669-54f2a2260ac2", "legado sign: documentRef = document.key");
check(p1.signerKey === "916487c8-9939-0000-0000-4cd7ffd8785b" && p1.signerEmail === "maria@empresa.com" && p1.signerPhone === "11999999999", "legado sign: signatário (key, e-mail minúsculo, telefone)");
check(p1.signerRef === p1.signerKey, "legado sign: signerRef prefere a key");
check(p1.occurredAt === "2026-09-13T10:00:00.000-03:00", "legado sign: occurredAt");
check(p1.providerStatus === "running" && !p1.signedFileUrl, "legado sign: status e sem PDF assinado");
check(typeof p1.providerEventId === "string" && p1.providerEventId.startsWith("wh:sign:db4a2cf7"), "legado sign: providerEventId sintético estável");
check(parseClicksignWebhook(legacySign).providerEventId === p1.providerEventId, "legado sign: reenvio gera o mesmo providerEventId (idempotência)");
check(!("pdf" in p1.payload) && JSON.stringify(p1.payload).length < 600, "legado sign: payload compacto");

const legacyRefusal = {
  event: { name: "refusal", data: { signer: { key: "k2", email: "b@x.com" }, refusal: { reasons: ["Dados pessoais incorretos"], comment: "CPF errado" } } },
  document: { key: "doc-1", status: "canceled" },
};
const p2 = parseClicksignWebhook(legacyRefusal);
check(p2.eventType === "refused" && p2.reason === "Dados pessoais incorretos — CPF errado" && p2.payload.reason === p2.reason, "legado refusal: motivo (reasons + comment)");
check(p2.providerEventId === undefined, "legado refusal sem occurred_at: providerEventId vazio (RPC usa digest)");

const legacyClosed = {
  event: { name: "auto_close", data: {}, occurred_at: "2026-09-14T09:00:00Z" },
  document: { key: "doc-1", status: "closed", finished_at: "2026-09-14T09:00:00Z", downloads: { signed_file_url: "https://s3.example/signed.pdf?X-Amz-Signature=abc" } },
};
const p3 = parseClicksignWebhook(legacyClosed);
check(p3.eventType === "completed" && p3.signedFileUrl === "https://s3.example/signed.pdf?X-Amz-Signature=abc" && p3.payload.signed_file_available === true, "legado auto_close: completed + link do assinado");

const p4 = parseClicksignWebhook({ event: { name: "cancel", data: { user: { name: "Ana Souza" } } }, document: { key: "doc-1" } });
check(p4.eventType === "canceled" && p4.reason === "Cancelado na Clicksign por Ana Souza", "legado cancel: motivo com usuário");
const p5 = parseClicksignWebhook({ event: { name: "deadline", data: { reached_at: "2026-09-21T00:00:00Z" } }, document: { key: "doc-1" } });
check(p5.eventType === "expired" && p5.occurredAt === "2026-09-21T00:00:00Z", "legado deadline: expired + occurredAt de reached_at");

// ── 3) parseWebhook — JSON:API v3 ──
const v3 = {
  data: {
    id: "evt-123", type: "events",
    attributes: { name: "sign", data: { signer: { email: "c@x.com" } }, created: "2026-09-13T12:00:00Z" },
    relationships: { envelope: { data: { type: "envelopes", id: "env-9" } }, document: { data: { type: "documents", id: "doc-9" } }, signer: { data: { type: "signers", id: "sg-9" } } },
  },
};
const p6 = parseClicksignWebhook(v3);
check(p6.providerEventId === "evt-123" && p6.envelopeRef === "env-9" && p6.documentRef === "doc-9", "v3: ids do evento/envelope/documento");
check(p6.signerKey === "sg-9" && p6.signerRef === "sg-9" && p6.eventType === "signed" && p6.occurredAt === "2026-09-13T12:00:00Z", "v3: signatário via relationships");

const p7 = parseClicksignWebhook({ foo: "bar" });
check(p7.eventType === "info" && !p7.documentRef && !p7.envelopeRef, "payload desconhecido → info sem referência (webhook ignora)");
check(parseClicksignWebhook(null).eventType === "info" && parseClicksignWebhook("x").eventType === "info", "payload não-objeto não explode");

// ── 4) HMAC ──
const secret = "973d92ca80c2206a0e65b35d2371d595";
const rawBody = JSON.stringify(legacySign);
const good = await hmacSha256Hex(secret, rawBody);
check(/^[0-9a-f]{64}$/.test(good), "hmacSha256Hex: hex de 64");
check(await hmacSha256Hex("key", "The quick brown fox jumps over the lazy dog") === "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8", "hmacSha256Hex: vetor conhecido (RFC)");
check(await verifyClicksignWebhook(rawBody, new Headers({ "Content-Hmac": `sha256=${good}` }), secret), "verify: Content-Hmac sha256=<hex>");
check(await verifyClicksignWebhook(rawBody, new Headers({ "content-hmac": good.toUpperCase() }), secret), "verify: hex sem prefixo, maiúsculo");
check(await verifyClicksignWebhook(rawBody, new Headers({ "x-clicksign-signature": `sha256=${good}` }), secret), "verify: header alternativo");
check(!(await verifyClicksignWebhook(rawBody + " ", new Headers({ "Content-Hmac": `sha256=${good}` }), secret)), "verify: body alterado falha");
check(!(await verifyClicksignWebhook(rawBody, new Headers({ "Content-Hmac": `sha256=${good}` }), "outro")), "verify: secret errado falha");
check(!(await verifyClicksignWebhook(rawBody, new Headers(), secret)), "verify: sem header falha");
check(!(await verifyClicksignWebhook(rawBody, new Headers({ "Content-Hmac": "sha256=zz" }), secret)), "verify: header malformado falha");
check(!(await verifyClicksignWebhook(rawBody, new Headers({ "Content-Hmac": `sha256=${good}` }), "")), "verify: secret vazio falha");
const concat = await sha256Hex(rawBody + secret);
check(await verifyClicksignWebhook(rawBody, new Headers({ "Content-Hmac": `sha256=${concat}` }), secret), "verify: aceita SHA-256(body+secret) como fallback");
check(timingSafeEqual("abc", "abc") && !timingSafeEqual("abc", "abd") && !timingSafeEqual("abc", "ab"), "timingSafeEqual");
check(extractSignature(new Headers({ "Content-Hmac": ` sha256=${good} ` })) === good, "extractSignature: trim");

// ── 5) telefone / CPF / nome ──
check(normalizePhoneBR("(11) 99999-8888") === "11999998888", "telefone: máscara → 11 dígitos");
check(normalizePhoneBR("+55 11 99999-8888") === "11999998888", "telefone: remove DDI 55");
check(normalizePhoneBR("5511999998888") === "11999998888" && normalizePhoneBR("551133334444") === "1133334444", "telefone: 55 + 11/10 dígitos");
check(normalizePhoneBR("1133334444") === "1133334444", "telefone: fixo 10 dígitos");
check(normalizePhoneBR("999998888") === null && normalizePhoneBR("") === null && normalizePhoneBR(null) === null, "telefone: inválido → null");
check(formatCpf("12345678909") === "123.456.789-09" && formatCpf("123.456.789-09") === "123.456.789-09", "cpf: formata");
check(formatCpf("12345678000199") === null && formatCpf("11111111111") === null && formatCpf(null) === null, "cpf: CNPJ/repetido/nulo → null");
check(hasTwoWords("Maria da Silva") && hasTwoWords(" Ana  Souza ") && !hasTwoWords("Maria") && !hasTwoWords(""), "nome: ≥ 2 palavras");

// ── 6) erros JSON:API ──
check(describeJsonApiError(422, JSON.stringify({ errors: [{ detail: "não pode ficar em branco", source: { pointer: "/data/attributes/email" } }] })) === "Clicksign 422: email: não pode ficar em branco", "erro JSON:API legível");
check(describeJsonApiError(401, "<html>") .includes("401"), "erro 401 sem JSON");

console.log(failures ? `\n${failures} falha(s)` : "\ntodos os testes passaram");
if (failures) {
  const d = (globalThis as { Deno?: { exit(code: number): never } }).Deno;
  if (d) d.exit(1);
  throw new Error(`${failures} teste(s) falharam`);
}
