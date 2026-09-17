import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const body = await req.json().catch(() => ({}));
  const limit = body.limit || 50;
  const days = body.days || 7;

  // Buscar instância conectada pra pegar API key E URL
  const { data: inst } = await supabase
    .from("whatsapp_instances")
    .select("api_key, api_url")
    .eq("status", "connected")
    .not("api_url", "is", null)
    .limit(1)
    .maybeSingle();

  if (!inst?.api_key || !inst?.api_url) {
    return new Response(JSON.stringify({ error: "No connected instance with api_url" }), { status: 500 });
  }
  const UAZAPI_URL = inst.api_url;

  const cleanPhone = (p: string | null) =>
    !!p && !p.startsWith("insta_") && !p.startsWith("pending");
  const byId = new Map<string, { id: string; phone: string | null; name: string | null }>();

  // 1) PRIORIDADE: leads que estão em negociações ATIVAS no pipeline (o que aparece
  //    no board). Assim as fotos do que o vendedor vê enchem primeiro.
  const { data: activeDeals } = await supabase
    .from("deals")
    .select("lead:leads!deals_lead_id_fkey(id, phone, name, photo_url)")
    .not("pipeline_stage_id", "is", null)
    .limit(4000);
  for (const d of (activeDeals || []) as any[]) {
    const l = d.lead;
    if (l && !l.photo_url && cleanPhone(l.phone) && !byId.has(l.id)) {
      byId.set(l.id, { id: l.id, phone: l.phone, name: l.name });
      if (byId.size >= limit) break;
    }
  }

  // 2) COMPLEMENTO: leads recentes sem foto (pra novos que ainda não viraram deal)
  if (byId.size < limit) {
    const { data: recent } = await supabase
      .from("leads")
      .select("id, phone, name")
      .is("photo_url", null)
      .gte("created_at", new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString())
      .not("phone", "like", "insta_%")
      .not("phone", "like", "pending%")
      .order("created_at", { ascending: false })
      .limit(limit);
    for (const l of recent || []) {
      if (!byId.has(l.id)) byId.set(l.id, { id: l.id, phone: l.phone, name: l.name });
      if (byId.size >= limit) break;
    }
  }

  const leads = Array.from(byId.values());

  let success = 0, failed = 0, noPhoto = 0;

  for (const lead of leads || []) {
    try {
      const res = await fetch(`${UAZAPI_URL}/chat/details`, {
        method: "POST",
        headers: { "Content-Type": "application/json", token: inst.api_key },
        body: JSON.stringify({ number: lead.phone, preview: false }),
      });

      if (!res.ok) { failed++; continue; }
      const data = await res.json();
      const imageUrl = data.image || data.imagePreview;

      if (!imageUrl) { noPhoto++; continue; }

      const imgRes = await fetch(imageUrl);
      if (!imgRes.ok) { failed++; continue; }
      const blob = await imgRes.blob();
      if (blob.size < 100) { noPhoto++; continue; }

      const path = `avatars/${lead.id}_${Date.now()}.jpg`;
      const { error: uploadErr } = await supabase.storage
        .from("profile-photos")
        .upload(path, blob, { contentType: "image/jpeg", upsert: true });

      if (uploadErr) { failed++; continue; }

      const { data: urlData } = supabase.storage.from("profile-photos").getPublicUrl(path);
      await supabase.from("leads").update({ photo_url: urlData.publicUrl }).eq("id", lead.id);

      success++;
      // Delay 300ms
      await new Promise(r => setTimeout(r, 300));
    } catch {
      failed++;
    }
  }

  return new Response(JSON.stringify({
    total: leads?.length || 0,
    success,
    failed,
    noPhoto,
  }));
});
