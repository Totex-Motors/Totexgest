import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";

const KEY = "marketing_loja";

/**
 * Loja cujo marketing está sendo visto.
 *
 * Usuário comum: sempre a própria loja. Superadmin (matriz): pode escolher outra loja
 * pra VER campanhas, métricas e descadastros dela (as policies *_superadmin_read liberam a
 * leitura). Criar/disparar continua só na própria loja — por isso `somenteLeitura`.
 * A escolha fica no navegador (localStorage) e vale pra todas as telas de Marketing · Email.
 */
export function useMarketingTenant() {
  const { teamMember, isSuperAdmin } = useAuth();
  const propria = teamMember?.tenant_id || null;
  const [loja, setLojaState] = useState<string>(() => {
    try { return localStorage.getItem(KEY) || ""; } catch { return ""; }
  });

  // sincroniza entre telas/abas (storage event) e entre hooks montados na mesma página
  useEffect(() => {
    const on = () => { try { setLojaState(localStorage.getItem(KEY) || ""); } catch { /* ignore */ } };
    window.addEventListener("storage", on);
    window.addEventListener("marketing-loja", on);
    return () => { window.removeEventListener("storage", on); window.removeEventListener("marketing-loja", on); };
  }, []);

  const setLoja = (id: string) => {
    try { if (id) localStorage.setItem(KEY, id); else localStorage.removeItem(KEY); } catch { /* ignore */ }
    setLojaState(id);
    window.dispatchEvent(new Event("marketing-loja"));
  };

  const lojas = useQuery({
    queryKey: ["marketing-lojas"],
    enabled: isSuperAdmin,
    staleTime: 300_000,
    queryFn: async () => {
      const { data, error } = await supabase.from("tenants").select("id, name").order("name");
      if (error) throw error;
      return (data || []) as { id: string; name: string }[];
    },
  });

  const tenantId = isSuperAdmin && loja ? loja : propria;
  return {
    tenantId,
    propria,
    isSuperAdmin,
    loja: isSuperAdmin ? (loja || propria || "") : (propria || ""),
    setLoja,
    lojas: lojas.data || [],
    somenteLeitura: !!tenantId && tenantId !== propria,
  };
}
