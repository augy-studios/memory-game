# main-site

What Vercel deploys, served at <https://memy.uwuapps.org>. No build step:
the files are served as they are, and `api/` holds the serverless functions.

| Path | What it is |
| --- | --- |
| `index.html` | The only page. Its `<head>` is the template for any page added later. |
| `404.html`, `404.css` | The template's not-found page, as it was. |
| `sw.js` | Service worker: the offline shell, and the update bar's waiting worker. |
| `manifest.json` | PWA manifest. |
| `css/theme.css` | The uwuapps theme, verbatim from `uwuapps-theme.md`, time-based mode included. |
| `css/style.css` | Layout, the cards, the tray. Fixed-meaning colours (card face, QR) are tokens at the top. |
| `js/` | ES modules, below. |
| `api/` | The API, below. |
| `tiles/` | The pictures, one folder per pack. |
| `models/` | The 3D models for the food, pets and holiday packs, with each pack's texture. |
| `vendor/` | three.js 0.186.1 (MIT) and PeerJS 1.5.4 (MIT), served from here so they are precached. |
| `fonts/` | Jua, self-hosted, with its licence. |
| `images/` | Manifest screenshots. |

## js

Every file here is precached; `scripts/check-precache.mjs` fails if one is
not. `rules.js`, `seed.js` and `replay-format.js` are pure, with no DOM, and
the API imports them, so the browser and the server always agree on a game.

| File | What it does |
| --- | --- |
| `rules.js` | The rules: difficulties, picture packs, the deal, turns, timeouts, scoring, and the server's check of a finished game. |
| `seed.js` | Seeds. |
| `replay-format.js` | The replay format, and packing a whole game into a long link. |
| `board.js` | The board: the flat cards, and the switch to 3D. The flat cards stay for the keyboard and screen readers in 3D too. |
| `board3d.js` | The 3D board, with three.js. Loaded only when chosen. |
| `game.js` | A solo game: start, play, pause, the result, submitting, seeds, resuming after a reload. |
| `replay.js` | The instant replay, and sharing replays. |
| `p2p.js` | Pairing over PeerJS, STUN only, verbatim from `STUN-p2p-spec.md`. |
| `party.js` | Party games on top of `p2p.js`: hosting, joining, the lobby, the game, the messages. |
| `qr.js` | QR encoder for the join link, from uwuPromptr, so it works offline. |
| `fullscreen.js` | Full screen, and the header turning into the Edge Tray. |
| `api.js`, `leaderboard.js`, `settings.js` | The API client, and the leaderboard and settings windows, after MRT Station Guesser's. |
| `theme.js`, `icons.js`, `ui.js`, `update-bar.js`, `app.js` | Theme, inline SVG icons, view, modal and storage helpers, the update bar, and boot. |

## The game

**Playing.** Turn over two cards a turn. A pair stays face up; a miss turns
back after a moment, or as soon as the next card is turned. Cards work by
tap, click, or the keyboard: arrow keys move between cards, Enter or Space
turns one. `P` pauses, which stops the clock and hides the board. A game left
in a tab is paused when the tab is hidden, and a reload comes back to it
paused (Resume game).

**Difficulty.** Easy is 4 by 4, Normal 6 by 4, Hard 6 by 6, Expert 8 by 6. A
wide board turns on its side on a tall screen.

**Pictures.** Five packs, 114 pictures in all. The pack decides the view:
flat packs play on the flat board, 3D packs on the 3D one, and a board is
never part of each. Mixed draws from every flat pack, Mixed 3D from every 3D
pack, and a pack smaller than the board is topped up from the others of its
kind.

| Pack | Pictures | View | Source |
| --- | --- | --- | --- |
| Jungle | 12 | flat | The original game's tiles |
| Animals | 30 | flat | Kenney, Animal Pack Redux, CC0 |
| Food | 30 | 3D, models | Kenney, Food Kit, CC0 |
| Pets | 24 | 3D, animated models | Kenney, Cube Pets, CC0 |
| Holiday | 18 | 3D, models | Kenney, Holiday Kit, CC0 |

**3D.** The 3D packs are drawn with three.js: thick cards on a table that
flip over, each face with a model on it that turns slowly; the pets idle,
cheer on a match and sulk on a miss. Where WebGL is not available a 3D pack
plays flat, and the new game card says so. Replays and party games follow
the pack, so everyone sees a game in the view it was played in.

**Full screen.** The first header button. The footer goes, the board grows,
and the header's buttons become the Edge Tray (`edge-tray-spec.md`, as in
sg-psi): a column top right that slides off the edge to an arrow tab. Whether
it is open is remembered. Where the browser cannot go full screen, as Safari
on iPhone, it fills the window instead.

**Seeds.** A seed looks like `NM-BXK4-M9TR`: difficulty (E, N, H, X), pack
(M mixed, J jungle, A animals; D mixed 3D, F food, P pets, W holiday), and
eight characters. The pack letter also fixes flat or 3D. The same seed
always deals the same board. It shows during play
and at the end, where it can be copied; paste one on the new game card or
the result to play that board. Eight characters on their own use the current
difficulty and pack.

**Scoring.** The score grows as the game goes on.

| | Points |
| --- | --- |
| A match | 100 |
| Each match in a row after the first | +20% on that match, up to +100% |
| A quick turn | up to +50% on that match: full at 1.5 s, nothing at 10 s or the turn limit |
| A miss on a card whose pair had been seen (a slip) | minus 25 |
| Clearing the board in few turns | 60 x pairs x pairs / turns |
| Time to spare | up to +50%, by the share of the game clock left (12 s a pair without one) |

The total is then scaled by the difficulty (100%, 150%, 225%, 350%), the
turn limit (none 100%, 10 s 110%, 5 s 125%, 3 s 150%) and the game clock
(none 100%, Relaxed 110%, Brisk 125%, Tight 150%, at 12, 8 and 5 seconds a
pair). Running out of turn time ends the turn; running out of game clock ends
the game, keeping the points so far but no finishing bonus.

**Replay.** Watch replay on the result, or automatically (a setting). Every
card, match, miss and timeout plays back in order, with a caption, the score
as it was, and a red tick on the timeline at each miss. Play and pause, a
step back or forward, drag the timeline, and 0.5x to 4x, as Word Rain's; the
speed is remembered. `Space`, `←` `→` and `Esc` work too.

**Sharing a replay.** Share replay makes a link through the share sheet or
the clipboard. Online it is short, `/r/<id>`, stored by `/api/replay/create`
as MRT Station Guesser's are. Offline, or if the API will not take it, the
link holds the whole game, as chess-game's do:
`/?watch=<moves>&seed=...&turn=...&limit=...&names=...`, a couple of bytes a
move. Every score in a replay is worked out again from its moves. A solo
replay made from a scored run is checked by the server and says so; anything
else says it is not checked.

**Settings,** kept in this browser, as MRT Station Guesser's:

| Setting | Default | What it does |
| --- | --- | --- |
| Leaderboard name | not set | Checked by `/api/leaderboard/name`; also saved by every successful submit. |
| Add finished games automatically | off | Needs a name. |
| Play the replay when a game ends | off | |
| Difficulty | Normal | From the next game. |
| Pictures | Mixed | From the next game. |
| Time per turn | None | None, 10, 5 or 3 seconds. |
| Game clock | None | None, Relaxed, Brisk or Tight. |

**Leaderboards.** Best score and total points, one row per name, as MRT
Station Guesser's. Only games the server dealt count; see the root README
for what it checks.

## Party games

The people button. One device hosts and shows a code, a QR code and a link
(`/join?id=CODE`); up to three more join, four players in all. The host picks
the board, the pictures and the time per turn, and starts. Players take
turns, a match keeps the turn, and a timed-out turn passes. The host's device
runs the game with `rules.js` and sends each guest a snapshot 20 times a
second, showing only the pictures on face-up cards and the seed only at the
end. At the end everyone gets the replay, to watch or share.

Pairing follows `STUN-p2p-spec.md`, the way uwuPromptr's remote pairs: STUN
only, no TURN relay. **Everyone has to be on the same network**: the same
wifi, or one device sharing a hotspot and the others joining it. Guest wifi
that isolates devices will not work. A guest that drops rejoins its seat by
itself; a host that reloads carries on with the same game and code. Party
games never go on the leaderboard.

**Privacy:** in a party game each device learns the others' public IP
addresses, as any peer-to-peer connection does, and PeerJS's broker sees
peer ids and IP addresses, never the game. The privacy policy should say so.

## Offline and updates

Everything the site serves is precached on the first visit: the page, every
module, the font, all 114 pictures, the 72 models and their textures,
three.js and PeerJS. The whole game, both views and replays included, plays
with no connection. Only scoring, the leaderboard, short replay links and
pairing a party need the network; nothing under `/api/` is ever cached.
Analytics and ads are other sites and simply fail offline.

A new service worker installs and waits. The update bar offers Reload or Not
now, and nothing reloads until the player asks (`update-bar-spec.md`). Bump
`VERSION` in `sw.js` on every change to anything in this directory.

## API

| Endpoint | Body | Returns |
| --- | --- | --- |
| `POST /api/run/start` | `client_key, difficulty, pack, turn, limit` | `run_id, seed, expires_in` |
| `POST /api/leaderboard/submit` | `run_id, client_key, name, log, duration_ms` | `name, score, rank, best_score, total, games, total_rank` |
| `POST /api/leaderboard/name` | `name` | `name`, cleaned, or a `400` saying why not |
| `GET /api/leaderboard` | `?board=best` (default) or `?board=total` | `board, entries`, cached 30 s |
| `POST /api/replay/create` | `replay`, and `run_id, client_key` for a scored game | `id`, for `/r/<id>` |
| `GET /api/replay` | `?id=<id>` | `id, kind, verified, created_at, replay`, cached a day |

`log` is every card turned over, `[ms into the game, card]`. The score is
never taken from the browser. Errors are `{ error, message? }`: `400` bad
input, `404` no such run for this browser, `409` already submitted or
overlapping, `410` older than three hours, `422` a game real play could not
have made (the reason goes to the logs, not the caller). There is no login
and there are no rate limits.

## Environment variables (Vercel)

Documented in `.env.example`. `.vercelignore` keeps every env file out of
deployments, since anything in this directory would otherwise be served.

| Variable | Used for |
| --- | --- |
| `SUPABASE_URL` | The shared uwuapps project. |
| `SUPABASE_SERVICE_KEY` | Service role key. Server side only, never sent to a browser. |
