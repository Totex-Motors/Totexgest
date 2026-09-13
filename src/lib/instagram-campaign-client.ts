import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from './supabase';
// Narrow adapter for the Instagram table, absent from the legacy generated schema.
// Reuses the authenticated client; does not create another session or hide query errors.
type CampaignFields = {
 id: string; tenant_id: string; name: string; post_id: string; status: string;
 post_caption: string | null; dm_template: string | null; updated_at: string;
 keyword_mode: string; keywords: string[]; reply_mode: string; agent_slug: string | null;
 once_per_user: boolean; process_existing: boolean; studio_payload: unknown;
};
type InstagramDatabase = {public:{Tables:{instagram_comment_campaigns:{
 Row:CampaignFields;Insert:Partial<CampaignFields>;Update:Partial<CampaignFields>;Relationships:[];
}};Views:Record<string,never>;Functions:Record<string,never>}};
export const instagramCampaignClient = supabase as unknown as SupabaseClient<InstagramDatabase>;
