-- Company value participation through an OREH license agreement (오레 라이선스 계약):
-- the company signs a license contract and pays by bank transfer (tax invoice), OREH registers it on
-- the admin page, and the company's own Leon introduction video (like the LUNALA film) plays before
-- the story. Leon's only line about the company: "가치참여에 함께 했습니다."
alter table public.sponsors add column video_path text;   -- storage path in bucket sponsor-videos
alter table public.sponsors add column source text not null default 'web' check (source in ('web', 'license'));

-- the package every license registration points at (never offered on the site; the amount is per contract)
insert into public.sponsor_packages (id, sponsor_type, amount_krw, days, active)
values ('license', 'company', 1000, 365, false)
on conflict (id) do nothing;

create or replace view public.public_sponsors as
select s.id, s.campaign_id, s.sponsor_type, s.display_name, s.message, s.logo_path, s.voice_path, s.lang, s.created_at,
       s.video_path
from public.sponsors s
join public.orders o on o.id = s.order_uuid and o.status = 'paid'
where s.review_status = 'approved'
  and (s.show_from is null or s.show_from <= current_date)
  and (s.show_until is null or s.show_until >= current_date);

-- partner introduction videos: public read, uploads only through signed URLs from admin-order
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sponsor-videos', 'sponsor-videos', true, 52428800, array['video/mp4'])
on conflict (id) do nothing;
