import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  handleMetaCampaignEvents,
  handleCampaignReplyByUsername,
  resolveAccountFromEvent,
  type IgAccount,
} from "./meta-campaign.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// --- Types ---

// Normalized message (both formats converge here)
interface NormalizedMessage {
  mid: string;
  senderId: string;
  recipientId: string | null;
  senderUsername: string | null;
  text: string;
  messageType: string; // "text" | "image" | "audio" | "video" | "story_reply" | "story_mention"
  mediaUrl: string | null;
  timestamp: number; // ms
  referenceType: string | null; // "story" | "post" | "reel"
  referenceId: string | null;
  referenceUrl: string | null;
  isEcho: boolean;
  source: "uchat" | "meta";
}

interface SocialSellerRule {
  id: string;
  name: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  from_stage_id: string | null;
  to_stage_id: string;
  create_alert: boolean;
  alert_message: string | null;
  is_active: boolean;
  priority: number;
  from_stage: { name: string } | null;
  to_stage: { name: string } | null;
}

// Fire-and-forget AI analysis trigger — runs on every client message
async function triggerAIAnalysis(
  supabase: ReturnType<typeof createClient>,
  convId: string,
  _totalMessages: number,
  isFromMe: boolean,
  _messageType: string,
  _metadata: Record<string, unknown> | null
) {
  // Only trigger on client messages
  if (isFromMe) return;

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  fetch(`${supabaseUrl}/functions/v1/analyze-instagram-conversation`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${supabaseKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ conversation_id: convId }),
  }).catch((e) => console.warn("AI analysis trigger failed:", e));
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// --- Detect payload format ---
// deno-lint-ignore no-explicit-any
function isUChatPayload(body: any): boolean {
  return !!body.uchat_userid && !!body.last_message;
}

// deno-lint-ignore no-explicit-any
function isMetaPayload(body: any): boolean {
  return body.object === "instagram" && Array.isArray(body.entry);
}

// Story reply trigger from uChat (flat payload, no last_message)
// deno-lint-ignore no-explicit-any
function isStoryReplyPayload(body: any): boolean {
  return !!body.uchat_userid && !body.last_message && !!(body.story_id || body.story_url);
}

// Sent message / comment interaction from uChat flow (type = "sent_message")
// Registers: lead's comment (comentario_insta) + team's reply (sent_text) on a post/reel
// deno-lint-ignore no-explicit-any
function isSentMessagePayload(body: any): boolean {
  return body.type === "sent_message" && !!body.instagram_username;
}

// deno-lint-ignore no-explicit-any
function parseStoryReply(body: any): NormalizedMessage {
  const storyId = body.story_id ? String(body.story_id) : null;
  return {
    mid: `story_${storyId || "unknown"}_${body.uchat_userid}`,
    senderId: body.uchat_userid,
    recipientId: null,
    senderUsername: body.instagram_username || null,
    text: body.stories_message || "",
    messageType: "story_reply",
    mediaUrl: null,
    timestamp: Date.now(),
    referenceType: "story",
    referenceId: storyId,
    referenceUrl: body.story_url || null,
    isEcho: false,
    source: "uchat",
  };
}

// --- Process comment interaction (lead commented + team replied) ---
// deno-lint-ignore no-explicit-any
async function processCommentInteraction(
  supabase: ReturnType<typeof createClient>,
  body: any
) {
  const username = body.instagram_username;
  const commentText = body.comentario_insta || body.comment_text || "";
  const replyText = body.sent_text || body.reply_text || "";
  const postId = body.post_id ? String(body.post_id) : null;
  const commentId = body.comment_id ? String(body.comment_id) : null;
  const permalink = body.permalink && body.permalink.trim() !== "" ? body.permalink : null;
  const postCaption = body.post_caption || null;
  const uchatUserId = body.user_id || null;

  // Determine reference type from permalink
  let referenceType: string | null = null;
  if (permalink) {
    if (permalink.includes("/reel/")) referenceType = "reel";
    else if (permalink.includes("/p/")) referenceType = "post";
    else if (permalink.includes("/stories/")) referenceType = "story";
  }

  // 1. Dedup by comment_id (if we already registered this comment, skip)
  if (commentId) {
    const { data: existingComment } = await supabase
      .from("instagram_messages")
      .select("id")
      .eq("instagram_message_id", `comment_${commentId}`)
      .maybeSingle();

    if (existingComment) {
      console.log("Comment interaction dedup: already registered comment", commentId);
      return { deduplicated: true, comment_id: commentId };
    }
  }

  // 2. Get connected account — uChat não identifica a conta no payload:
  // só funciona com 1 conta connected (fallback single-tenant); 2+ contas → skip.
  const account = await resolveAccountFromEvent(supabase, null);
  if (!account) {
    console.error("No connected Instagram account (ou 2+ contas sem como identificar no payload uChat)");
    return { error: "No connected Instagram account" };
  }
  const tenantId = account.tenant_id;

  // 3. Resolve participant — search by username first, then by uchat user_id
  let existingConv = null;

  // Try by username
  const { data: convByUsername } = await supabase
    .from("instagram_conversations")
    .select("*")
    .eq("account_id", account.id)
    .eq("participant_username", username)
    .limit(1)
    .maybeSingle();
  existingConv = convByUsername;

  // If not found by username, try by uchat user_id (participant_instagram_id)
  if (!existingConv && uchatUserId) {
    const { data: convByUchatId } = await supabase
      .from("instagram_conversations")
      .select("*")
      .eq("account_id", account.id)
      .eq("participant_instagram_id", uchatUserId)
      .limit(1)
      .maybeSingle();
    existingConv = convByUchatId;

    // If found, update username on the existing conversation
    if (existingConv && username && !existingConv.participant_username) {
      await supabase
        .from("instagram_conversations")
        .update({ participant_username: username })
        .eq("id", existingConv.id);
    }
  }

  const participantId = existingConv?.participant_instagram_id || uchatUserId || `username_${username}`;

  // 4. Fetch profile data
  const profileData = await fetchProfileData(supabase, username, tenantId);

  // 5. Find or create conversation
  let conversation = existingConv;
  if (!conversation) {
    const { data: firstStage } = await supabase
      .from("social_seller_stages")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("is_active", true)
      .order("position", { ascending: true })
      .limit(1)
      .maybeSingle();

    const { data: newConv, error: convError } = await supabase
      .from("instagram_conversations")
      .insert({
        tenant_id: tenantId,
        account_id: account.id,
        thread_id: participantId,
        participant_instagram_id: participantId,
        participant_username: username,
        participant_name: profileData.name,
        participant_profile_pic: profileData.profilePic,
        status: "open",
        social_seller_stage_id: firstStage?.id || null,
        stage_changed_at: new Date().toISOString(),
      })
      .select("*")
      .single();

    if (convError || !newConv) {
      console.error("Failed to create conversation:", convError);
      return { error: "Failed to create conversation" };
    }
    conversation = newConv;
  } else {
    // Reopen if handled
    if (conversation.status === "handled") {
      await supabase
        .from("instagram_conversations")
        .update({ status: "open" })
        .eq("id", conversation.id);
    }
  }

  const convId = conversation.id;
  const isIgnored = conversation.is_ignored === true;
  const now = new Date().toISOString();

  const postMeta = {
    post_id: postId,
    comment_id: commentId,
    parent_id: body.parent_id || null,
    permalink,
    post_caption: postCaption,
  };

  // 6. Insert MESSAGE 1: Lead's comment (incoming)
  const { error: commentError } = await supabase
    .from("instagram_messages")
    .insert({
      tenant_id: tenantId,
      conversation_id: convId,
      instagram_message_id: commentId ? `comment_${commentId}` : `comment_${postId}_${Date.now()}`,
      content: commentText,
      message_type: "post_comment",
      is_from_me: false,
      sender_instagram_id: participantId,
      sender_username: username,
      reference_type: referenceType,
      reference_id: postId,
      reference_url: permalink,
      status: "delivered",
      sent_at: now,
      metadata: postMeta,
    });

  if (commentError) {
    console.error("Failed to insert comment message:", commentError);
    return { error: "Failed to insert comment" };
  }

  // 7. Insert MESSAGE 2: Team's reply (outgoing) — only if reply_text exists
  if (replyText) {
    const { error: replyError } = await supabase
      .from("instagram_messages")
      .insert({
        tenant_id: tenantId,
        conversation_id: convId,
        instagram_message_id: commentId ? `reply_${commentId}_${Date.now()}` : `reply_${postId}_${Date.now()}`,
        content: replyText,
        message_type: "comment_reply",
        is_from_me: true,
        sender_instagram_id: null,
        sender_username: null,
        reference_type: referenceType,
        reference_id: postId,
        reference_url: permalink,
        status: "delivered",
        sent_at: now,
        metadata: postMeta,
      });

    if (replyError) {
      console.error("Failed to insert reply message:", replyError);
    }
  }

  // 8. Update conversation metadata
  const lastMsg = replyText || commentText;
  const updateData: Record<string, unknown> = {
    last_message: lastMsg.substring(0, 200),
    last_message_at: now,
    last_client_message_at: now, // the comment is the client action
  };
  if (replyText) {
    updateData.last_agent_message_at = now;
  }
  await supabase
    .from("instagram_conversations")
    .update(updateData)
    .eq("id", convId);

  // Counters (for the incoming comment)
  if (!isIgnored) {
    await supabase.rpc("increment_instagram_unread", { conv_id: convId });
    await supabase.rpc("increment_instagram_message_count", { conv_id: convId });
  }

  // 9. Auto-match lead
  if (!conversation.lead_id && !isIgnored) {
    const { data: lead } = await supabase
      .from("leads")
      .select("id")
      .eq("tenant_id", tenantId)
      .ilike("instagram", `%${username}%`)
      .limit(1)
      .maybeSingle();

    if (lead) {
      await supabase
        .from("instagram_conversations")
        .update({ lead_id: lead.id })
        .eq("id", convId);
    }
  }

  // 10. Evaluate rules on the comment
  if (!isIgnored) {
    const { data: updatedConv } = await supabase
      .from("instagram_conversations")
      .select("*")
      .eq("id", convId)
      .single();

    if (updatedConv) {
      await evaluateRules(supabase, updatedConv, commentText, "post_comment", tenantId);
    }
  }

  // Trigger AI analysis (fire-and-forget)
  await triggerAIAnalysis(
    supabase,
    convId,
    (conversation.total_messages as number) + 1,
    false, // comment is from client
    "post_comment",
    (conversation.metadata as Record<string, unknown>) || null
  );

  return {
    success: true,
    conversation_id: convId,
    comment_registered: true,
    reply_registered: !!replyText,
    reference_type: referenceType,
  };
}

// --- Parse uChat format ---
// deno-lint-ignore no-explicit-any
function parseUChat(body: any): NormalizedMessage | null {
  const lm = body.last_message;
  if (!lm?.mid) return null;

  const timeMs = typeof lm.time === "string"
    ? parseInt(lm.time, 10) * 1000
    : (lm.time || 0) * 1000;

  // Detect story reply from body-level or last_message-level fields
  const storyUrl = body.story_url || lm.story_url || null;
  const storyId = body.story_id || lm.story_id || null;
  const isStoryReply = !!(storyUrl || storyId || lm.type === "story_reply");

  return {
    mid: lm.mid,
    senderId: body.uchat_userid,
    recipientId: null,
    senderUsername: body.instagram_username || null,
    text: lm.text || lm.caption || body.stories_message || "",
    messageType: isStoryReply ? "story_reply" : (lm.type || "text"),
    mediaUrl: lm.url || null,
    timestamp: timeMs,
    referenceType: isStoryReply ? "story" : null,
    referenceId: storyId ? String(storyId) : null,
    referenceUrl: storyUrl,
    isEcho: false,
    source: "uchat",
  };
}

// --- Parse Meta format ---
// deno-lint-ignore no-explicit-any
function parseMetaMessages(body: any): { messages: NormalizedMessage[]; igBusinessId: string } {
  const messages: NormalizedMessage[] = [];
  let igBusinessId = "";

  for (const entry of body.entry || []) {
    igBusinessId = entry.id;
    for (const messaging of entry.messaging || []) {
      const msg = messaging.message;
      if (!msg?.mid) continue;

      const isEcho = messaging.sender?.id === igBusinessId;

      let messageType = "text";
      let mediaUrl: string | null = null;
      let text = msg.text || "";
      let referenceType: string | null = null;
      let referenceUrl: string | null = null;

      if (msg.attachments?.length > 0) {
        const att = msg.attachments[0];
        messageType = att.type || "image";
        mediaUrl = att.payload?.url || null;
        if (!text) text = `[${messageType}]`;
      }

      let referenceId: string | null = null;

      if (msg.reply_to?.story) {
        messageType = "story_reply";
        referenceType = "story";
        referenceUrl = msg.reply_to.story.url || null;
        referenceId = msg.reply_to.story.id || null;
      }

      messages.push({
        mid: msg.mid,
        senderId: messaging.sender.id,
        recipientId: messaging.recipient?.id || null,
        senderUsername: null,
        text,
        messageType,
        mediaUrl,
        timestamp: messaging.timestamp,
        referenceType,
        referenceId,
        referenceUrl,
        isEcho,
        source: "meta",
      });
    }
  }

  return { messages, igBusinessId };
}

// --- Rule evaluation ---
async function evaluateRules(
  supabase: ReturnType<typeof createClient>,
  conversation: Record<string, unknown>,
  content: string,
  messageType: string,
  tenantId: string
) {
  const { data: rules } = await supabase
    .from("social_seller_rules")
    .select("*, from_stage:from_stage_id(name), to_stage:to_stage_id(name)")
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .order("priority", { ascending: false });

  if (!rules || rules.length === 0) return;

  for (const rule of rules as SocialSellerRule[]) {
    if (
      rule.from_stage_id &&
      rule.from_stage_id !== conversation.social_seller_stage_id
    )
      continue;

    let triggered = false;
    let detectedKeywords: string[] = [];

    switch (rule.trigger_type) {
      case "message_count": {
        const minMessages = (rule.trigger_config.min_messages as number) || 3;
        triggered = (conversation.total_messages as number) >= minMessages;
        break;
      }
      case "keyword_detected": {
        const keywords = (rule.trigger_config.keywords as string[]) || [];
        const matchType = (rule.trigger_config.match_type as string) || "any";
        detectedKeywords = keywords.filter((kw) =>
          content.toLowerCase().includes(kw.toLowerCase())
        );
        triggered =
          matchType === "all"
            ? detectedKeywords.length === keywords.length
            : detectedKeywords.length > 0;
        break;
      }
      case "interaction_type": {
        const types = (rule.trigger_config.types as string[]) || [];
        triggered = types.includes(messageType);
        break;
      }
    }

    if (triggered) {
      await supabase
        .from("instagram_conversations")
        .update({
          social_seller_stage_id: rule.to_stage_id,
          stage_changed_at: new Date().toISOString(),
        })
        .eq("id", conversation.id);

      if (rule.create_alert) {
        await supabase.from("social_seller_alerts").insert({
          tenant_id: tenantId,
          conversation_id: conversation.id,
          lead_id: conversation.lead_id || null,
          rule_id: rule.id,
          alert_type:
            rule.trigger_type === "keyword_detected"
              ? "keyword_detected"
              : "stage_change",
          title: rule.alert_message || `Regra "${rule.name}" disparou`,
          trigger_message: content.substring(0, 500),
          detected_keywords:
            detectedKeywords.length > 0 ? detectedKeywords : null,
          from_stage: rule.from_stage?.name || null,
          to_stage: rule.to_stage?.name || null,
          status: "pending",
        });
      }
      break;
    }
  }
}

// --- Fetch profile data from instagram_profiles ---
async function fetchProfileData(
  supabase: ReturnType<typeof createClient>,
  username: string,
  tenantId: string
): Promise<{ name: string | null; profilePic: string | null }> {
  const { data: profile } = await supabase
    .from("instagram_profiles")
    .select("full_name, stored_profile_picture_url, profile_picture_url_hd")
    .eq("tenant_id", tenantId)
    .eq("username", username)
    .maybeSingle();

  if (!profile) return { name: null, profilePic: null };

  return {
    name: profile.full_name || null,
    profilePic: profile.stored_profile_picture_url || profile.profile_picture_url_hd || null,
  };
}

// --- Process a single normalized message ---
async function processMessage(
  supabase: ReturnType<typeof createClient>,
  msg: NormalizedMessage,
  igBusinessId: string | null
) {
  // 1. Dedup - check by instagram_message_id first
  const { data: existing } = await supabase
    .from("instagram_messages")
    .select("id, tenant_id, content, media_url, sender_username, conversation_id")
    .eq("instagram_message_id", msg.mid)
    .maybeSingle();

  // 1b. For echos: also check if instagram-send-dm already saved this message
  // (it saves with instagram_message_id = null, so check by content + time window)
  if (!existing && msg.isEcho && msg.text) {
    const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const { data: recentOwn } = await supabase
      .from("instagram_messages")
      .select("id, conversation_id")
      .eq("is_from_me", true)
      .eq("content", msg.text)
      .is("instagram_message_id", null)
      .gte("sent_at", twoMinAgo)
      .limit(1)
      .maybeSingle();

    if (recentOwn) {
      // Enrich: add the instagram_message_id so future dedup works by mid
      await supabase
        .from("instagram_messages")
        .update({ instagram_message_id: msg.mid, status: "delivered" })
        .eq("id", recentOwn.id);
      console.log("Echo dedup: enriched instagram-send-dm message with mid", msg.mid.substring(0, 30));
      return { deduplicated: true, enriched_send_dm: true };
    }
  }

  if (existing) {
    // uChat arrives after Meta with richer data (transcription + media_url)
    // Enrich the existing message if uChat has better info
    if (msg.source === "uchat") {
      const enrichData: Record<string, unknown> = {};

      // Update content if existing is empty or just a placeholder like "[audio]"
      if (msg.text && (!existing.content || existing.content.startsWith("["))) {
        enrichData.content = msg.text;
      }

      // Add media_url if missing
      if (msg.mediaUrl && !existing.media_url) {
        enrichData.media_url = msg.mediaUrl;
      }

      // Add username if missing
      if (msg.senderUsername && !existing.sender_username) {
        enrichData.sender_username = msg.senderUsername;
      }

      // Fix story reference data if uChat has it and Meta stored wrong values
      if (msg.referenceType === "story" && msg.messageType === "story_reply") {
        enrichData.reference_type = "story";
        enrichData.message_type = "story_reply";
        if (msg.referenceId) enrichData.reference_id = msg.referenceId;
        if (msg.referenceUrl) enrichData.reference_url = msg.referenceUrl;
      }

      if (Object.keys(enrichData).length > 0 || msg.senderUsername) {
        console.log("Enriching existing message with uChat data:", enrichData);
        if (Object.keys(enrichData).length > 0) {
          await supabase
            .from("instagram_messages")
            .update(enrichData)
            .eq("id", existing.id);
        }

        // Update conversation: username + last_message if content changed
        const { data: msgWithConv } = await supabase
          .from("instagram_messages")
          .select("conversation_id")
          .eq("id", existing.id)
          .single();

        if (msgWithConv) {
          const updateConv: Record<string, unknown> = {};
          if (enrichData.content) {
            updateConv.last_message = (enrichData.content as string).substring(0, 200);
          }
          if (msg.senderUsername) {
            updateConv.participant_username = msg.senderUsername;
            // Fetch profile data (name, photo) from instagram_profiles
            // tenant vem da própria mensagem existente (padrão B3: entidade da linha)
            const profileData = await fetchProfileData(supabase, msg.senderUsername, (existing as { tenant_id: string }).tenant_id);
            if (profileData.name) updateConv.participant_name = profileData.name;
            if (profileData.profilePic) updateConv.participant_profile_pic = profileData.profilePic;
          }
          if (Object.keys(updateConv).length > 0) {
            await supabase
              .from("instagram_conversations")
              .update(updateConv)
              .eq("id", msgWithConv.conversation_id);
          }
        }

        return { enriched: true, message_id: existing.id };
      }
    }

    console.log("Dedup: already exists", msg.mid.substring(0, 30));
    return { deduplicated: true };
  }

  // 1c. Secondary dedup for story replies (cross-source: Meta mid ≠ uChat synthetic mid)
  if (msg.referenceType === "story" && msg.referenceId) {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: existingStoryReply } = await supabase
      .from("instagram_messages")
      .select("id")
      .eq("reference_id", msg.referenceId)
      .eq("sender_instagram_id", msg.senderId)
      .gte("sent_at", fiveMinAgo)
      .limit(1)
      .maybeSingle();

    if (existingStoryReply) {
      console.log("Story reply dedup: already exists for story", msg.referenceId);
      return { deduplicated: true };
    }
  }

  // 2. Get connected account — resolvida pelo dado do evento (entry.id =
  // instagram_business_id / ig_login_id); sem match: só usa fallback quando
  // existe UMA conta connected (2+ contas → não chuta tenant).
  const account: IgAccount | null = await resolveAccountFromEvent(supabase, igBusinessId);

  if (!account) {
    console.error("No connected Instagram account (ou 2+ contas sem match pro evento)");
    return { error: "No connected Instagram account" };
  }
  const tenantId = account.tenant_id;

  // 3. Determine sender vs our account
  const isFromMe = msg.isEcho || (igBusinessId ? msg.senderId === igBusinessId : false);
  // When it's our echo, the participant is the RECIPIENT, not the sender
  const participantId = isFromMe && msg.recipientId ? msg.recipientId : msg.senderId;
  const participantUsername = msg.senderUsername;

  // Try to resolve username from our own data (no Meta Graph API calls)
  let fetchedUsername = participantUsername;
  if (!fetchedUsername) {
    // Check existing conversations for this participant
    const { data: existingConv } = await supabase
      .from("instagram_conversations")
      .select("participant_username")
      .eq("tenant_id", tenantId)
      .eq("participant_instagram_id", participantId)
      .not("participant_username", "is", null)
      .limit(1)
      .maybeSingle();
    if (existingConv?.participant_username) {
      fetchedUsername = existingConv.participant_username;
    }
  }

  // 4. Fetch profile data if we have a username
  let profileName: string | null = null;
  let profilePic: string | null = null;
  if (fetchedUsername) {
    const profileData = await fetchProfileData(supabase, fetchedUsername, tenantId);
    profileName = profileData.name;
    profilePic = profileData.profilePic;
  }

  // 5. Find or create conversation
  let { data: conversation } = await supabase
    .from("instagram_conversations")
    .select("*")
    .eq("account_id", account.id)
    .eq("participant_instagram_id", participantId)
    .maybeSingle();

  // Fallback por USERNAME: conversa legado (uChat user_ns / outro id) da mesma pessoa.
  // Reusa e migra o id — mas SÓ upgrade (id novo é PSID numérico e o atual não é).
  // NUNCA rebaixar PSID pra user_ns: o Send API depende do PSID.
  if (!conversation && fetchedUsername) {
    const { data: byUsername } = await supabase
      .from("instagram_conversations")
      .select("*")
      .eq("account_id", account.id)
      .eq("participant_username", fetchedUsername)
      .order("last_message_at", { ascending: false })
      .limit(1);
    if (byUsername && byUsername.length > 0) {
      conversation = byUsername[0];
      const newIsPsid = /^\d+$/.test(participantId);
      const currentIsPsid = /^\d+$/.test(conversation.participant_instagram_id || "");
      if (newIsPsid && !currentIsPsid) {
        await supabase
          .from("instagram_conversations")
          .update({ participant_instagram_id: participantId })
          .eq("id", conversation.id);
      }
    }
  }

  if (!conversation) {
    const { data: firstStage } = await supabase
      .from("social_seller_stages")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("is_active", true)
      .order("position", { ascending: true })
      .limit(1)
      .maybeSingle();

    const { data: newConv, error: convError } = await supabase
      .from("instagram_conversations")
      .insert({
        tenant_id: tenantId,
        account_id: account.id,
        thread_id: participantId,
        participant_instagram_id: participantId,
        participant_username: fetchedUsername,
        participant_name: profileName,
        participant_profile_pic: profilePic,
        status: "open",
        social_seller_stage_id: firstStage?.id || null,
        stage_changed_at: new Date().toISOString(),
      })
      .select("*")
      .single();

    if (convError || !newConv) {
      console.error("Failed to create conversation:", convError);
      return { error: "Failed to create conversation" };
    }
    conversation = newConv;
  } else {
    // Update username/name/pic if we have them and conversation doesn't
    if (fetchedUsername && !conversation.participant_username) {
      const updateFields: Record<string, unknown> = { participant_username: fetchedUsername };
      if (profileName && !conversation.participant_name) updateFields.participant_name = profileName;
      if (profilePic && !conversation.participant_profile_pic) updateFields.participant_profile_pic = profilePic;
      await supabase
        .from("instagram_conversations")
        .update(updateFields)
        .eq("id", conversation.id);
    }
    // Reopen handled conversations on new client message
    if (conversation.status === "handled" && !isFromMe) {
      await supabase
        .from("instagram_conversations")
        .update({ status: "open" })
        .eq("id", conversation.id);
    }
  }

  const convId = conversation.id;
  const isIgnoredConversation = conversation.is_ignored === true;
  const sentAt = new Date(msg.timestamp).toISOString();
  const content = msg.text || "";

  // 6. Insert message
  // For audio/video: content = transcription text, media_url = playable file
  const { error: msgError } = await supabase
    .from("instagram_messages")
    .insert({
      tenant_id: tenantId,
      conversation_id: convId,
      instagram_message_id: msg.mid,
      content,
      message_type: msg.messageType,
      media_url: msg.mediaUrl || null,
      is_from_me: isFromMe,
      sender_instagram_id: msg.senderId,
      sender_username: fetchedUsername,
      reference_type: msg.referenceType,
      reference_id: msg.referenceId,
      reference_url: msg.referenceUrl,
      status: "delivered",
      sent_at: sentAt,
    });

  if (msgError) {
    console.error("Failed to insert message:", msgError);
    return { error: "Failed to insert message" };
  }

  // 7. Update conversation metadata
  // For last_message display: show transcription for audio, text for text
  const displayMessage = msg.messageType !== "text" && !content
    ? `[${msg.messageType}]`
    : content.substring(0, 200);

  const updateData: Record<string, unknown> = {
    last_message: displayMessage || `[${msg.messageType}]`,
    last_message_at: sentAt,
  };

  if (!isFromMe) {
    updateData.last_client_message_at = sentAt;
  } else {
    updateData.last_agent_message_at = sentAt;
  }

  if (fetchedUsername) {
    updateData.participant_username = fetchedUsername;
  }

  await supabase
    .from("instagram_conversations")
    .update(updateData)
    .eq("id", convId);

  // Counters (client messages only, skip if ignored)
  if (!isFromMe && !isIgnoredConversation) {
    await supabase.rpc("increment_instagram_unread", { conv_id: convId });
    await supabase.rpc("increment_instagram_message_count", { conv_id: convId });
  }

  // 8. Auto-match lead (skip if ignored)
  if (!isFromMe && !conversation.lead_id && !isIgnoredConversation) {
    const orFilter = fetchedUsername
      ? `instagram.ilike.%${fetchedUsername}%,instagram_id.eq.${participantId}`
      : `instagram_id.eq.${participantId}`;

    const { data: lead } = await supabase
      .from("leads")
      .select("id")
      .eq("tenant_id", tenantId)
      .or(orFilter)
      .limit(1)
      .maybeSingle();

    if (lead) {
      await supabase
        .from("instagram_conversations")
        .update({ lead_id: lead.id })
        .eq("id", convId);
    }
  }

  // 9. Evaluate rules (client messages only, skip if ignored)
  if (!isFromMe && !isIgnoredConversation) {
    const { data: updatedConv } = await supabase
      .from("instagram_conversations")
      .select("*")
      .eq("id", convId)
      .single();

    if (updatedConv) {
      await evaluateRules(supabase, updatedConv, content, msg.messageType, tenantId);
    }
  }

  // 10. Trigger AI analysis (fire-and-forget, client messages only)
  if (!isFromMe && !isIgnoredConversation) {
    await triggerAIAnalysis(
      supabase,
      convId,
      (conversation.total_messages as number) + 1,
      false,
      msg.messageType,
      (conversation.metadata as Record<string, unknown>) || null
    );
  }

  return { success: true, conversation_id: convId };
}

// --- Resolve username a partir do PSID (payload Meta não traz username) ---
// Fontes em ordem de custo:
//   1. Conversa existente com esse PSID
//   2. Recipients de campanha (Private Reply devolve o PSID → sabemos o username do comentário)
//   3. GET /{psid} na Graph — só funciona com Advanced Access (App Review pendente)
// deno-lint-ignore no-explicit-any
async function resolveUsernameFromPsid(supabase: any, psid: string, tenantId: string, account: IgAccount | null): Promise<string | null> {
  try {
    const { data: conv } = await supabase
      .from("instagram_conversations")
      .select("participant_username")
      .eq("tenant_id", tenantId)
      .eq("participant_instagram_id", psid)
      .not("participant_username", "is", null)
      .limit(1)
      .maybeSingle();
    if (conv?.participant_username) return conv.participant_username;

    const { data: rec } = await supabase
      .from("instagram_comment_campaign_recipients")
      .select("commenter_username")
      .eq("tenant_id", tenantId)
      .eq("recipient_psid", psid)
      .not("commenter_username", "is", null)
      .order("dm_sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (rec?.commenter_username) return rec.commenter_username;

    // Flavor novo primeiro (Standard Access resolve IDs do escopo novo)
    if (account?.ig_login_token) {
      const r = await fetch(
        `https://graph.instagram.com/v20.0/${psid}?fields=username,name&access_token=${account.ig_login_token}`,
      );
      if (r.ok) {
        const d = await r.json();
        if (d?.username) return d.username;
      }
    }
    // Flavor velho (só funciona com Advanced Access — fallback formal)
    if (account?.page_access_token) {
      const r = await fetch(
        `https://graph.facebook.com/v20.0/${psid}?fields=username,name&access_token=${account.page_access_token}`,
      );
      if (r.ok) {
        const d = await r.json();
        if (d?.username) return d.username;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// --- Main handler ---
/** Mídia (áudio/imagem/story) vira TEXTO antes de ir pro agente.
 *  Antes a gente simplesmente descartava "[audio]"/"[image]" — o lead mandava
 *  áudio respondendo a qualificação e levava silêncio (caso edu.amato 10/08:
 *  "tenho uma pizzaria, adoro tecnologia" — ficou sem resposta).
 *  Retorna o texto entendido, ou null se não deu (aí segue descartando). */
async function entenderMidia(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  senderUsername: string | null,
  tenantId: string,
): Promise<string | null> {
  try {
    if (!senderUsername) return null;
    const { data: convs } = await supabase
      .from("instagram_conversations").select("id")
      .eq("tenant_id", tenantId)
      .ilike("participant_username", senderUsername)
      .order("last_message_at", { ascending: false }).limit(1);
    const convId = convs?.[0]?.id;
    if (!convId) return null;

    const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/instagram-tools`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
      },
      body: JSON.stringify({ action: "media_understand", conversation_id: convId, only_last: true }),
      signal: AbortSignal.timeout(40_000),
    });
    const d = await r.json();
    return d?.ok && d?.texto ? String(d.texto) : null;
  } catch (e) {
    console.warn("[entenderMidia]", (e as Error).message);
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Handshake de verificação do webhook Meta (GET hub.challenge)
  if (req.method === "GET") {
    const url = new URL(req.url);
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode !== "subscribe" || !challenge || !token) {
      return new Response("forbidden", { status: 403 });
    }

    // O verify token é POR CONTA e vem do banco — é o mesmo valor que a UI
    // mostra em Configuracoes → Instagram Oficial pro admin colar na Meta.
    // (O handshake da Meta nao identifica a conta, entao qualquer conta
    //  conectada cujo token bata valida a URL.)
    try {
      const supa = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      const { data: match } = await supa
        .from("instagram_business_accounts")
        .select("id")
        .eq("webhook_verify_token", token)
        .limit(1)
        .maybeSingle();
      if (match) return new Response(challenge, { status: 200 });
    } catch (e) {
      console.error("[webhook verify] erro ao consultar contas:", (e as Error).message);
    }

    // Fallback: instalacoes que preferem fixar o token por variavel de ambiente.
    const envToken = Deno.env.get("IG_WEBHOOK_VERIFY_TOKEN");
    if (envToken && token === envToken) {
      return new Response(challenge, { status: 200 });
    }

    console.warn("[webhook verify] token nao confere com nenhuma conta conectada");
    return new Response("forbidden", { status: 403 });
  }

  try {
    // deno-lint-ignore no-explicit-any
    const body: any = await req.json();

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const results: Record<string, unknown>[] = [];

    // === FORMAT 1: uChat (has uchat_userid + last_message) ===
    if (isUChatPayload(body)) {
      const msg = parseUChat(body);
      if (!msg) {
        console.warn("uChat: could not parse message");
        return jsonResponse({ success: true, skipped: "uchat parse failed" });
      }

      console.log("uChat message:", {
        mid: msg.mid.substring(0, 30) + "...",
        from: msg.senderUsername || msg.senderId,
        type: msg.messageType,
        text: msg.text.substring(0, 50),
        hasMedia: !!msg.mediaUrl,
      });

      const result = await processMessage(supabase, msg, null);
      results.push(result);

      // Gancho campanha comentário→DM: se esse username recebeu private reply
      // recente, marca replied + agente continua a conversa (envio via Send API).
      // Guards: não roda em msg deduplicada nem em placeholder de mídia ("[image]").
      const isDup = !!(result as Record<string, unknown>)?.deduplicated;
      const isPlaceholder = /^\[\w+\]$/.test((msg.text || "").trim());
      // Tenant: uChat não identifica a conta — só resolve com 1 conta connected
      const uchatAccount = await resolveAccountFromEvent(supabase, null);
      let textoPraAgente = msg.text;
      if (uchatAccount && !isDup && isPlaceholder) {
        // áudio/imagem/story: entende antes de decidir descartar
        textoPraAgente = (await entenderMidia(supabase, msg.senderUsername, uchatAccount.tenant_id)) || "";
      }
      if (uchatAccount && !isDup && textoPraAgente && !/^\[\w+\]$/.test(textoPraAgente.trim())) {
        await handleCampaignReplyByUsername(supabase, msg.senderUsername, textoPraAgente, uchatAccount.tenant_id);
      }
    }

    // === FORMAT 2: uChat Story Reply trigger (flat, no last_message) ===
    else if (isStoryReplyPayload(body)) {
      const msg = parseStoryReply(body);

      console.log("uChat story reply:", {
        from: msg.senderUsername || msg.senderId,
        storyId: msg.referenceId,
        text: msg.text.substring(0, 50),
      });

      const result = await processMessage(supabase, msg, null);
      results.push(result);
    }

    // === FORMAT 3: Meta Webhook (has object=instagram + entry) ===
    // REABILITADO 13/07/2026 — uChat foi descontinuado; Meta é o canal único.
    // (O disable antigo era por duplicação uChat+Meta; dedup por mid segura a transição.)
    else if (isMetaPayload(body)) {
      // 1. Eventos de campanha comentário→DM (comments + replies de recipients)
      const { handled } = await handleMetaCampaignEvents(supabase, body);

      // 2. Fluxo geral de DMs (inbox)
      const { messages, igBusinessId } = parseMetaMessages(body);
      // Conta/tenant resolvidos pelo dado do evento (entry.id)
      const metaAccount = await resolveAccountFromEvent(supabase, igBusinessId || null);
      for (const msg of messages) {
        if (msg.isEcho) continue; // nossas próprias msgs (já espelhadas pelos senders)

        // DEDUP ATÔMICO por mid (fix flood 14/07): Meta RE-ENTREGA o mesmo evento
        // quando o 200 demora (retry). Só quem inserir o mid primeiro processa.
        if (msg.mid) {
          const { data: claimed, error: claimErr } = await supabase
            .from("instagram_processed_mids")
            .insert({ mid: msg.mid })
            .select("mid")
            .maybeSingle();
          if (claimErr && claimErr.code !== "23505") {
            // Falha real de insert (RLS/conexão) NÃO é duplicado — processa e loga
            console.error("mid claim error:", claimErr.message);
          } else if (!claimed) {
            console.log("mid duplicado (retry Meta), ignorando:", msg.mid.substring(0, 30));
            continue;
          }
        }

        // Resolve username a partir do PSID (Meta não manda no payload)
        if (!msg.senderUsername && msg.senderId && metaAccount) {
          msg.senderUsername = await resolveUsernameFromPsid(supabase, msg.senderId, metaAccount.tenant_id, metaAccount);
        }

        console.log("Meta message:", {
          mid: msg.mid.substring(0, 30) + "...",
          from: msg.senderUsername || msg.senderId,
          type: msg.messageType,
          text: msg.text.substring(0, 50),
        });

        const result = await processMessage(supabase, msg, igBusinessId);
        results.push(result);

        // Gancho campanha/agente: RODA EM BACKGROUND (fix flood 14/07) — o agente
        // leva 10-30s + pausas do split; segurar o 200 até o fim estourava o
        // timeout do Meta e gerava retry em loop.
        if (!metaAccount) continue; // sem conta resolvida pro evento → sem agente
        let txtAgente = msg.text;
        if (/^\[\w+\]$/.test((txtAgente || "").trim())) {
          txtAgente = (await entenderMidia(supabase, msg.senderUsername, metaAccount.tenant_id)) || "";
          if (!txtAgente || /^\[\w+\]$/.test(txtAgente.trim())) continue; // não deu pra entender
        }
        const bgWork = handleCampaignReplyByUsername(supabase, msg.senderUsername, txtAgente, metaAccount.tenant_id)
          .catch((e) => console.error("campaign reply bg error:", (e as Error).message));
        // deno-lint-ignore no-explicit-any
        const runtime = (globalThis as any).EdgeRuntime;
        if (runtime?.waitUntil) runtime.waitUntil(bgWork);
        else await bgWork; // sem waitUntil, promise flutuante pode ser morta no shutdown
      }

      return jsonResponse({ success: true, processed: messages.length, campaign_events: handled });
    }

    // === FORMAT 4: Comment interaction (lead commented + team replied) ===
    else if (isSentMessagePayload(body)) {
      console.log("Comment interaction:", {
        user: body.instagram_username,
        comment: (body.comentario_insta || "").substring(0, 50),
        reply: (body.sent_text || "").substring(0, 50),
        post: body.post_id,
        comment_id: body.comment_id,
      });

      const result = await processCommentInteraction(supabase, body);
      results.push(result);
    }

    // === Unknown format ===
    else {
      console.warn("Unknown payload format. Keys:", Object.keys(body));
      return jsonResponse({ success: true, skipped: "unknown format", keys: Object.keys(body) });
    }

    return jsonResponse({ success: true, processed: results.length, results });
  } catch (error) {
    console.error("Instagram webhook error:", error);
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Internal server error" },
      500
    );
  }
});
