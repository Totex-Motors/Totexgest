import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "sonner";
import { Sparkles, Globe, Copy, Eye, EyeOff, RefreshCw, Loader2, ExternalLink, Trash2, Search } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/**
 * Páginas de carro com IA ("autoconsultor"): uma landing page por carro do estoque.
 * Lista o estoque da loja (marketplace), gera o conteúdo com IA, publica e mostra views/cliques.
 */
type Page = { id: string; vehicle_id: string; slug: string; status: string; url: string; preview_url: string; titulo: string; preco: number | null; foto: string | null; views: number; clicks: number; generated_at: string | null; published_at: string | null; tem_fipe: boolean; tem_simulacao: boolean };
type Veiculo = { id: string; titulo: string; ano: number | null; preco: number | null; km: number | null; cor: string | null; fotos: string[]; loja: { nome: string | null }; pagina: Page | null };

const brl = (n: number | null) => (n ? n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }) : "—");

async function call<T = any>(action: string, extra: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.functions.invoke("vehicle-page", { body: { action, ...extra } });
  if (error) { let m = "Falha ao falar com o servidor."; try { const d = await error.context?.json(); if (d?.error) m = d.error; } catch { /* offline */ } throw new Error(m); }
  if (data?.error) throw new Error(data.error);
  return data as T;
}

export default function VehiclePages() {
  const qc = useQueryClient();
  const [busca, setBusca] = useState("");
  const [filtro, setFiltro] = useState<"todos" | "com" | "sem" | "publicadas">("todos");
  const [gerando, setGerando] = useState<Set<string>>(new Set());
  // superadmin (matriz) escolhe a loja; usuário de loja usa a própria
  const [loja, setLoja] = useState<string>("");
  const lojas = useQuery({ queryKey: ["vehicle-pages-lojas"], queryFn: () => call<{ lojas: { tenant_id: string; nome: string }[] }>("lojas"), staleTime: 300_000 });
  const tenantArg = loja ? { tenant_id: loja } : {};

  const estoque = useQuery({ queryKey: ["vehicle-pages-estoque", loja], queryFn: () => call<{ total: number; veiculos: Veiculo[]; error?: string }>("estoque", tenantArg), staleTime: 60_000, enabled: !lojas.isLoading && (!(lojas.data?.lojas?.length) || !!loja) });

  const veiculos = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return (estoque.data?.veiculos || []).filter((v) => {
      if (q && !`${v.titulo} ${v.ano || ""}`.toLowerCase().includes(q)) return false;
      if (filtro === "com") return !!v.pagina;
      if (filtro === "sem") return !v.pagina;
      if (filtro === "publicadas") return v.pagina?.status === "published";
      return true;
    });
  }, [estoque.data, busca, filtro]);

  const totais = useMemo(() => {
    const vs = estoque.data?.veiculos || [];
    const pags = vs.map((v) => v.pagina).filter(Boolean) as Page[];
    return { carros: vs.length, paginas: pags.length, publicadas: pags.filter((p) => p.status === "published").length, views: pags.reduce((s, p) => s + (p.views || 0), 0), cliques: pags.reduce((s, p) => s + (p.clicks || 0), 0) };
  }, [estoque.data]);

  const gerar = async (v: Veiculo) => {
    setGerando((s) => new Set(s).add(v.id));
    try {
      await call("generate", { vehicle_id: v.id, ...tenantArg });
      toast.success(`Página do ${v.titulo} gerada. Confira a prévia e publique.`);
      await qc.invalidateQueries({ queryKey: ["vehicle-pages-estoque"] });
    } catch (e) { toast.error("Não gerou", { description: (e as Error).message }); }
    finally { setGerando((s) => { const n = new Set(s); n.delete(v.id); return n; }); }
  };

  const toggle = useMutation({
    mutationFn: ({ p, pub }: { p: Page; pub: boolean }) => call(pub ? "publish" : "unpublish", { id: p.id, ...tenantArg }),
    onSuccess: (_d, vars) => { toast.success(vars.pub ? "Página publicada" : "Página despublicada"); qc.invalidateQueries({ queryKey: ["vehicle-pages-estoque"] }); },
    onError: (e: Error) => toast.error(e.message),
  });
  const apagar = useMutation({
    mutationFn: (p: Page) => call("delete", { id: p.id, ...tenantArg }),
    onSuccess: () => { toast.success("Página apagada"); qc.invalidateQueries({ queryKey: ["vehicle-pages-estoque"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  const copiar = async (url: string) => { try { await navigator.clipboard.writeText(url); toast.success("Link copiado"); } catch { toast.error("Não consegui copiar"); } };

  return (
    <AppLayout>
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Sparkles className="h-6 w-6 text-primary shrink-0" />
            <div>
              <h1 className="text-xl sm:text-2xl font-bold">Páginas de carro com IA</h1>
              <p className="text-sm text-muted-foreground">Uma página por carro do estoque, escrita pelo autoconsultor: argumentos, FIPE, parcela, perguntas e o botão do WhatsApp que vira lead.</p>
            </div>
          </div>
          <Button variant="outline" onClick={() => estoque.refetch()} disabled={estoque.isFetching}><RefreshCw className={`h-4 w-4 mr-2 ${estoque.isFetching ? "animate-spin" : ""}`} /> Atualizar estoque</Button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {[["Carros no estoque", totais.carros], ["Com página", totais.paginas], ["Publicadas", totais.publicadas], ["Visualizações", totais.views], ["Cliques no WhatsApp", totais.cliques]].map(([l, n]) => (
            <Card key={String(l)}><CardContent className="p-4"><p className="text-xs text-muted-foreground">{l}</p><p className="text-2xl font-bold">{n}</p></CardContent></Card>
          ))}
        </div>

        {!!lojas.data?.lojas?.length && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Loja:</span>
            <Select value={loja} onValueChange={setLoja}>
              <SelectTrigger className="w-[260px]"><SelectValue placeholder="Escolha a loja" /></SelectTrigger>
              <SelectContent>{lojas.data.lojas.map((l) => <SelectItem key={l.tenant_id} value={l.tenant_id}>{l.nome}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        )}

        <div className="flex flex-wrap gap-2 items-center">
          <div className="relative flex-1 min-w-[220px]"><Search className="h-4 w-4 absolute left-3 top-3 text-muted-foreground" /><Input className="pl-9" placeholder="Buscar carro…" value={busca} onChange={(e) => setBusca(e.target.value)} /></div>
          {([["todos", "Todos"], ["sem", "Sem página"], ["com", "Com página"], ["publicadas", "Publicadas"]] as const).map(([k, l]) => (
            <Button key={k} size="sm" variant={filtro === k ? "default" : "outline"} onClick={() => setFiltro(k)}>{l}</Button>
          ))}
        </div>

        {estoque.isLoading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Carregando o estoque da loja…</div>}
        {estoque.isError && <p className="text-sm text-destructive">{(estoque.error as Error).message}</p>}
        {estoque.data?.error && <p className="text-sm text-destructive">{estoque.data.error}</p>}

        <div className="space-y-3">
          {veiculos.map((v) => {
            const p = v.pagina;
            const g = gerando.has(v.id);
            return (
              <Card key={v.id}>
                <CardContent className="p-4 flex flex-col sm:flex-row gap-4">
                  <div className="w-full sm:w-40 shrink-0">{v.fotos[0] ? <img src={v.fotos[0]} alt="" className="w-full aspect-[4/3] object-cover rounded-lg bg-muted" /> : <div className="w-full aspect-[4/3] rounded-lg bg-muted" />}</div>
                  <div className="flex-1 min-w-0 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{v.titulo}</span>
                      {v.ano && <span className="text-sm text-muted-foreground">{v.ano}</span>}
                      {p ? <Badge variant={p.status === "published" ? "default" : "secondary"}>{p.status === "published" ? "publicada" : "rascunho"}</Badge> : <Badge variant="outline">sem página</Badge>}
                      {p?.tem_fipe && <Badge variant="outline" className="text-[10px]">FIPE</Badge>}
                      {p?.tem_simulacao && <Badge variant="outline" className="text-[10px]">parcela</Badge>}
                    </div>
                    <p className="text-sm text-muted-foreground">{brl(v.preco)}{v.km != null ? ` · ${v.km.toLocaleString("pt-BR")} km` : ""}{v.cor ? ` · ${v.cor}` : ""}</p>
                    {p && (
                      <p className="text-xs text-muted-foreground">
                        {p.views} visualizações · {p.clicks} cliques{p.generated_at ? ` · gerada em ${new Date(p.generated_at).toLocaleDateString("pt-BR")}` : ""}
                        {p.status === "published" && <> · <a className="underline" href={p.url} target="_blank" rel="noreferrer">{p.url.replace(/^https?:\/\//, "")}</a></>}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2 pt-1">
                      {!p && <Button size="sm" onClick={() => gerar(v)} disabled={g}>{g ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Sparkles className="h-4 w-4 mr-1" />} Gerar com IA</Button>}
                      {p && <>
                        <Button size="sm" variant="outline" asChild><a href={p.preview_url} target="_blank" rel="noreferrer"><Eye className="h-4 w-4 mr-1" /> Prévia</a></Button>
                        {p.status === "published"
                          ? <Button size="sm" variant="outline" onClick={() => toggle.mutate({ p, pub: false })}><EyeOff className="h-4 w-4 mr-1" /> Despublicar</Button>
                          : <Button size="sm" onClick={() => toggle.mutate({ p, pub: true })}><Globe className="h-4 w-4 mr-1" /> Publicar</Button>}
                        {p.status === "published" && <Button size="sm" variant="outline" onClick={() => copiar(p.url)}><Copy className="h-4 w-4 mr-1" /> Copiar link</Button>}
                        {p.status === "published" && <Button size="sm" variant="ghost" asChild><a href={p.url} target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4 mr-1" /> Abrir</a></Button>}
                        <Button size="sm" variant="ghost" onClick={() => gerar(v)} disabled={g}>{g ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />} Regerar</Button>
                        <Button size="sm" variant="ghost" className="text-destructive" onClick={() => { if (confirm(`Apagar a página do ${v.titulo}?`)) apagar.mutate(p); }}><Trash2 className="h-4 w-4" /></Button>
                      </>}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
          {!estoque.isLoading && veiculos.length === 0 && <p className="text-sm text-muted-foreground">Nenhum carro nesse filtro.</p>}
        </div>

        <p className="text-xs text-muted-foreground">
          A IA escreve com os dados do anúncio (ano, km, cor, descrição) e informações de referência do modelo, sempre com aviso "confirme na loja". FIPE vem da consulta oficial do CRM; a parcela aparece só nas lojas com simulador. Nunca fala em taxa de juros.
        </p>
      </div>
    </AppLayout>
  );
}
