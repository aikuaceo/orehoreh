-- Sample catalogue matching the campaigns shown on orehoreh.com (all figures are examples to edit before launch).
-- c1, c2: donation projects; donations stay closed until a nonprofit collector registers (value participation is open).
-- c3: reward project open from today so test payments work. Set the real dates before launch.
insert into public.campaigns (id, status, track, goal_krw, starts_on, ends_on, video_url) values
  ('c1', 'live', 'donation', 30000000, '2026-10-26', '2027-03-31', 'assets/video/oreh-film.mp4'),
  ('c2', 'live', 'donation', 50000000, '2026-10-26', '2027-04-07', null),
  ('c3', 'live', 'reward', 20000000, '2026-10-26', '2027-05-12', null),
  ('c4', 'soon', 'reward', 10000000, '2027-04-20', '2027-05-19', null)
on conflict (id) do nothing;

-- the site's reward tiers, for reward projects only (rw0 = digital postcards, emailed)
insert into public.rewards (id, campaign_id, amount_krw, ships, stock, sort)
select c.id || '-' || r.key, c.id, r.amount, r.ships, r.stock, r.sort
from public.campaigns c
cross join (values ('rw0', 5000, false, null::int, 0), ('rw1', 10000, true, null, 1), ('rw2', 30000, true, null, 2),
                   ('rw3', 50000, true, null, 3), ('rw4', 100000, true, 100, 4)) as r(key, amount, ships, stock, sort)
where c.track = 'reward'
on conflict (id) do nothing;

-- value participation (가치참여): Leon's 15-second introduction, shown for the campaign's run
insert into public.sponsor_packages (id, sponsor_type, amount_krw, days) values
  ('person-30', 'person', 50000, 30),
  ('company-30', 'company', 1000000, 30)
on conflict (id) do nothing;
