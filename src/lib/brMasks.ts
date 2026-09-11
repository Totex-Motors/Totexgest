/**
 * Máscaras leves de documentos/endereço brasileiros pra inputs.
 * Só formatam o que o usuário digita — o servidor normaliza de novo (regexp nas RPCs).
 */

export const onlyDigits = (s: string) => s.replace(/\D/g, "");

/** 000.000.000-00 (CPF) ou 00.000.000/0000-00 (CNPJ), conforme a quantidade de dígitos. */
export function maskCpfCnpj(raw: string): string {
  const d = onlyDigits(raw).slice(0, 14);
  if (d.length <= 11) {
    return d.replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d{1,2})$/, "$1-$2");
  }
  return d
    .replace(/^(\d{2})(\d)/, "$1.$2")
    .replace(/^(\d{2})\.(\d{3})(\d)/, "$1.$2.$3")
    .replace(/\.(\d{3})(\d)/, ".$1/$2")
    .replace(/(\d{4})(\d)/, "$1-$2");
}

/** 000.000.000-00 */
export const maskCpf = (raw: string) => maskCpfCnpj(onlyDigits(raw).slice(0, 11));

/** 00.000.000/0000-00 */
export function maskCnpj(raw: string): string {
  const d = onlyDigits(raw).slice(0, 14);
  return d
    .replace(/^(\d{2})(\d)/, "$1.$2")
    .replace(/^(\d{2})\.(\d{3})(\d)/, "$1.$2.$3")
    .replace(/\.(\d{3})(\d)/, ".$1/$2")
    .replace(/(\d{4})(\d)/, "$1-$2");
}

/** 00000-000 */
export const maskCep = (raw: string) => onlyDigits(raw).slice(0, 8).replace(/(\d{5})(\d)/, "$1-$2");

/** Placa Mercosul/antiga: 7 caracteres, maiúsculos, sem hífen. */
export const maskPlate = (raw: string) => raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 7);

/** Chassi (VIN): 17 caracteres alfanuméricos maiúsculos. */
export const maskChassis = (raw: string) => raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 17);

/** Renavam: 11 dígitos (9 nos documentos antigos). */
export const maskRenavam = (raw: string) => onlyDigits(raw).slice(0, 11);

/** UF: 2 letras maiúsculas. */
export const maskUF = (raw: string) => raw.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2);
