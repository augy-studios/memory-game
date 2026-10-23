// Calls to the API. The game itself runs in the page and works offline;
// only scored runs, the leaderboard and short replay links need the network.

import { store } from "./ui.js";

const KEY_STORAGE = "uwumemy.clientKey";

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

// A random id tying this browser's requests to its own runs. Not an
// identity: it grants nothing and is never shown.
function makeKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function clientKey() {
  let key = store.get(KEY_STORAGE);
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(key ?? "")) {
    key = makeKey();
    store.set(KEY_STORAGE, key);
  }
  return key;
}

async function call(method, path, body, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(path, {
      method,
      signal: controller.signal,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "offline", "This needs a connection.");
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    // An HTML error page from the platform, not the API.
  }
  if (!response.ok) throw new ApiError(response.status, data?.error ?? "server", data?.message);
  return data;
}

export const api = {
  // Short, so a slow connection falls back to an unscored game rather than
  // keeping somebody waiting at the start button.
  startRun: (options) => call("POST", "/api/run/start", { client_key: clientKey(), ...options }, { timeoutMs: 4000 }),
  checkName: (name) => call("POST", "/api/leaderboard/name", { name }),
  submit: (runId, name, log, durationMs) =>
    call("POST", "/api/leaderboard/submit", { run_id: runId, client_key: clientKey(), name, log, duration_ms: durationMs }),
  leaderboard: (board) => call("GET", `/api/leaderboard?board=${encodeURIComponent(board)}`),
  createReplay: (replay, runId) =>
    call("POST", "/api/replay/create", { replay, run_id: runId ?? undefined, client_key: runId ? clientKey() : undefined }),
  replay: (id) => call("GET", `/api/replay?id=${encodeURIComponent(id)}`),
};
