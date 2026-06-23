import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getTenantConfig, requireActiveConfig, type EmailConfig } from "../_shared/tenant-email-config.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";

interface AudienceCriteria {
  pipeline_ids?: string[];
  stage_ids?: string[];
  lead_ids?: string[];
  source?: string;
}

interface SendBody {
  campaign_id?: string;
  test_email?: string;
  html?: string;
  subject?: string;
  audience_override?: AudienceCriteria;
  // MULTI-TENANT: opcional p/ chamadas server-to-server (cron, automation)
  tenant_id?: string;
}

interface Recipient {
  lead_id: string | null;
  email: string;
  name: string | null;
  first_name: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  sales_rep_name: string | null;
}

// MULTI-TENANT: todas as queries de leads/stages/team agora filtram por tenant_id
async function resolveAudienceByCriteria(
  supabase: any,
  tenantId: string,
  criteria: AudienceCriteria,
): Promise<Recipient[]> {
  if (!criteria || (!criteria.pipeline_ids?.length && !criteria.stage_ids?.length && !criteria.lead_ids?.length)) {
    return [];
  }

  let q = supabase
    .from("leads")
    .select("id, name, email, phone, city_name, state, sales_rep_id")
    .eq("tenant_id", tenantId)
    .not("email", "is", null);

  if (criteria.lead_ids?.length) {
    q = q.in("id", criteria.lead_ids);
  } else {
    if (criteria.stage_ids?.length) {
      q = q.in("pipeline_stage_id", criteria.stage_ids);
    } else if (criteria.pipeline_ids?.length) {
      const { data: stages } = await supabase
        .from("sales_pipeline_stages")
        .select("id")
        .eq("tenant_id", tenantId)
        .in("pipeline_id", criteria.pipeline_ids);
      const stageIds = (stages || []).map((s: any) => s.id);
      if (stageIds.length) q = q.in("pipeline_stage_id", stageIds);
    }
    if (criteria.source) q = q.eq("source", criteria.source);
  }

  const { data: leads, error } = await q.limit(10000);
  if (error) throw error;

  const emails = (leads || []).map((l: any) => l.email).filter(Boolean);
  if (emails.length === 0) return [];

  const { data: unsubs } = await supabase
    .from("email_subscribers")
    .select("email")
    .eq("tenant_id", tenantId)
    .in("email", emails)
    .in("status", ["unsubscribed", "bounced", "complained"]);
  const unsubSet = new Set((unsubs || []).map((u: any) => u.email));

  // Busca nomes dos vendedores em batch
  const repIds = Array.from(
    new Set((leads || []).map((l: any) => l.sales_rep_id).filter(Boolean)),
  ) as string[];
  const repsMap = new Map<string, string>();
  if (repIds.length) {
    const { data: reps } = await supabase
      .from("team_members")
      .select("id, name")
      .eq("tenant_id", tenantId)
      .in("id", repIds);
    (reps || []).forEach((r: any) => repsMap.set(r.id, r.name));
  }

  return (leads || [])
    .filter((l: any) => l.email && !unsubSet.has(l.email))
    .map((l: any) => ({
      lead_id: l.id,
      email: l.email,
      name: l.name,
      first_name: l.name ? l.name.split(" ")[0] : null,
      phone: l.phone || null,
      city: l.city_name || null,
      state: l.state || null,
      sales_rep_name: l.sales_rep_id ? (repsMap.get(l.sales_rep_id) || null) : null,
    }));
}

async function resolveAudienceFromList(
  supabase: any,
  tenantId: string,
  listId: string | null,
): Promise<Recipient[]> {
  if (!listId) return [];
  const { data: list } = await supabase
    .from("email_lists")
    .select("criteria")
    .eq("id", listId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!list) return [];
  return resolveAudienceByCriteria(supabase, tenantId, list.criteria || {});
}

async function getOrCreateUnsubscribeToken(
  supabase: any,
  tenantId: string,
  email: string,
  leadId: string | null,
): Promise<string | null> {
  try {
    const { data: existing } = await supabase
      .from("email_subscribers")
      .select("unsubscribe_token, status")
      .eq("tenant_id", tenantId)
      .eq("email", email)
      .maybeSingle();

    if (existing?.unsubscribe_token) {
      return existing.status === "unsubscribed" || existing.status === "complained"
        ? null
        : existing.unsubscribe_token;
    }

    // MULTI-TENANT: insert PRECISA de tenant_id explícito (service_role bypassa default)
    const { data: created } = await supabase
      .from("email_subscribers")
      .insert({
        tenant_id: tenantId,
        email,
        lead_id: leadId,
        status: "subscribed",
        consent_source: "campaign_send",
        consent_at: new Date().toISOString(),
      })
      .select("unsubscribe_token")
      .single();

    return created?.unsubscribe_token || null;
  } catch (e) {
    console.error("Erro ao gerar unsubscribe token:", e);
    return null;
  }
}

function injectComplianceFooter(html: string, unsubscribeUrl: string, config: EmailConfig): string {
  const address = config.company_address || config.company_name || "";
  const replyEmail = config.reply_to || config.from_email || "";
  const footer = `
<table role="presentation" width="100%" style="margin-top:32px;border-top:1px solid #e5e5e5;padding:24px 0;">
  <tr>
    <td style="text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;color:#999;line-height:1.6;">
      ${address ? `<p style="margin:0 0 8px;">${address}</p>` : ""}
      <p style="margin:0;">
        <a href="${unsubscribeUrl}" style="color:#999;text-decoration:underline;">Descadastrar</a>
        ${replyEmail ? `· <a href="mailto:${replyEmail}" style="color:#999;text-decoration:underline;">Contato</a>` : ""}
      </p>
    </td>
  </tr>
</table>`;
  if (html.includes("</body>")) {
    return html.replace("</body>", `${footer}</body>`);
  }
  return html + footer;
}

function substituteVariables(text: string, vars: Record<string, string>): string {
  if (!text) return text;
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => vars[key] ?? "");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const body: SendBody = await req.json();
    const { campaign_id, test_email, audience_override } = body;

    // MULTI-TENANT (categoria a/d): resolve tenant_id
    //   - Preferência: JWT do user (chamada do frontend)
    //   - Fallback: body.tenant_id (chamada server-to-server, ex: email-automation-tick)
    let tenantId: string | null = null;
    const authHeader = req.headers.get("Authorization");
    if (authHeader && !authHeader.includes(SUPABASE_SERVICE_ROLE_KEY)) {
      const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user } } = await userClient.auth.getUser();
      tenantId = (user?.app_metadata as any)?.tenant_id || null;
    }
    if (!tenantId && body.tenant_id) {
      tenantId = body.tenant_id;
    }
    if (!tenantId && campaign_id) {
      // Último fallback: tira tenant da própria campanha
      const { data: c } = await supabase
        .from("email_campaigns").select("tenant_id").eq("id", campaign_id).maybeSingle();
      tenantId = c?.tenant_id || null;
    }
    if (!tenantId) {
      return new Response(JSON.stringify({ error: "missing tenant" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // === MODO TESTE — quando test_email vem no body, é teste (independente de ter campaign_id) ===
    // O wizard de criar campanha PASSA campaign_id (campanha-shell já criada) + test_email.
    // Independente disso, se test_email está presente, é envio teste pra esse endereço só.
    if (test_email && body.html) {
      const tCfg = await getTenantConfig(supabase, tenantId);
      const cfg = requireActiveConfig(tCfg, tenantId);
      const fEmail = (cfg.from_email || "").trim();
      const fName = (cfg.from_name || "CRM").trim();
      const rTo = cfg.reply_to || undefined;
      const appUrlT = (cfg.app_url || "").replace(/\/?$/, "");
      if (!appUrlT) console.warn("[send-email-campaign] app_url não configurado — links de unsubscribe ficarão vazios. Configure em Configurações > Integrações > Email.");

      const variables: Record<string, string> = {
        nome: "Teste",
        primeiro_nome: "Teste",
        empresa: cfg.company_name || "Empresa",
        email: test_email,
        telefone: "(11) 99999-9999",
        cidade: "São Paulo",
        estado: "SP",
        vendedor: "Vendedor de Teste",
        produto: "Produto de Teste",
        unsubscribe_url: `${appUrlT}/unsubscribe?token=teste`,
        link_descadastro: `${appUrlT}/unsubscribe?token=teste`,
      };
      const html = substituteVariables(body.html, variables);
      const subject = `[TESTE] ${substituteVariables(body.subject || "Teste de template", variables)}`;
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${cfg.resend_api_key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: `${fName} <${fEmail}>`,
          to: [test_email],
          subject,
          html,
          reply_to: rTo,
        }),
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Resend: ${err}`);
      }
      return new Response(
        JSON.stringify({ success: true, test: true, sent_to: test_email }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (!campaign_id) throw new Error("campaign_id é obrigatório");

    // MULTI-TENANT: carrega campanha do tenant atual (defesa em profundidade)
    const { data: campaign, error: campaignErr } = await supabase
      .from("email_campaigns")
      .select("*")
      .eq("id", campaign_id)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (campaignErr || !campaign) throw new Error("Campanha não encontrada");

    // Lê config Resend do tenant
    const emailConfigData = await getTenantConfig(supabase, tenantId);
    const config = requireActiveConfig(emailConfigData, tenantId);

    const fromEmail = (campaign.from_email || config.from_email || "").trim();
    const fromName = (campaign.from_name || config.from_name || "").trim() || "CRM";
    const replyTo = campaign.reply_to || config.reply_to || undefined;
    const appUrl = (config.app_url || "").replace(/\/?$/, "");
    if (!appUrl) throw new Error("app_url não configurado. Configure a URL do frontend em Configurações > Integrações > Email antes de disparar campanhas.");

    // === MODO TESTE com campaign_id ===
    if (test_email) {
      const variables: Record<string, string> = {
        nome: "Teste",
        primeiro_nome: "Teste",
        empresa: config.company_name || "Empresa",
        email: test_email,
        telefone: "(11) 99999-9999",
        cidade: "São Paulo",
        estado: "SP",
        vendedor: "Vendedor de Teste",
        produto: "Produto de Teste",
        unsubscribe_url: `${appUrl}/unsubscribe?token=teste`,
      };
      const baseHtml = body.html || `<p>${campaign.subject}</p>`;
      const html = substituteVariables(baseHtml, variables);
      const subject = `[TESTE] ${substituteVariables(campaign.subject, variables)}`;
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${config.resend_api_key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: `${fromName} <${fromEmail}>`,
          to: [test_email],
          subject,
          html,
          reply_to: replyTo,
        }),
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Resend: ${err}`);
      }
      return new Response(
        JSON.stringify({ success: true, test: true, sent_to: test_email }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (campaign.status === "completed" || campaign.status === "cancelled") {
      return new Response(
        JSON.stringify({ error: `Campanha já está ${campaign.status}` }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    await supabase
      .from("email_campaigns")
      .update({ status: "sending", updated_at: new Date().toISOString() })
      .eq("id", campaign_id)
      .eq("tenant_id", tenantId);

    // Resolve audience
    const campaignAudience = (campaign as any).settings?.audience as AudienceCriteria | undefined;
    let audience: Recipient[] = [];
    if (audience_override) {
      audience = await resolveAudienceByCriteria(supabase, tenantId, audience_override);
    } else if (campaignAudience) {
      audience = await resolveAudienceByCriteria(supabase, tenantId, campaignAudience);
    } else if ((campaign as any).list_id) {
      audience = await resolveAudienceFromList(supabase, tenantId, (campaign as any).list_id);
    } else {
      // Fallback: usa email_campaign_leads (populado por populate_email_campaign_leads)
      const { data: ecls } = await supabase
        .from("email_campaign_leads")
        .select("lead_id, email")
        .eq("tenant_id", tenantId)
        .eq("campaign_id", campaign_id)
        .eq("status", "pending");

      // Recipients com lead_id → resolve metadata completa (nome, telefone, etc)
      const leadIds = (ecls || []).map((r: any) => r.lead_id).filter(Boolean);
      if (leadIds.length) {
        audience = await resolveAudienceByCriteria(supabase, tenantId, { lead_ids: leadIds });
      }

      // MODO LISTA IMPORTADA: recipients SEM lead_id (uploaded_emails)
      // Cria recipients "fake" só com email — variáveis tipo @nome ficam vazias.
      const uploaded = (ecls || []).filter((r: any) => !r.lead_id);
      for (const u of uploaded) {
        audience.push({
          lead_id: null,
          email: u.email,
          name: null,
          first_name: null,
          phone: null,
          city: null,
          state: null,
          sales_rep_name: null,
        } as any);
      }
    }

    if (audience.length === 0) {
      await supabase
        .from("email_campaigns")
        .update({ status: "cancelled", updated_at: new Date().toISOString() })
        .eq("id", campaign_id)
        .eq("tenant_id", tenantId);
      throw new Error("Nenhum destinatário encontrado");
    }

    await supabase
      .from("email_campaigns")
      .update({ total_leads: audience.length })
      .eq("id", campaign_id)
      .eq("tenant_id", tenantId);

    const from = `${fromName} <${fromEmail}>`;
    let sent = 0;
    let failed = 0;

    const bgTask = (async () => {
      for (const recipient of audience) {
        try {
          const token = await getOrCreateUnsubscribeToken(supabase, tenantId!, recipient.email, recipient.lead_id);
          if (!token) {
            console.log(`Skip ${recipient.email} (unsubscribed/complained)`);
            continue;
          }

          const unsubscribeUrl = `${appUrl}/unsubscribe?token=${token}`;
          const variables: Record<string, string> = {
            nome: recipient.name || "",
            primeiro_nome: recipient.first_name || "",
            email: recipient.email,
            empresa: config.company_name || "",
            telefone: recipient.phone || "",
            cidade: recipient.city || "",
            estado: recipient.state || "",
            vendedor: recipient.sales_rep_name || "",
            produto: "",
            unsubscribe_url: unsubscribeUrl,
            link_descadastro: unsubscribeUrl,
          };

          const baseHtml = body.html || (campaign as any).html_content || `<p>${campaign.subject}</p>`;
          let html = substituteVariables(baseHtml, variables);
          html = injectComplianceFooter(html, unsubscribeUrl, config);
          const subject = substituteVariables(campaign.subject, variables);

          // MULTI-TENANT: insert email_sends precisa de tenant_id explícito
          const { data: sendRow } = await supabase
            .from("email_sends")
            .insert({
              tenant_id: tenantId,
              campaign_id,
              lead_id: recipient.lead_id,
              email: recipient.email,
              status: "pending",
              html,
            })
            .select("id")
            .single();

          const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${config.resend_api_key}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from,
              to: [recipient.email],
              subject,
              html,
              reply_to: replyTo,
              headers: {
                "X-Campaign-ID": campaign_id,
                "X-Send-ID": sendRow?.id || "",
                "X-Tenant-ID": tenantId,
                "List-Unsubscribe": `<${unsubscribeUrl}>`,
                "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
              },
              // MULTI-TENANT: tags servem como pista p/ process-email-event (Resend webhook)
              tags: [
                { name: "tenant_id", value: tenantId },
                { name: "campaign_id", value: campaign_id },
                { name: "send_id", value: sendRow?.id || "" },
              ],
            }),
          });

          if (res.ok) {
            const data = await res.json();
            const nowIso = new Date().toISOString();
            await supabase
              .from("email_sends")
              .update({
                status: "sent",
                sent_at: nowIso,
                resend_id: data.id,
              })
              .eq("id", sendRow!.id)
              .eq("tenant_id", tenantId);
            await supabase
              .from("email_campaign_leads")
              .update({
                status: "sent",
                sent_at: nowIso,
                resend_id: data.id,
              })
              .eq("campaign_id", campaign_id)
              .eq("tenant_id", tenantId)
              .eq("email", recipient.email);
            sent++;
          } else {
            const errText = await res.text();
            await supabase
              .from("email_sends")
              .update({
                status: "failed",
                error_message: errText.slice(0, 500),
              })
              .eq("id", sendRow!.id)
              .eq("tenant_id", tenantId);
            await supabase
              .from("email_campaign_leads")
              .update({
                status: "failed",
                error_message: errText.slice(0, 500),
              })
              .eq("campaign_id", campaign_id)
              .eq("tenant_id", tenantId)
              .eq("email", recipient.email);
            failed++;
          }
        } catch (err) {
          console.error(`Erro enviando pra ${recipient.email}:`, err);
          failed++;
        }

        await new Promise((r) => setTimeout(r, 100));
      }

      await supabase
        .from("email_campaigns")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
          sent_count: sent,
          failed_count: failed,
          updated_at: new Date().toISOString(),
        })
        .eq("id", campaign_id)
        .eq("tenant_id", tenantId);

      console.log(`Campaign ${campaign_id} done: ${sent} sent, ${failed} failed`);
    })();

    // @ts-ignore EdgeRuntime global
    if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(bgTask);

    return new Response(
      JSON.stringify({
        success: true,
        message: "Campanha em envio",
        recipients: audience.length,
      }),
      { status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
