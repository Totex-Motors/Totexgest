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
export const UI_URI_INBOX = 'ui://totexgest/inbox.html';
export const UI_URI_AGENDA = 'ui://totexgest/agenda-semana.html';
export const UI_URI_RANKING = 'ui://totexgest/ranking.html';

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
input,textarea{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;min-height:36px;width:100%}
textarea{resize:vertical;min-height:64px}
.conv{display:flex;gap:10px;align-items:flex-start;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--bg);cursor:pointer}
.conv:hover{border-color:var(--accent)} .conv.wait{border-left:3px solid var(--warn)}
.conv .ic{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;background:var(--bg3);font-size:16px;flex:none}
.conv .ic.wa{background:#25d36622} .conv .ic.ig{background:#e1306c22}
.conv .last{color:var(--fg2);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.thread{display:flex;flex-direction:column;gap:6px;padding:10px;background:var(--bg2);border:1px solid var(--line);border-radius:var(--r)}
.reply{display:flex;gap:8px;align-items:flex-end;margin-top:10px}
.week{display:flex;gap:8px;overflow-x:auto;padding-bottom:6px}
.day{min-width:170px;flex:1 0 170px;background:var(--bg2);border:1px solid var(--line);border-radius:var(--r);padding:8px}
.day.today{border-color:var(--accent)} .day h3{font-size:13px;margin:0 0 6px;display:flex;justify-content:space-between}
.ev{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:6px 8px;margin-bottom:6px;font-size:12px;cursor:pointer}
.ev:hover{border-color:var(--accent)} .ev.done{opacity:.6} .ev .h{font-family:ui-monospace,monospace;color:var(--fg2)}
.rank{display:flex;flex-direction:column;gap:8px}
.rk{display:grid;grid-template-columns:36px 1fr auto;gap:10px;align-items:center;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--bg)}
.rk .pos{font-size:20px;text-align:center} .rk .bar{height:6px;border-radius:3px;background:var(--bg3);margin-top:6px;overflow:hidden} .rk .bar i{display:block;height:100%;background:var(--accent)}
.rk .stats{display:flex;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--fg2);margin-top:4px}
`;

// JS compartilhado: utilidades + renderização da ficha (usada nas duas telas).
const SHARED_JS = /* js */ `
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const brl = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? '' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const has = (a) => Array.isArray(a) && a.length > 0;
const ACAO = { ENVIAR_MENSAGEM: 'Enviar mensagem', LIGAR: 'Ligar', CONFIRMAR_CALL: 'Confirmar call', RESGATAR_NO_SHOW: 'Resgatar no-show', AGUARDAR: 'Aguardar', ENCERRAR: 'Encerrar' };
const ETAPA = { new: 'Novo', novo: 'Novo', em_contato: 'Em contato', contacted: 'Em contato', qualificado: 'Qualificado', qualified: 'Qualificado', call_agendada: 'Call agendada', no_show: 'No-show', call_realizada: 'Call realizada', em_fechamento: 'Em fechamento', negotiation: 'Negociação', proposal: 'Proposta', ganho: 'Ganho', won: 'Ganho', perdido: 'Perdido', lost: 'Perdido' };
const etapa = (v) => ETAPA[v] || v || '';
const DIA = { Monday: 'Segunda-feira', Tuesday: 'Terça-feira', Wednesday: 'Quarta-feira', Thursday: 'Quinta-feira', Friday: 'Sexta-feira', Saturday: 'Sábado', Sunday: 'Domingo', Mon: 'Seg', Tue: 'Ter', Wed: 'Qua', Thu: 'Qui', Fri: 'Sex', Sat: 'Sáb', Sun: 'Dom' };
const diaPt = (v) => DIA[v] || v || '';
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
  let out = '<div class="row between" style="margin-bottom:10px"><div><h1>Pipeline do dia</h1><div class="muted">' + esc(diaPt(d.dia_semana)) + ', ' + esc(d.data) + (d.loja ? ' · ' + esc(d.loja) : '') + '</div></div><div class="row"><button data-refresh>Atualizar</button>' + (d.app_url ? '<button class="primary" data-open="' + esc(d.app_url + '/comercial/pipeline') + '">Abrir no CRM</button>' : '') + '</div></div>';
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

// ─── Inbox (WhatsApp oficial + Instagram) ───────────────────────────────────
export const INBOX_HTML = page('Totexgest — Inbox', '<div class="loading">Abrindo o inbox…</div>', /* js */ `
let inbox = null, args = { canal: 'todos', filtro: 'pendentes' }, thread = null, pollTimer = null;
const icon = (c) => '<div class="ic ' + (c === 'instagram' ? 'ig' : 'wa') + '">' + (c === 'instagram' ? '📷' : '💬') + '</div>';
function convRow(c, canal) {
  const chips = [];
  if (c.aguardando) chips.push('<span class="chip warn">aguardando' + (c.sem_resposta > 1 ? ' · ' + esc(c.sem_resposta) : '') + '</span>');
  if (c.janela_aberta) chips.push('<span class="chip ok">janela 24h aberta</span>');
  if (c.nina) chips.push('<span class="chip ' + (c.nina === 'replied' ? 'ok' : 'warn') + '">Nina: ' + esc(c.nina) + '</span>');
  if (c.nao_lidas) chips.push('<span class="chip acc">' + esc(c.nao_lidas) + ' não lidas</span>');
  if (canal === 'whatsapp' && c.provider && c.provider !== 'meta_cloud') chips.push('<span class="chip">' + esc(c.instancia || 'UAZAPI') + '</span>');
  if (c.outra_loja) chips.push('<span class="chip muted">lead da ' + esc(c.outra_loja) + '</span>');
  const who = canal === 'instagram' ? '@' + esc(c.usuario) + (c.nome ? ' · ' + esc(c.nome) : '') : esc(c.nome || c.telefone || 'Sem nome');
  return '<div class="conv ' + (c.aguardando ? 'wait' : '') + '" data-conv="' + canal + ':' + esc(c.id) + '">' + icon(canal) + '<div style="flex:1;min-width:0"><div class="row between" style="gap:6px"><b style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + who + '</b><span class="muted" style="font-size:12px;white-space:nowrap">' + esc(c.ultima_em || '') + '</span></div>' +
    '<div class="last">' + (c.ultima_minha ? '<span class="muted">' + esc(c.enviada_por || 'você') + ': </span>' : '') + esc(c.ultima || '') + '</div>' +
    '<div class="row" style="gap:4px;margin-top:4px">' + (c.codigo ? '<span class="code">' + esc(c.codigo) + '</span>' : '') + chips.join('') + (c.vendedor || c.responsavel ? '<span class="chip">' + esc(c.vendedor || c.responsavel) + '</span>' : '') + (c.etapa ? '<span class="chip muted">' + esc(c.etapa) + '</span>' : '') + '</div></div></div>';
}
function renderInbox() {
  const d = inbox, r = d.resumo || {};
  const wa = d.whatsapp || [], ig = d.instagram || [];
  let out = '<div class="row between" style="margin-bottom:10px"><div><h1>Inbox</h1><div class="muted">' + esc(d.loja || '') + ' · WhatsApp ' + (d.oficial_conectado ? 'oficial conectado' : '<span style="color:var(--bad)">oficial desconectado</span>') + ' · Instagram ' + (d.instagram_conectado ? 'conectado' : '<span style="color:var(--bad)">desconectado</span>') + '</div></div><div class="row"><button data-refresh>Atualizar</button></div></div>';
  out += '<div class="row" style="margin-bottom:10px"><div class="tabs">' + [['todos','Todos'],['whatsapp','WhatsApp'],['instagram','Instagram']].map(([k,v]) => '<button data-canal="' + k + '" class="' + (args.canal === k ? 'on' : '') + '">' + v + '</button>').join('') + '</div><div class="tabs">' + [['pendentes','Aguardando resposta'],['todas','Todas']].map(([k,v]) => '<button data-filtro="' + k + '" class="' + (args.filtro === k ? 'on' : '') + '">' + v + '</button>').join('') + '</div><form data-busca class="row" style="flex:1;min-width:200px"><input name="q" placeholder="Buscar nome, @usuário, telefone ou código" value="' + esc(args.busca || '') + '"><button type="submit">Buscar</button></form></div>';
  out += '<div class="tiles" style="margin-bottom:10px">' + '<div class="tile"><div class="n ' + (r.wa_aguardando ? 'warn' : '') + '">' + esc(r.wa_aguardando ?? 0) + '</div><div class="l">WhatsApp aguardando</div></div><div class="tile"><div class="n ' + (r.ig_aguardando ? 'warn' : '') + '">' + esc(r.ig_aguardando ?? 0) + '</div><div class="l">Instagram aguardando</div></div><div class="tile"><div class="n">' + esc((r.wa_total ?? 0) + (r.ig_total ?? 0)) + '</div><div class="l">conversas listadas</div></div></div>';
  const all = [...wa.map((c) => ({ c, canal: 'whatsapp' })), ...ig.map((c) => ({ c, canal: 'instagram' }))];
  if (args.canal === 'todos') all.sort((a, b) => String(b.c.ultima_em || '').localeCompare(String(a.c.ultima_em || '')));
  out += all.length ? '<div class="list">' + all.map(({ c, canal }) => convRow(c, canal)).join('') + '</div>' : '<div class="empty">' + (args.filtro === 'pendentes' ? 'Ninguém aguardando resposta. 👏' : 'Nenhuma conversa encontrada.') + '</div>';
  root.innerHTML = out;
  root.querySelectorAll('[data-canal]').forEach((b) => b.addEventListener('click', () => loadInbox({ ...args, canal: b.getAttribute('data-canal') })));
  root.querySelectorAll('[data-filtro]').forEach((b) => b.addEventListener('click', () => loadInbox({ ...args, filtro: b.getAttribute('data-filtro') })));
  root.querySelector('[data-busca]').addEventListener('submit', (e) => { e.preventDefault(); loadInbox({ ...args, busca: e.target.q.value.trim() || undefined }); });
  root.querySelector('[data-refresh]').addEventListener('click', () => loadInbox(args));
  root.querySelectorAll('[data-conv]').forEach((el) => el.addEventListener('click', () => { const [canal, id] = el.getAttribute('data-conv').split(':'); openThread(canal, id); }));
}
async function loadInbox(a) {
  args = a; root.innerHTML = '<div class="loading">Carregando…</div>';
  try { const r = await app.callServerTool({ name: 'inbox', arguments: a }); const d = fromResult(r); if (r?.isError || d?.error) throw new Error(d?.error || 'Falhou'); inbox = d; renderInbox(); }
  catch (e) { root.innerHTML = '<div class="err">' + esc(e?.message || e) + '</div>'; }
}
function renderThread(t, note) {
  const h = t.cabecalho || {}, canal = t.canal;
  let out = '<div class="row between" style="margin-bottom:10px"><div class="row"><button data-back>← Inbox</button>' + icon(canal) + '<div><div><b>' + (canal === 'instagram' ? '@' + esc(h.usuario) + (h.nome ? ' · ' + esc(h.nome) : '') : esc(h.nome || h.telefone)) + '</b> ' + (h.codigo ? '<span class="code">' + esc(h.codigo) + '</span>' : '') + '</div><div class="muted" style="font-size:12px">' + esc([h.telefone, h.etapa, h.vendedor || h.responsavel, h.outra_loja ? 'lead da ' + h.outra_loja : ''].filter(Boolean).join(' · ')) + (h.ultima_do_cliente ? ' · cliente escreveu ' + esc(h.ultima_do_cliente) : '') + '</div></div></div><div class="row"><button data-refresh>Atualizar</button>' + (h.codigo ? '<button data-ficha="' + esc(h.codigo) + '">Ficha</button>' : '') + (h.link ? '<button class="primary" data-open="' + esc(h.link) + '">Abrir no CRM</button>' : '') + '</div></div>';
  if (has(h.nina)) out += '<div class="row" style="margin-bottom:8px;gap:4px">' + h.nina.map((e) => '<span class="chip ' + (e.evento === 'replied' ? 'ok' : e.evento === 'error' ? 'bad' : 'warn') + '" title="' + esc(e.motivo || '') + '">Nina ' + esc(e.evento) + ' ' + esc(e.em) + '</span>').join('') + '</div>';
  const msgs = t.mensagens || [];
  out += '<div class="thread">' + (msgs.length ? msgs.map((m) => '<div class="msg ' + (m.minha ? 'me' : '') + '">' + esc(m.texto) + (m.tem_midia ? ' 📎' : '') + '<small>' + esc(m.em) + (m.minha ? ' · ' + esc(m.por || '') + (m.status ? ' · ' + esc(m.status) : '') : '') + (m.erro ? ' · ⚠ ' + esc(m.erro) : '') + '</small></div>').join('') : '<div class="empty">Sem mensagens.</div>') + '</div>';
  if (note) out += '<div class="' + (note.ok ? 'card' : 'err') + '" style="margin-top:8px">' + esc(note.texto) + '</div>';
  if (h.pode_responder) out += '<form data-reply class="reply"><textarea name="texto" maxlength="1500" placeholder="Responder pelo ' + (canal === 'instagram' ? 'Instagram (conta oficial)' : 'WhatsApp oficial') + '…" required></textarea><button class="primary" type="submit">Enviar</button></form>';
  else out += '<div class="muted" style="margin-top:8px;font-size:12px">🔒 ' + esc(h.motivo_bloqueio || 'Não dá pra responder por aqui.') + '</div>';
  root.innerHTML = out;
  root.querySelector('[data-back]').addEventListener('click', () => loadInbox(args));
  root.querySelector('[data-refresh]').addEventListener('click', () => openThread(canal, t.id));
  bindFicha(root, openFichaFromInbox);
  root.querySelector('[data-reply]')?.addEventListener('submit', (e) => { e.preventDefault(); sendReply(canal, t.id, e.target.texto.value.trim(), e.target); });
}
async function openThread(canal, id) {
  root.innerHTML = '<div class="loading">Abrindo a conversa…</div>';
  try { const r = await app.callServerTool({ name: 'conversa', arguments: { canal, id } }); const d = fromResult(r); if (r?.isError || d?.error) throw new Error(d?.error || 'Falhou'); thread = d; renderThread(d); }
  catch (e) { root.innerHTML = '<div class="row" style="margin-bottom:10px"><button data-back>← Inbox</button></div><div class="err">' + esc(e?.message || e) + '</div>'; root.querySelector('[data-back]').addEventListener('click', () => loadInbox(args)); }
}
async function openFichaFromInbox(termo) {
  root.innerHTML = '<div class="loading">Abrindo a ficha…</div>';
  try { const r = await app.callServerTool({ name: 'ficha_lead', arguments: { termo } }); const d = fromResult(r); if (r?.isError || d?.error) throw new Error(d?.error || 'Falhou');
    root.innerHTML = '<div class="row" style="margin-bottom:10px"><button data-back>← Conversa</button></div>' + renderFicha(d);
    root.querySelector('[data-back]').addEventListener('click', () => thread ? renderThread(thread) : loadInbox(args)); bindFicha(root, openFichaFromInbox);
  } catch (e) { root.innerHTML = '<div class="err">' + esc(e?.message || e) + '</div>'; }
}
async function sendReply(canal, id, texto, form) {
  if (!texto) return;
  form.querySelector('button').disabled = true; form.querySelector('textarea').disabled = true;
  try {
    const r = await app.callServerTool({ name: 'responder', arguments: { canal, id, texto } }); const d = fromResult(r);
    if (r?.isError || d?.error) throw new Error(d?.error || 'Falhou');
    let st = null;
    for (let i = 0; i < 14 && !st?.pronto; i++) { await new Promise((ok) => setTimeout(ok, 1500)); const s = await app.callServerTool({ name: 'envio_status', arguments: { request_id: d.request_id } }); st = fromResult(s); }
    const rr = await app.callServerTool({ name: 'conversa', arguments: { canal, id } }); thread = fromResult(rr);
    renderThread(thread, !st?.pronto ? { ok: true, texto: 'Mensagem enviada pra fila. Ainda sem confirmação da Meta — atualize em instantes.' } : st.ok ? { ok: true, texto: 'Enviada ✓' } : { ok: false, texto: 'Não foi: ' + (st.erro || 'erro desconhecido') });
  } catch (e) { renderThread(thread, { ok: false, texto: e?.message || String(e) }); }
}
app.ontoolinput = ({ arguments: a }) => { if (a && (a.canal || a.filtro || a.busca) && !a.id) args = { canal: a.canal || 'todos', filtro: a.filtro || 'pendentes', busca: a.busca }; };
app.ontoolresult = (r) => { const d = fromResult(r); if (r?.isError || d?.error) { root.innerHTML = '<div class="err">' + esc(d?.error || 'A ferramenta falhou.') + '</div>'; return; }
  if (d?.tipo === 'conversa') { thread = d; renderThread(d); } else { inbox = d; if (d?.canal) args = { canal: d.canal, filtro: d.filtro || 'pendentes', busca: d.busca || undefined }; renderInbox(); } };
app.onhostcontextchanged = (c) => { if (c?.theme) document.documentElement.style.colorScheme = c.theme; };
await app.connect();
`);

// ─── Agenda da semana ────────────────────────────────────────────────────────
export const AGENDA_HTML = page('Totexgest — Agenda da semana', '<div class="loading">Montando a semana…</div>', /* js */ `
let data = null;
const TIPO = { meeting: '🤝', call: '📞', follow_up: '🔁', note: '📝', visit: '🏬', internal: '🏢' };
function renderWeek() {
  const d = data, r = d.resumo || {};
  let out = '<div class="row between" style="margin-bottom:10px"><div><h1>Agenda da semana</h1><div class="muted">' + esc(d.inicio) + ' a ' + esc(d.fim) + (d.loja ? ' · ' + esc(d.loja) : '') + '</div></div><div class="row"><button data-nav="' + esc(d.anterior) + '">← Anterior</button><button data-nav="">Esta semana</button><button data-nav="' + esc(d.proxima) + '">Próxima →</button>' + (d.app_url ? '<button class="primary" data-open="' + esc(d.app_url + '/gestao/calendario') + '">Abrir no CRM</button>' : '') + '</div></div>';
  out += '<div class="tiles" style="margin-bottom:10px"><div class="tile"><div class="n">' + esc(r.total ?? 0) + '</div><div class="l">compromissos</div></div><div class="tile"><div class="n">' + esc(r.reunioes ?? 0) + '</div><div class="l">reuniões / visitas</div></div><div class="tile"><div class="n">' + esc(r.ligacoes ?? 0) + '</div><div class="l">ligações</div></div><div class="tile"><div class="n ok">' + esc(r.concluidas ?? 0) + '</div><div class="l">concluídos</div></div></div>';
  out += '<div class="week">' + (d.dias || []).map((dia) => '<div class="day ' + (dia.eh_hoje ? 'today' : '') + '"><h3><span>' + esc(diaPt(dia.semana)) + ' ' + esc(dia.data) + (dia.eh_hoje ? ' <span class="chip acc">hoje</span>' : '') + '</span><span class="cnt">' + (dia.itens || []).length + '</span></h3>' +
    ((dia.itens || []).map((a) => '<div class="ev ' + (a.concluida ? 'done' : '') + '" ' + (a.codigo ? 'data-ficha="' + esc(a.codigo) + '"' : '') + '><div><span class="h">' + (a.dia_inteiro ? 'dia' : esc(a.hora || '--:--')) + '</span> ' + (TIPO[a.tipo] || '•') + ' ' + (a.concluida ? '<s>' : '') + esc(a.titulo) + (a.concluida ? '</s>' : '') + (a.critica ? ' <span class="chip bad">!</span>' : '') + '</div>' + (a.lead || a.responsavel ? '<div class="muted">' + esc([a.lead, a.responsavel].filter(Boolean).join(' · ')) + (a.confirmada ? ' ✓ confirmado' : '') + '</div>' : '') + '</div>').join('') || '<div class="empty">livre</div>') + '</div>').join('') + '</div>';
  root.innerHTML = out;
  root.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => load(b.getAttribute('data-nav') || undefined)));
  bindFicha(root, openFicha);
}
async function load(inicio) {
  root.innerHTML = '<div class="loading">Carregando…</div>';
  try { const r = await app.callServerTool({ name: 'agenda_semana', arguments: inicio ? { inicio } : {} }); const d = fromResult(r); if (r?.isError || d?.error) throw new Error(d?.error || 'Falhou'); data = d; renderWeek(); }
  catch (e) { root.innerHTML = '<div class="err">' + esc(e?.message || e) + '</div>'; }
}
async function openFicha(termo) {
  root.innerHTML = '<div class="loading">Abrindo a ficha…</div>';
  try { const r = await app.callServerTool({ name: 'ficha_lead', arguments: { termo } }); const d = fromResult(r); if (r?.isError || d?.error) throw new Error(d?.error || 'Falhou');
    root.innerHTML = '<div class="row" style="margin-bottom:10px"><button data-back>← Agenda</button></div>' + renderFicha(d); root.querySelector('[data-back]').addEventListener('click', renderWeek); bindFicha(root, openFicha);
  } catch (e) { root.innerHTML = '<div class="row" style="margin-bottom:10px"><button data-back>← Agenda</button></div><div class="err">' + esc(e?.message || e) + '</div>'; root.querySelector('[data-back]').addEventListener('click', renderWeek); }
}
app.ontoolresult = (r) => { const d = fromResult(r); if (r?.isError || d?.error) root.innerHTML = '<div class="err">' + esc(d?.error || 'A ferramenta falhou.') + '</div>'; else { data = d; renderWeek(); } };
app.onhostcontextchanged = (c) => { if (c?.theme) document.documentElement.style.colorScheme = c.theme; };
await app.connect();
`);

// ─── Ranking do time ─────────────────────────────────────────────────────────
export const RANKING_HTML = page('Totexgest — Ranking do time', '<div class="loading">Calculando o ranking…</div>', /* js */ `
let data = null;
const PER = { week: 'Esta semana', month: 'Este mês', all: 'Tudo' };
function renderRank() {
  const d = data, rk = d.ranking || [], maxV = Math.max(1, ...rk.map((x) => Number(x.valor_ganho) || 0)), maxN = Math.max(1, ...rk.map((x) => Number(x.vendas_ganhas) || 0));
  let out = '<div class="row between" style="margin-bottom:10px"><div><h1>Ranking do time</h1><div class="muted">' + esc(PER[d.periodo] || d.periodo) + ' · desde ' + esc(d.desde) + (d.loja ? ' · ' + esc(d.loja) : '') + '</div></div><div class="tabs">' + Object.entries(PER).map(([k, v]) => '<button data-per="' + k + '" class="' + (d.periodo === k ? 'on' : '') + '">' + v + '</button>').join('') + '</div></div>';
  const tot = rk.reduce((a, x) => ({ v: a.v + (Number(x.valor_ganho) || 0), n: a.n + (Number(x.vendas_ganhas) || 0), ab: a.ab + (Number(x.em_aberto) || 0) }), { v: 0, n: 0, ab: 0 });
  out += '<div class="tiles" style="margin-bottom:10px"><div class="tile"><div class="n ok">' + esc(tot.n) + '</div><div class="l">vendas no período</div></div><div class="tile"><div class="n">' + esc(brl(tot.v) || 'R$ 0') + '</div><div class="l">valor ganho</div></div><div class="tile"><div class="n">' + esc(tot.ab) + '</div><div class="l">em aberto com vendedor</div></div>' + (d.sem_vendedor ? '<div class="tile"><div class="n ' + (d.sem_vendedor.em_aberto ? 'warn' : '') + '">' + esc(d.sem_vendedor.em_aberto ?? 0) + '</div><div class="l">em aberto SEM vendedor</div></div>' : '') + '</div>';
  out += rk.length ? '<div class="rank">' + rk.map((x, i) => '<div class="rk"><div class="pos">' + (i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1) + 'º') + '</div><div style="min-width:0"><div class="row between"><b>' + esc(x.vendedor) + '</b><span class="muted" style="font-size:12px">' + esc(x.papel || '') + '</span></div><div class="bar"><i style="width:' + Math.round(100 * ((Number(x.valor_ganho) || 0) > 0 ? (Number(x.valor_ganho) / maxV) : (Number(x.vendas_ganhas) / maxN))) + '%"></i></div><div class="stats"><span>' + esc(x.em_aberto) + ' em aberto</span><span>' + esc(x.perdidas) + ' perdidas</span><span>' + esc(x.leads_novos) + ' leads novos</span><span>' + esc(x.leads_que_responderam) + ' responderam</span><span>' + esc(x.tarefas_feitas) + ' tarefas feitas</span>' + (Number(x.tarefas_atrasadas) ? '<span style="color:var(--bad)">' + esc(x.tarefas_atrasadas) + ' atrasadas</span>' : '') + '</div></div><div style="text-align:right"><div style="font-size:20px;font-weight:600">' + esc(x.vendas_ganhas) + '</div><div class="muted" style="font-size:12px">' + esc(brl(x.valor_ganho) || 'R$ 0') + '</div></div></div>').join('') + '</div>' : '<div class="empty">Nenhum vendedor ativo.</div>';
  root.innerHTML = out;
  root.querySelectorAll('[data-per]').forEach((b) => b.addEventListener('click', () => load(b.getAttribute('data-per'))));
}
async function load(periodo) {
  root.innerHTML = '<div class="loading">Calculando…</div>';
  try { const r = await app.callServerTool({ name: 'ranking_time', arguments: { periodo } }); const d = fromResult(r); if (r?.isError || d?.error) throw new Error(d?.error || 'Falhou'); data = d; renderRank(); }
  catch (e) { root.innerHTML = '<div class="err">' + esc(e?.message || e) + '</div>'; }
}
app.ontoolresult = (r) => { const d = fromResult(r); if (r?.isError || d?.error) root.innerHTML = '<div class="err">' + esc(d?.error || 'A ferramenta falhou.') + '</div>'; else { data = d; renderRank(); } };
app.onhostcontextchanged = (c) => { if (c?.theme) document.documentElement.style.colorScheme = c.theme; };
await app.connect();
`);
