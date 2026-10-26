-- For OREH's own content projects (for example the short-film series), value participation (가치참여,
-- an advertising product) pays for production, so it may count toward the project's goal.
-- Off by default: on donation projects the ad money is OREH revenue, not money for the heroes.
alter table public.campaigns add column sponsor_counts boolean not null default false;

create or replace view public.campaign_stats as
select c.id as campaign_id,
       coalesce(sum(o.amount_krw) filter (where o.status = 'paid' and (o.kind in ('reward', 'donation') or (o.kind = 'sponsor' and c.sponsor_counts))), 0)::bigint as raised_krw,
       count(o.id) filter (where o.status = 'paid' and (o.kind in ('reward', 'donation') or (o.kind = 'sponsor' and c.sponsor_counts)))::int as backers,
       count(o.id) filter (where o.status = 'paid' and o.kind = 'sponsor')::int as sponsors,
       (select count(*) from public.likes l where l.campaign_id = c.id)::int as likes
from public.campaigns c
left join public.orders o on o.campaign_id = c.id
where c.status <> 'draft'
group by c.id;
