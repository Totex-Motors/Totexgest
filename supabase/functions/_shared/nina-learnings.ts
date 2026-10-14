/**
 * APRENDIZADO DA NINA (2026-10-14, pedido do Marco: "a Nina tem que ter um mecanismo de
 * aprendizagem para entender todo tipo de atendimento e melhorar sempre").
 *
 * Ciclo:
 *  1. Depois de CADA ligação, `reviewCall` avalia a transcrição contra o que a Nina devia ter
 *     feito (nota 0–10, acertos, erros) e propõe LIÇÕES como regra curta de prompt.
 *     Vai pra tabela `nina_learnings` com status 'pendente' (lição repetida só soma `vezes`).
 *     A avaliação fica em call_history.metadata.avaliacao (aparece no card da ligação).
 *  2. A equipe aprova/rejeita na tela Nina — Ligações › "O que a Nina aprendeu".
 *  3. `lessonsBlock` injeta as lições APROVADAS no prompt do agente (syncNinaAgent e o
 *     provisionamento), no máximo NINA_MAX_LICOES (padrão 20), as mais recentes.
 * Humano no circuito de propósito: lição errada no prompt estraga todas as ligações.
 */
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { askClaudeJson } from "./claude-json.ts";
import { getIntegrationKey } from "./config.ts";

export const LESSONS_START = "<!-- LICOES:inicio -->";
export const LESSONS_END = "<!-- LICOES:fim -->";

export type Lesson = { id: string; regra: string; categoria: string | null; vezes: number };

export async function getApprovedLessons(sb: SupabaseClient): Promise<Lesson[]> {
  const max = Number((await getIntegrationKey(sb, "NINA_MAX_LICOES")) || 20);
  const { data } = await sb.from("nina_learnings").select("id, regra, categoria, vezes")
    .eq("status", "aprovada").order("aprovada_em", { ascending: false }).limit(Math.max(1, Math.min(60, max)));
  return (data || []) as Lesson[];
}

export function lessonsBlock(lessons: Lesson[]): string {
  if (!lessons.length) return "";
  return [
    LESSONS_START,
    "# LIÇÕES APRENDIDAS (vindas de ligações reais, aprovadas pela equipe — valem como regra)",
    ...lessons.map((l) => `- ${l.regra}${l.categoria ? ` [${l.categoria}]` : ""}`),
    LESSONS_END,
  ].join("\n");
}

/** Prompt final = base (sem bloco antigo) + lições aprovadas. Devolve também um hash curto pro sync. */
export async function withLessons(sb: SupabaseClient, basePrompt: string): Promise<{ prompt: string; hash: string }> {
  const re = new RegExp(`\\n*${LESSONS_START}[\\s\\S]*?${LESSONS_END}\\n*`, "g");
  const clean = String(basePrompt || "").replace(re, "\n").trim();
  const lessons = await getApprovedLessons(sb).catch(() => [] as Lesson[]);
  const block = lessonsBlock(lessons);
  const hash = "li" + lessons.length + ":" + lessons.map((l) => l.id.slice(0, 6)).join(",");
  return { prompt: block ? `${clean}\n\n${block}` : clean, hash };
}

export type CallReview = { nota: number | null; acertos: string[]; erros: string[]; licoes: Array<{ regra: string; categoria: string; evidencia: string }> };

/** Avalia a ligação e registra as lições como PENDENTES. Devolve a avaliação (ou null). */
export async function reviewCall(sb: SupabaseClient, tenantId: string | null, callId: string, transcript: string, contexto: string): Promise<CallReview | null> {
  if (!transcript || transcript.length < 60) return null;
  const system = [
    "Você é o treinador da Nina, atendente de voz de uma rede de lojas de carros (Totex Motors / Cardoso Veículos). Avalie a ligação abaixo com rigor e objetividade.",
    "Critérios: (1) usou o dossiê (nome, carro de interesse, origem) sem perguntar o que já sabia; (2) quando interrompida, retomou o ponto que ficou pela metade; (3) uma pergunta por vez, curta; (4) consultou estoque antes de afirmar; (5) confirmou carro/dia/hora e agendou UMA vez; (6) anotou resumo e próximo passo; (7) convidou pro Instagram da Totex quando cabia; (8) tom natural, sem ler ficha, sem jargão de sistema; (9) não inventou disponibilidade, taxa ou desconto.",
    'Responda SÓ JSON: {"nota": 0-10, "acertos": ["frase curta"...], "erros": ["frase curta e específica, citando o trecho"...],',
    '"licoes": [{"regra": "regra curta, imperativa e GENÉRICA pra entrar no prompt (máx 180 caracteres, sem nome de cliente)", "categoria": "interrupcao|descoberta|estoque|agendamento|encerramento|tom|dados", "evidencia": "trecho da ligação que justifica"}]}',
    "Lições: no máximo 3, só quando houver ERRO real e repetível. Ligação boa = licoes []. Não repita regras óbvias que já estão no método (uma pergunta por vez, usar o nome).",
  ].join("\n");
  const user = `CONTEXTO (dossiê que a Nina tinha): ${contexto || "(nenhum)"}\n\nTRANSCRIÇÃO:\n${transcript.slice(0, 14000)}`;
  const j = await askClaudeJson(sb, tenantId, system, user, { maxTokens: 1200, tag: "review" });
  if (!j) return null;
  const arr = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).slice(0, 300)).filter(Boolean) : []);
  const nota = Number(j.nota); const review: CallReview = {
    nota: Number.isFinite(nota) ? Math.max(0, Math.min(10, Math.round(nota))) : null,
    acertos: arr(j.acertos).slice(0, 6), erros: arr(j.erros).slice(0, 6),
    licoes: (Array.isArray(j.licoes) ? j.licoes : []).slice(0, 3).map((l: any) => ({
      regra: String(l?.regra || "").trim().slice(0, 200), categoria: String(l?.categoria || "geral").trim().slice(0, 30), evidencia: String(l?.evidencia || "").trim().slice(0, 400),
    })).filter((l: any) => l.regra.length >= 15),
  };

  for (const l of review.licoes) {
    const key = l.regra.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
    const { data: dup } = await sb.from("nina_learnings").select("id, vezes, status").eq("chave", key).limit(1).maybeSingle();
    if (dup) {
      await sb.from("nina_learnings").update({ vezes: Number(dup.vezes || 1) + 1, ultima_ligacao_id: callId, ultima_evidencia: l.evidencia, updated_at: new Date().toISOString() }).eq("id", dup.id);
    } else {
      const { error } = await sb.from("nina_learnings").insert({
        tenant_id: tenantId, regra: l.regra, categoria: l.categoria, chave: key, evidencia: l.evidencia, ultima_evidencia: l.evidencia,
        origem_ligacao_id: callId, ultima_ligacao_id: callId, status: "pendente",
      });
      if (error) console.warn("[nina-learnings] insert:", error.message);
    }
  }
  return review;
}
