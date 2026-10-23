// POST /api/leaderboard/submit  { run_id, client_key, name, log, duration_ms }
//   -> { name, score, rank, best_score, total, games, total_rank }
//
// The game runs in the browser, so what arrives is its log: every card
// turned over and when. The server replays it from the run's own seed and
// limits with js/rules.js, the module the game plays by, works the score
// out itself, and refuses anything real play could not have made (see
// checkGame there). That bounds cheating; it does not prevent it.

import { clientKey, endpoint, HttpError, runId } from "../_lib/http.js";
import { cleanName } from "../_lib/names.js";
import { rpc } from "../_lib/supabase.js";
import { checkRun, loadRun } from "../_lib/runs.js";
import { CLOCK_SLACK_MS, RUN_TTL_MS } from "../../js/rules.js";

const REFUSALS = {
  not_found: [404, "That game is not one this browser started."],
  already_submitted: [409, "That game is already on the leaderboard."],
  expired: [410, "That game is more than three hours old."],
  overlap: [409, "That game was played at the same time as another game already on the leaderboard under this name."],
  implausible: [422, "That game's moves do not add up, so it was not added."],
};

const refuse = (reason) => {
  const [status, message] = REFUSALS[reason] ?? [500, "Could not submit."];
  return new HttpError(status, REFUSALS[reason] ? reason : "server", message);
};

export default endpoint("POST", async ({ body }) => {
  const id = runId(body.run_id);
  const key = clientKey(body.client_key);
  const name = cleanName(body.name);

  const run = await loadRun(id, key);
  if (!run) throw refuse("not_found");
  if (run.submitted) throw refuse("already_submitted");
  if (Date.now() - Date.parse(run.created_at) > RUN_TTL_MS) throw refuse("expired");

  const check = checkRun(run, body.log, body.duration_ms);
  if (check.reason) {
    // The reason stays in the logs. Telling the caller which bound it hit
    // would only help tune the next attempt.
    const moves = Array.isArray(body.log) ? body.log.length : typeof body.log;
    console.warn(`implausible run ${id}: ${check.reason}`, { moves, duration: body.duration_ms, elapsed: check.elapsed });
    throw refuse("implausible");
  }
  const r = check.result;

  // The function repeats the ownership, submitted and expiry checks under a
  // row lock, so two submits at once cannot both go through, and refuses a
  // game that overlaps another under the same name.
  const [row] =
    (await rpc("uwumemy_submit", {
      p_run_id: id,
      p_client_key: key,
      p_name: name,
      p_score: r.score,
      p_pairs: r.pairs,
      p_turns: r.turns,
      p_duration_ms: body.duration_ms,
      p_finished: check.state.reason === "done",
      p_log: body.log,
      p_slack_ms: CLOCK_SLACK_MS,
      p_ttl_ms: RUN_TTL_MS,
    })) ?? [];
  if (row?.status !== "ok") throw refuse(row?.status);

  return {
    name,
    score: r.score,
    rank: Number(row.best_rank),
    best_score: row.best_score,
    total: Number(row.total),
    games: row.games,
    total_rank: Number(row.total_rank),
  };
});
