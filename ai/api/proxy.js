// Tabspace AI proxy: the only thing that touches your API key.
// Set OPENROUTER_API_KEY as an environment variable in this app's Wasmer settings.
// Optional: set ALLOWED_ORIGIN to your site's URL (e.g. https://tabspace.wasmer.app) so only your site can use it.

const MODEL = "anthropic/claude-haiku-5.5";
const SYSTEM_PROMPT = "You are Tabspace AI, a helpful, concise assistant. Use markdown for formatting and code blocks for code.";
const MAX_TOKENS = 4096;
const RATE_LIMIT = 20, RATE_WINDOW = 60000;   // 20 requests per visitor per minute

const env = (typeof process !== "undefined" && process.env) ? process.env : {};
const hits = new Map();

const cors = () => ({
  "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
});
const json = (status, message) =>
  new Response(JSON.stringify({ error: { message } }), {
    status, headers: { "Content-Type": "application/json", ...cors() }
  });

function limited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < RATE_WINDOW);
  const hit = recent.length >= RATE_LIMIT;
  if (!hit) recent.push(now);
  hits.set(ip, recent);
  return hit;
}

async function handle(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
  if (req.method !== "POST" || new URL(req.url).pathname !== "/api/chat") return json(404, "Not found");

  const key = env.OPENROUTER_API_KEY;
  if (!key) return json(500, "Server is missing the OPENROUTER_API_KEY environment variable.");

  const ip = (req.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
  if (limited(ip)) return json(429, "Too many requests. Wait a moment and try again.");

  let msgs;
  try {
    const data = await req.json();
    msgs = data.messages.slice(-60)
      .filter(m => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map(m => ({ role: m.role, content: m.content.slice(0, 20000) }));
    if (!msgs.length) throw new Error("empty");
  } catch (e) { return json(400, "Bad request."); }

  let up;
  try {
    up = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json", "X-Title": "Tabspace AI" },
      body: JSON.stringify({
        model: MODEL, stream: true, max_tokens: MAX_TOKENS,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...msgs]
      })
    });
  } catch (e) { return json(502, "Could not reach the AI provider."); }

  if (!up.ok) {
    let msg = "";
    try { msg = (await up.json()).error.message; } catch (e) {}
    return json(up.status === 401 ? 502 : up.status, msg || "The AI provider returned an error.");
  }
  return new Response(up.body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...cors() } });
}

addEventListener("fetch", (event) => event.respondWith(handle(event.request)));
