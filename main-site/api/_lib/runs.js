// A run as the rules want it, and its game checked against it. Shared by
// submit, which puts a game on the leaderboard, and replay/create, which
// marks a replay as checked.

import { rest } from "./supabase.js";
import { advance, checkGame, createGame, flip } from "../../js/rules.js";
import { parseSeed } from "../../js/seed.js";

export async function loadRun(id, key) {
  const [run] =
    (await rest(
      `uwumemy_runs?select=id,created_at,submitted,seed,turn_limit,game_limit&id=eq.${id}&client_key=eq.${encodeURIComponent(key)}&limit=1`
    )) ?? [];
  return run ?? null;
}

export const setupOfRun = (run, name) => ({
  seed: parseSeed(run.seed),
  turn: run.turn_limit,
  limit: run.game_limit,
  players: [name],
});

// When a solo log's game ended: its last match, or its game clock.
export function endOf(setup, log) {
  const state = createGame(setup);
  for (const [t, card] of log) if (!flip(state, card, t)) break;
  if (state.phase === "play" && state.gameMs) advance(state, state.gameMs);
  return state.endedAt;
}

export function checkRun(run, log, durationMs) {
  const elapsed = Date.now() - Date.parse(run.created_at);
  return { elapsed, ...checkGame(setupOfRun(run, "Player"), log, durationMs, elapsed) };
}
