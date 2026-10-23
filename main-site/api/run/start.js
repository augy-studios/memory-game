// POST /api/run/start  { client_key, difficulty, pack, turn, limit }
//   -> { run_id, seed, expires_in }
// Deals a scored game: the server picks the seed and starts its clock. A
// finished game can only go on the leaderboard under a run, and is checked
// against this seed, these limits and the time the server saw pass.

import { randomInt } from "node:crypto";
import { clientKey, endpoint } from "../_lib/http.js";
import { rest, rpc } from "../_lib/supabase.js";
import { RUN_TTL_MS, cleanDifficulty, cleanLimit, cleanPack, cleanTurn } from "../../js/rules.js";
import { newSeed } from "../../js/seed.js";

export default endpoint("POST", async ({ body }) => {
  const key = clientKey(body.client_key);
  const seed = newSeed(cleanDifficulty(body.difficulty), cleanPack(body.pack), () => randomInt(256));

  const [run] = await rest("uwumemy_runs", {
    method: "POST",
    body: { client_key: key, seed: seed.text, turn_limit: cleanTurn(body.turn), game_limit: cleanLimit(body.limit) },
    prefer: "return=representation",
  });

  // Now and then, clear out runs nobody submitted.
  if (randomInt(50) === 0) rpc("uwumemy_prune", {}).catch((err) => console.warn("prune failed:", err.message));

  return { run_id: run.id, seed: seed.text, expires_in: RUN_TTL_MS };
});
