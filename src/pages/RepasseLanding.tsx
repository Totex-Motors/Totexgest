import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { maskPhoneBR, onlyDigits } from "@/lib/phone";
import { CheckCircle2, Loader2, MessageCircle, ShieldCheck, Car } from "lucide-react";

// REPASSE POR INDICAÇÃO — landing pública do cartão NFC (/r/:code)
//
// "Telinha que confirma o WhatsApp": a pessoa aproxima o cartão da promotora,
// abre esta tela, confirma o WhatsApp e recebe o link do grupo de repasses.
// A confirmação atrela o telefone à promotora (rastreio exato). Se essa pessoa
// comprar um carro pela intermediação, a promotora ganha R$ 150.
//
// Pública: não exige login. Chama a edge fn repasse-track (verify_jwt=false).

type Step = "loading" | "form" | "invalid" | "done";

export default function RepasseLanding() {
  const { code = "" } = useParams();
  const [step, setStep] = useState<Step>("loading");
  const [promoterName, setPromoterName] = useState<string>("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [groupLink, setGroupLink] = useState<string>("");

  // resolve o nome da promotora pelo código (GET)
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data, error } = await supabase.functions.invoke(
          `repasse-track?code=${encodeURIComponent(code)}`,
          { method: "GET" }
        );
        if (!alive) return;
        if (error || !data?.ok) { setStep("invalid"); return; }
        setPromoterName(data.promoter_name || "");
        setStep("form");
      } catch {
        if (alive) setStep("invalid");
      }
    })();
    return () => { alive = false; };
  }, [code]);

  const digits = onlyDigits(phone);
  const phoneOk = digits.length === 10 || digits.length === 11;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!phoneOk) { setError("Confira o número do seu WhatsApp (com DDD)."); return; }
    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke("repasse-track", {
        body: { code, phone: digits, name: name.trim() || null },
      });
      if (error) {
        let msg = "Não foi possível confirmar. Tente de novo.";
        try { const j = await (error as any).context?.json?.(); if (j?.error) msg = j.error; } catch { /* noop */ }
        setError(msg);
        return;
      }
      if (data && data.ok === false) { setError(data.error || "Não foi possível confirmar."); return; }
      setGroupLink(data?.group_link || "");
      setStep("done");
    } catch {
      setError("Não foi possível confirmar. Tente de novo.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-emerald-50 to-white flex flex-col items-center justify-center px-5 py-10">
      <div className="w-full max-w-md">
        {/* marca */}
        <div className="flex items-center justify-center gap-2 mb-6 text-emerald-700">
          <Car className="h-6 w-6" />
          <span className="font-bold text-lg tracking-tight">Totex Motors</span>
        </div>

        <div className="bg-white rounded-2xl shadow-xl border border-emerald-100 overflow-hidden">
          {step === "loading" && (
            <div className="p-10 flex flex-col items-center gap-3 text-slate-500">
              <Loader2 className="h-7 w-7 animate-spin text-emerald-600" />
              <p>Carregando seu convite…</p>
            </div>
          )}

          {step === "invalid" && (
            <div className="p-8 text-center">
              <div className="mx-auto mb-4 h-12 w-12 rounded-full bg-amber-100 flex items-center justify-center">
                <ShieldCheck className="h-6 w-6 text-amber-600" />
              </div>
              <h1 className="text-lg font-semibold text-slate-800">Convite não encontrado</h1>
              <p className="mt-2 text-sm text-slate-500">
                Esse cartão não está mais ativo. Peça um novo link para a promotora que te indicou.
              </p>
            </div>
          )}

          {step === "form" && (
            <form onSubmit={handleSubmit} className="p-7">
              <div className="text-center mb-5">
                <div className="mx-auto mb-3 h-14 w-14 rounded-full bg-emerald-100 flex items-center justify-center">
                  <MessageCircle className="h-7 w-7 text-emerald-600" />
                </div>
                <h1 className="text-xl font-bold text-slate-800">Grupo de Repasses</h1>
                <p className="mt-1 text-sm text-slate-500">
                  {promoterName
                    ? <>Você foi convidado por <span className="font-semibold text-emerald-700">{promoterName}</span>.</>
                    : "Você foi convidado para o grupo de repasses."}
                </p>
                <p className="mt-2 text-sm text-slate-500">
                  Confirme seu WhatsApp para entrar no grupo e receber as ofertas de carros.
                </p>
              </div>

              <label className="block text-sm font-medium text-slate-700 mb-1">Seu nome (opcional)</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Como podemos te chamar?"
                className="w-full mb-4 rounded-xl border border-slate-200 px-4 py-3 text-slate-800 outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
              />

              <label className="block text-sm font-medium text-slate-700 mb-1">Seu WhatsApp</label>
              <input
                type="tel"
                inputMode="numeric"
                value={phone}
                onChange={(e) => setPhone(maskPhoneBR(e.target.value))}
                placeholder="(11) 99999-9999"
                className="w-full rounded-xl border border-slate-200 px-4 py-3 text-slate-800 outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
                autoFocus
              />

              {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

              <button
                type="submit"
                disabled={submitting || !phoneOk}
                className="mt-5 w-full rounded-xl bg-emerald-600 py-3 font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {submitting ? <><Loader2 className="h-5 w-5 animate-spin" /> Confirmando…</> : "Confirmar e entrar no grupo"}
              </button>

              <p className="mt-4 text-center text-xs text-slate-400">
                Ao confirmar, você concorda em receber contatos sobre carros pelo WhatsApp.
              </p>
            </form>
          )}

          {step === "done" && (
            <div className="p-8 text-center">
              <div className="mx-auto mb-4 h-14 w-14 rounded-full bg-emerald-100 flex items-center justify-center">
                <CheckCircle2 className="h-8 w-8 text-emerald-600" />
              </div>
              <h1 className="text-xl font-bold text-slate-800">WhatsApp confirmado! 🎉</h1>
              <p className="mt-2 text-sm text-slate-500">
                Agora é só entrar no grupo de repasses para ver as ofertas de carros.
              </p>
              {groupLink ? (
                <a
                  href={groupLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 py-3 font-semibold text-white shadow-sm transition hover:bg-emerald-700"
                >
                  <MessageCircle className="h-5 w-5" /> Entrar no grupo do WhatsApp
                </a>
              ) : (
                <p className="mt-6 text-sm text-slate-400">O link do grupo aparecerá em instantes.</p>
              )}
            </div>
          )}
        </div>

        <p className="mt-6 text-center text-xs text-slate-400">Totex Motors · Grupo de Repasses</p>
      </div>
    </div>
  );
}
