/**
 * consultar-fipe — tool do agente de texto (agent-runner).
 *
 * Chamada pelo agent-runner com body { arguments, user_id, session_id }. É só uma casca:
 * TODA consulta passa pela porta única `fipe-lookup` (regra de ouro em CLAUDE.md), com
 * `x-fipe-token` + tenant. Devolve texto curto pro agente falar: valor em reais + mês de
 * referência ("FIPE nov/2026"), ou os candidatos quando o modelo precisa ser confirmado.
 *
 * Vocabulário: FIPE é TABELA pública de referência — nunca "avaliação", nunca valor de troca.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "../_shared/config.ts";
import { getCaller, deny } from "../_shared/auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const HQ_TENANT = "c13681e3-5db9-48d1-9c5c-856e6041d77f";
const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const brl = (c: number) => (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const mesRef = (m: string | null | undefined) => {
  const [y, mm] = String(m || "").split("-");
  return y && mm ? `${MESES[Number(mm) - 1] || mm}/${y}` : "";
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "método" }, 405);
  const caller = await getCaller(req);
  if (!caller.ok) return deny();
  const body = await req.json().catch(() => ({}));
  const a = (body.arguments || body) as Record<string, unknown>;

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const token = await getIntegrationKey(sb, "FIPE_LOOKUP_TOKEN");
  if (!token) return json({ ok: false, erro: "FIPE_LOOKUP_TOKEN não configurado" });

  const payload: Record<string, unknown> = { tenant_id: String(a.tenant_id || body.tenant_id || HQ_TENANT) };
  for (const k of ["placa", "marca", "modelo", "ano", "combustivel", "codigo_fipe", "modelo_slug", "lead_id", "confirmar"]) if (a[k] != null && a[k] !== "") payload[k] = a[k];
  if (!payload.placa && !payload.codigo_fipe && !payload.modelo_slug && !(payload.marca || payload.modelo)) {
    return json({ ok: false, erro: "Informe placa OU marca + modelo + ano." });
  }

  const r = await fetch(`${SUPABASE_URL}/functions/v1/fipe-lookup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}`, "x-fipe-token": token },
    body: JSON.stringify(payload),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d?.ok === false) return json({ ok: false, erro: d?.error || d?.erro || `fipe-lookup ${r.status}` });

  if (d.precisa_confirmar_modelo) {
    const cands = (d.candidatos || []).slice(0, 5).map((c: any, i: number) => ({
      n: i + 1, nome: c.nome_modelo || c.label || c.modelo || c.name, codigo_fipe: c.codigo_fipe || c.code || null, model_slug: c.model_slug || c.slug || null, fuel_acronym: c.fuel_acronym || c.combustivel || null,
    }));
    return json({ ok: true, precisa_confirmar_modelo: true, candidatos: cands, instrucao: "Mostre as opções pro cliente escolher a versão dele (nunca escolha sozinho). Depois chame de novo com marca, modelo, ano e `confirmar` = {codigo_fipe, model_slug, fuel_acronym, nome_modelo} do escolhido." });
  }

  const v = d.veiculo || {};
  const preco = d.preco || {};
  const valor = Number(preco.valor_centavos || 0);
  const ref = mesRef(preco.mes_referencia);
  return json({
    ok: true,
    veiculo: `${[v.marca, v.modelo].filter(Boolean).join(" ")}${v.ano_modelo ? ` ${v.ano_modelo}` : ""}${v.combustivel ? ` ${v.combustivel}` : ""}`,
    fipe: valor ? brl(valor) : null,
    referencia: ref ? `FIPE ${ref}` : null,
    fonte: d.fonte || null,
    fala: valor ? `${[v.marca, v.modelo].filter(Boolean).join(" ")} ${v.ano_modelo || ""}: ${brl(valor)} na tabela FIPE de ${ref}.`.replace(/\s+/g, " ") : "Não achei esse modelo na FIPE.",
    aviso: "Tabela FIPE é referência pública de mercado. NÃO é avaliação e NÃO é o valor que o carro entra na troca — isso sai na avaliação na loja.",
  });
});
