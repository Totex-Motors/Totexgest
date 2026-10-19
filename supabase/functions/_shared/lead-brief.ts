/**
 * lead-brief.ts — DOSSIÊ do lead pra Nina (voz) e pro agente de texto.
 *
 * Junta tudo que o CRM já sabe quando o lead entra, pra IA NÃO perguntar de novo:
 *   - quem é (nome, cidade), por onde entrou (promotora no shopping, QR da loja, totem…)
 *   - INTENÇÃO: vender | trocar | comprar | descobrir  → define o PLAYBOOK da ligação
 *   - carro do cliente (seller_vehicles) + FIPE (vehicle_fipe_snapshot) + as 3 PROPOSTAS
 *     da Totex calculadas (percentuais em config NINA_PROPOSTA_*_PCT)
 *   - carro de interesse / loja do QR (metadata, working_memory da sessão do agente de texto)
 *   - observações da promotora, temperatura, agendamentos existentes, intermediação em curso
 *   - memória entre agentes: últimas mensagens do WhatsApp + última ligação da Nina
 *     (leads.metadata.nina) + notas (leads.metadata.nina.notes)
 *
 * Regras: só leitura; nunca envia mensagem; valores em reais formatados pra fala.
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "./config.ts";
import { getNinaExclusiveStore, spokenCarName } from "./nina-store.ts";

export type Playbook = "vender" | "trocar" | "comprar" | "descobrir";

export interface Proposta { nome: string; valor: string | null; valor_num: number | null; como_funciona: string }

export interface LeadBrief {
  lead_id: string;
  conhecido: boolean;
  nome: string | null;
  primeiro_nome: string;
  cidade: string | null;
  playbook: Playbook;
  intencao_texto: string;
  origem: string;
  promotora: string | null;
  local_captacao: string | null;
  carro_do_cliente: null | { descricao: string; ano: number | null; km: number | null; financiado: boolean | null; expectativa: string | null };
  fipe: null | { valor: string; valor_num: number; referencia: string };
  propostas: Proposta[];
  carro_interesse: string | null;
  /** true = ainda no estoque; false = já saiu (vendido/retirado); null = não deu pra conferir */
  carro_interesse_disponivel: boolean | null;
  /** 2–3 opções parecidas quando o carro de interesse já saiu */
  alternativas: string[];
  loja_referencia: string | null;
  temperatura: string | null;
  observacoes_promotora: string | null;
  agendamento_existente: string | null;
  intermediacao: string | null;
  ultimas_mensagens: string[];
  ultima_ligacao: null | { quando: string; resumo: string | null; proximo_passo: string | null; agendou: boolean };
  notas_agentes: string[];
  orientacao: string;
}

const brl = (n: number) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

function firstName(n: string | null | undefined): string {
  return String(n || "").trim().split(/\s+/)[0] || "";
}
function isRealName(n: string | null | undefined): boolean {
  if (!n) return false;
  return !/^lead sem nome|^\+?\d[\d\s-]*$|^sem nome/i.test(String(n).trim());
}
async function pct(sb: SupabaseClient, key: string, def: number): Promise<number> {
  const v = Number(await getIntegrationKey(sb, key));
  return Number.isFinite(v) && v > 0 && v <= 100 ? v : def;
}

export async function buildLeadBrief(sb: SupabaseClient, leadId: string, opts: { created?: boolean } = {}): Promise<LeadBrief | null> {
  const { data: lead } = await sb.from("leads")
    .select("id, name, phone, city_name, state, lead_kind, lead_intent, source, utm_source, capture_channel, seller_qualification, metadata, handoff_status, captured_by_member_id, capture_location_id, created_at, last_interaction_at")
    .eq("id", leadId).maybeSingle();
  if (!lead) return null;

  const sq = (lead.seller_qualification || {}) as Record<string, any>;
  const phone = String(lead.phone || "").replace(/\D/g, "");

  // LEADS-IRMÃOS (14/10): o mesmo cliente existe como lead da Totex e como cópia distribuída pra
  // loja; o agente de texto escreve numa, a Nina lia a outra e abria a ligação sem o carro
  // (Gabriel: "vi que você se interessou por um carro com a gente" em vez de "pela Toro").
  // O dossiê junta o metadata dos irmãos: o do próprio lead manda, o irmão preenche o vazio.
  const md: Record<string, any> = { ...(lead.metadata || {}) };
  const siblingIds: string[] = [leadId];
  if (phone.length >= 10) {
    const { data: sibs } = await sb.from("leads").select("id, metadata, instagram")
      .or(`phone.eq.${phone},phone.eq.+${phone}`).neq("id", leadId).order("created_at", { ascending: true }).limit(4);
    for (const s of (sibs || []) as any[]) {
      siblingIds.push(s.id);
      const smd = (s.metadata || {}) as Record<string, any>;
      for (const k of ["vehicle", "vehicles", "veiculo_interesse_texto", "tem_veiculo_troca", "precisa_financiar", "faixa_preco_min", "faixa_preco_max", "entrada_disponivel", "forma_pagamento", "marketplace_store_name", "captured_by_name", "owner_tenant_id"]) {
        if ((md[k] === null || md[k] === undefined || md[k] === "") && smd[k] !== null && smd[k] !== undefined && smd[k] !== "") md[k] = smd[k];
      }
      if (!md.nina?.notes && smd.nina?.notes) md.nina = { ...(md.nina || {}), notes: smd.nina.notes };
    }
  }

  // ── origem / promotora / local ──
  let promotora: string | null = md.captured_by_name || null;
  if (!promotora && lead.captured_by_member_id) {
    const { data: tm } = await sb.from("team_members").select("name").eq("id", lead.captured_by_member_id).maybeSingle();
    promotora = tm?.name || null;
  }
  let local: string | null = null;
  if (lead.capture_location_id) {
    const { data: loc } = await sb.from("capture_locations").select("name, city_name").eq("id", lead.capture_location_id).maybeSingle();
    local = loc ? [loc.name, loc.city_name].filter(Boolean).join(" — ") : null;
  }
  const src = String(lead.source || lead.utm_source || "").toLowerCase();
  const origem =
    lead.captured_by_member_id ? `Captado pessoalmente pela promotora ${promotora || ""}${local ? ` no ${local}` : " no stand da Totex"}`.trim()
    : src.startsWith("stand") ? "Escaneou o QR Code de um carro no stand/loja"
    : src.startsWith("totem") ? "Totem de autoatendimento no shopping"
    : src === "marketplace" ? "Site/marketplace da Totex"
    : src === "ligacao_ia" || md.origin === "nina-voz" ? "Ligou pro número oficial (primeiro contato pela ligação)"
    : src === "distribuicao" ? "Lead distribuído pra loja"
    : src ? `Origem: ${src}` : "Origem não informada";

  // ── carro do cliente (quem vende/troca) + FIPE ──
  const { data: sv } = await sb.from("seller_vehicles")
    .select("id, brand, model, version, year_model, km, has_financing, expected_price, status")
    .in("lead_id", siblingIds).order("created_at", { ascending: false }).limit(1).maybeSingle();
  let carroDoCliente: LeadBrief["carro_do_cliente"] = null;
  if (sv && (sv.brand || sv.model)) {
    carroDoCliente = {
      descricao: [sv.brand, sv.model, sv.version].filter(Boolean).join(" "),
      fala: spokenCarName([sv.brand, sv.model].filter(Boolean).join(" ")),
      ano: sv.year_model ?? null, km: sv.km ?? null, financiado: sv.has_financing ?? null,
      expectativa: sv.expected_price ? brl(Number(sv.expected_price)) : null,
    };
  }
  // carro NA TROCA do comprador (card "Veículo na Troca/Compra" — trade_in_vehicles), em qualquer irmão
  if (!carroDoCliente) {
    const { data: ti } = await sb.from("trade_in_vehicles").select("marca, modelo, versao, ano, km, valor_pedido")
      .in("lead_id", siblingIds).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (ti && (ti.marca || ti.modelo)) {
      carroDoCliente = {
        descricao: [ti.marca, ti.modelo, ti.versao].filter(Boolean).join(" "),
        fala: spokenCarName([ti.marca, ti.modelo].filter(Boolean).join(" ")),
        ano: ti.ano ?? null, km: ti.km ?? null, financiado: null,
        expectativa: ti.valor_pedido ? brl(Number(ti.valor_pedido)) : null,
      };
    }
  }
  let fipe: LeadBrief["fipe"] = null;
  const { data: snap } = await sb.from("vehicle_fipe_snapshot")
    .select("valor_centavos, mes_referencia, ano_referencia, nome_marca, nome_modelo, ano_modelo")
    .eq("lead_id", leadId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (snap?.valor_centavos) {
    const v = Number(snap.valor_centavos) / 100;
    const mes = MESES[Number(snap.mes_referencia) - 1] || "";
    fipe = { valor: brl(v), valor_num: v, referencia: `FIPE ${mes}/${snap.ano_referencia || ""}`.trim() };
    if (!carroDoCliente && (snap.nome_marca || snap.nome_modelo)) {
      carroDoCliente = { descricao: [snap.nome_marca, snap.nome_modelo].filter(Boolean).join(" "), ano: snap.ano_modelo ?? null, km: null, financiado: null, expectativa: null };
    }
  }

  // ── as 3 propostas da Totex (percentuais configuráveis — confirmar com a diretoria) ──
  const propostas: Proposta[] = [];
  if (fipe) {
    const rapida = await pct(sb, "NINA_PROPOSTA_RAPIDA_PCT", 80);
    const troca = await pct(sb, "NINA_PROPOSTA_TROCA_PCT", 85);
    const interMin = await pct(sb, "NINA_PROPOSTA_INTERMEDIACAO_MIN_PCT", 90);
    const interMax = await pct(sb, "NINA_PROPOSTA_INTERMEDIACAO_MAX_PCT", 90); // Marco (2026-10-14): "até 90%"
    const interFaixa = interMin < interMax ? `${brl(v * interMin / 100)} a ${brl(v * interMax / 100)}` : `até ${brl(v * interMax / 100)}`;
    const interPct = interMin < interMax ? `${interMin}% a ${interMax}%` : `até ${interMax}%`;
    const v = fipe.valor_num;
    propostas.push(
      { nome: "Proposta rápida", valor: brl(v * rapida / 100), valor_num: Math.round(v * rapida / 100), como_funciona: "Compra imediata: a Totex confirma com as lojas do ecossistema e o cliente vende em poucos dias, sem anunciar nem receber desconhecido em casa." },
      { nome: "Proposta de troca", valor: brl(v * troca / 100), valor_num: Math.round(v * troca / 100), como_funciona: "Valorização maior quando o carro entra na troca por um dos carros das lojas do ecossistema." },
      { nome: "Intermediação Totex", valor: interFaixa, valor_num: Math.round(v * interMax / 100), como_funciona: `O maior valor: a Totex conecta o dono ao comprador (que pode estar no mesmo shopping), com curadoria e segurança, chegando ${interPct} da FIPE conforme o carro. O valor certo depende do detalhe do carro e sai na avaliação presencial.` },
    );
  }

  // ── intenção → playbook ──
  const intent = String(sq.intent || lead.lead_intent || "").toLowerCase();
  let playbook: Playbook = "descobrir";
  if (intent.includes("troc") || intent === "trade_in") playbook = "trocar";
  else if (intent.includes("vend") || intent.includes("sell") || lead.lead_kind === "seller") playbook = "vender";
  // comprador que JÁ disse que tem carro na troca (perfil de compra ou card da troca) → é troca (Soraya, 15/10)
  else if (lead.lead_kind === "buyer" && (md.tem_veiculo_troca === true || !!carroDoCliente)) playbook = "trocar";
  else if (lead.lead_kind === "buyer" && (md.vehicle || md.veiculo_interesse_texto || src.startsWith("stand") || src.startsWith("totem") || src === "marketplace")) playbook = "comprar";
  const intencaoTexto = { vender: "quer VENDER o carro", trocar: "quer TROCAR o carro por outro", comprar: "quer COMPRAR um carro", descobrir: "intenção ainda não registrada — descobrir na conversa" }[playbook];

  // ── carro de interesse / loja (comprador) ──
  let carroInteresse: string | null = md.veiculo_interesse_texto || (md.vehicle ? [md.vehicle.brand, md.vehicle.model, md.vehicle.version, md.vehicle.year].filter(Boolean).join(" ") : null) || sq.veiculo_interesse || null;
  let lojaRef: string | null = md.marketplace_store_name || md.store?.name || md.credere_store_name || null;
  if (phone) {
    const { data: sess } = await sb.from("agents_sessions").select("working_memory")
      .eq("channel", "whatsapp").contains("working_memory", { customer_phone: phone })
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    const wm = (sess?.working_memory || {}) as Record<string, any>;
    // wm.vehicle pode ser OBJETO (do intake do stand) — virava "[object Object]" no reaquecimento (14/10)
    const wmCar = (v: unknown): string | null => {
      if (!v) return null;
      if (typeof v === "string") return v;
      const o = v as Record<string, any>;
      return [o.titulo || o.title || o.description, !o.titulo && !o.title && !o.description ? [o.brand || o.marca, o.model || o.modelo, o.version || o.versao, o.year || o.ano].filter(Boolean).join(" ") : null].filter(Boolean)[0] || null;
    };
    carroInteresse = carroInteresse || wmCar(wm.carro) || wmCar(wm.vehicle) || null;
    lojaRef = lojaRef || wm.owner_label || wm.loja || null;
  }

  // Nina exclusiva de uma loja (config NINA_LOJA_EXCLUSIVA): estoque e alternativas só dela.
  const excl = await getNinaExclusiveStore(sb).catch(() => null);
  if (excl) lojaRef = excl.name;
  const escopo = excl ? { tenant_id: excl.tenantId } : {};

  // ── o carro de interesse AINDA está no estoque? (o lead pode ter sido captado dias atrás) ──
  let disponivel: boolean | null = null;
  const alternativas: string[] = [];
  if (carroInteresse) {
    try {
      const vehicleId = md.vehicle?.id || md.vehicle_id || null;
      const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/consultar-estoque`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`, apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "" },
        body: JSON.stringify({ arguments: vehicleId ? { vehicle_id: vehicleId, busca: carroInteresse, limite: 6 } : { busca: carroInteresse, ...(lojaRef ? { loja: lojaRef } : {}), ...escopo, limite: 6 }, session_id: null, user_id: null }),
      });
      const est = await r.json().catch(() => ({}));
      const list: any[] = Array.isArray(est?.veiculos) ? est.veiculos : [];
      if (r.ok && !est?.error) {
        const normTxt = (s: string) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
        const words = normTxt(carroInteresse).split(/\s+/).filter((w) => w.length >= 3).slice(0, 2);
        const exact = vehicleId ? list.find((v) => String(v.vehicle_id) === String(vehicleId)) : list.find((v) => words.every((w) => normTxt(v.titulo).includes(w)));
        disponivel = !!exact;
        if (!exact) {
          // parecidos: mesma marca/modelo (busca mais aberta pela 1ª palavra)
          const r2 = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/consultar-estoque`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`, apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "" },
            body: JSON.stringify({ arguments: { busca: words[0] || carroInteresse, ...escopo, limite: 6 }, session_id: null, user_id: null }),
          });
          const est2 = await r2.json().catch(() => ({}));
          for (const v of (Array.isArray(est2?.veiculos) ? est2.veiculos : []).filter((v: any) => !/moto/i.test(String(v.tipo || ""))).slice(0, 3)) {
            alternativas.push(`${spokenCarName(v.titulo) || v.titulo}${v.ano ? ` ${v.ano}` : ""}${v.preco ? ` por ${v.preco}` : ""}${v.loja ? ` na ${v.loja}` : ""}`);
          }
        }
      }
    } catch (e) { console.warn("[lead-brief] estoque do carro de interesse:", (e as Error).message); }
  }

  // ── agendamento existente / intermediação ──
  const { data: ag } = await sb.from("company_activities").select("name, scheduled_at")
    .in("lead_id", siblingIds).eq("task_type", "meeting").gte("scheduled_at", new Date().toISOString())
    .order("scheduled_at", { ascending: true }).limit(1).maybeSingle();
  // Agendamento DO JEITO QUE SE FALA ("avaliação do Corolla, quarta-feira, 14 de outubro, às 15 horas"),
  // não o nome bruto da tarefa ("Agendamento: Avaliação do carro — Marco (Corolla 2021) em qua., 14/10, 15:00").
  let agendamento: string | null = null;
  if (ag) {
    const nm = String(ag.name || "");
    const tipo = (nm.match(/Agendamento:\s*([^—(]+)/)?.[1] || nm).trim().toLowerCase().replace(/^avaliação do carro$/, "avaliação");
    const carroAg = spokenCarName(nm.match(/\(([^)]*)\)/)?.[1] || "");
    const d = new Date(ag.scheduled_at);
    const dia = d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long", day: "numeric", month: "long" });
    const h = Number(d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "numeric", hour12: false }));
    const m = Number(d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", minute: "numeric" }));
    agendamento = `${tipo}${carroAg ? ` do ${carroAg}` : ""}, ${dia}, às ${h}${m ? ` e ${m}` : " horas"}`;
  }
  const { data: inter } = await sb.from("intermediations").select("status, asking_price").eq("owner_lead_id", leadId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  const intermediacao = inter ? `Intermediação já aberta (status ${inter.status}${inter.asking_price ? `, pedida ${brl(Number(inter.asking_price))}` : ""})` : null;

  // ── memória entre agentes ──
  const { data: msgs } = await sb.from("whatsapp_messages").select("content, is_from_me, message_type, created_at")
    .eq("lead_id", leadId).order("created_at", { ascending: false }).limit(6);
  const ultimas = (msgs || []).reverse()
    .filter((m: any) => m.content && !["ai_tool_call", "ai_system_error"].includes(m.message_type))
    .map((m: any) => `${m.is_from_me ? "Totex" : "Cliente"}: ${String(m.content).slice(0, 160)}`);
  const nina = (md.nina || {}) as Record<string, any>;
  const ultimaLigacao = nina.last_call ? {
    quando: new Date(nina.last_call.at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }),
    resumo: nina.last_call.resumo || null, proximo_passo: nina.last_call.proximo_passo || null, agendou: !!nina.last_call.agendou,
  } : null;
  const notas: string[] = Array.isArray(nina.notes) ? nina.notes.slice(-5).map((n: any) => `${n.quem || "agente"} (${String(n.at || "").slice(0, 10)}): ${n.texto}`) : [];

  const nome = isRealName(lead.name) ? lead.name : null;
  const orient = [
    nome ? `Cumprimente pelo primeiro nome (${firstName(nome)}).` : "Cliente sem nome: pergunte o nome de forma natural.",
    "Ao falar de carro use o nome falado (campos _fala / titulo_falado): só marca e modelo. O nome completo é só pra buscar no estoque.",
    `Playbook: ${playbook.toUpperCase()} — ${intencaoTexto}.`,
    carroDoCliente ? `Já sabemos o carro: ${carroDoCliente.fala || carroDoCliente.descricao}${carroDoCliente.ano ? ` ${carroDoCliente.ano}` : ""}. Não pergunte de novo.` : null,
    fipe ? `Temos a ${fipe.referencia}: ${fipe.valor}. As três propostas estão calculadas — apresente a lógica, não despeje os três números de uma vez.` : (playbook !== "comprar" && playbook !== "descobrir" ? "Sem FIPE ainda: diga que a avaliação sai em minutos e ofereça agendar." : null),
    carroInteresse
      ? (disponivel === false
          ? `Interesse: ${spokenCarName(carroInteresse) || carroInteresse}${lojaRef ? ` na ${lojaRef}` : ""} — JÁ SAIU do estoque. Não diga que está disponível: avise com naturalidade que ele já foi e ofereça${alternativas.length ? `: ${alternativas.join("; ")}` : " opções parecidas (consultar_estoque)"}.`
          : `Interesse: ${spokenCarName(carroInteresse) || carroInteresse}${lojaRef ? ` na ${lojaRef}` : ""}${disponivel ? " (ainda disponível)" : ""}. Fale desse carro primeiro.`)
      : null,
    agendamento ? `JÁ TEM agendamento (${agendamento}). Não abra a ligação com isso nem leia como ficha: siga o motivo da conversa e, quando fizer sentido, confirme em uma frase leve ("sua avaliação de quarta continua de pé?") em vez de marcar outro.` : null,
    ultimaLigacao ? `Já conversou com a Nina em ${ultimaLigacao.quando}. Continue de onde parou.` : null,
  ].filter(Boolean).join(" ");

  return {
    lead_id: leadId,
    conhecido: !opts.created,
    nome, primeiro_nome: firstName(nome),
    cidade: [lead.city_name, lead.state].filter(Boolean).join("/") || null,
    playbook, intencao_texto: intencaoTexto, origem, promotora, local_captacao: local,
    carro_do_cliente: carroDoCliente, fipe, propostas,
    carro_interesse: carroInteresse, carro_interesse_fala: spokenCarName(carroInteresse), carro_interesse_disponivel: disponivel, alternativas, loja_referencia: lojaRef,
    temperatura: sq.temperatura || null,
    observacoes_promotora: sq.observacao || null,
    agendamento_existente: agendamento, intermediacao,
    ultimas_mensagens: ultimas, ultima_ligacao: ultimaLigacao, notas_agentes: notas,
    orientacao: orient,
  };
}

/** Nota compartilhada entre agentes (Nina ↔ texto ↔ humanos): leads.metadata.nina.notes + timeline. */
export async function appendAgentNote(sb: SupabaseClient, leadId: string, quem: string, texto: string, extra: Record<string, unknown> = {}): Promise<void> {
  const { data: lead } = await sb.from("leads").select("tenant_id, metadata").eq("id", leadId).maybeSingle();
  if (!lead) return;
  const md = (lead.metadata || {}) as Record<string, any>;
  const nina = (md.nina || {}) as Record<string, any>;
  const notes = Array.isArray(nina.notes) ? nina.notes : [];
  notes.push({ quem, texto: String(texto).slice(0, 600), at: new Date().toISOString(), ...extra });
  await sb.from("leads").update({ metadata: { ...md, nina: { ...nina, notes: notes.slice(-20) } } }).eq("id", leadId);
  await sb.from("company_activities").insert({
    tenant_id: lead.tenant_id, lead_id: leadId,
    name: `Nota da ${quem}`, description: String(texto).slice(0, 2000),
    task_type: "note", team: "sales", status: "completed", completed: true, priority: "medium",
    scheduled_at: new Date().toISOString(), ai_generated: true, source_type: "agent",
    metadata: { source: "nina-voz", quem, ...extra },
  });
}
