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
      `- Tem veículo na troca?: ${boolFmt(m.tem_veiculo_troca)}`,
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

    // === MODO REAQUECIMENTO (lead-rewarm abriu a conversa com uma conta; leads.metadata.reaquecimento) ===
    const re = (m.reaquecimento ?? null) as Record<string, any> | null;
    if (re && re.ativo) {
      const momento: Record<string, string> = {
        A_saiu_do_stand: "saiu do stand há pouco sem agendar (pode ainda estar no shopping)",
        B_nunca_falou: "nunca tinha recebido mensagem nossa",
        C_esfriou: "conversou e esfriou (dias sem responder)",
      };
      lines.push("", "🔥 MODO REAQUECIMENTO — este cliente " + (momento[String(re.momento)] || "esfriou") + ". A gente abriu a conversa com uma conta pronta e ele RESPONDEU. Agora é o seu momento:");
      if (re.abertura) lines.push(`- A mensagem que ELE recebeu e respondeu foi: "${re.abertura}"`);
      lines.push(
        "- ⛔ NÃO pergunte o nome dele" + (re.nome ? ` (é ${re.nome})` : "") + ", NÃO pergunte se é troca ou compra, NÃO pergunte qual carro ele tem" + (re.carro_cliente ? ` (é o ${re.carro_cliente})` : "") + ". A abertura já disse tudo isso; perguntar de novo soa robô. Se ele disse 'pode mandar' / 'sim', a PRÓXIMA mensagem É a conta, não outra pergunta.",
      );
      if (re.carro_cliente) lines.push(`- Carro DELE (entra na troca/venda): ${re.carro_cliente}. A TRAVA continua: não diga quanto ele vale, nem faixa, nem FIPE — "a avaliação sai na loja em 15 minutos e entra como entrada".`);
      if (re.playbook === "trocar") lines.push("- Como mandar a conta na TROCA: pergunte (ou use, se ele já disse) qual carro ele viu ou quer; consultar_estoque pra achar o valor; simular_plano com o valor do carro (sem carro_na_troca: o valor do dele sai na avaliação) e mostre a parcela em reais + a jogada do décimo terceiro; diga que o carro dele entra como entrada e derruba essa parcela. Se ele JÁ citou o carro, pule a pergunta e vá direto pra conta.");
      if (re.playbook === "vender") lines.push("- Como mandar a conta na VENDA: explique em 2 frases por que vender pela Totex vale mais (loja comum compra barato; a Totex intermedeia perto da FIPE) e feche com a avaliação presencial com dia e hora. Sem número de valor.");
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
        "Como agir: otimista e concreto. Primeiro o ganho dele (carro melhor, mais seguro, mais econômico, mais conforto) e a sensação de que dá pra subir de carro AGORA; depois a conta (simular_plano com o valor do carro; use décimo terceiro, férias, PLR ou FGTS como dinheiro que derruba parcelas do fim). Nunca fale taxa nem porcentagem: só reais. Uma pergunta por mensagem, fácil de responder sim. Nunca pergunte se ele 'ainda tem interesse' nem se 'quer conversar depois'. Feche com visita, avaliação ou a Grazi, sempre com dia e hora ou com o cupom de 48 h como motivo real de urgência.",
      );
    }
  }

  lines.push("", "Use estes UUIDs SEMPRE que chamar tools que pedem `lead_id` ou `deal_id`.");
  return lines.join("\n");
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
