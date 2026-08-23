/**
 * Trava anti-loop do agente de WhatsApp.
 *
 * Impede que o agente entre num ping-pong infinito com outro robô/autoresposta
 * (ou seja floodado por alguém), limitando quantas RESPOSTAS ele manda pro mesmo
 * número numa janela curta. Ao estourar o limite, PAUSA a sessão por um tempo
 * (cooldown) e gera UM alerta pro supervisor. Enquanto pausada, o agente não
 * responde; passado o cooldown, ele volta sozinho (se o loop parou).
 *
 * Contexto: em jul/2026 o agente ficou ~3 dias trocando >9 mil mensagens com o
 * robô de cobrança do TotexCar Co-pilot. Esta trava evita a reincidência.
 */

const WINDOW_MIN = 5;    // janela de contagem das respostas do bot
const MAX_REPLIES = 8;   // máx. de respostas do bot na janela antes de travar
const COOLDOWN_MIN = 60; // tempo que a sessão fica pausada após detectar o loop

/**
 * Retorna true se o agente NÃO deve responder agora (loop detectado ou sessão
 * em cooldown). Chamar logo após resolver a sessão, antes de acionar o runner.
 */
export async function loopGuardBlocks(
  supabase: any,
  args: { leadId?: string | null; sessionId?: string | null; tenantId?: string | null; phone?: string | null },
): Promise<boolean> {
  const { leadId, sessionId, tenantId, phone } = args;
  const nowMs = Date.now();

  // 1. Sessão já pausada pela trava? Respeita o cooldown (e auto-retoma no fim).
  if (sessionId) {
    const { data: sess } = await supabase
      .from("agents_sessions").select("status, provider_state").eq("id", sessionId).maybeSingle();
    const ps = (sess?.provider_state || {}) as Record<string, any>;
    if (sess?.status === "paused" && ps.pause_reason === "loop_guard") {
      const pausedAt = ps.loop_paused_at ? new Date(ps.loop_paused_at).getTime() : 0;
      if (nowMs - pausedAt < COOLDOWN_MIN * 60000) {
        return true; // ainda em cooldown → não responde
      }
      // cooldown acabou → volta a sessão pra ativa e segue o fluxo normal
      ps.pause_reason = null;
      ps.loop_paused_at = null;
      await supabase.from("agents_sessions")
        .update({ status: "active", provider_state: ps }).eq("id", sessionId);
    }
  }

  // 2. Conta quantas respostas o bot já mandou pra esse número na janela.
  if (!leadId) return false;
  const since = new Date(nowMs - WINDOW_MIN * 60000).toISOString();
  const { count } = await supabase
    .from("whatsapp_messages")
    .select("id", { count: "exact", head: true })
    .eq("lead_id", leadId).eq("is_from_me", true).gte("created_at", since);
  if ((count || 0) < MAX_REPLIES) return false;

  // 3. Estourou o limite → pausa a sessão + alerta o supervisor (uma vez).
  if (sessionId) {
    const { data: sess } = await supabase
      .from("agents_sessions").select("provider_state").eq("id", sessionId).maybeSingle();
    const ps = (sess?.provider_state || {}) as Record<string, any>;
    const jaTravado = ps.pause_reason === "loop_guard";
    ps.pause_reason = "loop_guard";
    ps.loop_paused_at = new Date(nowMs).toISOString();
    await supabase.from("agents_sessions")
      .update({ status: "paused", provider_state: ps }).eq("id", sessionId);

    if (!jaTravado && tenantId) {
      await supabase.from("sales_alerts").insert({
        lead_id: leadId,
        tenant_id: tenantId,
        alert_type: "agent_loop_paused",
        title: "Agente pausado — possível loop",
        description: `O agente enviou ${count} mensagens em ${WINDOW_MIN} min pro número ${phone || ""}. `
          + `Pausei a conversa por ${COOLDOWN_MIN} min pra evitar loop/spam. `
          + `Provavelmente é outro robô do outro lado — confira antes de reativar.`,
        priority: 8,
      }).then(() => {}, () => {});
    }
    console.warn(`[loop-guard] sessão ${sessionId} pausada — ${count} respostas em ${WINDOW_MIN}min (lead ${leadId})`);
  }
  return true;
}

/**
 * True se a ÚLTIMA mensagem que o bot mandou pra esse lead já foi o texto de
 * fallback. Serve pra não repetir "Desculpa, não consegui processar agora."
 * em sequência (o que alimentava o loop). Se já mandou, fica quieto.
 */
export async function lastOutboundWasFallback(
  supabase: any, leadId: string | null | undefined, fallbackText: string,
): Promise<boolean> {
  if (!leadId) return false;
  const { data } = await supabase
    .from("whatsapp_messages")
    .select("content")
    .eq("lead_id", leadId).eq("is_from_me", true)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  return String(data?.content || "").trim() === fallbackText.trim();
}
