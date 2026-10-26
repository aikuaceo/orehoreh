-- OREH crowdfunding: campaigns, rewards, value-participation packages, likes, orders, sponsors.
-- Money is in KRW (integer won). Card data never touches this database: Toss Payments holds it.
-- Writes to orders and sponsors happen only in Edge Functions (service role). The browser reads
-- aggregated views and calls one RPC (toggle_like).

create extension if not exists pgcrypto;

-- ---------- catalogue ----------
create table public.campaigns (
  id               text primary key check (id ~ '^[a-z0-9-]{2,40}$'),
  status           text not null default 'draft' check (status in ('draft', 'soon', 'live', 'ended', 'canceled')),
  -- reward = a sale (OREH or a named seller is the 통신판매업자); donation = only through a registered nonprofit collector
  track            text not null default 'reward' check (track in ('reward', 'donation')),
  -- who sells the rewards (the 통신판매업자). 'OREH' while OREH runs its own campaigns.
  seller_name      text not null default '오레 주식회사',
  goal_krw         bigint not null check (goal_krw > 0),
  starts_on        date not null,
  ends_on          date not null check (ends_on >= starts_on),
  -- donations only for a campaign with a 기부금품 모집 등록 (registered collector + number)
  donation_enabled boolean not null default false,
  donation_collector text,
  donation_reg_no  text,
  sponsor_enabled  boolean not null default true,
  video_url        text,
  created_at       timestamptz not null default now(),
  constraint donation_needs_registration check (not donation_enabled or (track = 'donation' and donation_reg_no is not null and donation_collector is not null))
);

create table public.rewards (
  id          text primary key,
  campaign_id text not null references public.campaigns(id) on delete cascade,
  amount_krw  integer not null check (amount_krw >= 1000),
  ships       boolean not null default true,
  stock       integer check (stock is null or stock >= 0),
  sort        integer not null default 0,
  active      boolean not null default true
);

-- value participation (가치참여) = an advertising/sponsorship product: Leon introduces the sponsor for 15 seconds
create table public.sponsor_packages (
  id           text primary key,
  sponsor_type text not null check (sponsor_type in ('person', 'company')),
  amount_krw   integer not null check (amount_krw >= 1000),
  days         integer not null default 30 check (days between 1 and 365),
  active       boolean not null default true
);

-- ---------- engagement ----------
create table public.likes (
  campaign_id text not null references public.campaigns(id) on delete cascade,
  device_id   uuid not null,
  created_at  timestamptz not null default now(),
  primary key (campaign_id, device_id)
);

-- ---------- money ----------
create table public.orders (
  id            uuid primary key default gen_random_uuid(),
  order_id      text not null unique check (order_id ~ '^[A-Za-z0-9_-]{6,64}$'),   -- Toss orderId
  campaign_id   text not null references public.campaigns(id),
  kind          text not null check (kind in ('reward', 'donation', 'sponsor')),
  reward_id     text references public.rewards(id),
  package_id    text references public.sponsor_packages(id),
  base_krw      integer not null default 0 check (base_krw >= 0),
  extra_krw     integer not null default 0 check (extra_krw between 0 and 10000000),
  amount_krw    integer not null check (amount_krw > 0),
  status        text not null default 'ready' check (status in ('ready', 'paid', 'failed', 'canceled', 'partial_canceled', 'expired')),
  payment_key   text unique,
  method        text,
  buyer_name    text not null check (char_length(buyer_name) between 1 and 60),
  buyer_email   text not null check (buyer_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  buyer_country text not null check (buyer_country ~ '^[A-Z]{2}$'),
  lang          text not null check (lang in ('ko', 'en', 'zh')),
  agreements    jsonb not null,            -- {version, accepted_at, items:[...]}
  fail_code     text,
  fail_message  text,
  toss          jsonb,                     -- the confirm / lookup response, for audit
  created_at    timestamptz not null default now(),
  paid_at       timestamptz,
  canceled_at   timestamptz,
  constraint kind_matches_item check (
    (kind = 'reward' and reward_id is not null and package_id is null) or
    (kind = 'donation' and reward_id is null and package_id is null) or
    (kind = 'sponsor' and package_id is not null and reward_id is null)
  ),
  constraint amount_adds_up check (amount_krw = base_krw + extra_krw)
);
create index orders_campaign_status on public.orders (campaign_id, status);

create table public.sponsors (
  id            uuid primary key default gen_random_uuid(),
  order_uuid    uuid not null unique references public.orders(id) on delete cascade,
  campaign_id   text not null references public.campaigns(id),
  sponsor_type  text not null check (sponsor_type in ('person', 'company')),
  display_name  text not null check (char_length(display_name) between 1 and 40),
  message       text check (message is null or char_length(message) <= 80),
  logo_path     text,                      -- storage path in bucket sponsor-logos
  lang          text not null check (lang in ('ko', 'en', 'zh')),
  voice_path    text,                      -- storage path in bucket leon-voice (optional TTS)
  review_status text not null default 'pending' check (review_status in ('pending', 'approved', 'rejected')),
  review_note   text,
  show_from     date,
  show_until    date,
  created_at    timestamptz not null default now()
);

-- ---------- public read models ----------
-- Views run with the owner's rights, so they expose only these aggregates and approved sponsors.
create view public.campaign_stats as
select c.id as campaign_id,
       coalesce(sum(o.amount_krw) filter (where o.status = 'paid' and o.kind in ('reward', 'donation')), 0)::bigint as raised_krw,
       count(o.id) filter (where o.status = 'paid' and o.kind in ('reward', 'donation'))::int as backers,
       count(o.id) filter (where o.status = 'paid' and o.kind = 'sponsor')::int as sponsors,
       (select count(*) from public.likes l where l.campaign_id = c.id)::int as likes
from public.campaigns c
left join public.orders o on o.campaign_id = c.id
where c.status <> 'draft'
group by c.id;

create view public.public_sponsors as
select s.id, s.campaign_id, s.sponsor_type, s.display_name, s.message, s.logo_path, s.voice_path, s.lang, s.created_at
from public.sponsors s
join public.orders o on o.id = s.order_uuid and o.status = 'paid'
where s.review_status = 'approved'
  and (s.show_from is null or s.show_from <= current_date)
  and (s.show_until is null or s.show_until >= current_date);

-- ---------- RLS ----------
alter table public.campaigns enable row level security;
alter table public.rewards enable row level security;
alter table public.sponsor_packages enable row level security;
alter table public.likes enable row level security;
alter table public.orders enable row level security;
alter table public.sponsors enable row level security;

create policy "published campaigns are public" on public.campaigns for select to anon, authenticated using (status <> 'draft');
create policy "active rewards of published campaigns" on public.rewards for select to anon, authenticated
  using (active and exists (select 1 from public.campaigns c where c.id = campaign_id and c.status <> 'draft'));
create policy "active packages are public" on public.sponsor_packages for select to anon, authenticated using (active);
-- likes, orders, sponsors: no policies for anon = no direct access. Likes go through toggle_like().

revoke all on public.orders, public.sponsors, public.likes from anon, authenticated;
grant select on public.campaigns, public.rewards, public.sponsor_packages to anon, authenticated;
grant select on public.campaign_stats, public.public_sponsors to anon, authenticated;

-- ---------- likes ----------
create or replace function public.toggle_like(p_campaign text, p_device uuid)
returns table (liked boolean, likes int)
language plpgsql security definer set search_path = public as $$
declare
  v_liked boolean;
begin
  if not exists (select 1 from campaigns where id = p_campaign and status in ('soon', 'live', 'ended')) then
    raise exception 'unknown campaign';
  end if;
  -- at most 30 like changes per device per hour
  if (select count(*) from likes where device_id = p_device and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'too many likes';
  end if;
  delete from likes where campaign_id = p_campaign and device_id = p_device;
  if found then
    v_liked := false;
  else
    insert into likes (campaign_id, device_id) values (p_campaign, p_device);
    v_liked := true;
  end if;
  return query select v_liked, (select count(*)::int from likes where campaign_id = p_campaign);
end $$;
revoke all on function public.toggle_like(text, uuid) from public;
grant execute on function public.toggle_like(text, uuid) to anon, authenticated;

create or replace function public.my_likes(p_device uuid)
returns setof text language sql security definer set search_path = public stable as $$
  select campaign_id from likes where device_id = p_device;
$$;
revoke all on function public.my_likes(uuid) from public;
grant execute on function public.my_likes(uuid) to anon, authenticated;

-- ---------- storage ----------
-- sponsor-logos: public read (paths are random); uploads only through signed URLs from create-order.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sponsor-logos', 'sponsor-logos', true, 1048576, array['image/png', 'image/jpeg', 'image/webp']),
       ('leon-voice', 'leon-voice', true, 2097152, array['audio/mpeg'])
on conflict (id) do nothing;
