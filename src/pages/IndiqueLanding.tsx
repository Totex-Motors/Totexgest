import { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { maskPhoneBR, onlyDigits } from "@/lib/phone";
import { Gift, Loader2, MessageCircle, Copy, Share2, CheckCircle2, Car, Users, Sparkles, ShieldCheck } from "lucide-react";

// INDIQUE E GANHE — páginas públicas do programa de indicação (sem login).
//   /indique          → cadastro (nome + WhatsApp) → recebe o link e o texto pra compartilhar
//   /indique/:code    → painel do indicador (link, indicados, quanto tem a receber)
//
// Regras (decisão do Marco, 08/11/2026): R$ 200 quando o indicado dá o sinal, R$ 800 quando a
// venda fecha; até 5 indicações pagas (R$ 5.000). Um telefone conta pra um indicador (o
// primeiro). O link é o WhatsApp OFICIAL da Totex com texto pronto; quem chega cai na Nina.

type Painel = {
  ok: boolean; code: string; nome: string; status: string; link: string | null; painel_url: string; share_text: string | null; texto_indicado: string;
  valores: { sinal_cents: number; venda_cents: number; max_pagas: number };
  totais: { indicados: number; em_conversa: number; com_sinal: number; vendas: number; pagas_no_teto: number; a_receber_cents: number; recebido_cents: number };
  indicados: { quem: string; status: string; em: string; valor_cents: number; pago: boolean | null }[];
};

const brl = (c: number) => (Number(c || 0) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const STATUS: Record<string, { label: string; cls: string }> = {
  contato: { label: "Em conversa com a Nina", cls: "bg-sky-50 text-sky-700 border-sky-200" },
  sinal: { label: "Deu o sinal 🎯", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  venda: { label: "Comprou 🎉", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  cancelada: { label: "Não valeu", cls: "bg-slate-50 text-slate-500 border-slate-200" },
};

function Regras({ sinal, venda, max }: { sinal: number; venda: number; max: number }) {
  return (
    <div className="rounded-2xl border border-emerald-100 bg-white p-5 text-sm text-slate-700 space-y-2">
      <p className="font-semibold text-slate-900 flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-emerald-600" /> Como funciona</p>
      <ol className="list-decimal pl-5 space-y-1">
        <li>Você compartilha o seu link. Quem clicar cai no WhatsApp oficial da Totex e fala com a Nina.</li>
        <li>Quando o seu indicado <b>dá o sinal</b> da compra, você ganha <b>{brl(sinal)}</b>.</li>
        <li>Quando a <b>venda fecha</b>, você ganha mais <b>{brl(venda)}</b>. Total de <b>{brl(sinal + venda)}</b> por indicação.</li>
        <li>Vale pra até <b>{max} indicações</b> ({brl((sinal + venda) * max)} no total).</li>
      </ol>
      <p className="text-xs text-slate-500 pt-1">Cada pessoa indicada conta uma vez, pro primeiro link que ela usar. Não vale indicar a si mesmo nem quem já estava negociando com a Totex. O pagamento é feito por PIX pela Totex Motors depois de cada etapa confirmada no sistema.</p>
    </div>
  );
}

function ShareBox({ p }: { p: Painel }) {
  const [copied, setCopied] = useState<"link" | "texto" | null>(null);
  async function copy(what: "link" | "texto") {
    const v = what === "link" ? p.link : p.share_text;
    if (!v) return;
    try { await navigator.clipboard.writeText(v); setCopied(what); setTimeout(() => setCopied(null), 1800); } catch { /* ignore */ }
  }
  async function share() {
    if (!p.share_text) return;
    if (navigator.share) { try { await navigator.share({ title: "Totex Motors — Indique e Ganhe", text: p.share_text }); return; } catch { /* cancelado */ } }
    window.open(`https://wa.me/?text=${encodeURIComponent(p.share_text)}`, "_blank");
  }
  return (
    <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 space-y-3">
      <p className="font-semibold text-emerald-900 flex items-center gap-2"><Share2 className="h-4 w-4" /> Seu link de indicação</p>
      {p.link ? (
        <>
          <div className="rounded-xl bg-white border border-emerald-100 px-3 py-2 text-xs font-mono break-all text-slate-700">{p.link}</div>
          <div className="grid grid-cols-3 gap-2 text-xs font-medium">
            <button type="button" onClick={share} className="rounded-xl bg-emerald-600 text-white py-2.5 flex items-center justify-center gap-1"><MessageCircle className="h-4 w-4" /> Compartilhar</button>
            <button type="button" onClick={() => copy("link")} className="rounded-xl bg-white border border-emerald-200 py-2.5 flex items-center justify-center gap-1">{copied === "link" ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />} Copiar link</button>
            <button type="button" onClick={() => copy("texto")} className="rounded-xl bg-white border border-emerald-200 py-2.5 flex items-center justify-center gap-1">{copied === "texto" ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />} Copiar texto</button>
          </div>
          <p className="text-xs text-emerald-900/80">Seu código é <b className="font-mono">{p.code}</b>. Salve esta página: <span className="font-mono break-all">{p.painel_url}</span></p>
        </>
      ) : (
        <p className="text-sm text-amber-800">O WhatsApp oficial da Totex está sendo configurado. Volte em instantes.</p>
      )}
    </div>
  );
}

function PainelView({ p }: { p: Painel }) {
  const t = p.totais;
  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-white border border-emerald-100 p-5">
        <p className="text-xs uppercase tracking-wide text-slate-500">Olá, {p.nome.split(" ")[0]}</p>
        <div className="mt-2 grid grid-cols-2 gap-3">
          <div className="rounded-xl bg-emerald-50 p-3"><p className="text-2xl font-bold text-emerald-700">{brl(t.a_receber_cents)}</p><p className="text-xs text-slate-600">a receber</p></div>
          <div className="rounded-xl bg-slate-50 p-3"><p className="text-2xl font-bold text-slate-800">{brl(t.recebido_cents)}</p><p className="text-xs text-slate-600">já recebido</p></div>
          <div className="rounded-xl bg-slate-50 p-3"><p className="text-2xl font-bold text-slate-800">{t.indicados}</p><p className="text-xs text-slate-600">indicados</p></div>
          <div className="rounded-xl bg-slate-50 p-3"><p className="text-2xl font-bold text-slate-800">{t.vendas}</p><p className="text-xs text-slate-600">compraram</p></div>
        </div>
        <p className="mt-3 text-xs text-slate-500 flex items-center gap-1"><Sparkles className="h-3.5 w-3.5" /> {t.pagas_no_teto} de {p.valores.max_pagas} indicações pagas usadas.</p>
      </div>
      <ShareBox p={p} />
      <div className="rounded-2xl bg-white border border-emerald-100 p-5">
        <p className="font-semibold text-slate-900 flex items-center gap-2 mb-3"><Users className="h-4 w-4 text-emerald-600" /> Seus indicados</p>
        {p.indicados.length === 0 ? (
          <p className="text-sm text-slate-500">Ninguém ainda. Compartilhe seu link com quem está pensando em trocar de carro. 🚀</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {p.indicados.map((i, k) => {
              const st = STATUS[i.status] || STATUS.contato;
              return (
                <li key={k} className="py-2.5 flex items-center justify-between gap-3 text-sm">
                  <div><p className="font-medium text-slate-800">{i.quem}</p><p className="text-xs text-slate-500">{i.em}</p></div>
                  <div className="text-right">
                    <span className={`inline-block rounded-full border px-2 py-0.5 text-xs ${st.cls}`}>{st.label}</span>
                    {i.valor_cents > 0 && <p className="text-xs mt-1 text-slate-600">{brl(i.valor_cents)} {i.pago ? "· pago" : "· a receber"}</p>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <Regras sinal={p.valores.sinal_cents} venda={p.valores.venda_cents} max={p.valores.max_pagas} />
    </div>
  );
}

export default function IndiqueLanding() {
  const { code = "" } = useParams();
  const navigate = useNavigate();
  const [step, setStep] = useState<"form" | "loading" | "painel" | "invalid">(code ? "loading" : "form");
  const [painel, setPainel] = useState<Painel | null>(null);
  const [nome, setNome] = useState("");
  const [phone, setPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const digits = onlyDigits(phone);
  const phoneOk = digits.length === 10 || digits.length === 11;
  const valores = useMemo(() => painel?.valores || { sinal_cents: 20000, venda_cents: 80000, max_pagas: 5 }, [painel]);

  useEffect(() => {
    if (!code) return;
    let alive = true;
    (async () => {
      try {
        const { data, error } = await supabase.functions.invoke(`indique?code=${encodeURIComponent(code)}`, { method: "GET" });
        if (!alive) return;
        if (error || !data?.ok) { setStep("invalid"); return; }
        setPainel(data as Painel); setStep("painel");
      } catch { if (alive) setStep("invalid"); }
    })();
    return () => { alive = false; };
  }, [code]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault(); setError(null);
    if (nome.trim().length < 2) { setError("Diga seu nome."); return; }
    if (!phoneOk) { setError("Confira o número do seu WhatsApp (com DDD)."); return; }
    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke("indique", { body: { action: "cadastrar", nome: nome.trim(), telefone: digits } });
      if (error) {
        let msg = "Não consegui fazer seu cadastro. Tente de novo.";
        try { const j = await (error as any).context?.json?.(); if (j?.error) msg = j.error; } catch { /* noop */ }
        setError(msg); return;
      }
      if (!data?.ok) { setError(data?.error || "Não consegui fazer seu cadastro."); return; }
      navigate(`/indique/${data.code}`, { replace: true });
    } catch { setError("Não consegui fazer seu cadastro. Tente de novo."); }
    finally { setSubmitting(false); }
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-emerald-50 to-white">
      <div className="mx-auto max-w-md px-4 py-8 space-y-4">
        <div className="text-center space-y-2">
          <div className="mx-auto h-14 w-14 rounded-2xl bg-emerald-600 text-white grid place-items-center"><Gift className="h-7 w-7" /></div>
          <h1 className="text-2xl font-bold text-slate-900">Indique e Ganhe</h1>
          <p className="text-sm text-slate-600">Indique quem quer trocar de carro e ganhe até <b>{brl(valores.sinal_cents + valores.venda_cents)}</b> por pessoa. Até {brl((valores.sinal_cents + valores.venda_cents) * valores.max_pagas)} no total.</p>
        </div>

        {step === "loading" && <div className="py-10 grid place-items-center text-emerald-600"><Loader2 className="h-6 w-6 animate-spin" /></div>}
        {step === "invalid" && (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
            Esse código não existe. <button className="underline font-medium" onClick={() => navigate("/indique")}>Fazer meu cadastro</button>
          </div>
        )}
        {step === "painel" && painel && <PainelView p={painel} />}
        {step === "form" && (
          <>
            <form onSubmit={handleSubmit} className="rounded-2xl bg-white border border-emerald-100 p-5 space-y-3">
              <p className="font-semibold text-slate-900 flex items-center gap-2"><Car className="h-4 w-4 text-emerald-600" /> Pegue o seu link</p>
              <label className="block text-sm">
                <span className="text-slate-600">Seu nome</span>
                <input value={nome} onChange={(e) => setNome(e.target.value)} className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-base" placeholder="Como quer ser chamado" autoComplete="name" />
              </label>
              <label className="block text-sm">
                <span className="text-slate-600">Seu WhatsApp (com DDD)</span>
                <input value={phone} onChange={(e) => setPhone(maskPhoneBR(e.target.value))} inputMode="tel" className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-base" placeholder="(11) 99999-9999" autoComplete="tel" />
              </label>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <button type="submit" disabled={submitting} className="w-full rounded-xl bg-emerald-600 text-white py-3 font-semibold flex items-center justify-center gap-2 disabled:opacity-60">
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Gift className="h-4 w-4" />} Quero meu link
              </button>
              <p className="text-xs text-slate-500">Se você já tem cadastro, basta colocar o mesmo WhatsApp: a gente mostra o seu painel.</p>
            </form>
            <Regras sinal={valores.sinal_cents} venda={valores.venda_cents} max={valores.max_pagas} />
          </>
        )}
        <p className="text-center text-xs text-slate-400">Totex Motors · Shopping Tamboré, Alphaville</p>
      </div>
    </div>
  );
}
