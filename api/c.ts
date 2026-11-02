// /c/<slug> → página pública do carro (vehicle-page no Supabase).
// Por que existe: o domínio *.supabase.co devolve HTML como text/plain (proteção da Supabase),
// então a Vercel busca o HTML na função e entrega com o content-type certo, no nosso domínio.
export const config = { runtime: "edge" };

const FN = "https://mztfyavuclqzivywkaeu.supabase.co/functions/v1/vehicle-page";

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const slug = (url.searchParams.get("slug") || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
  const qs = new URLSearchParams(url.searchParams);
  qs.delete("slug");
  if (!slug) return new Response("Página não encontrada", { status: 404 });
  const r = await fetch(`${FN}/${slug}${qs.toString() ? `?${qs}` : ""}`, { headers: { accept: "text/html" } });
  const body = await r.text();
  const preview = qs.get("preview") === "1";
  return new Response(body, {
    status: r.status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": r.status === 200 && !preview ? "public, max-age=300, s-maxage=600, stale-while-revalidate=3600" : "no-store",
    },
  });
}
