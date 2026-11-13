/**
 * auto-context — blocos automáticos injetados no system prompt do agente.
 *
 * O LLM precisa de informações estruturadas que NÃO devem ser hardcoded no
 * system_prompt (mudam com frequência ou são por agente):
 *  - closer_pool: lista de team_members do pool com nomes + UUIDs (pra tools)
 *  - icp_criteria: critério ICP (texto livre, já em settings — só formatamos)
 *  - working_hours / working_days
 *  - lista de pipelines/stages se o agente lida com multi-pipeline (futuro)
 *
 * O LLM precisa saber UUIDs porque as tools `check_availability`,
 * `schedule_meeting`, etc, exigem uuid (não nome).
 */

import { db } from "../_shared/supabase.ts";

interface BuildContextArgs {
  settings: Record<string, unknown> | null | undefined;
  channel?: string;
  context?: Record<string, unknown> | null;   // payload.context (lead_id, deal_id, etc)
  agent_id?: string;                          // pra buscar notas do agente
}

export async function buildAutoContext(args: BuildContextArgs): Promise<string> {
  const blocks: string[] = [];

  // Bloco 1: Pool de closers (com UUIDs)
  const closerBlock = await buildCloserPoolBlock(args.settings);
  if (closerBlock) blocks.push(closerBlock);

  // Bloco 2: ICP (já em texto livre no settings)
  const icpBlock = buildIcpBlock(args.settings);
  if (icpBlock) blocks.push(icpBlock);

  // Bloco 3: Working hours
  const whBlock = buildWorkingHoursBlock(args.settings);
  if (whBlock) blocks.push(whBlock);

  // Bloco 4: Sessão (lead/deal disponíveis OU instrução de modo teste)
  const sessionBlock = await buildSessionContextBlock(args.channel, args.context);
  if (sessionBlock) blocks.push(sessionBlock);

  // Bloco 5: Índice de notas (se agente tem auto_inject_index=true)
  const notesBlock = await buildNotesIndexBlock(args.agent_id, args.settings);
  if (notesBlock) blocks.push(notesBlock);

  if (blocks.length === 0) return "";
  return ["\n---\n[CONTEXTO OPERACIONAL DO AGENTE]\n", ...blocks].join("\n");
}

/**
 * Injeta índice de notas do agente no system prompt (lista título + tags + preview).
 * Configurável via settings.notes.{auto_inject_index, max_index_notes, index_preview_chars}.
 * Default: ON se agente tem skills de notas vinculadas.
 */
async function buildNotesIndexBlock(
  agentId: string | undefined,
  settings: Record<string, unknown> | null | undefined,
): Promise<string> {
  if (!agentId) return "";

  const notesCfg = (settings as { notes?: Record<string, unknown> } | null)?.notes || {};
  const enabled = (notesCfg as any).auto_inject_index !== false;  // default ON
  if (!enabled) return "";

  const maxNotes = (notesCfg as any).max_index_notes ?? 30;
  const previewChars = (notesCfg as any).index_preview_chars ?? 80;
  const ragEnabled = (notesCfg as any).rag_enabled !== false;

  const { db } = await import("../_shared/supabase.ts");
  const { data, error } = await db
    .from("agent_notes")
    .select("title, slug, tags, content, updated_at")
    .eq("agent_id", agentId)
    .eq("archived", false)
    .order("updated_at", { ascending: false })
    .limit(maxNotes);

  if (error) {
    console.error("[auto-context] notes lookup err:", error.message);
    return "";
  }
  if (!data || data.length === 0) {
    return [
      "## Notas do agente",
      "",
      "Nenhuma nota ainda. Use `salvar_nota(titulo, conteudo)` quando o usuário pedir pra guardar algo.",
    ].join("\n");
  }

  const lines = data.map((n: any) => {
    const preview = (n.content || "").slice(0, previewChars).replace(/\n/g, " ").trim();
    const tags = (n.tags || []).length > 0 ? ` ${n.tags.map((t: string) => "#" + t).join(" ")}` : "";
    return `- "${n.title}"${tags} · "${preview}${preview.length === previewChars ? "..." : ""}"`;
  }).join("\n");

  const rules: string[] = [
    "",
    "**Regras de busca:**",
    "1. Usuário menciona título específico OU está acima no índice → `ler_nota(titulo)`",
    "2. Pergunta por tema/conceito sem mencionar título → `buscar_nota(query)` (busca semântica)",
    "3. Pediu lista/inventário → `listar_notas(tag)` opcional",
    "4. Salvar/atualizar → `salvar_nota(titulo, conteudo, modo)`",
  ];
  if (!ragEnabled) rules.splice(2, 1);  // remove buscar_nota

  return [
    "## Notas do agente",
    "",
    "Use `ler_nota(titulo)` pra puxar conteúdo completo de qualquer uma:",
    "",
    lines,
    ...rules,
  ].join("\n");
}

/**
 * Bloco com lead_id/deal_id quando vier no payload (canal real WhatsApp).
 * Quando NÃO vier (playground/chat_web sem contexto): instrui o LLM a NÃO
 * chamar tools que dependam de uuid de lead — evita LLM inventar string.
 */
async function buildSessionContextBlock(
  channel: string | undefined,
  context: Record<string, unknown> | null | undefined,
): Promise<string> {
  const leadId = typeof context?.lead_id === "string" ? context.lead_id : null;
  const dealId = typeof context?.deal_id === "string" ? context.deal_id : null;
  const isUuid = (s: string | null) => !!s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

  if (!isUuid(leadId)) {
    // Modo simulação — sem lead real. NÃO injeta instrução restritiva no prompt:
    // o executor SQL valida UUIDs e retorna erro amigável se LLM tentar usar tools
    // que dependem de lead_id. Best practice: validar no sistema, não pedir pro LLM.
    return [
      "## Sessão atual",
      "",
      `Canal: ${channel || "chat_web"} (modo de teste — sem lead real conectado)`,
    ].join("\n");
  }

  // Tem lead — busca contexto adicional pra enriquecer
  const { db } = await import("../_shared/supabase.ts");
  const { data: lead } = await db.from("leads")
    .select("id, name, email, company, phone, monthly_revenue_min, monthly_revenue_max, sales_score, lead_temperature, metadata")
    .eq("id", leadId!)
    .maybeSingle();

  const lines: string[] = [
    "## Sessão atual",
    "",
    `Canal: ${channel}`,
    `lead_id (UUID): \`${leadId}\``,
  ];
  if (isUuid(dealId)) lines.push(`deal_id (UUID): \`${dealId}\``);

  if (lead) {
    lines.push("", "Dados do lead:");
    if (lead.name) lines.push(`- Nome: ${lead.name}`);
    if (lead.email) lines.push(`- Email: ${lead.email}`);
    if (lead.company) lines.push(`- Empresa: ${lead.company}`);
    if (lead.phone) lines.push(`- Telefone: ${lead.phone}`);
    if (lead.monthly_revenue_min || lead.monthly_revenue_max) {
      lines.push(`- Faturamento mensal estimado: ${lead.monthly_revenue_min || "?"} – ${lead.monthly_revenue_max || "?"} BRL`);
    }
    if (lead.sales_score !== null && lead.sales_score !== undefined) {
      lines.push(`- Score atual: ${lead.sales_score}/100`);
    }
    if (lead.lead_temperature) lines.push(`- Temperatura: ${lead.lead_temperature}`);

    // === PERFIL DE COMPRA AUTOMOTIVO (o que já sabemos × o que falta descobrir) ===
    const m = (lead.metadata ?? {}) as Record<string, any>;
    const fone8 = String(lead.phone || context?.whatsapp_phone || "").replace(/\D/g, "").slice(-8);
    // Reaquecimento: o lead-rewarm marca o lead da MATRIZ, mas a resposta pode cair no lead da loja
    // (o roteamento pega o lead mais recente do telefone). Sem isso o agente não sabia o que a
    // abertura já tinha dito e perguntava "que carro você tem pra dar na troca?" (Marcos, 23/10).
    const re = await reaquecimentoDoTelefone(db, m, leadId!, fone8);
    const veic = m.vehicle
      ? `${m.vehicle.brand ?? ""} ${m.vehicle.model ?? ""} ${m.vehicle.version ?? ""} ${m.vehicle.year ?? ""}`.trim()
      : (m.veiculo_interesse_texto ?? null);
    const has = (v: unknown) => v !== null && v !== undefined && v !== "";
    const boolFmt = (v: unknown) => (v === null || v === undefined ? "? falta descobrir" : (v ? "Sim" : "Não"));
    lines.push(
      "",
      "Perfil de compra (automotivo) — descubra o que ainda falta, uma pergunta por vez:",
      `- Veículo de interesse: ${veic ? veic : "? falta descobrir"}`,
      `- Orçamento: ${has(m.faixa_preco_min) ? m.faixa_preco_min : "?"} a ${has(m.faixa_preco_max) ? m.faixa_preco_max : "?"} BRL`,
      `- Precisa financiar?: ${boolFmt(m.precisa_financiar)}`,
      `- Entrada disponível: ${has(m.entrada_disponivel) ? m.entrada_disponivel : "? falta descobrir"}`,
      `- Tem veículo na troca?: ${re?.carro_cliente ? `Sim — ${re.carro_cliente} (já dito na mensagem que mandamos; NÃO pergunte)` : boolFmt(m.tem_veiculo_troca)}`,
      `- Forma de pagamento: ${has(m.forma_pagamento) ? m.forma_pagamento : "? falta descobrir"}`,
      `- Urgência da compra: ${has(m.urgencia) ? m.urgencia : "? falta descobrir"}`,
      "Quando o cliente revelar qualquer um desses dados, chame a tool capturar_perfil_compra com o campo correspondente. Não pergunte o que já está preenchido.",
    );

    // === MEMÓRIA COMPARTILHADA COM A NINA (voz) — ligações e notas (leads.metadata.nina) ===
    const nina = (m.nina ?? {}) as Record<string, any>;
    if (nina.last_call || (Array.isArray(nina.notes) && nina.notes.length)) {
      lines.push("", "Nina (agente de VOZ, mesma equipe) já falou com este cliente por ligação:");
      if (nina.last_call) {
        const lc = nina.last_call;
        const quando = lc.at ? new Date(lc.at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
        lines.push(`- Última ligação ${quando}: ${lc.outcome === "nao_atendeu" ? "NÃO ATENDEU" : `${lc.duracao || 0}s`}${lc.agendou ? " — AGENDOU visita" : ""}${lc.resumo ? ` — ${String(lc.resumo).slice(0, 400)}` : ""}`);
        if (lc.outcome === "nao_atendeu") lines.push("  → Diga que a Nina tentou ligar e não conseguiu; pergunte o melhor horário pra retornar (e registre com agendar_lembrete).");
      }
      for (const n of (nina.notes || []).slice(-3)) {
        lines.push(`- Nota (${n.quem || "agente"}): ${String(n.texto || "").slice(0, 300)}`);
      }
      lines.push("Continue de onde a Nina parou; não repita perguntas que ela já fez.");
    }

    // === MODO REAQUECIMENTO (lead-rewarm abriu a conversa com uma simulação; leads.metadata.reaquecimento) ===
    if (re && re.ativo) {
      const momento: Record<string, string> = {
        A_saiu_do_stand: "saiu do stand há pouco sem agendar (pode ainda estar no shopping)",
        B_nunca_falou: "nunca tinha recebido mensagem nossa",
        C_esfriou: "conversou e esfriou (dias sem responder)",
      };
      lines.push("", "🔥 MODO REAQUECIMENTO — este cliente " + (momento[String(re.momento)] || "esfriou") + ". A gente abriu a conversa com uma simulação pronta e ele RESPONDEU. Agora é o seu momento:");
      if (re.abertura) lines.push(`- A mensagem que ELE recebeu e respondeu foi: "${re.abertura}"`);
      lines.push(
        "- ⛔ NÃO pergunte o nome dele" + (re.nome ? ` (é ${re.nome})` : "") + ", NÃO pergunte se é troca ou compra, NÃO pergunte qual carro ele tem" + (re.carro_cliente ? ` (é o ${re.carro_cliente})` : "") + ". A abertura já disse tudo isso; perguntar de novo soa robô. Se ele disse 'pode mandar' / 'sim', a PRÓXIMA mensagem É a simulação, não outra pergunta. Vocabulário: diga sempre 'simulação' (nunca 'conta').",
      );
      if (re.carro_cliente) lines.push(`- Carro DELE (entra na troca/venda): ${re.carro_cliente}. A TRAVA continua: não diga quanto ele vale, nem faixa, nem FIPE — "a avaliação sai na loja em 15 minutos e entra como entrada".`);
      if (re.playbook === "trocar") lines.push("- Como mandar a simulação na TROCA: pergunte (ou use, se ele já disse) qual carro ele viu ou quer; consultar_estoque pra achar o valor; simular_plano com o valor do carro (sem carro_na_troca: o valor do dele sai na avaliação) e mostre a parcela em reais + a jogada do décimo terceiro; diga que o carro dele entra como entrada e derruba essa parcela. Se ele JÁ citou o carro, pule a pergunta e vá direto pra simulação.");
      if (re.playbook === "vender") lines.push("- Como mandar a simulação na VENDA: explique em 2 frases por que vender pela Totex vale mais (loja comum compra barato; a Totex intermedeia perto da FIPE) e feche com a avaliação presencial com dia e hora. Sem número de valor.");
      if (re.carro) lines.push(`- Carro da conversa: ${re.carro}`);
      if (re.plano?.parcela) {
        lines.push(`- Plano já mostrado: ${re.plano.prazo}x de R$ ${Math.round(re.plano.parcela).toLocaleString("pt-BR")}` +
          (re.plano.antecipacao?.ultima_parcela_hoje ? ` · antecipando a última parcela junto com a do mês (13º, férias, PLR ou FGTS) ela sai por R$ ${Math.round(re.plano.antecipacao.ultima_parcela_hoje).toLocaleString("pt-BR")} (some uma parcela do fim)` : ""));
      }
      if (re.plano?.cupom_campanha?.valor) lines.push(`- Bônus da loja em cartaz: ${re.plano.cupom_campanha.titulo} de R$ ${re.plano.cupom_campanha.valor}`);
      if (re.correcao) lines.push(`- ⚠️ CORREÇÃO: ${re.correcao}`);
      lines.push(re.cupom
        ? `- Cupom JÁ gerado: ${re.cupom} (não gere outro; lembre a validade)`
        : "- Cupom ainda NÃO gerado: gere com gerar_cupom quando o cliente topar seguir (desconto na parcela, 48 h, com a Grazi).");
      lines.push(re.grazi_avisada_em ? "- Grazi já foi avisada." : "- Quando o cliente mostrar intenção (quer a condição, pergunta como faz, topa a visita), chame chamar_grazi.");
      lines.push(
        "Como agir: otimista e concreto. Primeiro o ganho dele (carro melhor, mais seguro, mais econômico, mais conforto) e a sensação de que dá pra subir de carro AGORA; depois a simulação (simular_plano com o valor do carro; use décimo terceiro, férias, PLR ou FGTS como dinheiro que derruba parcelas do fim). Nunca fale taxa nem porcentagem: só reais. Uma pergunta por mensagem, fácil de responder sim. Nunca pergunte se ele 'ainda tem interesse' nem se 'quer conversar depois'. Feche com visita, avaliação ou a Grazi, sempre com dia e hora ou com o cupom de 48 h como motivo real de urgência.",
      );
    }
  }

  // === MODO E-MAIL DE REATIVAÇÃO (cliente da loja parceira clicou no botão do e-mail da Nina; leads.metadata.email_reativacao) ===
  {
    const er = (lead?.metadata as any)?.email_reativacao;
    if (er?.loja) {
      const loja = String(er.loja);
      const oferta = er.tipo === "oferta";
      const assunto = oferta ? `dos carros em oferta na ${loja}; ele clicou no ${er.carro_interesse || "carro"} e quer saber mais` : er.variante === "B" ? `quanto vale o ${er.modelo} dele na FIPE hoje` : `que já é hora de trocar o ${er.modelo} dele`;
      lines.push("", `📧 MODO E-MAIL ${oferta ? "DE OFERTA" : "DE REATIVAÇÃO"} — este cliente é CLIENTE DA ${loja.toUpperCase()}${er.modelo ? `: comprou um ${er.modelo} lá${er.ano_compra ? ` em ${er.ano_compra}` : ""}` : ""} e acabou de clicar no botão do e-mail que a Nina da ${loja} mandou (o e-mail falava ${assunto}). Estas regras valem ACIMA da abertura padrão:`);
      if (oferta) {
        lines.push(`- Você é a Nina, da ${loja}. NÃO diga "Totex Motors". Primeira resposta: confirme que é a Nina da ${loja} e vá direto ao ${er.carro_interesse || "carro"}: consultar_estoque com loja = "${loja}" e busca = "${er.carro_interesse || ""}", mostre o carro (ano, km, cor, preço) e pergunte UMA coisa útil (se é pra trocar o ${er.modelo || "carro atual"} dele ou compra nova; se o ${er.modelo ? er.modelo : "carro atual"} entra na troca, o valor sai na avaliação na loja).`);
        lines.push(`- Depois: simulação (enviar_simulacao) com o aviso de estimativa sem CPF + Grazi + cupom. Nunca taxa, nunca avaliação por mensagem, nunca pressão de escassez.`);
      }
      if (!oferta) lines.push(`- Você é a Nina, da ${loja}. NÃO diga "Totex Motors" nesta conversa. Carros, simulação e visita são na ${loja}: em consultar_estoque passe loja = "${loja}".`);
      const nomeConhecido = (er.base_nome && er.telefone_bate) ? String(er.base_nome) : (lead?.name && !/^\+?\d+$/.test(String(lead.name)) && !/cliente|n[aã]o identificado/i.test(String(lead.name)) ? String(lead.name) : "");
      lines.push(`- NÃO faça a abertura genérica ("que bom que você entrou em contato", "me diz seu nome pra te atender", "como posso te chamar"). ${nomeConhecido ? `O nome dele é ${nomeConhecido}: use e NÃO pergunte o nome.` : "Só pergunte o nome DEPOIS de responder ao que ele pediu, e uma vez só."} NÃO pergunte se é troca ou compra: é a TROCA do ${er.modelo} dele por um mais novo.`);
      if (!oferta) lines.push(`- O ${er.modelo} é o carro que ele JÁ TEM (entra na troca). NUNCA ofereça "opções de ${er.modelo}" nem trate o ${er.modelo} como carro de interesse. Se ele ainda não disse qual carro quer, pergunte o que ele busca no próximo (tipo, tamanho, uso) e mostre 1 ou 2 opções do estoque da ${loja} mais novas que o ${er.modelo}.`);
      lines.push(`- Toda resposta sua começa respondendo o que ELE acabou de dizer (mesmo áudio transcrito com erro: interprete pelo contexto da troca). Nunca responda uma pergunta dele só com outra pergunta.`);
      if (!oferta) lines.push(`- Primeira resposta: diga que é a Nina da ${loja} e entregue o que o e-mail prometeu. Pra puxar a FIPE do ${er.modelo} use consultar_fipe (precisa de marca, modelo e ano; se a tool devolver candidatos, mostre as versões pra ele escolher). Cite a FIPE com o mês de referência ("na tabela FIPE de nov/2026"). A FIPE é tabela pública: NUNCA chame de avaliação, NUNCA diga quanto a loja paga nem quanto o carro dele entra na troca — "o valor dele na troca sai na avaliação na loja, em 15 minutos".`);
      if (!oferta) lines.push(`- Depois: ofereça a simulação de um carro mais novo do estoque da ${loja} com o ${er.modelo} entrando como entrada (consultar_estoque + simular_plano/enviar_simulacao). Parcela só em reais, nunca taxa.`);
      lines.push(...await regrasVisitaReativacao(loja, er));
    }
  }

  // === INDIQUE E GANHE (o cliente chegou pelo link de um indicador; leads.metadata.indicacao) ===
  {
    const ind = (lead?.metadata as any)?.indicacao;
    if (ind?.codigo) {
      lines.push("", `👥 VEIO POR INDICAÇÃO de ${ind.indicador_nome || "um indicador"} (programa Indique e Ganhe, código ${ind.codigo}). Trate como cliente NOVO, atendimento normal da Totex: descubra o que ele procura e avance pra simulação/visita.`);
      lines.push(`- NÃO fale de comissão, valor da indicação nem de quem indicou, a não ser que ELE pergunte. Se perguntar como funciona o programa, explique em 1 linha (quem indica ganha R$ 200 quando o indicado dá o sinal e R$ 800 quando a venda fecha) e mande o link ${appUrlIndique()} pra ele também indicar.`);
      lines.push(`- A primeira mensagem dele é o texto pronto do link ("Vim pela indicação…"): NÃO repita esse texto, não pergunte "de quem é a indicação". Vá direto: cumprimente pelo nome se tiver e pergunte que tipo de carro ele está buscando (ou se é troca).`);
    }
  }

  // === O QUE A LOJA JÁ MANDOU PRA ELE fora deste chat (follow-up, reaquecimento, lembretes) ===
  // O histórico da sessão só tem a conversa com o agente. Mensagem automática que saiu por outro
  // caminho ficava invisível, e o cliente respondia a ela ("Sim") sem o agente saber do quê.
  const enviadas = await mensagensEnviadasFora(db, String(lead?.phone || context?.whatsapp_phone || ""));
  if (enviadas.length) {
    lines.push("", "Mensagens que a loja mandou pra ele nas últimas 72 h (fora deste chat). A resposta dele pode ser a uma delas: continue a partir dela e NÃO pergunte o que ela já diz:");
    for (const e of enviadas) lines.push(`- ${e.quando}: "${e.texto}"`);
  }

  lines.push("", "Use estes UUIDs SEMPRE que chamar tools que pedem `lead_id` ou `deal_id`.");
  return lines.join("\n");
}

/** Reaquecimento ativo deste lead OU de outro lead do mesmo telefone (matriz × loja), dos últimos 7 dias. */
async function reaquecimentoDoTelefone(db: any, m: Record<string, any>, leadId: string, fone8: string): Promise<Record<string, any> | null> {
  const proprio = (m.reaquecimento ?? null) as Record<string, any> | null;
  if (proprio?.ativo) return proprio;
  if (fone8.length < 8) return proprio;
  try {
    const { data } = await db.from("leads").select("metadata").ilike("phone", `%${fone8}`).neq("id", leadId)
      .order("updated_at", { ascending: false }).limit(5);
    const limite = Date.now() - 7 * 86_400_000;
    const outro = (data || []).map((l: any) => l?.metadata?.reaquecimento).find((r: any) =>
      r?.ativo && Date.parse(String(r.iniciado_em || "")) >= limite);
    return outro || proprio;
  } catch { return proprio; }
}

/** Últimas mensagens automáticas/humanas que saíram pra este telefone (não as do próprio agente). */
async function mensagensEnviadasFora(db: any, phone: string): Promise<{ quando: string; texto: string }[]> {
  const fone8 = phone.replace(/\D/g, "").slice(-8);
  if (fone8.length < 8) return [];
  try {
    const desde = new Date(Date.now() - 72 * 3_600_000).toISOString();
    const { data } = await db.from("whatsapp_messages").select("content, sent_at, metadata")
      .ilike("remote_jid", `%${fone8}@%`).eq("is_from_me", true).gte("sent_at", desde)
      .order("sent_at", { ascending: false }).limit(8);
    return (data || [])
      .filter((r: any) => !["ai_agent", "ai_agent_v2"].includes(String(r?.metadata?.sent_by || "")) && String(r.content || "").trim())
      .slice(0, 3).reverse()
      .map((r: any) => ({
        quando: new Date(r.sent_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }),
        texto: String(r.content).replace(/\s+/g, " ").slice(0, 400),
      }));
  } catch { return []; }
}

async function buildCloserPoolBlock(
  settings: Record<string, unknown> | null | undefined,
): Promise<string> {
  const pool = (settings as { closer_pool?: string[] } | null)?.closer_pool;
  if (!Array.isArray(pool) || pool.length === 0) return "";

  const { data, error } = await db
    .from("team_members")
    .select("id, name, email")
    .in("id", pool);

  if (error || !data || data.length === 0) return "";

  const lines = data
    .map((c: { id: string; name: string; email?: string }) =>
      `- ${c.name} (UUID: ${c.id})${c.email ? ` · ${c.email}` : ""}`
    )
    .join("\n");

  return [
    "## Pool de Closers (vendedores disponíveis)",
    "",
    "Esses são os vendedores no pool deste agente. Use SEMPRE o UUID nas tools",
    "(`check_availability`, `schedule_meeting`), NUNCA o nome:",
    "",
    lines,
    "",
    "Quando o lead aceitar agendar reunião, escolha 1 UUID e passe em `closer_id`.",
    "Para `check_availability`, passe `closer_ids: [\"uuid1\", \"uuid2\"]` com TODOS do pool.",
  ].join("\n");
}

function buildIcpBlock(settings: Record<string, unknown> | null | undefined): string {
  const icp = (settings as { icp_criteria?: string } | null)?.icp_criteria;
  if (!icp || typeof icp !== "string" || icp.trim().length === 0) return "";
  return [
    "## Critério ICP (qualificação)",
    "",
    icp.trim(),
  ].join("\n");
}

function buildWorkingHoursBlock(
  settings: Record<string, unknown> | null | undefined,
): string {
  const s = settings as { working_hours_start?: string; working_hours_end?: string; working_days?: number[] } | null;
  if (!s?.working_hours_start || !s?.working_hours_end) return "";
  const days = Array.isArray(s.working_days) ? s.working_days : [1, 2, 3, 4, 5];
  const dayNames = days
    .map((d) => ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sab"][d] || "?")
    .join(", ");
  return [
    "## Horário de trabalho",
    "",
    `Atendimento: ${s.working_hours_start} às ${s.working_hours_end} (Brasília)`,
    `Dias úteis: ${dayNames}`,
  ].join("\n");
}

/** Link público do cadastro de indicador (config app_url; default do projeto). */
function appUrlIndique(): string {
  const base = (Deno.env.get("APP_URL") || "https://totexgest.vercel.app").replace(/\/$/, "");
  return `${base}/indique`;
}


/**
 * MODO E-MAIL (reativação/oferta): o objetivo da conversa é TRAZER O CLIENTE NA LOJA (Marco, 13/11/2026).
 * Nas primeiras conversas a Nina dava FIPE, mostrava carro, simulava e acionava a Grazi — e encerrava
 * sem nunca oferecer visita (0 agendamentos em 8 conversas). Estas regras põem a visita como meta e
 * dão à Nina endereço e horário das unidades (config VOICE_LOJAS_INFO, o mesmo da Nina voz).
 */
async function regrasVisitaReativacao(loja: string, er: any): Promise<string[]> {
  const out: string[] = [];
  let unidades: Array<{ nome?: string; endereco?: string; referencia?: string; horario?: string }> = [];
  try {
    const { data } = await db.from("config").select("value").eq("key", "VOICE_LOJAS_INFO").maybeSingle();
    const lista = JSON.parse(String(data?.value || "[]"));
    const alvo = String(loja).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const item = (Array.isArray(lista) ? lista : []).find((l: any) =>
      String(l?.nome || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").includes(alvo.split(" ")[0]));
    unidades = Array.isArray(item?.unidades) ? item.unidades.filter((u: any) => !/stand|totex/i.test(String(u?.nome || ""))) : [];
  } catch { /* sem config: segue sem endereço */ }

  const carroDele = er?.modelo ? String(er.modelo) : "carro atual";
  out.push(`- 🎯 OBJETIVO DESTA CONVERSA: TRAZER O CLIENTE NA ${loja.toUpperCase()} com DIA e HORA marcados (agendar_visita). FIPE, estoque, simulação e Grazi são o caminho; a conversa só está bem resolvida com a visita marcada.`);
  out.push(`- QUANDO CONVIDAR (sem esperar ele pedir, uma vez em cada momento, sem pressão):`);
  out.push(`  • logo depois da FIPE: "o valor real do ${carroDele} na troca sai na avaliação na ${loja}, leva uns 15 minutos. Quer passar pra avaliar e já ver os carros?";`);
  out.push(`  • quando ele escolher/gostar de um carro: convide pra ver de perto e fazer test drive;`);
  out.push(`  • junto com a simulação ou quando acionar a Grazi: Grazi e visita andam JUNTAS. NUNCA encerre só com "a Grazi vai te chamar": "enquanto a Grazi vê a parcela no seu CPF, quer deixar a visita marcada pra ver o carro e avaliar o ${carroDele}?";`);
  out.push(`  • se ele agradecer ou disser que não precisa de mais nada: antes de se despedir, faça UM convite leve pra visita (sem insistir se ele recusar).`);
  out.push(`- COMO CONVIDAR: ofereça DUAS opções concretas dentro do horário da loja (ex.: "amanhã às 10h ou sábado às 11h?"), calculadas com current_time_br. Nunca domingo. Se ele sugerir outro horário dentro do funcionamento, aceite.`);
  out.push(`- AO CONFIRMAR: chame agendar_visita (loja = "${loja}"; tipo = "avaliacao" se o foco é o ${carroDele} dele, "test_drive" se ele quer dirigir um carro do estoque, senão "visita"; carro = o carro de interesse ou o ${carroDele}; observacoes = unidade escolhida + o que ele quer ver + se vem com financiamento/Grazi). Depois confirme na conversa com dia, hora, endereço e a referência pra chegar, e diga que a equipe da ${loja} vai estar esperando.`);
  out.push(`- SE NÃO DER AGORA (viagem, sem tempo, "mais pra frente"): pergunte quando fica bom e use agendar_lembrete pra retomar nessa data (ex.: "volto em março" → lembrete no começo de março). Não deixe solto.`);
  out.push(`- SE ELE SÓ QUER VENDER o ${carroDele}: a ${loja} também compra carro; convide pra avaliação presencial do mesmo jeito (o valor sai na loja, nunca por mensagem).`);
  if (unidades.length) {
    out.push(`- UNIDADES DA ${loja.toUpperCase()} (ofereça a que fica melhor pra ele; se o carro de interesse está numa unidade, prefira essa):`);
    for (const u of unidades) out.push(`  • ${u.nome}: ${u.endereco}${u.referencia ? ` (${u.referencia})` : ""}. Horário: ${u.horario}.`);
  }
  out.push(`- Ligação só se ELE pedir. Nada de escassez ("última unidade", "vai sair rápido"), nunca taxa de juros, nunca valor de troca por mensagem.`);
  return out;
}
