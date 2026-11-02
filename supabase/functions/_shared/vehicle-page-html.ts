/**
 * HTML da página pública do carro ("autoconsultor"). Sem framework: HTML + CSS inline,
 * mobile-first, OG tags (preview no WhatsApp), JSON-LD de veículo (SEO).
 * Todo texto passa por esc(). Números em reais, nunca taxa.
 */

export interface PageVehicle {
  id: string; titulo: string; marca: string; modelo: string; versao: string | null; ano: number | null;
  preco: number | null; km: number | null; cor: string | null; cambio: string | null; combustivel: string | null;
  portas: number | null; cidade: string | null; estado: string | null; descricao: string | null;
  fotos: string[]; loja: { nome: string | null; telefone: string | null; cidade: string | null }; link_marketplace: string | null;
}
export interface PageContent {
  headline?: string; subheadline?: string; resumo?: string[];
  pontos_fortes?: { titulo: string; texto: string }[];
  para_quem?: string; equipamentos?: string[];
  consumo?: { cidade?: string; estrada?: string; observacao?: string };
  custo_mensal?: { ipva_ano?: string; seguro_mes?: string; combustivel_mes?: string; observacao?: string };
  concorrentes?: { modelo: string; comparacao: string }[];
  faq?: { pergunta: string; resposta: string }[];
  objecoes?: { objecao: string; resposta: string }[];
  cta?: string; seo?: { title?: string; description?: string };
}
export interface PageFipe { valor_centavos: number; mes_referencia: string | null; codigo_fipe?: string | null; diferenca_pct?: number | null }
export interface PageSim { prazo: number; parcela: number; entrada: number; outros_prazos?: string | null; ultima_parcela_hoje?: number | null }

export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
export const brl0 = (n: number) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const km = (n: number) => `${n.toLocaleString("pt-BR")} km`;
const CAMBIO: Record<string, string> = { AUTOMATIC: "Automático", MANUAL: "Manual", CVT: "CVT", AUTOMATED: "Automatizado" };
const COMB: Record<string, string> = { GASOLINE: "Gasolina", FLEX: "Flex", DIESEL: "Diesel", ELECTRIC: "Elétrico", HYBRID: "Híbrido", ETHANOL: "Etanol" };
export const cambioPt = (s: string | null) => (s ? CAMBIO[s] || s : null);
export const combPt = (s: string | null) => (s ? COMB[s] || s : null);

export function buildVehicleHtml(a: {
  v: PageVehicle; c: PageContent; fipe: PageFipe | null; sim: PageSim | null;
  slug: string; pageUrl: string; functionUrl: string; whatsapp: { numero: string | null; texto_base: string };
  geradoEm: string | null;
}): string {
  const { v, c, fipe, sim } = a;
  const title = c.seo?.title || `${v.titulo} ${v.ano || ""}`.trim();
  const desc = c.seo?.description || c.subheadline || `${v.titulo}${v.preco ? ` por ${brl0(v.preco)}` : ""} na ${v.loja.nome || "loja"}.`;
  const foto = v.fotos[0] || "";
  const chips = [v.ano && String(v.ano), v.km != null && km(v.km), cambioPt(v.cambio), combPt(v.combustivel), v.cor, v.portas && `${v.portas} portas`].filter(Boolean) as string[];
  const fipeValor = fipe ? fipe.valor_centavos / 100 : null;
  const dif = fipe?.diferenca_pct ?? (fipeValor && v.preco ? ((v.preco - fipeValor) / fipeValor) * 100 : null);
  const jsonld = {
    "@context": "https://schema.org", "@type": "Vehicle", name: v.titulo, brand: { "@type": "Brand", name: v.marca }, model: v.modelo,
    vehicleModelDate: v.ano || undefined, mileageFromOdometer: v.km != null ? { "@type": "QuantitativeValue", value: v.km, unitCode: "KMT" } : undefined,
    color: v.cor || undefined, image: v.fotos.slice(0, 5), description: desc,
    offers: v.preco ? { "@type": "Offer", price: v.preco, priceCurrency: "BRL", availability: "https://schema.org/InStock", seller: { "@type": "AutoDealer", name: v.loja.nome || undefined } } : undefined,
  };
  const lista = (xs: string[] | undefined) => (xs || []).map((x) => `<li>${esc(x)}</li>`).join("");
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(a.pageUrl)}">
<meta property="og:type" content="product"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
${foto ? `<meta property="og:image" content="${esc(foto)}">` : ""}<meta property="og:url" content="${esc(a.pageUrl)}"><meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, "\\u003c")}</script>
<style>
:root{--bg:#0b1220;--card:#121a2b;--line:#223049;--tx:#e8edf5;--mut:#9aa7bd;--acc:#14b8a6;--acc2:#0f9488;--gold:#f5c451;--ok:#34d399}
@media(prefers-color-scheme:light){:root{--bg:#f4f6fa;--card:#fff;--line:#e3e8f0;--tx:#111827;--mut:#5b6678;--acc:#0f9488;--acc2:#0d7f75;--gold:#b7791f;--ok:#059669}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:0 16px 120px}
header{padding:14px 0;display:flex;align-items:center;justify-content:space-between;gap:12px}
.loja{font-weight:700}.loja small{display:block;font-weight:400;color:var(--mut);font-size:12px}
.hero{border-radius:16px;overflow:hidden;background:var(--card);border:1px solid var(--line)}
.hero img{width:100%;aspect-ratio:4/3;object-fit:cover;display:block;background:#000}
.thumbs{display:flex;gap:6px;padding:8px;overflow-x:auto}.thumbs img{width:84px;height:63px;object-fit:cover;border-radius:8px;cursor:pointer;border:2px solid transparent;flex:none}
.thumbs img.on{border-color:var(--acc)}
h1{font-size:26px;line-height:1.15;margin:18px 0 6px}.sub{color:var(--mut);margin:0 0 12px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}.chip{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:5px 11px;font-size:13px}
.preco{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:14px 0}
.preco b{font-size:34px;line-height:1}.preco small{color:var(--mut);display:block;font-size:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin:12px 0}
.card h2{font-size:17px;margin:0 0 10px}.card p{margin:8px 0}.mut{color:var(--mut)}.small{font-size:12px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}@media(max-width:560px){.grid{grid-template-columns:1fr}}
.pf{border-left:3px solid var(--acc);padding-left:10px}.pf b{display:block}
.fipe{display:flex;gap:16px;align-items:center;flex-wrap:wrap}.fipe .n{font-size:22px;font-weight:800}
.bar{height:8px;border-radius:99px;background:var(--line);position:relative;flex:1;min-width:120px}.bar i{position:absolute;top:-4px;width:16px;height:16px;border-radius:50%;background:var(--acc);transform:translateX(-50%)}
.parcela{background:linear-gradient(135deg,var(--acc),var(--acc2));color:#fff;border-radius:14px;padding:16px}.parcela b{font-size:30px}
details{border-top:1px solid var(--line);padding:10px 0}details:first-of-type{border-top:0}summary{cursor:pointer;font-weight:600;list-style:none}summary::-webkit-details-marker{display:none}
summary:after{content:"+";float:right;color:var(--mut)}details[open] summary:after{content:"–"}
ul{padding-left:18px;margin:6px 0}li{margin:4px 0}
.cta{position:fixed;left:0;right:0;bottom:0;background:var(--card);border-top:1px solid var(--line);padding:10px 12px calc(10px + env(safe-area-inset-bottom))}
.cta .in{max-width:860px;margin:0 auto;display:flex;gap:8px}
.btn{flex:1;display:flex;align-items:center;justify-content:center;gap:8px;padding:13px 10px;border-radius:12px;font-weight:700;text-decoration:none;color:#fff;border:0;cursor:pointer;font-size:15px}
.wa{background:#25d366}.sec{background:var(--acc)}.ter{background:transparent;color:var(--tx);border:1px solid var(--line)}
.rodape{color:var(--mut);font-size:12px;margin:20px 0}
.disc{font-size:12px;color:var(--mut);border:1px dashed var(--line);border-radius:10px;padding:10px;margin-top:12px}
</style></head>
<body><div class="wrap">
<header><div class="loja">${esc(v.loja.nome || "Totex Motors")}<small>${esc([v.loja.cidade || v.cidade, v.estado].filter(Boolean).join(" · "))}</small></div>
${v.link_marketplace ? `<a class="mut small" href="${esc(v.link_marketplace)}" target="_blank" rel="noopener">ver no site</a>` : ""}</header>

<div class="hero">${foto ? `<img id="foto" src="${esc(foto)}" alt="${esc(v.titulo)}">` : ""}
${v.fotos.length > 1 ? `<div class="thumbs">${v.fotos.slice(0, 12).map((f, i) => `<img src="${esc(f)}" class="${i === 0 ? "on" : ""}" alt="" loading="lazy" onclick="troca(this)">`).join("")}</div>` : ""}</div>

<h1>${esc(c.headline || v.titulo)}</h1>
<p class="sub">${esc(c.subheadline || v.titulo)}</p>
<div class="chips">${chips.map((x) => `<span class="chip">${esc(x)}</span>`).join("")}</div>

<div class="preco"><div><small>Preço</small><b>${v.preco ? esc(brl0(v.preco)) : "Consulte"}</b></div>
${fipeValor ? `<div><small>Tabela FIPE${fipe?.mes_referencia ? ` (${esc(fipe.mes_referencia)})` : ""}</small><b style="font-size:22px">${esc(brl0(fipeValor))}</b></div>` : ""}</div>

${fipeValor && dif != null ? `<div class="card"><h2>Preço × FIPE</h2><div class="fipe"><div class="n" style="color:${dif <= 0 ? "var(--ok)" : "var(--gold)"}">${dif <= 0 ? `${Math.abs(dif).toFixed(0)}% abaixo` : `${dif.toFixed(0)}% acima`}</div><div class="bar"><i style="left:${Math.max(4, Math.min(96, 50 + dif * 2)).toFixed(0)}%"></i></div></div>
<p class="mut small">${dif <= 0 ? "Está abaixo da tabela FIPE do mês: boa referência pra negociar com segurança." : "Acima da tabela: normalmente reflete estado, quilometragem baixa ou opcionais. Vale conferir pessoalmente."}</p></div>` : ""}

${sim ? `<div class="parcela"><small>Estimativa do simulador · ${sim.prazo}x</small><br><b>${esc(brl0(sim.parcela))}</b> <span>por mês</span>
<div class="small" style="opacity:.9;margin-top:6px">Entrada ${esc(brl0(sim.entrada))}${sim.outros_prazos ? ` · Outros prazos: ${esc(sim.outros_prazos)}` : ""}${sim.ultima_parcela_hoje ? ` · Antecipando a última junto com a do mês (13º, férias, PLR ou FGTS), ela sai por ${esc(brl0(sim.ultima_parcela_hoje))}` : ""}</div>
<div class="small" style="opacity:.8;margin-top:4px">Pré-atendimento. A condição final é fechada com a loja e os bancos parceiros.</div></div>` : ""}

${c.resumo?.length ? `<div class="card"><h2>O que você precisa saber</h2>${c.resumo.map((p) => `<p>${esc(p)}</p>`).join("")}</div>` : ""}

${c.pontos_fortes?.length ? `<div class="card"><h2>Pontos fortes</h2><div class="grid">${c.pontos_fortes.map((p) => `<div class="pf"><b>${esc(p.titulo)}</b><span class="mut">${esc(p.texto)}</span></div>`).join("")}</div></div>` : ""}

${c.para_quem ? `<div class="card"><h2>Pra quem esse carro faz sentido</h2><p>${esc(c.para_quem)}</p></div>` : ""}

${v.descricao ? `<div class="card"><h2>Como a loja descreve este carro</h2><p style="white-space:pre-line">${esc(v.descricao)}</p></div>` : ""}

${c.equipamentos?.length ? `<div class="card"><h2>Equipamentos típicos da versão</h2><ul>${lista(c.equipamentos)}</ul><p class="mut small">Lista de referência da versão. Confirme os itens deste exemplar na loja.</p></div>` : ""}

${c.consumo || c.custo_mensal ? `<div class="card"><h2>Consumo e custo de manter</h2><div class="grid">
${c.consumo ? `<div><b>Consumo (referência)</b><p class="mut">${esc([c.consumo.cidade && `Cidade: ${c.consumo.cidade}`, c.consumo.estrada && `Estrada: ${c.consumo.estrada}`].filter(Boolean).join(" · "))}${c.consumo.observacao ? `<br>${esc(c.consumo.observacao)}` : ""}</p></div>` : ""}
${c.custo_mensal ? `<div><b>Custo mensal (estimativa)</b><p class="mut">${esc([c.custo_mensal.ipva_ano && `IPVA/ano: ${c.custo_mensal.ipva_ano}`, c.custo_mensal.seguro_mes && `Seguro: ${c.custo_mensal.seguro_mes}/mês`, c.custo_mensal.combustivel_mes && `Combustível: ${c.custo_mensal.combustivel_mes}/mês`].filter(Boolean).join(" · "))}${c.custo_mensal.observacao ? `<br>${esc(c.custo_mensal.observacao)}` : ""}</p></div>` : ""}
</div></div>` : ""}

${c.concorrentes?.length ? `<div class="card"><h2>Comparado com os concorrentes</h2>${c.concorrentes.map((x) => `<p><b>${esc(x.modelo)}:</b> <span class="mut">${esc(x.comparacao)}</span></p>`).join("")}</div>` : ""}

${c.objecoes?.length ? `<div class="card"><h2>"Mas e se…"</h2>${c.objecoes.map((x) => `<details><summary>${esc(x.objecao)}</summary><p class="mut">${esc(x.resposta)}</p></details>`).join("")}</div>` : ""}

${c.faq?.length ? `<div class="card"><h2>Perguntas frequentes</h2>${c.faq.map((x) => `<details><summary>${esc(x.pergunta)}</summary><p class="mut">${esc(x.resposta)}</p></details>`).join("")}</div>` : ""}

<div class="card"><h2>${esc(c.cta || "Quer ver de perto?")}</h2><p class="mut">Fale com a ${esc(v.loja.nome || "loja")} pelo WhatsApp: a gente responde na hora, simula a parcela e agenda sua visita.</p></div>

<div class="disc">Informações sobre o modelo são de referência e podem variar por versão e exemplar. Preço sujeito a alteração sem aviso. Nada aqui é proposta de crédito.${a.geradoEm ? ` Página gerada em ${esc(a.geradoEm)}.` : ""}</div>
<p class="rodape">${esc(v.loja.nome || "Totex Motors")}${v.loja.telefone ? ` · ${esc(v.loja.telefone)}` : ""} · Totex Motors</p>
</div>

<div class="cta"><div class="in">
<button class="btn wa" onclick="ir('whatsapp')">💬 WhatsApp</button>
<button class="btn sec" onclick="ir('simular')">Simular parcela</button>
<button class="btn ter" onclick="ir('visita')">Agendar visita</button>
</div></div>

<script>
function troca(el){var f=document.getElementById('foto');if(f){f.src=el.src;}document.querySelectorAll('.thumbs img').forEach(function(i){i.classList.toggle('on',i===el)});}
var FN=${JSON.stringify(a.functionUrl)},SLUG=${JSON.stringify(a.slug)},NUM=${JSON.stringify(a.whatsapp.numero || "")},BASE=${JSON.stringify(a.whatsapp.texto_base)};
var busy=false;
function ir(kind){if(busy)return;busy=true;var btns=document.querySelectorAll('.btn');btns.forEach(function(b){b.style.opacity='.6'});
  var extra=kind==='simular'?' Quero simular a parcela.':kind==='visita'?' Quero agendar uma visita.':'';
  fetch(FN,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'click',slug:SLUG,kind:kind})})
  .then(function(r){return r.json()}).catch(function(){return {}})
  .then(function(d){var ref=d&&d.ref?' (ref '+d.ref+')':'';var num=(d&&d.numero)||NUM;var txt=BASE+extra+ref;
    if(!num){alert('A loja ainda não configurou o WhatsApp desta página.');return;}
    window.location.href='https://wa.me/'+num+'?text='+encodeURIComponent(txt);})
  .finally(function(){busy=false;btns.forEach(function(b){b.style.opacity='1'})});}
</script>
</body></html>`;
}
