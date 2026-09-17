import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';

export interface InstagramProfile {
  id: string;
  username: string;
  full_name: string;
  biography: string;
  external_url: string | null;
  profile_data: {
    isPrivate: boolean;
    isVerified: boolean;
    postsCount: number;
    followersCount: number;
    followingCount: number;
    profilePicUrlHD: string;
    profilePictureUrl: string;
    storedProfilePictureUrl: string;
  };
  latest_posts: any[];
  profile_picture_url_hd: string;
  stored_profile_picture_url: string;
  is_verified: boolean;
  is_private: boolean;
  follower_count: number;
  following_count: number;
  media_count: number;
  created_at: string;
  updated_at: string;
  last_scraped_at: string;
}

export interface InstagramPost {
  id: string;
  post_id: string;
  code: string;
  media_type: number;
  thumbnail_url: string;
  stored_thumbnail_url: string;
  caption: string;
  like_count: number;
  comment_count: number;
  play_count: number;
  taken_at: string;
}

export interface InstagramStory {
  id: string;
  story_id: string;
  media_type: number;
  media_url: string;
  stored_media_url: string;
  thumbnail_url: string;
  stored_thumbnail_url: string;
  taken_at: string;
  expires_at: string;
  has_audio: boolean;
  ai_description: string | null;
}

// ── Business Discovery (perfil público de um @ via API da Meta, sem abrir a página) ──
export interface IgDiscoveryPost {
  id: string;
  caption?: string;
  media_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  like_count?: number;
  comments_count?: number;
  timestamp?: string;
}
export interface IgDiscoveryResult {
  available: boolean;
  cached?: boolean;
  reason?: string;
  profile?: {
    username: string | null;
    name: string | null;
    profile_pic?: string | null;
    biography?: string | null;
    followers_count?: number | null;
    follows_count?: number | null;
    media_count?: number | null;
    website?: string | null;
    is_verified?: boolean;
    follows_you?: boolean;   // a pessoa segue a sua conta
    you_follow?: boolean;    // a sua conta segue a pessoa
  };
  media?: IgDiscoveryPost[];
}

/**
 * Busca o perfil do lead no Instagram sem o vendedor abrir a página do IG.
 * - Por igsid (quem mandou DM): nome, foto, seguidores, verificado, "te segue".
 * - Por username: adiciona bio + posts SE a conta estiver ligada a uma Página
 *   do Facebook (Business Discovery). Sem isso, retorna só o que a API libera.
 */
export const useInstagramBusinessProfile = (
  username: string | undefined | null,
  igsid?: string | undefined | null,
) => {
  const uname = (username || '').replace(/^@/, '').trim();
  const id = (igsid || '').trim();
  return useQuery({
    queryKey: ['ig-profile-lookup', uname.toLowerCase(), id],
    queryFn: async (): Promise<IgDiscoveryResult> => {
      const { data, error } = await supabase.functions.invoke('instagram-profile-lookup', {
        body: { username: uname, igsid: id },
      });
      if (error) {
        let reason = error.message;
        try {
          const ctx = (error as { context?: Response }).context;
          if (ctx && typeof ctx.json === 'function') {
            const b = await ctx.json();
            reason = b?.reason || b?.error || reason;
          }
        } catch { /* mantém */ }
        return { available: false, reason };
      }
      return data as IgDiscoveryResult;
    },
    enabled: !!(uname || id),
    staleTime: 1000 * 60 * 30,
    retry: false,
  });
};

export const useInstagramProfile = (profileId: string | undefined) => {
  return useQuery({
    queryKey: ['instagram-profile', profileId],
    queryFn: async () => {
      if (!profileId) return null;
      
      const { data, error } = await supabase
        .from('instagram_profiles')
        .select('*')
        .eq('id', profileId)
        .single();

      if (error) throw error;
      return data as InstagramProfile;
    },
    enabled: !!profileId,
  });
};

export const useInstagramPosts = (profileId: string | undefined) => {
  return useQuery({
    queryKey: ['instagram-posts', profileId],
    queryFn: async () => {
      if (!profileId) return [];
      
      const { data, error } = await supabase
        .from('instagram_feed_posts')
        .select('*')
        .eq('instagram_profile_id', profileId)
        .order('taken_at', { ascending: false })
        .limit(12);

      if (error) throw error;
      return (data || []) as InstagramPost[];
    },
    enabled: !!profileId,
  });
};

export const useInstagramStories = (profileId: string | undefined) => {
  return useQuery({
    queryKey: ['instagram-stories', profileId],
    queryFn: async () => {
      if (!profileId) return [];
      
      const { data, error } = await supabase
        .from('instagram_stories')
        .select('*')
        .eq('instagram_profile_id', profileId)
        .order('taken_at', { ascending: false })
        .limit(20);

      if (error) throw error;
      return (data || []) as InstagramStory[];
    },
    enabled: !!profileId,
  });
};
