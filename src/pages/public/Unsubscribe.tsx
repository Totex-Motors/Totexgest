import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

export default function Unsubscribe() {
  const [params] = useSearchParams();
  const token = params.get("token");
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");

  useEffect(() => {
    if (!token) {
      setStatus("error");
      return;
    }
    fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/unsubscribe?token=${token}`)
      .then((r) => setStatus(r.ok ? "ok" : "error"))
      .catch(() => setStatus("error"));
  }, [token]);

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-muted">
      <div className="max-w-md w-full bg-white rounded-2xl p-8 text-center shadow">
        {status === "loading" && <p className="text-muted-foreground">Processando…</p>}
        {status === "ok" && (
          <>
            <h1 className="text-xl font-semibold mb-2">Descadastro confirmado</h1>
            <p className="text-sm text-muted-foreground">
              Você não receberá mais emails desta lista. Caso tenha sido um engano, entre em contato.
            </p>
          </>
        )}
        {status === "error" && (
          <>
            <h1 className="text-xl font-semibold mb-2 text-destructive">Não conseguimos processar</h1>
            <p className="text-sm text-muted-foreground">
              Link inválido ou já utilizado. Se o problema persistir, entre em contato.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
