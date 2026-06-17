// Utilitários de telefone (padrão Brasil)
// Máscara visual: (11) 96182-8095  |  (11) 6182-8095 (fixo)
// Armazenamento: somente dígitos (ex: 11961828095)

/** Remove tudo que não for dígito. */
export function onlyDigits(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

/** Formata a parte nacional: (11) 96182-8095 (celular) ou (11) 6182-8095 (fixo). */
function maskNational(digits: string): string {
  if (digits.length === 0) return "";
  if (digits.length <= 2) return `(${digits}`;

  const ddd = digits.slice(0, 2);
  const rest = digits.slice(2);

  // Número local: até 4 dígitos antes do hífen (fixo) ou 5 (celular com 9)
  const breakPoint = rest.length > 8 ? 5 : 4;

  if (rest.length <= breakPoint) {
    return `(${ddd}) ${rest}`;
  }

  return `(${ddd}) ${rest.slice(0, breakPoint)}-${rest.slice(breakPoint)}`;
}

/**
 * Aplica a máscara de telefone brasileiro progressivamente, conforme o usuário digita.
 *
 * - Número nacional (até 11 dígitos): (11) 96182-8095
 * - Com código do país 55 (12-13 dígitos): +55 (11) 96182-8095
 *
 * Preservar o código do país evita corromper números de lead já salvos como
 * 5511961828095 (o WhatsApp envia/recebe com o 55).
 */
export function maskPhoneBR(value: string | null | undefined): string {
  let digits = onlyDigits(value);

  // Número com código do país (55): mantém o 55 e formata o resto como nacional.
  if (digits.length >= 12 && digits.startsWith("55")) {
    digits = digits.slice(0, 13); // 55 + 2 DDD + 9 número
    return `+55 ${maskNational(digits.slice(2))}`;
  }

  return maskNational(digits.slice(0, 11));
}

/**
 * Formata para exibição um telefone que pode vir cru, com máscara, ou com código do país (55).
 * Útil para mostrar números salvos. Mantém o + e o código do país quando presente.
 */
export function formatPhoneDisplay(value: string | null | undefined): string {
  const digits = onlyDigits(value);
  if (!digits) return "";
  return maskPhoneBR(digits) || digits;
}
