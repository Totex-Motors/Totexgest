// ig-icp-score — pontua quem interagiu no Instagram contra o ICP da conta e
// devolve um GANCHO pessoal pra abordagem (o que faz a DM não parecer disparo).
//
// Entrada: { usernames: string[], tenant_id? }  (lote de até 20)
// Fonte: instagram_profiles (bio, seguidores, posts) + últimas msgs da conversa
// Saída: grava em ig_icp_scores e retorna o resumo.
//
// O critério de ICP é customizável por tenant via config `ig_icp_prompt`
// (Configurações → API Keys); sem config, usa o prompt genérico abaixo.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "../_shared/config.ts";
import { getTenantIdFromRequest } from "../_shared/tenant.ts";
import { resolveAccountFromEvent } from "../instagram-webhook/meta-campaign.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const MODEL = "gemini-2.5-flash";

const PROMPT_DEFAULT = `Você analisa perfis do Instagram pra decidir QUEM abordar comercialmente
em nome do dono da conta.

PÚBLICO IDEAL (nota alta):
- dono de empresa / sócio / fundador com operação de VENDAS pra consertar
- tem time comercial, vendedores, SDR, ou vende alto ticket (consultoria, mentoria, serviço B2B)
- clínica, escritório, agência, indústria, imobiliária, e-commerce com equipe

PÚBLICO RUIM (nota baixa):
- perfil pessoal sem negócio, estudante, curioso sem empresa
- perfil sem sinal nenhum de atividade profissional

DESCARTAR (descartar=true) SOMENTE se for concorrente direto do dono da conta,
fornecedor ou parceiro (não entram em abordagem comercial).

ATENÇÃO: seguidor alto NÃO é sinal de qualidade. Dono de negócio com 800 seguidores vale
mais que criador de conteúdo com 50 mil.

Pra CADA pessoa devolva:
- score: 0 a 100 (quão ideal pra abordagem)
- segmento: o que a pessoa faz, em 2-4 palavras (ex: "clínica odontológica", "agência de tráfego")
- motivo: 1 frase curta justificando a nota
- gancho: como o dono da conta abriria a conversa, em NO MÁXIMO 12 palavras, minúsculo e informal.
  REGRA DURA: o gancho PRECISA conter um elemento CONCRETO e único da pessoa —
  nome/@ da empresa, cidade, quantidade de unidades, ou algo que ela falou na conversa.
  Cargo sozinho NÃO vale (é genérico demais).
  BOM: "vi que tu toca a @feiraimob" | "vi que tu tem 5 clínicas"
  RUIM: "vi que tu é diretor de imobiliária" | "vi que tu tem clínica"
  Se a bio não tiver NENHUM elemento concreto, devolva gancho vazio "" (melhor vazio que genérico).
- ponte: UMA frase (máx 25 palavras, minúsculo, informal) dizendo onde o comercial DAQUELE tipo de
  negócio costuma vazar — concreto, do dia a dia dele. Serve pra pessoa pensar "é exatamente o que
  acontece aqui". Fale do negócio DELA, nunca invente detalhe que não está nos dados.
  BOM (clínica): "a secretária responde whats no intervalo do atendimento.. quem chega 19h fica pra amanhã e some"
  RUIM: "a IA pode ajudar muito no seu negócio" (genérico, não serve)
- descartar: true se for concorrente, fornecedor ou perfil claramente fora

Responda APENAS um array JSON:
[{"username":"...","score":0,"segmento":"...","motivo":"...","gancho":"...","ponte":"...","descartar":false}]`;

export async function handleIcpScore(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const body = await req.json();
    const usernames = body.usernames;
    if (!Array.isArray(usernames) || !usernames.length) {
      return new Response(JSON.stringify({ error: "usernames[] obrigatório" }), { status: 400, headers: cors });
    }
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Tenant: body → JWT → única conta connected (fallback single-tenant)
    let tenantId: string | null = body.tenant_id || getTenantIdFromRequest(req);
    if (!tenantId) {
      const single = await resolveAccountFromEvent(supabase, null);
      tenantId = single?.tenant_id || null;
    }
    if (!tenantId) {
      return new Response(JSON.stringify({ error: "Não deu pra identificar o tenant (2+ contas conectadas). Passe tenant_id." }), { status: 400, headers: cors });
    }

    const GEMINI_KEY = await getIntegrationKey(supabase, "GEMINI_API_KEY", tenantId);
    if (!GEMINI_KEY) {
      return new Response(JSON.stringify({ error: "GEMINI_API_KEY não configurada em Configurações → API Keys" }), { status: 400, headers: cors });
    }
    const PROMPT = (await getIntegrationKey(supabase, "ig_icp_prompt", tenantId)) || PROMPT_DEFAULT;

    const lower = usernames.map((u: string) => String(u).toLowerCase());

    const { data: perfis } = await supabase
      .from("instagram_profiles")
      .select("username, full_name, biography, follower_count, external_url, latest_posts")
      .eq("tenant_id", tenantId)
      .in("username", lower);

    const { data: convs } = await supabase
      .from("instagram_conversations")
      .select("id, participant_username, qualification_reason, last_message")
      .eq("tenant_id", tenantId)
      .in("participant_username", lower);

    // O que a PESSOA falou na conversa costuma ser o gancho mais forte que existe
    const convIds = (convs || []).map((c: any) => c.id);
    const falasPorConv = new Map<string, string[]>();
    if (convIds.length) {
      const { data: msgs } = await supabase
        .from("instagram_messages")
        .select("conversation_id, content, is_from_me, sent_at")
        .in("conversation_id", convIds)
        .eq("is_from_me", false)
        .order("sent_at", { ascending: false })
        .limit(400);
      for (const m of msgs || []) {
        const t = String(m.content || "").trim();
        if (t.length < 8 || t.startsWith("[")) continue;
        const arr = falasPorConv.get(m.conversation_id) || [];
        if (arr.length < 3) { arr.push(t.slice(0, 140)); falasPorConv.set(m.conversation_id, arr); }
      }
    }

    const byUser = new Map<string, any>();
    for (const u of lower) byUser.set(u, { username: u });
    for (const p of perfis || []) {
      const k = String(p.username).toLowerCase();
      const posts = Array.isArray(p.latest_posts)
        ? p.latest_posts.slice(0, 3).map((x: any) => String(x?.caption || "").slice(0, 120)).filter(Boolean)
        : [];
      Object.assign(byUser.get(k) || {}, {
        nome: p.full_name, bio: p.biography, seguidores: p.follower_count,
        site: p.external_url, posts,
      });
    }
    for (const c of convs || []) {
      const k = String(c.participant_username).toLowerCase();
      const o = byUser.get(k);
      if (o && !o.contexto) {
        o.contexto = c.qualification_reason || "";
        o.falou_na_conversa = falasPorConv.get(c.id) || [];
      }
    }

    const payload = [...byUser.values()].map((o) => ({
      username: o.username, nome: o.nome, bio: (o.bio || "").slice(0, 300),
      seguidores: o.seguidores, site: o.site, posts: o.posts, contexto: o.contexto,
      falou_na_conversa: o.falou_na_conversa,
    }));

    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${PROMPT}\n\nPERFIS:\n${JSON.stringify(payload)}` }] }],
          generationConfig: { temperature: 0.3, responseMimeType: "application/json" },
        }),
      },
    );
    const j = await r.json();
    const txt = j?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
    let arr: any[] = [];
    try { arr = JSON.parse(txt); } catch { arr = []; }
    if (!Array.isArray(arr)) arr = [];

    const rows = arr.filter((a) => a?.username).map((a) => ({
      tenant_id: tenantId,
      username: String(a.username).toLowerCase(),
      score: Math.max(0, Math.min(100, Number(a.score) || 0)),
      segmento: String(a.segmento || "").slice(0, 60),
      motivo: String(a.motivo || "").slice(0, 200),
      gancho: String(a.gancho || "").slice(0, 120),
      ponte: String(a.ponte || "").slice(0, 220),
      descartar: !!a.descartar,
      scored_at: new Date().toISOString(),
    }));
    if (rows.length) {
      // PK real: (tenant_id, username) — ver migration instagram_automacao
      await supabase.from("ig_icp_scores").upsert(rows, { onConflict: "tenant_id,username" });
    }
    return new Response(JSON.stringify({ ok: true, scored: rows.length, rows }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500, headers: cors });
  }
}
