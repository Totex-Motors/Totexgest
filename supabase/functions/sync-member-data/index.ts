import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// DESATIVADA (2026-10-07) — passo 1 de docs/ENTRADAS-DE-LEADS.md.
// Sincronizava membros do projeto PAIN (template "IA na Prática") e criava
// "leads" sem telefone (phone = "") no tenant fantasma …0001. Não é o negócio
// Totex. Nenhum cron ou código chama esta função; fica como stub só pra o deploy
// em lote das edge functions não quebrar com uma pasta ausente no config.toml.
Deno.serve(() =>
  new Response(
    JSON.stringify({
      disabled: true,
      reason: "sync-member-data foi desativada: legado PAIN (ver docs/ENTRADAS-DE-LEADS.md §3.5)",
    }),
    { status: 410, headers: { "Content-Type": "application/json" } },
  ));
