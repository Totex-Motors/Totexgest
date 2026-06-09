import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const DEFAULT_STAGES = [
  { name: "Novo Lead", position: 0 },
  { name: "Em Qualificação", position: 1 },
  { name: "Reunião Agendada", position: 2 },
  { name: "Proposta Enviada", position: 3 },
  { name: "Ganho", position: 4, is_won: true },
  { name: "Perdido", position: 5, is_lost: true },
];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // ── Auth: precisa de JWT e o caller precisa ser super-admin ───────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json({ error: "Unauthorized: missing bearer token" }, 401);
    }
    const jwt = authHeader.replace("Bearer ", "");

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: userData, error: userErr } = await userClient.auth.getUser(jwt);
    if (userErr || !userData?.user) {
      return json({ error: "Unauthorized: invalid token" }, 401);
    }

    // is_superadmin() é SECURITY DEFINER e usa auth.uid() — chamado pelo client do usuário.
    const { data: isSuper, error: rpcErr } = await userClient.rpc("is_superadmin");
    if (rpcErr) return json({ error: `Auth check failed: ${rpcErr.message}` }, 500);
    if (isSuper !== true) return json({ error: "Forbidden: super-admin required" }, 403);

    // Cliente service_role para operações cross-tenant.
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { action, data } = await req.json();

    // ── LIST: todas as lojas/tenants + contagem de membros ────────────────────
    if (action === "list") {
      const { data: tenants, error } = await supabase
        .from("tenants")
        .select("id, name, slug, is_active, is_super_admin, external_dealership_id, created_at")
        .order("created_at", { ascending: false });
      if (error) return json({ error: error.message }, 400);

      const { data: members } = await supabase
        .from("team_members")
        .select("tenant_id, is_active");

      const counts: Record<string, { total: number; active: number }> = {};
      for (const m of members ?? []) {
        const tid = (m as { tenant_id: string | null }).tenant_id;
        if (!tid) continue;
        counts[tid] ??= { total: 0, active: 0 };
        counts[tid].total++;
        if ((m as { is_active: boolean }).is_active) counts[tid].active++;
      }

      const result = (tenants ?? []).map((t) => ({
        ...t,
        members_total: counts[t.id]?.total ?? 0,
        members_active: counts[t.id]?.active ?? 0,
      }));
      return json({ tenants: result });
    }

    // ── PROVISION: cria tenant + admin + pipeline + agente ────────────────────
    if (action === "provision") {
      const { trade_name, cnpj, whatsapp, legal_name, admin } = data ?? {};
      if (!trade_name || !admin?.email || !admin?.name) {
        return json({ error: "Campos obrigatórios: trade_name, admin.name, admin.email" }, 400);
      }

      // slug único
      let slug = slugify(trade_name);
      const { data: slugHit } = await supabase
        .from("tenants").select("id").eq("slug", slug).maybeSingle();
      if (slugHit) slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;

      // 1. tenant
      const { data: tenant, error: tenantErr } = await supabase
        .from("tenants")
        .insert({
          name: trade_name,
          slug,
          is_active: true,
          metadata: { legal_name: legal_name ?? null, cnpj: cnpj ?? null, whatsapp: whatsapp ?? null },
        })
        .select("id")
        .single();
      if (tenantErr) return json({ error: `Falha ao criar tenant: ${tenantErr.message}` }, 400);
      const tenantId = tenant.id;

      // 2. admin user (convite por email; app_metadata amarra o tenant)
      let userId: string | null = null;
      let inviteUrl: string | null = null;
      const { data: invite, error: inviteErr } = await supabase.auth.admin.inviteUserByEmail(
        admin.email,
        { data: { name: admin.name } },
      );

      if (inviteErr || !invite?.user) {
        // rollback do tenant para não deixar lixo
        await supabase.from("tenants").delete().eq("id", tenantId);
        return json({ error: `Falha ao convidar admin: ${inviteErr?.message ?? "desconhecido"}` }, 400);
      }

      userId = invite.user.id;
      inviteUrl = (invite as { properties?: { action_link?: string } }).properties?.action_link ?? null;

      await supabase.auth.admin.updateUserById(userId, {
        app_metadata: { tenant_id: tenantId, role: "admin" },
      });

      await supabase.from("team_members").insert({
        tenant_id: tenantId,
        auth_user_id: userId,
        name: admin.name,
        email: admin.email,
        phone: admin.phone ?? null,
        role: "admin",
        is_active: true,
      });

      // 3. pipeline padrão + estágios
      const { data: pipeline } = await supabase
        .from("sales_pipelines")
        .insert({ tenant_id: tenantId, name: "Pipeline Padrão", is_default: true, is_active: true })
        .select("id")
        .single();

      if (pipeline) {
        await supabase.from("sales_pipeline_stages").insert(
          DEFAULT_STAGES.map((s) => ({ tenant_id: tenantId, pipeline_id: pipeline.id, ...s })),
        );
      }

      // 4. agente IA padrão (desligado)
      await supabase.from("ai_sales_agents").insert({
        tenant_id: tenantId,
        name: `Vendedor IA — ${trade_name}`,
        system_prompt:
          `Você é o assistente comercial da ${trade_name}. Atenda leads com cortesia, ` +
          `qualifique interesse em veículos e agende visitas ou test drives. Seja objetivo e profissional.`,
        is_active: false,
        settings: {
          debounce_seconds: 30,
          horario_inicio: "08:00",
          horario_fim: "20:00",
          dias_semana: [1, 2, 3, 4, 5, 6],
          max_messages_per_day: 50,
        },
      });

      // NOTA: não tocamos em config.enabled_modules — essa chave é GLOBAL (não por-tenant).
      return json({ tenant_id: tenantId, user_id: userId, invite_url: inviteUrl });
    }

    // ── SET_STATUS: ativa/desativa tenant ─────────────────────────────────────
    if (action === "set_status") {
      const { tenant_id, is_active } = data ?? {};
      if (!tenant_id || typeof is_active !== "boolean") {
        return json({ error: "Campos obrigatórios: tenant_id, is_active (boolean)" }, 400);
      }

      // Não permite desativar um tenant super-admin (evita travar o acesso)
      const { data: target } = await supabase
        .from("tenants").select("is_super_admin").eq("id", tenant_id).maybeSingle();
      if (!target) return json({ error: "Tenant não encontrado" }, 404);
      if (target.is_super_admin && !is_active) {
        return json({ error: "Não é possível desativar o tenant super-admin" }, 400);
      }

      const { error } = await supabase
        .from("tenants").update({ is_active }).eq("id", tenant_id);
      if (error) return json({ error: error.message }, 400);
      return json({ success: true });
    }

    return json({ error: `Ação desconhecida: ${action}. Válidas: list, provision, set_status` }, 400);
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
