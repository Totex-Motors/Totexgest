import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // ========================================
    // AUTORIZAÇÃO: SOMENTE ADMINS AUTENTICADOS
    // ========================================
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return jsonResponse({ error: "Unauthorized: missing bearer token" }, 401);
    }

    const jwt = authHeader.replace("Bearer ", "");

    // Cliente com JWT do usuário pra validar sessão
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: userData, error: userErr } = await userClient.auth.getUser(jwt);
    if (userErr || !userData?.user) {
      return jsonResponse({ error: "Unauthorized: invalid token" }, 401);
    }

    const callerAuthId = userData.user.id;

    // Cliente service_role pra operações admin
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Verifica se o caller é admin ATIVO no team_members
    const { data: callerMember, error: callerErr } = await supabase
      .from("team_members")
      .select("id, role, is_active, tenant_id")
      .eq("auth_user_id", callerAuthId)
      .maybeSingle();

    if (callerErr || !callerMember) {
      return jsonResponse({ error: "Forbidden: caller not found in team_members" }, 403);
    }

    if (!callerMember.is_active) {
      return jsonResponse({ error: "Forbidden: caller is inactive" }, 403);
    }

    if (callerMember.role !== "admin") {
      return jsonResponse({ error: "Forbidden: admin role required" }, 403);
    }

    // Tenant do caller — usado para isolar todas as operações abaixo.
    // Sob service_role não há JWT, então get_tenant_id() cairia no fallback:
    // por isso o tenant_id precisa ser propagado explicitamente.
    const callerTenantId = callerMember.tenant_id as string | null;
    if (!callerTenantId) {
      return jsonResponse({ error: "Forbidden: caller has no tenant_id" }, 403);
    }

    // ========================================
    // CALLER VALIDADO COMO ADMIN — PROCESSA AÇÃO
    // ========================================
    const { action, data } = await req.json();

    if (action === "create") {
      const { email, password, name, role, team, phone } = data;

      if (!email || !password || !name || !role) {
        return jsonResponse({ error: "Missing required fields: email, password, name, role" }, 400);
      }

      // 1. Create auth user — app_metadata.tenant_id é o que o JWT carrega e o que
      // get_tenant_id() (RLS) lê. Sem isso o usuário cairia no tenant fallback.
      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { name },
        app_metadata: { tenant_id: callerTenantId, role },
      });

      if (authError) {
        return jsonResponse({ error: `Auth error: ${authError.message}` }, 400);
      }

      // 2. Insert team_member — tenant_id explícito (default cairia no fallback sob service_role)
      const { data: teamMember, error: tmError } = await supabase
        .from("team_members")
        .insert({
          tenant_id: callerTenantId,
          email,
          name,
          role,
          team: team || "comercial",
          phone: phone || null,
          auth_user_id: authData.user.id,
          is_active: true,
        })
        .select()
        .single();

      if (tmError) {
        // Rollback: delete auth user if team_member insert fails
        await supabase.auth.admin.deleteUser(authData.user.id);
        return jsonResponse({ error: `Team member error: ${tmError.message}` }, 400);
      }

      // 3. Corrige o profiles criado pelo trigger handle_new_user:
      // o trigger já pega o tenant do app_metadata, mas não seta role — garantimos ambos.
      const { error: profileErr } = await supabase
        .from("profiles")
        .update({ tenant_id: callerTenantId, role })
        .eq("id", authData.user.id);

      if (profileErr) {
        // Não faz rollback (usuário e team_member já válidos), mas reporta para visibilidade.
        console.error("[manage-team-member] Falha ao ajustar profile:", profileErr.message);
      }

      return jsonResponse({ success: true, team_member: teamMember });
    }

    if (action === "reset_password") {
      const { auth_user_id, password } = data;

      if (!auth_user_id || !password) {
        return jsonResponse({ error: "Missing required fields: auth_user_id, password" }, 400);
      }

      // Garante que o alvo é do mesmo tenant do caller (evita reset cross-tenant)
      const { data: target } = await supabase
        .from("team_members")
        .select("id")
        .eq("auth_user_id", auth_user_id)
        .eq("tenant_id", callerTenantId)
        .maybeSingle();

      if (!target) {
        return jsonResponse({ error: "Forbidden: target not in caller tenant" }, 403);
      }

      const { error } = await supabase.auth.admin.updateUserById(auth_user_id, { password });

      if (error) {
        return jsonResponse({ error: `Reset password error: ${error.message}` }, 400);
      }

      return jsonResponse({ success: true });
    }

    if (action === "deactivate") {
      const { team_member_id } = data;

      if (!team_member_id) {
        return jsonResponse({ error: "Missing required field: team_member_id" }, 400);
      }

      const { data: updated, error } = await supabase
        .from("team_members")
        .update({ is_active: false })
        .eq("id", team_member_id)
        .eq("tenant_id", callerTenantId)
        .select("id");

      if (error) {
        return jsonResponse({ error: `Deactivate error: ${error.message}` }, 400);
      }

      if (!updated || updated.length === 0) {
        return jsonResponse({ error: "Forbidden: target not in caller tenant" }, 403);
      }

      return jsonResponse({ success: true });
    }

    return jsonResponse(
      { error: `Unknown action: ${action}. Valid: create, reset_password, deactivate` },
      400
    );
  } catch (err) {
    return jsonResponse({ error: (err as Error).message }, 500);
  }
});
