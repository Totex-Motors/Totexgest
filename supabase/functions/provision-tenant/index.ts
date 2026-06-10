import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INCOMING_OS_SECRET = Deno.env.get("INCOMING_OS_SECRET")!;
const CRM_APP_URL = Deno.env.get("CRM_APP_URL") ?? "https://crm.totexmotors.com.br";

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (req.headers.get("x-integration-secret") !== INCOMING_OS_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const payload = await req.json();
    const {
      external_dealership_id,
      trade_name,
      legal_name,
      cnpj,
      whatsapp,
      logo_url,
      plan = {},
      primary_contact,
    } = payload;

    if (!external_dealership_id || !trade_name) {
      return json({ error: "external_dealership_id e trade_name são obrigatórios" }, 400);
    }

    // Idempotência
    const { data: existing } = await supabase
      .from("tenants")
      .select("id")
      .eq("external_dealership_id", external_dealership_id)
      .maybeSingle();

    if (existing) {
      return json({ tenant_id: existing.id, conflict: true }, 409);
    }

    // 1. Cria tenant
    const slug = trade_name.toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

    const { data: tenant, error: tenantErr } = await supabase
      .from("tenants")
      .insert({
        name: trade_name,
        slug,
        is_active: true,
        external_dealership_id,
        external_source: "totex_os",
        metadata: { legal_name, cnpj, logo_url, whatsapp, plan },
      })
      .select("id")
      .single();

    if (tenantErr) throw tenantErr;
    const tenantId = tenant.id;

    // 2. Convida contato primário
    let userId: string | null = null;
    let inviteUrl: string | null = null;

    if (primary_contact?.email) {
      const { data: invite, error: inviteErr } = await supabase.auth.admin.inviteUserByEmail(
        primary_contact.email,
        {
          data: { name: primary_contact.name },
          redirectTo: `${CRM_APP_URL}/auth/callback`,
        }
      );

      if (!inviteErr && invite.user) {
        userId = invite.user.id;
        inviteUrl = (invite as any).properties?.action_link ?? null;

        await supabase.auth.admin.updateUserById(userId, {
          app_metadata: { tenant_id: tenantId, role: "admin" },
        });

        await supabase.from("team_members").insert({
          tenant_id: tenantId,
          auth_user_id: userId,
          name: primary_contact.name,
          email: primary_contact.email,
          phone: primary_contact.phone ?? null,
          role: "admin",
          is_active: true,
        });
      } else {
        console.warn("[provision-tenant] Falha ao convidar usuário:", inviteErr);
      }
    }

    // 3. Cria pipeline padrão + estágios
    const { data: pipeline } = await supabase
      .from("sales_pipelines")
      .insert({ tenant_id: tenantId, name: "Pipeline Padrão", is_default: true, is_active: true })
      .select("id")
      .single();

    if (pipeline) {
      await supabase.from("sales_pipeline_stages").insert([
        { tenant_id: tenantId, pipeline_id: pipeline.id, name: "Novo Lead",                 position: 0 },
        { tenant_id: tenantId, pipeline_id: pipeline.id, name: "Em Qualificação",           position: 1 },
        { tenant_id: tenantId, pipeline_id: pipeline.id, name: "Test Drive",                position: 2 },
        { tenant_id: tenantId, pipeline_id: pipeline.id, name: "Avaliação / Proposta",      position: 3 },
        { tenant_id: tenantId, pipeline_id: pipeline.id, name: "Financiamento (Credere)",   position: 4 },
        { tenant_id: tenantId, pipeline_id: pipeline.id, name: "Ganho",                     position: 5, is_won: true },
        { tenant_id: tenantId, pipeline_id: pipeline.id, name: "Perdido",                   position: 6, is_lost: true },
      ]);
    }

    // 4. Cria Agente IA padrão
    await supabase.from("ai_sales_agents").insert({
      tenant_id: tenantId,
      name: `Vendedor IA — ${trade_name}`,
      system_prompt:
        `Você é o assistente comercial da ${trade_name}. ` +
        `Atenda leads com cortesia, qualifique interesse em veículos, ` +
        `e agende visitas ou test drives. Seja objetivo e profissional.`,
      is_active: false,
      settings: {
        debounce_seconds: 30,
        horario_inicio: "08:00",
        horario_fim: "20:00",
        dias_semana: [1, 2, 3, 4, 5, 6],
        max_messages_per_day: 50,
      },
    });

    // 5. Habilita módulos DO TENANT conforme plano (por-tenant; não toca config global).
    await supabase.from("tenants").update({
      enabled_modules: {
        comercial: true,
        gestao: true,
        marketplace: plan.marketplace === true,
        credere: plan.credere === true,
        telefonia: false,
        analytics: false,
      },
    }).eq("id", tenantId);

    console.log(`[provision-tenant] Tenant criado: ${tenantId} (${trade_name})`);
    return json({ tenant_id: tenantId, user_id: userId, invite_url: inviteUrl });
  } catch (err) {
    console.error("[provision-tenant] Erro:", err);
    return json({ error: String(err) }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
