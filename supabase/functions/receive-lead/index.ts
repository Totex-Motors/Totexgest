import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-api-key",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

// deno-lint-ignore no-explicit-any
type RawPayload = Record<string, any>;

/** Extrai ad_id Meta de um payload (raw explícito, utm_content ou utm_term numérico) */
function extractMetaAdId(raw: RawPayload, utmContent?: string | null, utmTerm?: string | null): string | null {
  const explicit = raw.ad_id || raw.meta_ad_id || raw.fb_ad_id;
  if (explicit && /^\d{10,20}$/.test(String(explicit))) return String(explicit);
  if (utmContent && /^\d{10,20}$/.test(utmContent.trim())) return utmContent.trim();
  if (utmTerm && /^\d{10,20}$/.test(utmTerm.trim())) return utmTerm.trim();
  return null;
}

/** Dispara fetch-meta-creative async (não bloqueia receive-lead) */
function triggerCreativeFetch(tenantId: string, adId: string) {
  fetch(`${SUPABASE_URL}/functions/v1/fetch-meta-creative`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenant_id: tenantId, ad_id: adId }),
  }).catch((e) => console.warn("[receive-lead] creative fetch failed:", e?.message));
}

/** Extrai UTMs de um objeto de conversão do RD Station */
function extractConversionUtms(convObj: RawPayload | null) {
  if (!convObj) return { source: null, utm_source: null, utm_medium: null, utm_campaign: null, utm_content: null, utm_term: null };
  const conv = convObj.content || {};
  const payload = conv.__cdp__original_event?.payload || {};
  return {
    source: conv.conversion_identifier || convObj.source || null,
    utm_source: conv.traffic_source || conv["UTM Source(BL)"] || payload.cf_utm_source_bl || null,
    utm_medium: conv.traffic_medium || conv["UTM Medium(BL)"] || payload.cf_utm_medium_bl || null,
    utm_campaign: conv.traffic_campaign || conv["UTM Campaign(BL)"] || payload.cf_utm_campaign_bl || null,
    utm_content: conv["UTM Content(BL)"] || payload.cf_utm_content_bl || null,
    utm_term: conv["UTM Term(BL)"] || payload.cf_utm_term_bl || null,
  };
}

/** Extrai dados uteis do payload do RD Station */
function parseRDStation(raw: RawPayload) {
  const lead = raw.leads?.[0];
  if (!lead) return null;

  // Extrair UTMs de ambas as conversões
  const firstUtms = extractConversionUtms(lead.first_conversion);
  const lastUtms = extractConversionUtms(lead.last_conversion);
  // Se só tem first_conversion (lead novo), last = first
  const hasLastConversion = !!lead.last_conversion;

  const conv = lead.first_conversion?.content || {};
  const payload = conv.__cdp__original_event?.payload || {};
  // Para campos de enriquecimento, usar last_conversion se disponível (dados mais recentes)
  const lastConv = lead.last_conversion?.content || conv;
  const lastPayload = lastConv.__cdp__original_event?.payload || payload;

  return {
    name: lead.name || null,
    email: lead.email || null,
    phone: lead.personal_phone || lead.mobile_phone || conv.Telefone || payload.personal_phone || null,
    city: lead.city || lastPayload.city || payload.city || null,
    state: lead.state || lastPayload.state || payload.state || null,
    website: lead.website || null,
    tags: lead.tags || [],
    capital_disponivel: lastConv["Capital Disponível (BL)"] || lastPayload.cf_capital_disponivel_bl || conv["Capital Disponível (BL)"] || payload.cf_capital_disponivel_bl || null,
    ocupacao: lastConv["Qual sua ocupação atual?(BL)"] || conv["Qual sua ocupação atual?(BL)"] || payload.cf_qual_sua_ocupacao_atual_bl || null,
    melhor_horario: lastConv["Melhor horário para contato(BL)"] || conv["Melhor horário para contato(BL)"] || payload.cf_melhor_horario_para_contato_bl || null,
    // UTMs da última conversão (campos normais do lead)
    source: hasLastConversion ? lastUtms.source : firstUtms.source,
    utm_source: hasLastConversion ? lastUtms.utm_source : firstUtms.utm_source,
    utm_medium: hasLastConversion ? lastUtms.utm_medium : firstUtms.utm_medium,
    utm_campaign: hasLastConversion ? lastUtms.utm_campaign : firstUtms.utm_campaign,
    utm_content: hasLastConversion ? lastUtms.utm_content : firstUtms.utm_content,
    utm_term: hasLastConversion ? lastUtms.utm_term : firstUtms.utm_term,
    // UTMs da primeira conversão (campos original_*)
    original_source: firstUtms.source,
    original_utm_source: firstUtms.utm_source,
    original_utm_medium: firstUtms.utm_medium,
    original_utm_campaign: firstUtms.utm_campaign,
    original_utm_content: firstUtms.utm_content,
    original_utm_term: firstUtms.utm_term,
    rd_lead_id: lead.id || null,
    rd_uuid: lead.uuid || null,
    rd_created_at: lead.created_at || null,
    rd_lead_stage: lead.lead_stage || null,
    rd_fit_score: lead.fit_score || null,
  };
}

/** Extrai dados de um payload generico (API direta, Elementor, etc) */
function parseGeneric(raw: RawPayload) {
  return {
    name: raw.name || raw.nome || raw['Nome'] || null,
    email: raw.email || raw['E-mail'] || raw['e-mail'] || null,
    phone: raw.phone || raw.telefone || raw.personal_phone || raw['Telefone WhatsApp'] || raw['Telefone'] || raw['telefone_whatsapp'] || null,
    company_name: raw.company_name || raw.empresa || raw.company || raw['Nome da Empresa'] || raw['nome_empresa'] || raw['nome_da_empresa'] || null,
    city: raw.city || raw.cidade || raw['Cidade'] || null,
    state: raw.state || raw.estado || raw['UF'] || raw['uf'] || null,
    capital_disponivel: raw.capital_disponivel || raw.capital || raw['Capital disponível'] || raw['Capital disponivel'] || null,
    ocupacao: raw.ocupacao || raw['Ocupação'] || raw['ocupacao'] || null,
    melhor_horario: raw.melhor_horario || raw['Melhor horário'] || raw['Horário'] || null,
    // B2B custom fields (mapeados pra deals.metadata.custom_fields)
    qtde_vagas: raw.qtde_vagas || raw.quantidade_vagas || raw['Quantidade de vagas'] || raw['qtde_de_vagas'] || raw['Qtde de Vagas'] || null,
    segmento: raw.segmento || raw['Segmento'] || raw['Segmento da empresa'] || raw['segmento_empresa'] || null,
    source: raw.source || raw.form_name || null,
    utm_source: raw.utm_source || null,
    utm_medium: raw.utm_medium || null,
    utm_campaign: raw.utm_campaign || null,
    utm_content: raw.utm_content || null,
    utm_term: raw.utm_term || null,
  };
}

/** Normaliza capital_disponivel pra valor numerico pra comparação */
function capitalToNumber(capital: string | null): number {
  if (!capital) return 0;
  const lower = capital.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (lower.includes('400') || lower.includes('400mil')) return 400000;
  if (lower.includes('300') || lower.includes('300mil')) return 300000;
  if (lower.includes('200') || lower.includes('200mil')) return 200000;
  if (lower.includes('100') || lower.includes('100mil')) return 100000;
  // Try to extract raw number
  const digits = capital.replace(/[^0-9]/g, '');
  if (digits.length >= 5) return parseInt(digits, 10);
  return 0;
}

/** Normaliza estado brasileiro: nome completo → sigla (UF) */
const STATE_MAP: Record<string, string> = {
  'acre': 'AC', 'alagoas': 'AL', 'amapa': 'AP', 'amazonas': 'AM',
  'bahia': 'BA', 'ceara': 'CE', 'distrito federal': 'DF', 'espirito santo': 'ES',
  'goias': 'GO', 'maranhao': 'MA', 'mato grosso': 'MT', 'mato grosso do sul': 'MS',
  'minas gerais': 'MG', 'para': 'PA', 'paraiba': 'PB', 'parana': 'PR',
  'pernambuco': 'PE', 'piaui': 'PI', 'rio de janeiro': 'RJ', 'rio grande do norte': 'RN',
  'rio grande do sul': 'RS', 'rondonia': 'RO', 'roraima': 'RR', 'santa catarina': 'SC',
  'sao paulo': 'SP', 'sergipe': 'SE', 'tocantins': 'TO',
  // com acentos
  'amapá': 'AP', 'ceará': 'CE', 'espírito santo': 'ES', 'goiás': 'GO',
  'maranhão': 'MA', 'paraná': 'PR', 'paraíba': 'PB', 'piauí': 'PI',
  'rondônia': 'RO', 'são paulo': 'SP',
};

function normalizeState(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length <= 2) return trimmed.toUpperCase();
  const lookup = STATE_MAP[trimmed.toLowerCase()];
  return lookup || trimmed; // se nao achar no mapa, retorna original
}

function jsonResponse(
  data: Record<string, unknown>,
  status = 200
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method === "GET") {
    return jsonResponse({ status: "ok", message: "receive-lead is active" });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // Validate API key first (fast check)
  const url = new URL(req.url);
  const apiKey = req.headers.get("x-api-key") || url.searchParams.get("key");
  if (!apiKey) {
    return jsonResponse({ error: "Missing API key (header X-API-Key or ?key=)" }, 401);
  }

  // Read body before responding (must be done before response is sent)
  const contentType = req.headers.get("content-type") || "";
  let rawText: string;
  try {
    rawText = await req.text();
  } catch {
    return jsonResponse({ error: "Could not read request body" }, 400);
  }

  // Processa o lead SÍNCRONO: garante que ack 200 só vai depois do INSERT do lead.
  // Antes era fire-and-forget — perdíamos leads silenciosamente quando o EdgeRuntime
  // matava o processo de background (incidente jun/2026: 21 leads Meta perdidos em
  // 5 tenants). Best practice: don't ACK what you haven't done.
  // Latência típica: 1-4s. Todos os clientes (Meta 20s, Elementor 30s, RD 30s) aguentam.
  type ProcessResult =
    | { success: true; lead_id: string; deal_id?: string | null; assigned_to?: { id: string; name: string } | null; reconverted?: boolean }
    | { success: false; status: number; error: string };

  const processLead = async (): Promise<ProcessResult> => {
  try {
    const startMs = Date.now();
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: distConfig, error: configError } = await supabase
      .from("lead_distribution_config")
      .select("*")
      .eq("api_key", apiKey)
      .eq("is_active", true)
      .maybeSingle();

    // Check if API key belongs to a franchise campaign
    let franchiseCampaign: RawPayload | null = null;
    if (!distConfig) {
      const { data: fc } = await supabase
        .from("franchise_campaigns")
        .select("*")
        .eq("api_key", apiKey)
        .eq("is_active", true)
        .maybeSingle();
      franchiseCampaign = fc;
    }

    if (configError || (!distConfig && !franchiseCampaign)) {
      console.error("[receive-lead] Invalid or inactive API key");
      return { success: false, status: 401, error: "Invalid or inactive API key" };
    }

    // Resolve config: ALWAYS find the best active distribution config with members
    // The API key validates the tenant, but we use the tenant's active config (not the key's config)
    // This way, changes in the frontend Distribution settings are respected automatically
    const tenantId = distConfig?.tenant_id || franchiseCampaign?.tenant_id;

    async function findBestConfig(tid: string): Promise<RawPayload | null> {
      const { data: activeConfigs } = await supabase
        .from("lead_distribution_config")
        .select("*")
        .eq("tenant_id", tid)
        .eq("is_active", true)
        .order("created_at", { ascending: true });

      if (!activeConfigs) return null;

      for (const candidate of activeConfigs) {
        const { count } = await supabase
          .from("lead_distribution_members")
          .select("id", { count: "exact", head: true })
          .eq("config_id", candidate.id)
          .eq("is_active", true);
        if (count && count > 0) {
          return candidate;
        }
      }
      return null;
    }

    let config: RawPayload;

    if (distConfig) {
      // Key belongs to a distribution config — check if it has active members
      const { count: keyConfigMembers } = await supabase
        .from("lead_distribution_members")
        .select("id", { count: "exact", head: true })
        .eq("config_id", distConfig.id)
        .eq("is_active", true);

      if (keyConfigMembers && keyConfigMembers > 0) {
        // Key's config has active members — use it
        config = distConfig;
      } else {
        // Key's config has NO active members — fallback to tenant's best config
        console.log(`[receive-lead] Config ${distConfig.id} (${distConfig.name}) has 0 active members, finding fallback...`);
        const fallback = await findBestConfig(distConfig.tenant_id);
        if (!fallback) {
          console.error("[receive-lead] No distribution config with active members found");
          return { success: false, status: 422, error: "No distribution config with active members found" };
        }
        config = fallback;
        console.log(`[receive-lead] Fallback to config ${config.id} (${config.name})`);
      }
    } else {
      // Franchise campaign: find tenant's best active distribution config
      const resolved = await findBestConfig(franchiseCampaign!.tenant_id);
      if (!resolved) {
        console.error("[receive-lead] No distribution config with active members found (franchise)");
        return { success: false, status: 422, error: "No distribution config with active members found (franchise)" };
      }
      config = resolved;
      console.log("[receive-lead] Franchise campaign: using distribution config:", config.id);
    }

    // Fetch tenant sales config for SDR/Closer split
    let salesConfig: RawPayload | null = null;
    if (config.tenant_id) {
      const { data: sc } = await supabase
        .from("tenant_sales_config")
        .select("has_sdr_closer_split, sdr_pipeline_id, closer_pipeline_id")
        .eq("tenant_id", config.tenant_id)
        .maybeSingle();
      salesConfig = sc;
    }
    const hasSdrSplit = salesConfig?.has_sdr_closer_split === true && salesConfig?.sdr_pipeline_id;

    // 2. Parse body (JSON or form-urlencoded) — rawText and contentType already read above
    let raw: RawPayload;
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const params = new URLSearchParams(rawText);
      raw = Object.fromEntries(params.entries()) as RawPayload;
    } else {
      raw = JSON.parse(rawText);
    }
    const isRDStation = Array.isArray(raw.leads);
    const parsed = isRDStation ? parseRDStation(raw) : parseGeneric(raw);
    const origin = isRDStation ? "rdstation" : "api";

    if (!parsed) {
      console.error("[receive-lead] Could not parse payload");
      return { success: false, status: 400, error: "Could not parse payload" };
    }

    // BACKWARDS COMPATIBLE: Se o lead vem de um formulário específico que tem
    // distribution_config_id configurado, sobrescrever o config resolvido pela API key.
    // Se o form não tem distribution_config_id, mantém o config atual (não quebra nada).
    if (raw.form_id && typeof raw.form_id === 'string') {
      try {
        const { data: formRow } = await supabase
          .from('marketing_forms')
          .select('distribution_config_id, tenant_id')
          .eq('id', raw.form_id)
          .eq('tenant_id', config.tenant_id)
          .maybeSingle();

        if (formRow?.distribution_config_id) {
          const { data: formDistConfig } = await supabase
            .from('lead_distribution_config')
            .select('*')
            .eq('id', formRow.distribution_config_id)
            .eq('tenant_id', config.tenant_id)
            .eq('is_active', true)
            .maybeSingle();

          // Verificar se tem membros ativos antes de sobrescrever
          if (formDistConfig) {
            const { count: formConfigMembers } = await supabase
              .from('lead_distribution_members')
              .select('id', { count: 'exact', head: true })
              .eq('config_id', formDistConfig.id)
              .eq('is_active', true);

            if (formConfigMembers && formConfigMembers > 0) {
              console.log(`[receive-lead] Form ${raw.form_id} points to config ${formDistConfig.id} (${formDistConfig.name}), using it`);
              config = formDistConfig;
            }
          }
        }
      } catch (e) {
        console.warn('[receive-lead] Error resolving form distribution_config_id (non-fatal):', e);
      }
    }

    // Normalize phone: remove non-digits, ensure DDI 55 for BR numbers
    let phone: string | null = null;
    if (parsed.phone) {
      const raw_phone = String(parsed.phone).replace(/[^0-9]/g, "") || null;
      if (raw_phone) {
        // BR numbers: 10-11 digits without DDI. Add 55 prefix if missing.
        if (raw_phone.length === 10 || raw_phone.length === 11) {
          phone = "55" + raw_phone;
        } else if (raw_phone.length === 12 || raw_phone.length === 13) {
          // Already has DDI (55 + 10-11 digits)
          phone = raw_phone;
        } else {
          phone = raw_phone;
        }
      }
    }

    // 3. Build extra_data for lead_conversions
    const extraData: RawPayload = {};
    if ((parsed as RawPayload).capital_disponivel) extraData.capital_disponivel = (parsed as RawPayload).capital_disponivel;
    if ((parsed as RawPayload).ocupacao) extraData.ocupacao = (parsed as RawPayload).ocupacao;
    if ((parsed as RawPayload).melhor_horario) extraData.melhor_horario = (parsed as RawPayload).melhor_horario;
    if ((parsed as RawPayload).company_name) extraData.company_name = (parsed as RawPayload).company_name;
    if ((parsed as RawPayload).city) extraData.city = (parsed as RawPayload).city;
    if ((parsed as RawPayload).state) extraData.state = (parsed as RawPayload).state;
    if ((parsed as RawPayload).website) extraData.website = (parsed as RawPayload).website;
    if ((parsed as RawPayload).rd_lead_stage) extraData.rd_lead_stage = (parsed as RawPayload).rd_lead_stage;
    if ((parsed as RawPayload).rd_fit_score) extraData.rd_fit_score = (parsed as RawPayload).rd_fit_score;

    // 4. Check duplicate by phone (last 8 digits) OR email (case-insensitive)
    // Lead é único por pessoa: phone ou email já existente = reconversão (não duplica)
    let existingLead: any = null;
    if (phone) {
      const last8 = phone.replace(/[^0-9]/g, "").slice(-8);
      const { data: byPhone } = await supabase
        .rpc("find_lead_by_phone_suffix", { p_suffix: last8, p_tenant_id: tenantId });
      existingLead = byPhone?.[0] || null;
    }
    if (!existingLead && parsed.email) {
      const emailNorm = parsed.email.trim().toLowerCase();
      const { data: byEmail } = await supabase
        .from("leads")
        .select("*")
        .eq("tenant_id", tenantId)
        .ilike("email", emailNorm)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      existingLead = byEmail || null;
      if (existingLead) console.log("[receive-lead] Dedup matched by EMAIL:", emailNorm, "→ lead:", existingLead.id);
    }

    if (existingLead) {
        // ===== RECONVERSION =====
        console.log("[receive-lead] Reconversion for lead:", existingLead.id, existingLead.name);

        try {
        // Update lead UTMs + enrichment fields (last conversion = current UTMs)
        const updateFields: RawPayload = {};
        if (parsed.utm_source) updateFields.utm_source = parsed.utm_source;
        if (parsed.utm_campaign) updateFields.utm_campaign = parsed.utm_campaign;
        if (parsed.utm_medium) updateFields.utm_medium = parsed.utm_medium;
        if (parsed.utm_content) updateFields.utm_content = parsed.utm_content;
        if (parsed.source) updateFields.source = parsed.source;

        // Backfill original_* se o lead não tem (leads antigos migrados)
        // original_* = dados da primeira conversão, nunca sobrescritos
        if (!existingLead.original_source) {
          // Usa os UTMs atuais do lead (que são da primeira conversão) como original
          const origSource = (parsed as RawPayload).original_source || existingLead.source || parsed.source;
          const origUtmSource = (parsed as RawPayload).original_utm_source || existingLead.utm_source || null;
          const origUtmMedium = (parsed as RawPayload).original_utm_medium || existingLead.utm_medium || null;
          const origUtmCampaign = (parsed as RawPayload).original_utm_campaign || existingLead.utm_campaign || null;
          const origUtmContent = (parsed as RawPayload).original_utm_content || existingLead.utm_content || null;
          if (origSource) updateFields.original_source = origSource;
          if (origUtmSource) updateFields.original_utm_source = origUtmSource;
          if (origUtmMedium) updateFields.original_utm_medium = origUtmMedium;
          if (origUtmCampaign) updateFields.original_utm_campaign = origUtmCampaign;
          if (origUtmContent) updateFields.original_utm_content = origUtmContent;
          console.log("[receive-lead] Backfilling original_* for lead:", existingLead.id);
        }
        if (parsed.email && !existingLead.email) updateFields.email = parsed.email;
        if ((parsed as RawPayload).capital_disponivel) updateFields.capital_disponivel = (parsed as RawPayload).capital_disponivel;
        if ((parsed as RawPayload).ocupacao) updateFields.job_title = (parsed as RawPayload).ocupacao;
        if ((parsed as RawPayload).melhor_horario) updateFields.melhor_horario_contato = (parsed as RawPayload).melhor_horario;
        if ((parsed as RawPayload).city) updateFields.city_name = (parsed as RawPayload).city;
        if ((parsed as RawPayload).state) updateFields.state = normalizeState((parsed as RawPayload).state);

        if (Object.keys(updateFields).length > 0) {
          await supabase.from("leads").update(updateFields).eq("id", existingLead.id);
        }

        // Check for open deal and get sales rep
        let newDealId: string | null = null;
        let currentSalesRepId: string | null = existingLead.sales_rep_id || null;
        let currentSalesRepName = "";
        let currentDealId: string | null = null;
        let reconversionRedistributed = false;

        const { data: openDeals } = await supabase
          .from("deals")
          .select("id, sales_rep_id, sales_rep:team_members(id, name)")
          .eq("lead_id", existingLead.id)
          .not("status", "in", '("won","lost")')
          .order("created_at", { ascending: false })
          .limit(1);

        if (openDeals && openDeals.length > 0) {
          currentSalesRepId = openDeals[0].sales_rep_id || currentSalesRepId;
          const rep = openDeals[0].sales_rep as unknown as { name: string } | null;
          currentSalesRepName = rep?.name || "";
          currentDealId = openDeals[0].id;
        }

        // Check if current sales rep is active in THIS distribution config
        // If inactive in this config (OR if lead never had a rep — orphan lead), redistribute via round-robin
        const needsRedistribution = await (async () => {
          if (!currentSalesRepId) {
            // Lead órfão (criado fora do receive-lead, sem rep) — força distribuição
            console.log("[receive-lead] Reconversion: lead órfão sem sales_rep_id, distribuindo via round-robin");
            return true;
          }
          const { data: activeMembership } = await supabase
            .from("lead_distribution_members")
            .select("id")
            .eq("team_member_id", currentSalesRepId)
            .eq("config_id", config.id)
            .eq("is_active", true)
            .limit(1);
          if (!activeMembership || activeMembership.length === 0) {
            console.log("[receive-lead] Reconversion: sales rep", currentSalesRepId, "is inactive in distribution, redistributing via round-robin");
            return true;
          }
          return false;
        })();

        if (needsRedistribution) {
          const { data: newMemberId } = await supabase.rpc(
            "get_next_distribution_member",
            { p_config_id: config.id, p_require_availability: false, p_tenant_id: tenantId }
          );
          if (newMemberId) {
            const { data: newRep } = await supabase
              .from("team_members").select("id, name").eq("id", newMemberId).single();
            if (newRep) {
              currentSalesRepId = newRep.id;
              currentSalesRepName = newRep.name;
              reconversionRedistributed = true;
              // Update lead sales_rep_id
              await supabase.from("leads").update({ sales_rep_id: newRep.id }).eq("id", existingLead.id);
              // Update existing open deal if any
              if (currentDealId) {
                await supabase.from("deals").update({ sales_rep_id: newRep.id }).eq("id", currentDealId);
              }
              console.log("[receive-lead] Reconversion redistributed to:", newRep.name);
            }
          }
        }

        if (!currentDealId && config.auto_create_deal && config.pipeline_id) {
          // If SDR split is active, use SDR pipeline for new deals
          const effectivePipelineId = hasSdrSplit ? salesConfig!.sdr_pipeline_id : config.pipeline_id;
          let effectiveFirstStageId = config.first_stage_id;
          if (hasSdrSplit && salesConfig!.sdr_pipeline_id !== config.pipeline_id) {
            // Get first stage of SDR pipeline
            const { data: sdrStage } = await supabase
              .from("sales_pipeline_stages")
              .select("id")
              .eq("pipeline_id", salesConfig!.sdr_pipeline_id)
              .order("position", { ascending: true })
              .limit(1)
              .maybeSingle();
            if (sdrStage) effectiveFirstStageId = sdrStage.id;
          }
          const { data: newDeal } = await supabase
            .from("deals")
            .insert({
              tenant_id: tenantId,
              lead_id: existingLead.id,
              pipeline_id: effectivePipelineId,
              pipeline_stage_id: effectiveFirstStageId,
              product_id: config.product_id || null,
              sales_rep_id: currentSalesRepId,
              status: "negotiation",
            })
            .select("id")
            .single();
          newDealId = newDeal?.id || null;
        }

        // Get sales rep name if needed
        if (!currentSalesRepName && currentSalesRepId) {
          const { data: rep } = await supabase
            .from("team_members").select("name").eq("id", currentSalesRepId).single();
          currentSalesRepName = rep?.name || "";
        }

        const reconversionDealId = newDealId || currentDealId;

        // Insert lead_conversion record (reconversion)
        await supabase.from("lead_conversions").insert({
          tenant_id: tenantId,
          lead_id: existingLead.id,
          conversion_type: "reconversion",
          source: parsed.source || parsed.utm_source || origin,
          utm_source: parsed.utm_source,
          utm_medium: parsed.utm_medium,
          utm_campaign: parsed.utm_campaign,
          utm_content: parsed.utm_content,
          utm_term: parsed.utm_term,
          extra_data: extraData,
          sales_rep_id: currentSalesRepId,
          deal_id: reconversionDealId,
          origin,
          raw_payload: raw,
        });

        // Create task for sales rep (appears in focus mode)
        if (currentSalesRepId) {
          const sourceLabel = parsed.source || parsed.utm_source || origin;
          await supabase.from("company_activities").insert({
            tenant_id: tenantId,
            name: `Reconversao: ${existingLead.name} se cadastrou novamente via ${sourceLabel}`,
            description: `Lead ${existingLead.name} (${phone}) se cadastrou novamente via ${sourceLabel}.${parsed.utm_campaign ? ` Campanha: ${parsed.utm_campaign}.` : ""} Entrar em contato!`,
            team: "sales",
            lead_id: existingLead.id,
            task_type: "follow_up",
            priority: "high",
            scheduled_at: new Date().toISOString(),
            responsavel_id: currentSalesRepId,
            completed: false,
            metadata: { source: "focus_auto", is_auto_generated: true, reconversion: true },
          });
        }

        // Log distribution
        await supabase.from("lead_distribution_log").insert({
          tenant_id: tenantId,
          config_id: config.id,
          lead_id: existingLead.id,
          deal_id: reconversionDealId,
          team_member_id: currentSalesRepId,
          method_used: reconversionRedistributed ? "reconversion_redistributed" : "reconversion",
          source: origin,
          metadata: { format: origin, parsed, redistributed: reconversionRedistributed },
        });

        // Notify
        try {
          await supabase.functions.invoke("process-notification-event", {
            body: {
              event_type: "lead_created",
              tenant_id: tenantId,
              context: {
                tenant_id: tenantId,
                sales_rep_id: currentSalesRepId,
                lead_id: existingLead.id,
                cliente: existingLead.name,
                cliente_telefone: phone,
                cliente_email: parsed.email || "",
                lead_origem: parsed.source || parsed.utm_source || "reconversao",
                lead_context: `RECONVERSAO - ${existingLead.name} se cadastrou novamente via ${parsed.source || parsed.utm_source || origin}`,
                responsavel: currentSalesRepName,
              },
            },
          });
        } catch (_) { /* non-fatal */ }

        // Franchise routing for reconversions (same behavior as new leads)
        let franchiseReconvResult: RawPayload | null = null;
        if (franchiseCampaign) {
          try {
            const leadCapital = capitalToNumber((parsed as RawPayload).capital_disponivel);
            const minCapital = capitalToNumber(franchiseCampaign.min_capital_tier);
            const leadCity = (parsed as RawPayload).city?.trim() || null;

            if (leadCapital >= minCapital) {
              let franchisee: { id: string; name: string; phone: string } | null = null;
              const utmContent = parsed.utm_content || "";
              const utmMatch = utmContent.match(/Franquead[oa][_-](.+)/i);

              if (utmMatch) {
                const utmIdentifier = utmMatch[1].trim();
                console.log("[receive-lead] Reconversion franchise UTM match attempt:", utmIdentifier);
                const { data: utmMember } = await supabase
                  .from("franchise_members")
                  .select("id, name, phone")
                  .eq("campaign_id", franchiseCampaign.id)
                  .eq("is_active", true)
                  .eq("utm_identifier", utmIdentifier)
                  .maybeSingle();
                if (utmMember) {
                  franchisee = utmMember;
                  console.log("[receive-lead] Reconversion franchise UTM matched:", franchisee.name);
                } else {
                  console.log("[receive-lead] Reconversion franchise UTM no match for:", utmIdentifier, "- falling back to round-robin");
                }
              }

              if (!franchisee) {
                const { data: nextId } = await supabase.rpc("get_next_franchise_member", { p_campaign_id: franchiseCampaign.id, p_city: leadCity });
                if (nextId) {
                  const { data: rrMember } = await supabase.from("franchise_members").select("id, name, phone").eq("id", nextId).single();
                  franchisee = rrMember;
                }
              }

              if (franchisee) {
                await supabase.from("leads").update({
                  franchise_campaign_id: franchiseCampaign.id,
                  franchise_member_id: franchisee.id,
                  franchise_member_name: franchisee.name,
                  franchise_member_phone: franchisee.phone,
                }).eq("id", existingLead.id);

                await supabase.from("franchise_distribution_log").insert({
                  campaign_id: franchiseCampaign.id,
                  franchise_member_id: franchisee.id,
                  lead_id: existingLead.id,
                  tenant_id: franchiseCampaign.tenant_id,
                });

                let whatsappSent = false;
                if (franchiseCampaign.whatsapp_instance_id) {
                  const { data: instance } = await supabase
                    .from("whatsapp_instances")
                    .select("id, api_key, api_url")
                    .eq("id", franchiseCampaign.whatsapp_instance_id)
                    .eq("status", "connected")
                    .maybeSingle();

                  if (instance) {
                    const msg = (franchiseCampaign.message_template || "")
                      .replace("{{campaign_name}}", franchiseCampaign.name || "")
                      .replace("{{lead_name}}", existingLead.name)
                      .replace("{{lead_phone}}", phone || "Não informado")
                      .replace("{{lead_email}}", parsed.email || "Não informado")
                      .replace("{{lead_city}}", leadCity || "Não informada")
                      .replace("{{lead_state}}", normalizeState((parsed as RawPayload).state) || "")
                      .replace("{{lead_capital}}", (parsed as RawPayload).capital_disponivel || "Não informado")
                      .replace("{{lead_horario}}", (parsed as RawPayload).melhor_horario || "Não informado")
                      .replace("{{seller_name}}", currentSalesRepName || "");

                    const franchiseePhone = franchisee.phone.replace(/[^0-9]/g, "");
                    try {
                      const resp = await fetch(`${instance.api_url}/send/text`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json", "Accept": "application/json", "token": instance.api_key },
                        body: JSON.stringify({ number: franchiseePhone, text: msg }),
                      });
                      whatsappSent = resp.ok;
                      if (!resp.ok) console.error("[receive-lead] Reconversion franchise WhatsApp error:", await resp.text());
                    } catch (wppErr) {
                      console.error("[receive-lead] Reconversion franchise WhatsApp fetch error:", wppErr);
                    }
                  }
                }

                await supabase.from("franchise_distribution_log")
                  .update({ whatsapp_sent: whatsappSent })
                  .eq("lead_id", existingLead.id)
                  .eq("franchise_member_id", franchisee.id);

                await supabase.from("company_activities").insert({
                  tenant_id: tenantId,
                  name: `Reconversão → Franqueado: ${franchisee.name}`,
                  description: `Lead ${existingLead.name} (reconversão) distribuído para franqueado ${franchisee.name} (${franchisee.phone}) via campanha "${franchiseCampaign.name}". WhatsApp ${whatsappSent ? "enviado" : "não enviado"}.`,
                  team: "sales",
                  lead_id: existingLead.id,
                  task_type: "note",
                  priority: "medium",
                  scheduled_at: new Date().toISOString(),
                  completed: true,
                  metadata: {
                    source: "franchise_distribution",
                    reconversion: true,
                    franchise_campaign_id: franchiseCampaign.id,
                    franchise_member_id: franchisee.id,
                    franchise_member_name: franchisee.name,
                    whatsapp_sent: whatsappSent,
                  },
                }).then(() => {}).catch(() => {});

                franchiseReconvResult = { franchisee_name: franchisee.name, franchisee_phone: franchisee.phone, whatsapp_sent: whatsappSent };
                console.log("[receive-lead] Reconversion franchise routed to:", franchisee.name, "via:", utmMatch ? "UTM" : "round-robin", "WhatsApp sent:", whatsappSent);
              } else {
                console.log("[receive-lead] Reconversion franchise: no active member found");
              }
            } else {
              console.log("[receive-lead] Reconversion franchise: capital", leadCapital, "below minimum", minCapital);
            }
          } catch (franchiseErr) {
            console.error("[receive-lead] Reconversion franchise error:", franchiseErr);
          }
        }

        // Log to receive_lead_logs (audit)
        await supabase.from("receive_lead_logs").insert({
          tenant_id: tenantId,
          api_key: apiKey,
          config_id: config.id,
          origin,
          lead_name: existingLead.name,
          lead_email: parsed.email || null,
          lead_phone: phone,
          lead_source: parsed.source || parsed.utm_source || null,
          status: "success",
          lead_id: existingLead.id,
          deal_id: reconversionDealId,
          assigned_to: currentSalesRepId,
          assigned_to_name: currentSalesRepName || null,
          dedup_match: phone ? "phone" : null,
          existing_lead_id: existingLead.id,
          raw_payload: raw,
          processing_ms: Date.now() - startMs,
        }).then(() => {}).catch(() => {});

        console.log("[receive-lead] Reconversion done:", { lead_id: existingLead.id, new_deal_id: newDealId, ms: Date.now() - startMs });
        return {
          success: true,
          lead_id: existingLead.id,
          deal_id: reconversionDealId,
          assigned_to: currentSalesRepId ? { id: currentSalesRepId, name: currentSalesRepName || "" } : null,
          reconverted: true,
        };

        } catch (reconversionError: any) {
          // Log error to distribution audit so it's visible
          console.error("[receive-lead] Reconversion error for lead:", existingLead.id, reconversionError.message);
          await supabase.from("lead_distribution_log").insert({
            tenant_id: tenantId,
            config_id: config.id,
            lead_id: existingLead.id,
            team_member_id: existingLead.sales_rep_id,
            method_used: "reconversion_error",
            source: origin,
            metadata: { error: reconversionError.message, format: origin, parsed },
          }).then(() => {}).catch(() => {});

          await supabase.from("receive_lead_logs").insert({
            tenant_id: tenantId,
            api_key: apiKey,
            config_id: config.id,
            origin,
            lead_name: existingLead.name,
            lead_email: parsed.email || null,
            lead_phone: phone,
            lead_source: parsed.source || parsed.utm_source || null,
            status: "error",
            error_message: `Reconversion error: ${reconversionError.message}`,
            lead_id: existingLead.id,
            existing_lead_id: existingLead.id,
            raw_payload: raw,
            processing_ms: Date.now() - startMs,
          }).then(() => {}).catch(() => {});

          console.error("[receive-lead] Reconversion failed:", reconversionError.message);
          return { success: false, status: 500, error: `Reconversion error: ${reconversionError.message}` };
        }
    }

    // ===== NEW LEAD =====
    // 5. Get next member via round-robin
    // Resolve which distribution config to use based on mode
    let distributionConfigId = config.id;
    let distributionRequireAvailability = config.require_availability;
    if (hasSdrSplit) {
      // SDR/Closer mode: use SDR distribution config
      const { data: sdrConfig } = await supabase
        .from("lead_distribution_config")
        .select("id, require_availability")
        .eq("tenant_id", config.tenant_id)
        .eq("pipeline_id", salesConfig!.sdr_pipeline_id)
        .eq("is_active", true)
        .maybeSingle();
      if (sdrConfig) {
        distributionConfigId = sdrConfig.id;
        distributionRequireAvailability = sdrConfig.require_availability;
        console.log("[receive-lead] SDR split active, using SDR distribution config:", sdrConfig.id);
      }
    } else {
      // Direto mode: respeita config já resolvida (api_key + form override) se tem membros ativos.
      // Só busca alternativa se config atual está vazia (caso api_key apontar pra config sem membros).
      const { count: currentConfigMembers } = await supabase
        .from("lead_distribution_members")
        .select("id", { count: "exact", head: true })
        .eq("config_id", config.id)
        .eq("is_active", true);

      if (!(currentConfigMembers && currentConfigMembers > 0)) {
        // Config resolvida está vazia — busca primeira config do tenant com membros
        const { data: activeConfigs } = await supabase
          .from("lead_distribution_config")
          .select("id, require_availability, auto_create_deal, pipeline_id, first_stage_id, product_id")
          .eq("tenant_id", config.tenant_id)
          .eq("is_active", true)
          .order("created_at", { ascending: true });

        if (activeConfigs && activeConfigs.length > 0) {
          for (const candidate of activeConfigs) {
            const { count } = await supabase
              .from("lead_distribution_members")
              .select("id", { count: "exact", head: true })
              .eq("config_id", candidate.id)
              .eq("is_active", true);
            if (count && count > 0) {
              distributionConfigId = candidate.id;
              distributionRequireAvailability = candidate.require_availability;
              if (candidate.id !== config.id) {
                config.auto_create_deal = candidate.auto_create_deal;
                config.pipeline_id = candidate.pipeline_id;
                config.first_stage_id = candidate.first_stage_id;
                config.product_id = candidate.product_id;
                console.log("[receive-lead] Direto mode: original config sem membros, fallback para:", candidate.id);
              }
              break;
            }
          }
        }
      }
    }

    const { data: nextMemberId, error: rrError } = await supabase.rpc(
      "get_next_distribution_member",
      {
        p_config_id: distributionConfigId,
        p_require_availability: distributionRequireAvailability,
        p_tenant_id: tenantId,
      }
    );

    if (rrError || !nextMemberId) {
      console.error("[receive-lead] No available sales rep for distribution");
      return { success: false, status: 422, error: "No available sales rep for distribution" };
    }

    const { data: memberData } = await supabase
      .from("team_members")
      .select("id, name, phone, whatsapp_instance_id")
      .eq("id", nextMemberId)
      .single();

    // 6. Insert lead — fallback inteligente quando o webhook não envia nome
    function buildFallbackName(): string {
      if (parsed.name && parsed.name.trim()) return parsed.name.trim();
      if (parsed.email) return parsed.email.split("@")[0];
      if (phone) {
        const digits = phone.replace(/\D/g, "");
        const last8 = digits.slice(-8);
        return last8 ? `Lead ${last8.slice(0, 4)}-${last8.slice(4)}` : "Lead sem nome";
      }
      return "Lead sem nome";
    }
    const leadName = buildFallbackName();
    const { data: newLead, error: leadError } = await supabase
      .from("leads")
      .insert({
        tenant_id: tenantId,
        name: leadName,
        phone: phone || null,
        email: parsed.email || null,
        sales_stage: "new",
        sales_rep_id: nextMemberId,
        source: parsed.source || parsed.utm_source || "api",
        utm_source: parsed.utm_source || null,
        utm_campaign: parsed.utm_campaign || null,
        utm_content: parsed.utm_content || null,
        utm_medium: parsed.utm_medium || null,
        utm_term: parsed.utm_term || null,
        original_source: (parsed as RawPayload).original_source || parsed.source || parsed.utm_source || "api",
        original_utm_source: (parsed as RawPayload).original_utm_source || parsed.utm_source || null,
        original_utm_campaign: (parsed as RawPayload).original_utm_campaign || parsed.utm_campaign || null,
        original_utm_content: (parsed as RawPayload).original_utm_content || parsed.utm_content || null,
        original_utm_medium: (parsed as RawPayload).original_utm_medium || parsed.utm_medium || null,
        original_utm_term: (parsed as RawPayload).original_utm_term || parsed.utm_term || null,
        capital_disponivel: (parsed as RawPayload).capital_disponivel || null,
        job_title: (parsed as RawPayload).ocupacao || null,
        melhor_horario_contato: (parsed as RawPayload).melhor_horario || null,
        city_name: (parsed as RawPayload).city || null,
        state: normalizeState((parsed as RawPayload).state) || null,
        metadata: {
          source: "receive-lead",
          origin,
          ...(raw.form_id ? { form_id: raw.form_id, form_name: raw.form_name } : {}),
          ...(raw.gclid ? { gclid: raw.gclid } : {}),
          ...(raw.fbclid ? { fbclid: raw.fbclid } : {}),
          ...(raw.ttclid ? { ttclid: raw.ttclid } : {}),
          ...(raw.msclkid ? { msclkid: raw.msclkid } : {}),
          ...(raw.landing_page ? { landing_page: raw.landing_page } : {}),
          ...(raw.referrer ? { referrer: raw.referrer } : {}),
          ...(extractMetaAdId(raw, parsed.utm_content, parsed.utm_term) ? { ad_source: { provider: "meta", ad_id: extractMetaAdId(raw, parsed.utm_content, parsed.utm_term) } } : {}),
        },
      })
      .select("id")
      .single();

    if (leadError || !newLead) {
      // Log error to receive_lead_logs
      await supabase.from("receive_lead_logs").insert({
        tenant_id: tenantId,
        api_key: apiKey,
        config_id: distributionConfigId,
        origin,
        lead_name: leadName,
        lead_email: parsed.email || null,
        lead_phone: phone,
        lead_source: parsed.source || parsed.utm_source || null,
        status: "error",
        assigned_to: nextMemberId,
        assigned_to_name: memberData?.name || null,
        error_message: "Failed to create lead: " + leadError?.message,
        error_details: leadError ? { code: leadError.code, details: leadError.details, parsed } : null,
        raw_payload: raw,
        processing_ms: Date.now() - startMs,
      }).then(() => {}).catch(() => {});
      console.error("[receive-lead] Failed to create lead:", leadError?.message);
      return { success: false, status: 500, error: `Failed to create lead: ${leadError?.message || "unknown"}` };
    }

    // Dispara fetch do criativo Meta se tiver ad_id (async, não bloqueia)
    const metaAdId = extractMetaAdId(raw, parsed.utm_content, parsed.utm_term);
    if (metaAdId) triggerCreativeFetch(tenantId, metaAdId);

    // 7. Create deal if configured
    let dealId: string | null = null;
    // Declarado FORA do if pra que linhas 1118-1119 (notification context) consigam usar
    // mesmo quando auto_create_deal=false. Bug fix: ReferenceError silenciava notification.
    const effectivePipelineId = hasSdrSplit ? salesConfig!.sdr_pipeline_id : config.pipeline_id;
    if (config.auto_create_deal && config.pipeline_id) {
      // If SDR split is active, use SDR pipeline
      let effectiveFirstStageId = config.first_stage_id;
      if (hasSdrSplit && salesConfig!.sdr_pipeline_id !== config.pipeline_id) {
        const { data: sdrStage } = await supabase
          .from("sales_pipeline_stages")
          .select("id")
          .eq("pipeline_id", salesConfig!.sdr_pipeline_id)
          .order("position", { ascending: true })
          .limit(1)
          .maybeSingle();
        if (sdrStage) effectiveFirstStageId = sdrStage.id;
      }
      // Fetch product price if product is set
      let productPrice: number | null = null;
      if (config.product_id) {
        const { data: prod } = await supabase
          .from("products")
          .select("price")
          .eq("id", config.product_id)
          .maybeSingle();
        if (prod?.price) productPrice = Number(prod.price);
      }

      // Mapeia custom_fields do pipeline (auto-match por nome — funciona pra qualquer tenant)
      const customFieldsMap: Record<string, any> = {};
      // valores pra gravar em pipeline_custom_field_values (a tabela que o front lê) — { field_id, value }
      const customFieldValues: Array<{ field_id: string; value: string }> = [];
      try {
        const { data: pipeFields } = await supabase
          .from("pipeline_custom_fields")
          .select("id, name")
          .eq("pipeline_id", effectivePipelineId)
          .eq("is_active", true);
        if (pipeFields && pipeFields.length > 0) {
          const norm = (s: string) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
          const rp = parsed as RawPayload;
          const rw = raw as any; // payload bruto: tem campos que o parser não mapeia
          // Aliases payload → nome do campo do pipeline (normalizado). Lê de raw com fallback pro parsed.
          const aliases: Array<{ keys: string[]; value: any }> = [
            { keys: ["qtdedevagas", "quantidadedevagas", "qtdvagas", "qtdevagas"], value: rw.qtde_vagas ?? rp.qtde_vagas },
            { keys: ["nomedaempresa", "nomeempresa", "empresa", "company"], value: rw.company_name ?? rp.company_name },
            { keys: ["segmento", "segmentodaempresa", "segmentoempresa"], value: rw.segmento ?? rp.segmento },
            { keys: ["capitaldisponivel", "capital"], value: rw.capital_disponivel ?? rp.capital_disponivel },
            { keys: ["quandopretendeassumir", "quandoassumir", "quandopretende"], value: rw.quando_assumir ?? rw.quando_pretende_assumir },
            { keys: ["fonte"], value: rw.fonte ?? rp.source ?? rp.utm_source },
            { keys: ["funcaonaempresa", "funcao", "ocupacao", "cargo"], value: rw.ocupacao ?? rw.funcao_na_empresa ?? rw.cargo },
            { keys: ["formatodecampanha", "formatocampanha"], value: rw.formato_campanha ?? rw.formato_de_campanha },
            { keys: ["cidade", "city"], value: rw.city ?? rw.cidade },
            { keys: ["estado", "state", "uf"], value: rw.state ?? rw.estado },
          ];
          for (const f of pipeFields) {
            const fname = norm(f.name);
            for (const a of aliases) {
              if (a.value && a.keys.includes(fname)) {
                customFieldsMap[f.name] = a.value;
                customFieldValues.push({ field_id: f.id, value: String(a.value) });
                break;
              }
            }
          }
        }
      } catch (e) { console.warn("[receive-lead] custom_fields mapping failed:", e); }

      const dealPayload = {
        tenant_id: tenantId,
        lead_id: newLead.id,
        pipeline_id: effectivePipelineId,
        pipeline_stage_id: effectiveFirstStageId,
        product_id: config.product_id || null,
        original_price: productPrice,
        negotiated_price: productPrice,
        sales_rep_id: nextMemberId,
        status: "negotiation",
        metadata: {
          source: "receive-lead",
          origin,
          ...(Object.keys(customFieldsMap).length > 0 ? { custom_fields: customFieldsMap } : {}),
          ...(raw.form_id ? { form_id: raw.form_id, form_name: raw.form_name } : {}),
          ...(raw.gclid ? { gclid: raw.gclid } : {}),
          ...(raw.fbclid ? { fbclid: raw.fbclid } : {}),
          ...(raw.landing_page ? { landing_page: raw.landing_page } : {}),
        },
      };

      // 1ª tentativa
      let { data: newDeal, error: dealError } = await supabase
        .from("deals")
        .insert(dealPayload)
        .select("id")
        .single();

      // 1 retry imediato se falhou (cobre 90% dos casos transitórios: timeout, race, rede)
      if (dealError) {
        console.warn("[receive-lead] Deal insert failed on 1st attempt, retrying:", dealError.message);
        const retry = await supabase
          .from("deals")
          .insert(dealPayload)
          .select("id")
          .single();
        newDeal = retry.data;
        dealError = retry.error;
      }

      if (dealError) {
        console.error("[receive-lead] Deal insert FAILED after retry:", dealError);
        // Log permanente do erro pra investigação posterior (não desaparece como console.error)
        try {
          await supabase.from("receive_lead_logs").insert({
            tenant_id: tenantId,
            api_key: apiKey,
            config_id: distributionConfigId,
            origin,
            status: "deal_insert_failed",
            lead_id: newLead.id,
            lead_name: newLead.name,
            lead_email: newLead.email,
            lead_phone: newLead.phone,
            assigned_to: nextMemberId,
            error_message: dealError.message,
            error_details: {
              pipeline_id: effectivePipelineId,
              pipeline_stage_id: effectiveFirstStageId,
              product_id: config.product_id,
              attempts: 2,
              code: (dealError as any).code,
              hint: (dealError as any).hint,
            },
            raw_payload: raw,
          });
        } catch (logErr) {
          console.error("[receive-lead] Failed to log deal_insert_failed:", logErr);
        }
      } else {
        dealId = newDeal?.id || null;
        // Grava custom fields na tabela que o front lê (pipeline_custom_field_values).
        // Best-effort: nunca quebra o fluxo de recebimento do lead.
        if (dealId && customFieldValues.length > 0) {
          try {
            await supabase.from("pipeline_custom_field_values").insert(
              customFieldValues.map((cf) => ({
                tenant_id: tenantId,
                deal_id: dealId,
                field_id: cf.field_id,
                value: cf.value,
              }))
            );
          } catch (e) {
            console.warn("[receive-lead] pipeline_custom_field_values insert failed:", e);
          }
        }
      }
    }

    // 8. Insert lead_conversion record (first conversion / new)
    await supabase.from("lead_conversions").insert({
      tenant_id: tenantId,
      lead_id: newLead.id,
      conversion_type: "new",
      source: parsed.source || parsed.utm_source || origin,
      utm_source: parsed.utm_source,
      utm_medium: parsed.utm_medium,
      utm_campaign: parsed.utm_campaign,
      utm_content: parsed.utm_content,
      utm_term: parsed.utm_term,
      extra_data: extraData,
      sales_rep_id: nextMemberId,
      deal_id: dealId,
      origin,
      raw_payload: raw,
    });

    // 9. Log distribution
    await supabase.from("lead_distribution_log").insert({
      tenant_id: tenantId,
      config_id: distributionConfigId,
      lead_id: newLead.id,
      deal_id: dealId,
      team_member_id: nextMemberId,
      method_used: config.method,
      source: origin,
      metadata: { format: origin, parsed },
    });

    // 9b. Log to receive_lead_logs (audit)
    await supabase.from("receive_lead_logs").insert({
      tenant_id: tenantId,
      api_key: apiKey,
      config_id: distributionConfigId,
      origin,
      lead_name: leadName,
      lead_email: parsed.email || null,
      lead_phone: phone,
      lead_source: parsed.source || parsed.utm_source || null,
      status: "success",
      lead_id: newLead.id,
      deal_id: dealId,
      assigned_to: nextMemberId,
      assigned_to_name: memberData?.name || null,
      raw_payload: raw,
      processing_ms: Date.now() - startMs,
    }).then(() => {}).catch(() => {});

    // 10. Notifications (fire-and-forget) — uses notification_rules per tenant
    try {
      const sharedContext = {
        tenant_id: tenantId,
        sales_rep_id: nextMemberId,
        lead_id: newLead.id,
        deal_id: dealId,
        // pipeline_id pro filtro de regras (filter_pipeline_ids)
        lead_pipeline_id: effectivePipelineId,
        deal_pipeline_id: effectivePipelineId,
        cliente: leadName,
        cliente_telefone: phone || "",
        cliente_email: parsed.email || "",
        cliente_empresa: (parsed as RawPayload).company || "",
        lead_origem: parsed.source || parsed.utm_source || "api",
        responsavel: memberData?.name || "",
        responsavel_telefone: memberData?.phone || "",
      };

      await supabase.functions.invoke("process-notification-event", {
        body: {
          event_type: "lead_created",
          tenant_id: tenantId,
          context: sharedContext,
        },
      });

      if (dealId) {
        await supabase.functions.invoke("process-notification-event", {
          body: {
            event_type: "deal_created",
            tenant_id: tenantId,
            context: {
              ...sharedContext,
              deal_id: dealId,
              deal_titulo: `${leadName} - ${origin === "rdstation" ? "RD Station" : "API"}`,
              deal_vendedor: memberData?.name || "",
              deal_vendedor_telefone: memberData?.phone || "",
              deal_etapa: "Primeira etapa",
            },
          },
        });
      }
    } catch (notifErr) {
      console.error("[receive-lead] Notification error:", notifErr);
    }

    // 11. Franchise campaign: check criteria and notify franchisee via WhatsApp
    let franchiseResult: RawPayload | null = null;
    if (franchiseCampaign) {
      try {
        const leadCapital = capitalToNumber((parsed as RawPayload).capital_disponivel);
        const minCapital = capitalToNumber(franchiseCampaign.min_capital_tier);
        const leadCity = (parsed as RawPayload).city?.trim() || null;

        if (leadCapital >= minCapital) {
          // Try UTM-based matching first (utm_content contains franchisee identifier)
          let franchisee: { id: string; name: string; phone: string } | null = null;
          const utmContent = parsed.utm_content || "";
          const utmFranchiseeMatch = utmContent.match(/Franquead[oa][_-](.+)/i);

          if (utmFranchiseeMatch) {
            const utmIdentifier = utmFranchiseeMatch[1].trim();
            console.log("[receive-lead] Franchise UTM match attempt:", utmIdentifier, "from utm_content:", utmContent);
            const { data: utmMember } = await supabase
              .from("franchise_members")
              .select("id, name, phone")
              .eq("campaign_id", franchiseCampaign.id)
              .eq("is_active", true)
              .eq("utm_identifier", utmIdentifier)
              .maybeSingle();
            if (utmMember) {
              franchisee = utmMember;
              console.log("[receive-lead] Franchise UTM matched:", franchisee.name);
            } else {
              console.log("[receive-lead] Franchise UTM no match for:", utmIdentifier, "- falling back to round-robin");
            }
          }

          // Fallback: round-robin if no UTM match
          if (!franchisee) {
            const { data: nextFranchiseeId } = await supabase.rpc(
              "get_next_franchise_member",
              { p_campaign_id: franchiseCampaign.id, p_city: leadCity }
            );

            if (nextFranchiseeId) {
              const { data: rrMember } = await supabase
                .from("franchise_members")
                .select("id, name, phone")
                .eq("id", nextFranchiseeId)
                .single();
              franchisee = rrMember;
            }
          }

          if (franchisee) {
              // Update lead with franchise info
              await supabase.from("leads").update({
                franchise_campaign_id: franchiseCampaign.id,
                franchise_member_id: franchisee.id,
                franchise_member_name: franchisee.name,
                franchise_member_phone: franchisee.phone,
              }).eq("id", newLead.id);

              // Log franchise distribution
              await supabase.from("franchise_distribution_log").insert({
                campaign_id: franchiseCampaign.id,
                franchise_member_id: franchisee.id,
                lead_id: newLead.id,
                tenant_id: franchiseCampaign.tenant_id,
              });

              // Send WhatsApp to franchisee
              let whatsappSent = false;
              if (franchiseCampaign.whatsapp_instance_id) {
                const { data: instance } = await supabase
                  .from("whatsapp_instances")
                  .select("id, api_key, api_url")
                  .eq("id", franchiseCampaign.whatsapp_instance_id)
                  .eq("status", "connected")
                  .maybeSingle();

                if (instance) {
                  // Build message from template
                  const msg = (franchiseCampaign.message_template || "")
                    .replace("{{campaign_name}}", franchiseCampaign.name || "")
                    .replace("{{lead_name}}", leadName)
                    .replace("{{lead_phone}}", phone || "Não informado")
                    .replace("{{lead_email}}", parsed.email || "Não informado")
                    .replace("{{lead_city}}", leadCity || "Não informada")
                    .replace("{{lead_state}}", normalizeState((parsed as RawPayload).state) || "")
                    .replace("{{lead_capital}}", (parsed as RawPayload).capital_disponivel || "Não informado")
                    .replace("{{lead_horario}}", (parsed as RawPayload).melhor_horario || "Não informado")
                    .replace("{{seller_name}}", memberData?.name || "");

                  // Send via UAZAPI
                  const franchiseePhone = franchisee.phone.replace(/[^0-9]/g, "");
                  try {
                    const resp = await fetch(`${instance.api_url}/send/text`, {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                        "token": instance.api_key,
                      },
                      body: JSON.stringify({
                        number: franchiseePhone,
                        text: msg,
                      }),
                    });
                    whatsappSent = resp.ok;
                    if (!resp.ok) {
                      console.error("[receive-lead] Franchise WhatsApp error:", await resp.text());
                    }
                  } catch (wppErr) {
                    console.error("[receive-lead] Franchise WhatsApp fetch error:", wppErr);
                  }
                }
              }

              // Update log with WhatsApp status
              await supabase.from("franchise_distribution_log")
                .update({ whatsapp_sent: whatsappSent })
                .eq("lead_id", newLead.id)
                .eq("franchise_member_id", franchisee.id);

              // Create timeline activity for franchise assignment
              await supabase.from("company_activities").insert({
                tenant_id: tenantId,
                name: `Lead para Franqueado: ${franchisee.name}`,
                description: `Lead ${leadName} distribuído para franqueado ${franchisee.name} (${franchisee.phone}) via campanha "${franchiseCampaign.name}". WhatsApp ${whatsappSent ? "enviado" : "não enviado"}.`,
                team: "sales",
                lead_id: newLead.id,
                task_type: "note",
                priority: "medium",
                scheduled_at: new Date().toISOString(),
                completed: true,
                metadata: {
                  source: "franchise_distribution",
                  franchise_campaign_id: franchiseCampaign.id,
                  franchise_campaign_name: franchiseCampaign.name,
                  franchise_member_id: franchisee.id,
                  franchise_member_name: franchisee.name,
                  franchise_member_phone: franchisee.phone,
                  whatsapp_sent: whatsappSent,
                },
              }).then(() => {}).catch(() => {});

              franchiseResult = {
                franchisee_name: franchisee.name,
                franchisee_phone: franchisee.phone,
                whatsapp_sent: whatsappSent,
              };
              console.log("[receive-lead] Franchise lead routed to:", franchisee.name, "via:", utmFranchiseeMatch ? "UTM" : "round-robin", "WhatsApp sent:", whatsappSent);
          } else {
            console.log("[receive-lead] Franchise: no active member found for campaign", franchiseCampaign.id);
          }
        } else {
          console.log("[receive-lead] Franchise: lead capital", leadCapital, "below minimum", minCapital, "- skipping franchise routing");
        }
      } catch (franchiseErr) {
        console.error("[receive-lead] Franchise routing error:", franchiseErr);
        // Non-blocking: lead was already created and assigned normally
      }
    }

    console.log("[receive-lead] Done:", {
      lead_id: newLead.id,
      deal_id: dealId,
      assigned_to: memberData?.name || "Unknown",
      format: origin,
      ms: Date.now() - startMs,
    });

    return {
      success: true,
      lead_id: newLead.id,
      deal_id: dealId,
      assigned_to: memberData ? { id: memberData.id, name: memberData.name || "" } : null,
    };
  } catch (err: any) {
    console.error("[receive-lead] Unexpected error:", err);
    return { success: false, status: 500, error: `Unexpected error: ${err?.message || String(err)}` };
  }
  }; // end processLead

  // Aguarda o processamento ANTES de responder. Garante que o ack 200 só vai depois
  // do INSERT em leads. Latencia 1-4s, todos clientes (Meta/Elementor/RD/Make) aguentam.
  const result = await processLead();

  if (!result.success) {
    return jsonResponse({ success: false, error: result.error }, result.status);
  }

  return jsonResponse({
    success: true,
    lead_id: result.lead_id,
    deal_id: result.deal_id || null,
    assigned_to: result.assigned_to || null,
    ...(result.reconverted ? { reconverted: true } : {}),
  });
});
