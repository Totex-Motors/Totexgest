// Telas do Totexgest renderizadas DENTRO do Claude (MCP Apps).
// Cada tela é um HTML auto-contido servido como recurso `ui://totexgest/...` com
// mimeType `text/html;profile=mcp-app`. O host (Claude) abre num iframe isolado e
// entrega o resultado da ferramenta via postMessage; o SDK oficial (@modelcontextprotocol/ext-apps)
// cuida do protocolo. Nada aqui chama a internet além do próprio SDK (CSP abaixo).
//
// Pasta `_lib` começa com underscore de propósito: a Vercel não a trata como função.

export const UI_MIME = 'text/html;profile=mcp-app';
export const UI_URI_FICHA = 'ui://totexgest/ficha-lead.html';
export const UI_URI_PIPELINE = 'ui://totexgest/pipeline-dia.html';

// Versão fixada do SDK de UI (mesma do quickstart oficial). Subir junto com o CSP.
const SDK_URL = 'https://unpkg.com/@modelcontextprotocol/ext-apps@1.7.5/dist/src/app-with-deps.js';
export const UI_CSP = { resourceDomains: ['https://unpkg.com'] };

const CSS = /* css */ `
:root{color-scheme:light dark;
 --bg:var(--color-background-primary,light-dark(#ffffff,#1a1a1a));
 --bg2:var(--color-background-secondary,light-dark(#f4f4f5,#242424));
 --bg3:var(--color-background-tertiary,light-dark(#e9e9eb,#2e2e2e));
 --fg:var(--color-text-primary,light-dark(#111827,#f3f4f6));
 --fg2:var(--color-text-secondary,light-dark(#6b7280,#a1a1aa));
 --line:var(--color-border-primary,light-dark(#e5e7eb,#3a3a3a));
 --accent:var(--color-text-info,light-dark(#2563eb,#60a5fa));
 --ok:var(--color-text-success,light-dark(#15803d,#4ade80));
 --warn:var(--color-text-warning,light-dark(#b45309,#fbbf24));
 --bad:var(--color-text-danger,light-dark(#b91c1c,#f87171));
 --r:var(--border-radius-md,10px);
 --fs:var(--font-text-md-size,14px);
 --font:var(--font-sans,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif);}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--fg);font:var(--fs)/1.45 var(--font)}
body{padding:12px}
a{color:var(--accent)}
button{font:inherit;color:inherit;background:var(--bg2);border:1px solid var(--line);border-radius:8px;padding:6px 10px;cursor:pointer;min-height:36px}
button:hover{background:var(--bg3)}
button.primary{background:var(--accent);color:#fff;border-color:transparent}
.muted{color:var(--fg2)}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.between{justify-content:space-between}
.card{background:var(--bg2);border:1px solid var(--line);border-radius:var(--r);padding:12px}
.grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.chip{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--line);border-radius:999px;padding:2px 9px;font-size:12px;background:var(--bg);white-space:nowrap}
.chip.ok{border-color:var(--ok);color:var(--ok)} .chip.warn{border-color:var(--warn);color:var(--warn)} .chip.bad{border-color:var(--bad);color:var(--bad)} .chip.acc{border-color:var(--accent);color:var(--accent)}
.code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:var(--bg3);padding:1px 6px;border-radius:6px}
h1{font-size:18px;margin:0} h2{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--fg2);margin:0 0 8px}
h3{font-size:15px;margin:0}
.kv{display:grid;grid-template-columns:auto 1fr;gap:3px 10px;font-size:13px} .kv b{font-weight:500;color:var(--fg2)}
.list{display:flex;flex-direction:column;gap:6px}
.item{display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg)}
.item.click{cursor:pointer} .item.click:hover{border-color:var(--accent)}
.msgs{display:flex;flex-direction:column;gap:6px}
.msg{max-width:85%;padding:7px 10px;border-radius:12px;background:var(--bg3);font-size:13px;white-space:pre-wrap;word-break:break-word}
.msg.me{align-self:flex-end;background:var(--accent);color:#fff}
.msg small{display:block;opacity:.7;font-size:11px;margin-top:2px}
.tiles{display:grid;gap:8px;grid-template-columns:repeat(auto-fit,minmax(110px,1fr))}
.tile{background:var(--bg2);border:1px solid var(--line);border-radius:var(--r);padding:10px}
.tile .n{font-size:22px;font-weight:600;line-height:1.1} .tile .l{font-size:12px;color:var(--fg2)}
.board{display:flex;gap:10px;overflow-x:auto;padding-bottom:6px;scroll-snap-type:x proximity}
.col{min-width:230px;max-width:260px;flex:1 0 230px;background:var(--bg2);border:1px solid var(--line);border-radius:var(--r);padding:8px;scroll-snap-align:start}
.col h3{display:flex;justify-content:space-between;align-items:center;font-size:13px;margin:0 0 8px;padding:0 2px}
.col .cnt{background:var(--bg3);border-radius:999px;padding:0 8px;font-size:12px}
.dc{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px;margin-bottom:6px;cursor:pointer;font-size:13px}
.dc:hover{border-color:var(--accent)}
.dc .t{font-weight:500;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dc .s{color:var(--fg2);font-size:12px;display:flex;justify-content:space-between;gap:6px;margin-top:4px}
.tabs{display:flex;gap:6px;flex-wrap:wrap} .tabs button.on{background:var(--accent);color:#fff;border-color:transparent}
.sec{margin-top:14px}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;background:var(--ok)}
.empty{color:var(--fg2);font-style:italic;padding:6px 2px}
.err{border:1px solid var(--bad);color:var(--bad);border-radius:var(--r);padding:10px}
.loading{color:var(--fg2);padding:20px;text-align:center}
`;

// JS compartilhado: utilidades + renderização da ficha (usada nas duas telas).
const SHARED_JS = /* js */ `
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const brl = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? '' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const has = (a) => Array.isArray(a) && a.length > 0;
const ACAO = { ENVIAR_MENSAGEM: 'Enviar mensagem', LIGAR: 'Ligar', CONFIRMAR_CALL: 'Confirmar call', RESGATAR_NO_SHOW: 'Resgatar no-show', AGUARDAR: 'Aguardar', ENCERRAR: 'Encerrar' };
const ETAPA = { new: 'Novo', novo: 'Novo', em_contato: 'Em contato', contacted: 'Em contato', qualificado: 'Qualificado', qualified: 'Qualificado', call_agendada: 'Call agendada', no_show: 'No-show', call_realizada: 'Call realizada', em_fechamento: 'Em fechamento', negotiation: 'Negociação', proposal: 'Proposta', ganho: 'Ganho', won: 'Ganho', perdido: 'Perdido', lost: 'Perdido' };
const etapa = (v) => ETAPA[v] || v || '';
const kv = (pairs) => '<div class="kv">' + pairs.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => '<b>' + esc(k) + '</b><span>' + v + '</span>').join('') + '</div>';
const tel = (t) => t ? '<a href="https://wa.me/' + esc(String(t).replace(/\\D/g, '')) + '" data-link>' + esc(t) + '</a>' : '';
const openLink = async (url) => { try { await app.sendOpenLink({ url }); } catch { try { window.open(url, '_blank', 'noopener'); } catch {} } };
document.addEventListener('click', (e) => { const a = e.target.closest('a[data-link]'); if (a) { e.preventDefault(); openLink(a.href); } });

function renderFicha(d) {
  if (!d || d.encontrado === false) return '<div class="card">Nenhum lead encontrado para <b>' + esc(d?.termo) + '</b>. Tente o código (ex.: L000123), parte do nome ou o telefone.</div>';
  if (d.multiplos) {
    return '<div class="card"><h2>' + esc(d.total) + ' leads batem com “' + esc(d.termo) + '”. Qual deles?</h2><div class="list">' +
      (d.opcoes || []).map((o) => '<div class="item click" data-ficha="' + esc(o.codigo || o.id) + '"><span class="code">' + esc(o.codigo || '—') + '</span><div style="flex:1"><div><b>' + esc(o.nome) + '</b></div><div class="muted" style="font-size:12px">' + esc(o.telefone || '') + ' · ' + esc(o.etapa_pipeline || etapa(o.etapa)) + ' · atualizado ' + esc(o.atualizado_em) + '</div></div></div>').join('') + '</div></div>';
  }
  const l = d.lead || {}, p = d.playbook || {}, n = d.negociacao || {}, h = d.historico || {};
  const scoreChip = l.score !== null && l.score !== undefined ? '<span class="chip ' + (l.score >= 70 ? 'ok' : l.score >= 40 ? 'warn' : '') + '" title="' + esc(l.motivo_score || '') + '">Score ' + esc(l.score) + '</span>' : '';
  const acaoChip = p.acao_de_hoje ? '<span class="chip acc">Hoje: ' + esc(ACAO[p.acao_de_hoje] || p.acao_de_hoje) + (p.dia ? ' · dia ' + esc(p.dia) : '') + '</span>' : '';
  const respChip = p.resposta === 'RESPONDEU' ? '<span class="chip ok">Respondeu</span>' : p.resposta === 'NAO_RESPONDEU' && (p.tentativas || 0) > 0 ? '<span class="chip warn">Sem resposta · ' + esc(p.tentativas) + ' tent.</span>' : '';
  let out = '<div class="row between" style="margin-bottom:10px"><div><div class="row"><span class="code">' + esc(l.codigo || '—') + '</span><h1>' + esc(l.nome || 'Sem nome') + '</h1></div>' +
    '<div class="row" style="margin-top:6px"><span class="chip">' + esc(l.etapa_pipeline || etapa(l.etapa) || 'sem etapa') + '</span>' + scoreChip + acaoChip + respChip +
    (l.vendedor ? '<span class="chip">👤 ' + esc(l.vendedor) + '</span>' : '<span class="chip warn">Sem vendedor</span>') + (l.loja ? '<span class="chip muted">' + esc(l.loja) + '</span>' : '') + '</div></div>' +
    '<div class="row"><button data-refresh>Atualizar</button>' + (l.link ? '<button class="primary" data-open="' + esc(l.link) + '">Abrir no CRM</button>' : '') + '</div></div>';

  out += '<div class="grid">';
  out += '<div class="card"><h2>Contato</h2>' + kv([['Telefone', tel(l.telefone)], ['E-mail', esc(l.email)], ['Cidade', esc([l.cidade, l.estado].filter(Boolean).join(' / '))], ['Origem', esc([l.origem, l.campanha].filter(Boolean).join(' · '))], ['No CRM desde', esc(l.criado_em) + (l.dias_de_casa !== null && l.dias_de_casa !== undefined ? ' <span class="muted">(' + esc(l.dias_de_casa) + ' dias)</span>' : '')], ['Última interação', esc(l.ultima_interacao)], ['Mensagens', l.total_mensagens ? esc(l.total_mensagens) + ' · recebida ' + esc(l.ultima_msg_recebida || '—') + ' · enviada ' + esc(l.ultima_msg_enviada || '—') : '']]) + '</div>';
  const trocas = (n.trocas || []).map((t) => esc([t.marca, t.modelo, t.versao, t.ano].filter(Boolean).join(' ')) + (t.km ? ' · ' + esc(Number(t.km).toLocaleString('pt-BR')) + ' km' : '') + (t.valor_pedido ? ' · pede ' + brl(t.valor_pedido) : ''));
  const capt = (n.veiculos_captados || []).map((t) => esc([t.marca, t.modelo, t.versao, t.ano].filter(Boolean).join(' ')) + ' <span class="chip">' + esc(t.status || 'captado') + '</span>' + (t.valor_anuncio || t.valor_esperado ? ' · ' + brl(t.valor_anuncio || t.valor_esperado) : ''));
  out += '<div class="card"><h2>Negociação</h2>' + kv([['Carro de interesse', esc(n.veiculo_interesse || n.veiculo_meta)], ['Carro na troca', trocas.join('<br>') || (n.tem_troca === 'true' || n.tem_troca === 'sim' ? 'Sim (sem detalhes)' : '')], ['Captado (intermediação)', capt.join('<br>')], ['Entrada', esc(n.entrada)], ['Pagamento', esc([n.forma_pagamento, n.precisa_financiar === 'true' || n.precisa_financiar === 'sim' ? 'precisa financiar' : ''].filter(Boolean).join(' · '))], ['Faixa de preço', n.faixa_min || n.faixa_max ? esc([brl(n.faixa_min), brl(n.faixa_max)].filter(Boolean).join(' a ')) : ''], ['Simulações feitas', n.simulacoes ? esc(n.simulacoes) : ''], ['Última tratativa', esc(n.ultima_tratativa)], ['Observação', esc(n.observacao)]]) + (!n.veiculo_interesse && !n.veiculo_meta && !trocas.length && !capt.length && !n.entrada ? '<div class="empty">Sem dados de negociação ainda.</div>' : '') + '</div>';
  out += '</div>';

  const deals = d.deals || [];
  out += '<div class="sec card"><h2>Negócios (' + deals.length + ')</h2>' + (has(deals) ? '<div class="list">' + deals.map((x) => '<div class="item"><div style="flex:1"><div><b>' + esc(x.titulo) + '</b> ' + (x.ganho ? '<span class="chip ok">Ganho</span>' : x.perdido ? '<span class="chip bad">Perdido</span>' : '') + (x.temperatura ? ' <span class="chip">' + esc(x.temperatura) + '</span>' : '') + '</div><div class="muted" style="font-size:12px">' + esc([x.pipeline, x.etapa].filter(Boolean).join(' › ')) + (x.dias_na_etapa !== null && x.dias_na_etapa !== undefined ? ' · ' + esc(x.dias_na_etapa) + ' dias na etapa' : '') + ' · criado ' + esc(x.criado_em) + '</div></div>' + (x.valor ? '<b>' + brl(x.valor) + '</b>' : '') + '</div>').join('') + '</div>' : '<div class="empty">Nenhum negócio aberto.</div>');
  if (has(d.intermediacoes)) out += '<div class="list" style="margin-top:8px">' + d.intermediacoes.map((i) => '<div class="item"><span class="code">' + esc(i.codigo) + '</span><div style="flex:1">Intermediação · <span class="chip">' + esc(i.status) + '</span>' + (i.preco_pedido ? ' · pede ' + brl(i.preco_pedido) : '') + (i.preco_venda ? ' · vendido ' + brl(i.preco_venda) : '') + '</div></div>').join('') + '</div>';
  out += '</div>';

  const tarefas = d.tarefas || [];
  out += '<div class="sec grid"><div class="card"><h2>Tarefas abertas (' + tarefas.length + ')</h2>' + (has(tarefas) ? '<div class="list">' + tarefas.map((t) => '<div class="item">' + (t.atrasada ? '<span class="chip bad">atrasada</span>' : t.critica ? '<span class="chip warn">crítica</span>' : '<span class="chip">' + esc(t.tipo || 'tarefa') + '</span>') + '<div style="flex:1"><div>' + esc(t.titulo) + '</div><div class="muted" style="font-size:12px">' + esc([t.quando, t.responsavel].filter(Boolean).join(' · ')) + '</div></div></div>').join('') + '</div>' : '<div class="empty">Nada pendente.</div>') + '</div>';
  const ativ = d.atividades || [];
  out += '<div class="card"><h2>Últimas atividades</h2>' + (has(ativ) ? '<div class="list">' + ativ.map((a) => '<div class="item"><span class="muted" style="font-size:12px;white-space:nowrap">' + esc(a.em) + '</span><div style="flex:1">' + esc(a.titulo) + (a.resultado ? ' <span class="muted">— ' + esc(a.resultado) + '</span>' : '') + '</div>' + (a.concluida ? '<span class="chip ok">✓</span>' : '') + '</div>').join('') + '</div>' : '<div class="empty">Sem atividades registradas.</div>') + '</div></div>';

  const msgs = d.mensagens || [];
  out += '<div class="sec card"><h2>WhatsApp — últimas mensagens</h2>' + (has(msgs) ? '<div class="msgs">' + msgs.map((m) => '<div class="msg ' + (m.minha ? 'me' : '') + '">' + esc(m.texto) + '<small>' + esc(m.em) + (m.minha ? ' · ' + esc(m.status || 'enviada') : '') + '</small></div>').join('') + '</div>' : '<div class="empty">Sem conversa no WhatsApp.</div>') + '</div>';

  const ag = d.agente || [];
  const hist = [];
  if (has(h.mesclado_de)) hist.push('Mesclado com ' + h.mesclado_de.map((m) => '<span class="code">' + esc(m.codigo || 'cadastro') + '</span> ' + esc(m.nome || '') + (m.em ? ' <span class="muted">(' + esc(String(m.em).slice(0, 10)) + ')</span>' : '')).join(', '));
  if (has(h.codigos_antigos)) hist.push('Códigos antigos: ' + h.codigos_antigos.map((c) => '<span class="code">' + esc(c) + '</span>').join(' '));
  if (h.email_reativacao) hist.push('Veio do e-mail de reativação <b>' + esc(h.email_reativacao.campanha || '') + '</b> (' + esc(h.email_reativacao.tipo || '') + ')' + (h.email_reativacao.loja ? ' · cliente da ' + esc(h.email_reativacao.loja) : '') + (h.email_reativacao.modelo ? ' · tem ' + esc(h.email_reativacao.modelo) : '') + (h.email_reativacao.carro_interesse ? ' · viu ' + esc(h.email_reativacao.carro_interesse) : ''));
  if (h.reaquecimento) hist.push('Em reaquecimento' + (h.reaquecimento.template ? ' (' + esc(h.reaquecimento.template) + ')' : ''));
  if (h.captado_por) hist.push('Captado por ' + esc(h.captado_por));
  if (h.promotora) hist.push('Promotora: ' + esc(h.promotora));
  if (h.transferido_de) hist.push('Transferido de outra loja');
  if (l.contexto) hist.push('<span class="muted">' + esc(l.contexto) + '</span>');
  out += '<div class="sec grid"><div class="card"><h2>Histórico</h2>' + (hist.length ? '<div class="list">' + hist.map((x) => '<div class="item"><div>' + x + '</div></div>').join('') + '</div>' : '<div class="empty">Sem histórico extra.</div>') + '</div>';
  out += '<div class="card"><h2>Agente IA (Nina)</h2>' + (has(ag) ? '<div class="list">' + ag.map((e) => '<div class="item"><span class="chip ' + (e.evento === 'replied' ? 'ok' : e.evento === 'error' ? 'bad' : 'warn') + '">' + esc(e.evento) + '</span><div style="flex:1;font-size:12px">' + esc(e.motivo || '') + ' <span class="muted">' + esc(e.em) + '</span></div></div>').join('') + '</div>' : '<div class="empty">A Nina ainda não atuou neste lead.</div>') + '</div></div>';
  return out;
}

function bindFicha(root, onPick) {
  root.querySelectorAll('[data-ficha]').forEach((el) => el.addEventListener('click', () => onPick(el.getAttribute('data-ficha'))));
  root.querySelectorAll('[data-open]').forEach((el) => el.addEventListener('click', () => openLink(el.getAttribute('data-open'))));
}

function fromResult(r) {
  if (r?.structuredContent) return r.structuredContent;
  const t = (r?.content || []).find((c) => c.type === 'text')?.text;
  try { return t ? JSON.parse(t) : null; } catch { return null; }
}
`;

function page(title: string, body: string, js: string) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<style>${CSS}</style>
</head>
<body>
<div id="root">${body}</div>
<script type="module">
import { App } from "${SDK_URL}";
const app = new App({ name: ${JSON.stringify(title)}, version: '1.0.0' });
const root = document.getElementById('root');
${SHARED_JS}
${js}
</script>
</body>
</html>`;
}

export const FICHA_HTML = page('Totexgest — Ficha do lead', '<div class="loading">Carregando a ficha…</div>', /* js */ `
let lastArgs = {};
function show(d) { root.innerHTML = renderFicha(d); bindFicha(root, (termo) => load({ termo })); root.querySelector('[data-refresh]')?.addEventListener('click', () => load(lastArgs)); }
async function load(args) {
  lastArgs = args; root.innerHTML = '<div class="loading">Buscando…</div>';
  try { const r = await app.callServerTool({ name: 'ficha_lead', arguments: args }); const d = fromResult(r); if (r?.isError || d?.error) throw new Error(d?.error || 'Falhou'); show(d); }
  catch (e) { root.innerHTML = '<div class="err">' + esc(e?.message || e) + '</div>'; }
}
app.ontoolinput = ({ arguments: a }) => { lastArgs = a || {}; };
app.ontoolresult = (r) => { const d = fromResult(r); if (r?.isError || d?.error) root.innerHTML = '<div class="err">' + esc(d?.error || 'A ferramenta falhou.') + '</div>'; else show(d); };
app.onhostcontextchanged = (c) => { if (c?.theme) document.documentElement.style.colorScheme = c.theme; };
await app.connect();
`);

export const PIPELINE_HTML = page('Totexgest — Pipeline do dia', '<div class="loading">Montando o pipeline de hoje…</div>', /* js */ `
let data = null, tab = 0;
const tile = (n, l, cls) => '<div class="tile"><div class="n ' + (cls || '') + '">' + esc(n ?? 0) + '</div><div class="l">' + l + '</div></div>';
const who = (x) => x.lead ? '<b>' + esc(x.lead) + '</b>' + (x.codigo ? ' <span class="code">' + esc(x.codigo) + '</span>' : '') : '';
function renderBoard() {
  const d = data, r = d.resumo || {};
  let out = '<div class="row between" style="margin-bottom:10px"><div><h1>Pipeline do dia</h1><div class="muted">' + esc(d.dia_semana) + ', ' + esc(d.data) + (d.loja ? ' · ' + esc(d.loja) : '') + '</div></div><div class="row"><button data-refresh>Atualizar</button>' + (d.app_url ? '<button class="primary" data-open="' + esc(d.app_url + '/comercial/pipeline') + '">Abrir no CRM</button>' : '') + '</div></div>';
  out += '<div class="tiles">' + tile(r.novos_leads, 'novos leads hoje') + tile(r.responderam, 'responderam hoje', r.responderam ? 'ok' : '') + tile(r.movidos, 'cards movidos') + tile(r.ganhos, 'ganhos hoje', r.ganhos ? 'ok' : '') + tile(r.em_aberto, 'negócios abertos') + tile(r.fila, 'na fila do playbook', r.fila ? 'acc' : '') + tile(r.tarefas_hoje, 'tarefas hoje') + tile(r.tarefas_atrasadas, 'tarefas atrasadas', r.tarefas_atrasadas ? 'bad' : '') + '</div>';
  const pps = d.pipelines || [];
  if (pps.length > 1) out += '<div class="tabs sec">' + pps.map((p, i) => '<button data-tab="' + i + '" class="' + (i === tab ? 'on' : '') + '">' + esc(p.nome) + '</button>').join('') + '</div>';
  const p = pps[tab];
  if (p) {
    out += '<div class="board sec">' + (p.etapas || []).map((s) => '<div class="col"><h3><span>' + esc(s.nome) + (s.ganho ? ' <span class="muted" style="font-weight:400">(30 dias)</span>' : '') + '</span><span class="cnt">' + esc(s.total) + '</span></h3>' +
      ((s.cards || []).map((c) => '<div class="dc" data-ficha="' + esc(c.codigo || c.lead_id || '') + '"><div class="t">' + (c.movido_hoje ? '<span class="dot" title="movido hoje"></span> ' : '') + esc(c.lead || c.titulo) + '</div>' + (c.lead && c.titulo && c.titulo !== c.lead ? '<div class="muted" style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(c.titulo) + '</div>' : '') + '<div class="s"><span>' + esc([c.codigo, c.vendedor].filter(Boolean).join(' · ')) + '</span><span>' + (c.valor ? brl(c.valor) : (c.dias_na_etapa ?? 0) + 'd') + '</span></div>' + (c.respondeu_hoje || c.temperatura || (c.acao && c.acao !== 'AGUARDAR' && c.acao !== 'ENCERRAR') ? '<div class="row" style="margin-top:5px;gap:4px">' + (c.respondeu_hoje ? '<span class="chip ok">respondeu hoje</span>' : '') + (c.temperatura ? '<span class="chip">' + esc(c.temperatura) + '</span>' : '') + (c.acao && c.acao !== 'AGUARDAR' && c.acao !== 'ENCERRAR' ? '<span class="chip acc">' + esc(ACAO[c.acao] || c.acao) + '</span>' : '') + '</div>' : '') + '</div>').join('') || '<div class="empty">vazio</div>') +
      (s.total > (s.cards || []).length ? '<div class="muted" style="font-size:12px;padding:4px 2px">+ ' + esc(s.total - s.cards.length) + ' no CRM</div>' : '') + '</div>').join('') + '</div>';
  } else out += '<div class="empty sec">Nenhum pipeline ativo.</div>';

  const fila = d.fila || [], agenda = d.agenda || [], atr = d.atrasadas || [], novos = d.novos_leads || [];
  out += '<div class="grid sec">';
  out += '<div class="card"><h2>Fila do playbook (' + esc(r.fila ?? fila.length) + ')</h2>' + (fila.length ? '<div class="list">' + fila.map((x) => '<div class="item click" data-ficha="' + esc(x.codigo || x.id) + '"><span class="chip acc">' + esc(ACAO[x.acao] || x.acao) + '</span><div style="flex:1"><div><b>' + esc(x.nome) + '</b> <span class="code">' + esc(x.codigo || '') + '</span></div><div class="muted" style="font-size:12px">dia ' + esc(x.dia ?? 1) + ' · ' + esc(etapa(x.etapa)) + (x.resposta === 'RESPONDEU' ? ' · respondeu' : x.tentativas ? ' · ' + esc(x.tentativas) + ' tentativas' : '') + (x.vendedor ? ' · ' + esc(x.vendedor) : '') + '</div></div></div>').join('') + '</div>' : '<div class="empty">Ninguém na fila agora.</div>') + '</div>';
  out += '<div class="card"><h2>Agenda de hoje (' + agenda.length + ')</h2>' + (agenda.length ? '<div class="list">' + agenda.map((a) => '<div class="item ' + (a.codigo ? 'click' : '') + '" ' + (a.codigo ? 'data-ficha="' + esc(a.codigo) + '"' : '') + '><span class="code">' + esc(a.hora || '—') + '</span><div style="flex:1"><div>' + (a.concluida ? '<s>' : '') + esc(a.titulo) + (a.concluida ? '</s>' : '') + '</div><div class="muted" style="font-size:12px">' + [who(a), esc(a.tipo || ''), esc(a.responsavel || '')].filter(Boolean).join(' · ') + '</div></div>' + (a.concluida ? '<span class="chip ok">✓</span>' : '') + '</div>').join('') + '</div>' : '<div class="empty">Nada agendado para hoje.</div>') + '</div>';
  out += '<div class="card"><h2>Atrasadas (' + esc(r.tarefas_atrasadas ?? atr.length) + ')</h2>' + (atr.length ? '<div class="list">' + atr.map((a) => '<div class="item ' + (a.codigo ? 'click' : '') + '" ' + (a.codigo ? 'data-ficha="' + esc(a.codigo) + '"' : '') + '><span class="chip bad">' + esc(a.dias) + 'd</span><div style="flex:1"><div>' + esc(a.titulo) + '</div><div class="muted" style="font-size:12px">' + [who(a), 'vencia ' + esc(a.vencia_em), esc(a.responsavel || '')].filter(Boolean).join(' · ') + '</div></div></div>').join('') + '</div>' : '<div class="empty">Nada atrasado. 👏</div>') + '</div>';
  out += '<div class="card"><h2>Novos leads de hoje (' + esc(r.novos_leads ?? novos.length) + ')</h2>' + (novos.length ? '<div class="list">' + novos.map((x) => '<div class="item click" data-ficha="' + esc(x.codigo || x.id) + '"><span class="code">' + esc(x.hora) + '</span><div style="flex:1"><div><b>' + esc(x.nome || 'Sem nome') + '</b> <span class="code">' + esc(x.codigo || '') + '</span></div><div class="muted" style="font-size:12px">' + esc([x.origem, x.telefone].filter(Boolean).join(' · ')) + '</div></div>' + (x.respondeu ? '<span class="chip ok">respondeu</span>' : '') + '</div>').join('') + '</div>' : '<div class="empty">Nenhum lead novo ainda hoje.</div>') + '</div>';
  out += '</div>';
  root.innerHTML = out;
  root.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { tab = Number(b.getAttribute('data-tab')); renderBoard(); }));
  root.querySelector('[data-refresh]')?.addEventListener('click', loadBoard);
  bindFicha(root, openFicha);
}
async function loadBoard() {
  root.innerHTML = '<div class="loading">Atualizando…</div>';
  try { const r = await app.callServerTool({ name: 'pipeline_do_dia', arguments: {} }); const d = fromResult(r); if (r?.isError || d?.error) throw new Error(d?.error || 'Falhou'); data = d; renderBoard(); }
  catch (e) { root.innerHTML = '<div class="err">' + esc(e?.message || e) + '</div>'; }
}
async function openFicha(termo) {
  if (!termo) return;
  root.innerHTML = '<div class="loading">Abrindo a ficha…</div>';
  try {
    const r = await app.callServerTool({ name: 'ficha_lead', arguments: { termo } }); const d = fromResult(r);
    if (r?.isError || d?.error) throw new Error(d?.error || 'Falhou');
    root.innerHTML = '<div class="row" style="margin-bottom:10px"><button data-back>← Voltar ao pipeline</button></div>' + renderFicha(d);
    root.querySelector('[data-back]').addEventListener('click', renderBoard);
    root.querySelector('[data-refresh]')?.addEventListener('click', () => openFicha(termo));
    bindFicha(root, openFicha);
  } catch (e) { root.innerHTML = '<div class="row" style="margin-bottom:10px"><button data-back>← Voltar</button></div><div class="err">' + esc(e?.message || e) + '</div>'; root.querySelector('[data-back]').addEventListener('click', renderBoard); }
}
app.ontoolresult = (r) => { const d = fromResult(r); if (r?.isError || d?.error) root.innerHTML = '<div class="err">' + esc(d?.error || 'A ferramenta falhou.') + '</div>'; else { data = d; tab = 0; renderBoard(); } };
app.onhostcontextchanged = (c) => { if (c?.theme) document.documentElement.style.colorScheme = c.theme; };
await app.connect();
`);
