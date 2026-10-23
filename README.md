# Memory Game

Flip cards and find every pair. Four board sizes, five picture packs, a flat
board or a 3D one with models on the cards, turn and game clocks that score
more, seeds to share a board, an instant replay of every game, short links to
share it, a leaderboard, and party games for two to four players on the same
wifi. A PWA: once opened, everything plays offline.

Live at <https://memy.uwuapps.org>.

## What runs where

| Part | Runs on |
| --- | --- |
| `main-site/`, the PWA and its API (`main-site/api/`) | Vercel, root directory `main-site` |
| Database, `uwumemy_*` tables | The shared uwuapps Supabase project |
| Party games | Browser to browser over WebRTC. PeerJS's public broker introduces the devices; nothing of ours is in between |

The game runs entirely in the browser. The server deals scored games, checks
them before they go on the leaderboard, and stores short replay links.

## Layout

```text
README.md
migrations/      SQL to run in the Supabase SQL editor, in number order
scripts/         pre-deploy checks and the rules test
main-site/       the site Vercel deploys, including api/
```

The specs at the root are what this is built to: `uwuapps-theme.md` and
`uwuapps-retrofit-time-mode.md` (theme, with time-based mode),
`update-bar-spec.md` (the update prompt), `edge-tray-spec.md` (the tray the
header becomes in full screen) and `STUN-p2p-spec.md` (party pairing).
`main-site/README.md` covers the app itself.

## First setup

1. Run every file in `migrations/`, in number order, in the Supabase SQL
   editor of the shared uwuapps project. Each is safe to run again. Never edit
   one that has been run; a change is a new numbered file.
2. On the Vercel project (root directory `main-site`), set the variables in
   `main-site/.env.example`: `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`.
3. Add the domain `memy.uwuapps.org` to the Vercel project.
4. Deploy.

Without the variables the site still works in full; the API answers
`not_configured`, games say they are not scored, and shared replays use long
links.

| Migration | What it does |
| --- | --- |
| `001_uwumemy_schema.sql` | Runs, the leaderboard and its two boards, short replay links, and the submit and prune functions. |

## Before every deploy

1. Bump `VERSION` in `main-site/sw.js`. Without it, returning visitors keep
   the previous build and never see the update bar.
2. Run the checks, from the repo root, with Node 20 or later and nothing to
   install:

```text
node scripts/check-sw.mjs          # the worker only activates when asked
node scripts/check-precache.mjs    # everything the site serves is precached
node scripts/check-theme.mjs       # pre-paint script matches js/theme.js
node scripts/check-p2p.mjs         # party pairing is STUN only
node scripts/test-rules.mjs        # seeds, scoring, anti-cheat, replay links
```

**If you change `js/rules.js`, `js/seed.js` or the picture lists,** games
played on the old build stop verifying, and old seeds deal different boards:
the API replays every game with the code it has now. Adding a picture at the
end of a pack is safe; reordering or removing one is not.

## Leaderboard integrity

A browser game cannot prove its score, and the board is dealt in the browser
from the seed, so a script can know it. What the API does instead, with
`checkGame` in `main-site/js/rules.js`, is refuse a game real play could not
have made:

- it replays the log from the run's own seed and limits and works the score
  out itself, refusing any move the rules would not allow
- a game longer than the time the server saw pass since its run started
- cards turned over quicker than a hand can, more than now and then
- matches on cards whose partner had never been seen, more than chance
  allows: refused when chance would give that many less than once in a
  million games, which every script that knows the board hits
- a game played at the same time as another under the same name

Only games dealt by the server count: a pasted seed's board could be known in
advance, and an offline game never started a run. Each run can be submitted
once, only from the browser that started it, within three hours. This bounds
cheating; it does not prevent it. A script that plays like a person, misses
included, gets through.
