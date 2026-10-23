// POST /api/replay/create  { replay, run_id?, client_key? } -> { id }
//
// Stores a replay, in js/replay-format.js's format, for the short link
// /r/<id>. Names are run through the leaderboard's word filter.
//
// A solo replay sent with the run it was played under is checked the way a
// submission is, and marked verified if it passes; one replay per run, so
// asking again returns the same id. Anything else, a party game or a game
// played offline, is stored as sent and marked unverified.

import { randomInt } from "node:crypto";
import { clientKey, endpoint, HttpError, runId } from "../_lib/http.js";
import { cleanName } from "../_lib/names.js";
import { rest } from "../_lib/supabase.js";
import { checkRun, endOf, loadRun, setupOfRun } from "../_lib/runs.js";
import { cleanReplay } from "../../js/replay-format.js";

const ID_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
const ID_LENGTH = 8;
const MAX_BYTES = 64 * 1024;

const newId = () => Array.from({ length: ID_LENGTH }, () => ID_ALPHABET[randomInt(ID_ALPHABET.length)]).join("");

function nameOrNull(value) {
  try {
    return cleanName(value);
  } catch {
    return null;
  }
}

async function existingFor(run) {
  const [row] = (await rest(`uwumemy_replays?run_id=eq.${run}&select=id`)) ?? [];
  return row?.id ?? null;
}

async function store(row) {
  // Eight characters from 55 make a clash vanishingly rare, but a second try
  // costs nothing.
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = newId();
    try {
      await rest("uwumemy_replays", { method: "POST", body: { id, ...row } });
      return id;
    } catch (err) {
      if (!/supabase 409/.test(err.message ?? "")) throw err;
      // Asked twice at once for one run: the other request stored it.
      if (row.run_id) {
        const id = await existingFor(row.run_id);
        if (id) return id;
      }
    }
  }
  throw new HttpError(503, "busy", "Could not store the replay. Try again.");
}

export default endpoint("POST", async ({ body }) => {
  const replay = cleanReplay(body.replay);
  if (!replay) throw new HttpError(400, "bad_replay", "That is not a replay.");
  replay.players = replay.players.map((p, i) => nameOrNull(p) ?? `Player ${i + 1}`);
  if (new TextEncoder().encode(JSON.stringify(replay)).length > MAX_BYTES) {
    throw new HttpError(413, "too_big", "That game is too long to store. Share the long link instead.");
  }

  let verified = false;
  let run = null;
  if (body.run_id && replay.kind === "solo") {
    const id = runId(body.run_id);
    const found = await loadRun(id, clientKey(body.client_key));
    if (found && found.seed === replay.seed && found.turn_limit === replay.turn && found.game_limit === replay.limit) {
      const existing = await existingFor(id);
      if (existing) return { id: existing };
      const end = endOf(setupOfRun(found, "Player"), replay.log);
      const check = end === null ? { reason: "not_finished" } : checkRun(found, replay.log, end);
      if (!check.reason) {
        verified = true;
        run = id;
      }
    }
  }

  return { id: await store({ kind: replay.kind, verified, run_id: run, body: replay }) };
});
