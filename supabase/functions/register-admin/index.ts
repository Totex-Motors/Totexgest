import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || "empresa";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { name, email, password } = await req.json();

    if (!name || !email || !password) {
      return jsonResponse({ error: "Campos obrigatórios: name, email, password" }, 400);
    }

    // Permite apenas se não existir nenhum admin ainda (setup inicial)
    const { count, error: countError } = await supabase
      .from("team_members")
      .select("id", { count: "exact", head: true })
      .eq("role", "admin");

    if (countError) {
      return jsonResponse({ error: `Erro ao verificar admins: ${countError.message}` }, 500);
    }

    if (count && count > 0) {
      return jsonResponse(
        { error: "Já existe um admin cadastrado. Use Configurações > Equipe para adicionar membros." },
        403
      );
    }

    // 1. Cria o tenant primeiro (necessário pela FK team_members.tenant_id → tenants.id)
    const tenantSlug = `${slugify(name)}-${Date.now()}`;
    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .insert({ name, slug: tenantSlug, is_active: true })
      .select("id")
      .single();

    if (tenantError) {
      return jsonResponse({ error: `Erro ao criar empresa: ${tenantError.message}` }, 400);
    }

    const tenantId = tenant.id;

    // 2. Localiza ou cria o auth user
    let authUserId: string;
    let isNewUser = false;

    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name },
      app_metadata: { tenant_id: tenantId },
    });

    if (authError) {
      // Usuário já existe — localiza via listUsers
      const { data: usersPage, error: listError } = await supabase.auth.admin.listUsers({
        perPage: 1000,
        page: 1,
      });

      if (listError) {
        await supabase.from("tenants").delete().eq("id", tenantId);
        return jsonResponse({ error: `Erro ao localizar usuário: ${listError.message}` }, 500);
      }

      const found = usersPage?.users?.find((u: { email?: string }) => u.email === email);

      if (!found) {
        await supabase.from("tenants").delete().eq("id", tenantId);
        return jsonResponse({ error: `Erro ao criar usuário: ${authError.message}` }, 400);
      }

      authUserId = found.id;
      await supabase.auth.admin.updateUserById(authUserId, {
        app_metadata: { tenant_id: tenantId },
      });
    } else {
      authUserId = authData.user.id;
      isNewUser = true;
    }

    // 3. Cria o registro de admin no team_members
    const { error: tmError } = await supabase.from("team_members").insert({
      name,
      email,
      role: "admin",
      team: "admin",
      is_active: true,
      auth_user_id: authUserId,
      tenant_id: tenantId,
    });

    if (tmError) {
      await supabase.from("tenants").delete().eq("id", tenantId);
      if (isNewUser) await supabase.auth.admin.deleteUser(authUserId);
      return jsonResponse({ error: `Erro ao criar perfil de admin: ${tmError.message}` }, 400);
    }

    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse({ error: (err as Error).message }, 500);
  }
});
