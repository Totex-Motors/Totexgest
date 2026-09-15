import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { z } from "zod";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Building2, CheckCircle2, Loader2, Brain } from "lucide-react";

// SEGUNDO CÉREBRO (MCP) — telinha de consentimento OAuth (/oauth/consent).
//
// É aqui que você faz login e AUTORIZA a IA (Claude) a acessar seu CRM. O fluxo
// é do OAuth Server nativo do Supabase: a IA manda ?authorization_id=..., a gente
// confirma sua identidade e, se você aprovar, devolve o código pra IA.
// Sem auto-cadastro: contas são por convite (usuários já existem).

const infoSchema = z.object({ tenant_name: z.string(), can_write: z.boolean() });

function redirectToClient(raw: string) {
  const url = new URL(raw); // destino vem SÓ da resposta do Auth, nunca de query do navegador
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("Endereço de retorno inválido.");
  }
  window.location.assign(url.href);
}

export default function McpConsent() {
  const [params] = useSearchParams();
  const authorizationId = params.get("authorization_id");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [needsLogin, setNeedsLogin] = useState(false);
  const [email, setEmail] = useState("");
  const [clientName, setClientName] = useState<string>("Sua IA");
  const [info, setInfo] = useState<z.infer<typeof infoSchema> | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setError(""); setInfo(null);
      try {
        if (!authorizationId) throw new Error("Solicitação ausente. Inicie a conexão pelo Claude.");
        const { data: { user } } = await supabase.auth.getUser();
        if (cancelled) return;
        if (!user) { setNeedsLogin(true); return; }
        setNeedsLogin(false); setEmail(user.email ?? "");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const oauth = (supabase.auth as any).oauth;
        if (!oauth?.getAuthorizationDetails) throw new Error("Este projeto ainda não tem o OAuth Server habilitado.");
        const { data, error: authError } = await oauth.getAuthorizationDetails(authorizationId);
        if (cancelled) return;
        if (authError || !data) throw new Error("Solicitação inválida ou expirada. Reinicie a conexão na sua IA.");
        if ("redirect_url" in data) { redirectToClient(data.redirect_url); return; }
        setClientName(data?.client?.name || "Sua IA");
        const { data: permission, error: permErr } = await supabase.rpc("mcp_authorization_info" as never, { p_client_id: data?.client?.id } as never);
        if (cancelled) return;
        if (permErr) throw new Error(permErr.message || "Não foi possível verificar esta conexão.");
        setInfo(infoSchema.parse(permission));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Não foi possível carregar a conexão.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [authorizationId, attempt]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError("");
    const f = new FormData(event.currentTarget);
    try {
      const { error: e } = await supabase.auth.signInWithPassword({ email: String(f.get("email")).trim(), password: String(f.get("password")) });
      if (e) throw new Error("Não foi possível entrar. Confira seu e-mail e senha.");
      setAttempt((v) => v + 1);
    } catch (e) { setError(e instanceof Error ? e.message : "Falha ao entrar."); }
    finally { setBusy(false); }
  }

  async function changeAccount() {
    setBusy(true);
    try { await supabase.auth.signOut(); setAttempt((v) => v + 1); } finally { setBusy(false); }
  }

  async function decide(approve: boolean) {
    if (!authorizationId || (approve && !info)) return;
    setBusy(true); setError("");
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const oauth = (supabase.auth as any).oauth;
      const result = approve
        ? await oauth.approveAuthorization(authorizationId, { skipBrowserRedirect: true })
        : await oauth.denyAuthorization(authorizationId, { skipBrowserRedirect: true });
      if (result.error || !result.data) throw new Error("Não foi possível concluir. Reinicie a conexão na sua IA.");
      redirectToClient(result.data.redirect_url);
    } catch (e) { setError(e instanceof Error ? e.message : "Falha ao concluir."); setBusy(false); }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center px-5 py-10">
      <div className="w-full max-w-md">
        <div className="flex items-center justify-center gap-2 mb-6 text-amber-400">
          <Brain className="h-6 w-6" />
          <span className="font-bold text-lg tracking-tight">Totexgest · Segundo Cérebro</span>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[.03] p-6 space-y-5">
          {loading && (
            <p className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="animate-spin" size={17} /> Conferindo sua conexão…</p>
          )}
          {error && <p role="alert" className="rounded-xl border border-red-400/20 bg-red-400/10 p-4 text-sm leading-6 text-red-200">{error}</p>}

          {needsLogin && !loading && (
            <>
              <div>
                <h1 className="text-lg font-semibold">Entre para continuar</h1>
                <p className="mt-1 text-sm text-slate-400">Use sua conta de <strong>gestor/admin</strong> do CRM para autorizar a IA.</p>
              </div>
              <form onSubmit={login} className="space-y-4">
                <div className="space-y-2"><Label htmlFor="email">E-mail</Label><Input id="email" name="email" type="email" autoComplete="username" placeholder="voce@empresa.com.br" required /></div>
                <div className="space-y-2"><Label htmlFor="password">Senha</Label><Input id="password" name="password" type="password" autoComplete="current-password" placeholder="Sua senha do CRM" required /></div>
                <Button className="w-full" disabled={busy} type="submit">{busy ? "Entrando…" : "Entrar e continuar"}</Button>
                <p className="text-center text-xs text-slate-500">Você confere e autoriza o acesso na próxima etapa.</p>
              </form>
            </>
          )}

          {info && !loading && !needsLogin && (
            <>
              <div>
                <h1 className="text-lg font-semibold">Você está no controle</h1>
                <p className="mt-1 text-sm text-slate-300"><strong className="text-white">{clientName}</strong> quer acessar seu CRM. Autorize só se foi você que iniciou esta conexão.</p>
              </div>
              <div className="space-y-4 rounded-2xl border border-white/10 bg-white/[.025] p-5">
                <div className="flex items-center gap-3">
                  <span className="rounded-xl bg-amber-400/10 p-3 text-amber-400"><Building2 size={20} /></span>
                  <div><p className="text-xs text-slate-500">Empresa conectada</p><p className="font-semibold">{info.tenant_name}</p></div>
                </div>
                <div className="space-y-2 text-sm text-slate-300">
                  <p className="flex gap-2"><CheckCircle2 className="shrink-0 text-amber-400" size={17} /> Consultar sua operação (resumo, atrasos, aprovações, intermediação/repasse).</p>
                  {info.can_write && <p className="flex gap-2"><CheckCircle2 className="shrink-0 text-amber-400" size={17} /> Executar ações que você confirmar (criar/concluir tarefa, decidir aprovação).</p>}
                </div>
              </div>
              <Button className="w-full" disabled={busy || !info} onClick={() => decide(true)}>{busy ? "Conectando…" : "Autorizar conexão"}</Button>
              <div className="flex items-center justify-between">
                <Button variant="outline" disabled={busy} onClick={() => decide(false)}>Recusar</Button>
                <button type="button" className="text-xs text-slate-500 hover:text-white" disabled={busy} onClick={changeAccount}>Trocar conta ({email})</button>
              </div>
              <p className="text-center text-xs text-slate-500">Você pode desconectar a IA quando quiser.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
