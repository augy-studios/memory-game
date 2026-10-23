-- Memory Game schema, in the shared uwuapps Supabase project.
-- Paste into the Supabase SQL editor and run once.
-- Safe to run again: everything is "if not exists" or "or replace".
-- Never edit this file once it has been run; a change is a new numbered file.
--
-- Access model: only the Vercel functions in main-site/api touch these
-- tables, with the service role key. There is no Supabase Auth here. RLS is
-- on with no policies, so an anon key reads nothing.
--
-- The game runs in the browser. What the server holds is a run: the seed
-- it dealt, the time limits, the moment the game started by the server's
-- clock, and whether it has been submitted. A finished game's log is
-- replayed against the run by the API (main-site/js/rules.js, checkGame)
-- before uwumemy_submit is called.

-- One run is one scored game. Created by POST /api/run/start.
create table if not exists uwumemy_runs (
  id uuid primary key default gen_random_uuid(),
  client_key text not null,
  -- "NM-BXK4-M9TR": difficulty letter, pack letter, then the seed proper.
  seed text not null check (seed ~ '^[A-Z]{2}-[A-Z0-9]{4}-[A-Z0-9]{4}$'),
  -- Seconds per turn, and seconds per pair for the game; 0 for none.
  turn_limit int not null default 0 check (turn_limit between 0 and 600),
  game_limit int not null default 0 check (game_limit between 0 and 600),
  submitted boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists uwumemy_runs_created
  on uwumemy_runs (created_at);

-- One row per submitted game. The score is the server's own, worked out
-- from the log, which is kept so a game can be looked at again.
create table if not exists uwumemy_leaderboard (
  id bigserial primary key,
  name text not null check (char_length(name) between 1 and 20),
  score int not null check (score >= 0),
  pairs int not null check (pairs >= 0),
  turns int not null check (turns >= 0),
  duration_ms int not null check (duration_ms >= 0),
  finished boolean not null,
  seed text not null,
  log jsonb not null,
  run_id uuid not null unique references uwumemy_runs(id),
  started_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists uwumemy_lb_name
  on uwumemy_leaderboard (lower(name));

-- The two boards. One row per name, names compared case-insensitively.

-- Each name's best score. The earliest of an equal top score wins, and the
-- casing shown is the one attached to that score.
create or replace view uwumemy_leaderboard_best
with (security_invoker = true) as
select distinct on (lower(name)) name, score, created_at
from uwumemy_leaderboard
order by lower(name), score desc, created_at asc;

-- Every submitted game's score added up. The casing shown is the name's most
-- recent submission. Ties go to fewer games, then to whoever got there
-- first, which is the earlier last_at.
create or replace view uwumemy_leaderboard_total
with (security_invoker = true) as
select
  (array_agg(name order by created_at desc))[1] as name,
  sum(score)::bigint as total,
  count(*)::int as games,
  max(created_at) as last_at
from uwumemy_leaderboard
group by lower(name);

-- Short replay links, /r/<id>. A solo replay checked against its run is
-- verified; party games and offline games are stored as sent.
create table if not exists uwumemy_replays (
  id text primary key check (id ~ '^[A-Za-z0-9]{8}$'),
  kind text not null check (kind in ('solo', 'party')),
  verified boolean not null default false,
  run_id uuid unique references uwumemy_runs(id) on delete set null,
  body jsonb not null check (octet_length(body::text) <= 65536),
  created_at timestamptz not null default now()
);

alter table uwumemy_runs enable row level security;
alter table uwumemy_leaderboard enable row level security;
alter table uwumemy_replays enable row level security;

-- Submits a finished game under a name, with the score and counts the API
-- has already worked out. Repeats the checks that depend on the run row
-- under a lock, so two submits at once cannot both go through, and refuses
-- a game played at the same time as another already on the board under the
-- same name. The slack and time to live come from js/rules.js.
--
-- Returns the name's standing on both boards.
create or replace function uwumemy_submit(
  p_run_id uuid,
  p_client_key text,
  p_name text,
  p_score int,
  p_pairs int,
  p_turns int,
  p_duration_ms int,
  p_finished boolean,
  p_log jsonb,
  p_slack_ms int,
  p_ttl_ms int
)
returns table (
  status text,
  best_score int,
  best_rank bigint,
  total bigint,
  games int,
  total_rank bigint
)
language plpgsql
volatile
as $$
#variable_conflict use_column
declare
  v_run uwumemy_runs%rowtype;
  v_end timestamptz;
  v_best int;
  v_best_at timestamptz;
  v_total bigint;
  v_games int;
begin
  select * into v_run
  from uwumemy_runs r
  where r.id = p_run_id and r.client_key = p_client_key
  for update;

  if not found then
    status := 'not_found';
    return next;
    return;
  end if;
  if v_run.submitted then
    status := 'already_submitted';
    return next;
    return;
  end if;
  if v_run.created_at < now() - make_interval(secs => p_ttl_ms / 1000.0) then
    status := 'expired';
    return next;
    return;
  end if;
  -- A game cannot have lasted longer than the server has known about it.
  if p_duration_ms > extract(epoch from (now() - v_run.created_at)) * 1000 + p_slack_ms then
    status := 'implausible';
    return next;
    return;
  end if;

  v_end := v_run.created_at + make_interval(secs => p_duration_ms / 1000.0);
  if exists (
    select 1
    from uwumemy_leaderboard l
    where lower(l.name) = lower(p_name)
      and l.started_at < v_end
      and l.started_at + make_interval(secs => l.duration_ms / 1000.0) > v_run.created_at
  ) then
    status := 'overlap';
    return next;
    return;
  end if;

  update uwumemy_runs r set submitted = true where r.id = p_run_id;
  insert into uwumemy_leaderboard (name, score, pairs, turns, duration_ms, finished, seed, log, run_id, started_at)
  values (p_name, p_score, p_pairs, p_turns, p_duration_ms, p_finished, v_run.seed, p_log, p_run_id, v_run.created_at);

  select l.score, l.created_at into v_best, v_best_at
  from uwumemy_leaderboard l
  where lower(l.name) = lower(p_name)
  order by l.score desc, l.created_at asc
  limit 1;

  select sum(l.score)::bigint, count(*)::int into v_total, v_games
  from uwumemy_leaderboard l
  where lower(l.name) = lower(p_name);

  status := 'ok';
  best_score := v_best;
  best_rank := (
    select count(*) + 1
    from uwumemy_leaderboard_best b
    where b.score > v_best or (b.score = v_best and b.created_at < v_best_at)
  );
  total := v_total;
  games := v_games;
  total_rank := (
    select count(*) + 1
    from uwumemy_leaderboard_total t
    where lower(t.name) <> lower(p_name)
      and (
        t.total > v_total
        or (t.total = v_total and t.games < v_games)
        -- This name's total was only just reached, so an equal one got there first.
        or (t.total = v_total and t.games = v_games)
      )
  );
  return next;
end;
$$;

-- Housekeeping, called now and then by /api/run/start: runs nobody
-- submitted that are past any use. A replay made from one keeps its body
-- and loses only the link to the run.
create or replace function uwumemy_prune()
returns void
language sql
volatile
as $$
  delete from uwumemy_runs r
  where r.created_at < now() - interval '1 day'
    and not r.submitted
    and not exists (select 1 from uwumemy_leaderboard l where l.run_id = r.id);
$$;

-- Service role only.
revoke all on function uwumemy_submit(uuid, text, text, int, int, int, int, boolean, jsonb, int, int) from public, anon, authenticated;
revoke all on function uwumemy_prune() from public, anon, authenticated;
grant execute on function uwumemy_submit(uuid, text, text, int, int, int, int, boolean, jsonb, int, int) to service_role;
grant execute on function uwumemy_prune() to service_role;
