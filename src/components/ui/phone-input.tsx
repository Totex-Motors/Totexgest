import * as React from "react";

import { Input } from "@/components/ui/input";
import { maskPhoneBR, onlyDigits } from "@/lib/phone";

export interface PhoneInputProps
  extends Omit<React.ComponentProps<"input">, "onChange" | "value" | "type"> {
  /** Valor armazenado (somente dígitos). Aceita também valores já mascarados. */
  value: string | null | undefined;
  /** Recebe SOMENTE os dígitos (ex: "11961828095") para salvar no estado/banco. */
  onChange: (digits: string) => void;
}

/**
 * Input de telefone com máscara brasileira progressiva: (11) 96182-8095.
 * Exibe formatado, mas entrega apenas os dígitos no onChange.
 */
const PhoneInput = React.forwardRef<HTMLInputElement, PhoneInputProps>(
  ({ value, onChange, placeholder = "(11) 96182-8095", ...props }, ref) => {
    return (
      <Input
        ref={ref}
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        maxLength={19}
        placeholder={placeholder}
        value={maskPhoneBR(value)}
        onChange={(e) => onChange(onlyDigits(e.target.value))}
        {...props}
      />
    );
  },
);
PhoneInput.displayName = "PhoneInput";

export { PhoneInput };
