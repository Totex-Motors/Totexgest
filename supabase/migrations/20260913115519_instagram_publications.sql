-- Private, server-owned publication state. No client writes or token copies.
create table public.instagram_publications (
 campaign_id uuid primary key references public.instagram_comment_campaigns(id) on delete cascade,
 tenant_id uuid not null,
 caption text not null default '' check(length(caption)<=2200),
 paths jsonb not null default '[]',
 status text not null default 'staging' check(status in ('staging','draft','preparing','publishing','published','error','uncertain')),
 account_id uuid,
 ready_children integer not null default 0,
 children jsonb not null default '[]',
 container_id text,
 media_id text,
 permalink text,
 error text,
 lock_id uuid,
 locked_until timestamptz not null default now(),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
alter table public.instagram_publications enable row level security;
revoke all on public.instagram_publications from anon, authenticated;
grant all on public.instagram_publications to service_role;
create index instagram_publications_tenant on public.instagram_publications(tenant_id);
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('instagram-publications','instagram-publications',false,2097152,array['image/jpeg'])
on conflict(id) do nothing;
