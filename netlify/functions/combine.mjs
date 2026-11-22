// ZZ Craft shared brain: every combination is generated once by AI, then saved for ALL players.
import { getStore } from "@netlify/blobs";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

const clean = (s) => String(s || "").replace(/[\u0000-\u001f<>{}\[\]"`\\]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
const norm = (s) => clean(s).toLowerCase();
const pairKey = (a, b) => { const x = norm(a), y = norm(b); return (x < y ? x + "|" + y : y + "|" + x).replace(/[^a-z0-9|]+/g, "_"); };
const itemKey = (n) => norm(n).replace(/[^a-z0-9]+/g, "_");

const SYSTEM = `You are the crafting engine of the game Infinite Craft. The player drags two elements together and you answer with the ONE thing they make.

Rules:
- Answer with the single most natural, obvious result: a real thing, concept, place, food, animal, famous person, character, brand, or meme. 1-3 words, Title Case.
- It should feel like the original game: Water + Fire = Steam, Earth + Water = Plant, Fire + Earth = Lava, Wind + Wind = Tornado, Steam + Earth = Geyser, Plant + Plant = Tree, Lava + Water = Obsidian, Human + Fire = Cook, Dragon + Knight = Hero, Sun + Sand = Desert, Cloud + Fire = Lightning.
- Two identical things make a bigger, stronger or more advanced version (Water + Water = Lake, Fire + Fire = Volcano, Plant + Plant = Tree).
- NEVER just glue the two words together ("Water Fire"), never repeat an input word as the result, and never answer "Nothing" or explain yourself.
- Prefer common real nouns. Famous people and characters are allowed when the pair clearly points to them. No profanity, slurs or sexual content: pick a harmless real thing instead.
- Pick a fitting emoji.
Reply with ONLY JSON: {"emoji":"<single emoji>","name":"<result>"}`;

// Prefer GROQ_API_KEY. Otherwise accept a variable whose NAME is the key itself (starts with gsk_),
// using its value, or the name if the value isn't a key.
function findKey() {
  const direct = Netlify.env.get("GROQ_API_KEY");
  if (direct) return direct;
  const all = Netlify.env.toObject();
  for (const [name, value] of Object.entries(all)) {
    if (name.startsWith("gsk_")) return String(value || "").startsWith("gsk_") ? value : name;
  }
  return null;
}

function looksBad(name, a, b) {
  const n = name.toLowerCase(), x = a.toLowerCase(), y = b.toLowerCase();
  if (n === x || n === y) return true;                         // just echoes an input
  if (n.includes(x) && n.includes(y)) return true;             // glues both inputs together
  if (name.split(" ").length > 3) return true;                 // run-on names
  if (/^(super|giant|mega|tiny|double)\b/.test(n) && !/^(super|giant|mega|tiny|double)\b/.test(x + y) === false) return true;
  return false;
}

const PREFERRED = ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "llama-3.1-8b-instant", "openai/gpt-oss-20b", "qwen/qwen3.8-27b", "meta-models/muse-spark-open"];
let modelCache = null; // survives while the function instance is warm
async function pickModels(key) {
  const override = Netlify.env.get("GROQ_MODEL");
  if (modelCache && Date.now() - modelCache.t < 600000) return modelCache.list;
  let list = PREFERRED;
  try {
    const r = await fetch("https://api.groq.com/openai/v1/models", { headers: { Authorization: "Bearer " + key } });
    if (r.ok) {
      const ids = ((await r.json()).data || []).map((m) => m.id);
      const usable = PREFERRED.filter((m) => ids.includes(m));
      // anything else chat-like the key can use, as a last resort
      const extra = ids.filter((id) => !PREFERRED.includes(id) && !/whisper|tts|orpheus|guard|embed|playai/i.test(id));
      list = [...usable, ...extra];
      console.log("groq models available:", ids.join(", "));
    } else console.error("groq models list failed", r.status);
  } catch (e) { console.error("groq models list error", e && e.message); }
  if (override) list = [override, ...list.filter((m) => m !== override)];
  modelCache = { t: Date.now(), list };
  return list;
}

async function askGroq(a, b) {
  const key = findKey();
  if (!key) throw new Error("no Groq key found");
  const models = (await pickModels(key)).slice(0, 3);
  let lastErr;
  for (const model of models) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 7000);
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
        body: JSON.stringify({
          model,
          temperature: 0.3,
          max_tokens: /gpt-oss|qwen|minimax/i.test(model) ? 600 : 60,
          ...(/gpt-oss/i.test(model) ? { reasoning_effort: "low" } : {}),
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: `${a} + ${b}` },
          ],
        }),
      });
      clearTimeout(t);
      if (!r.ok) { const body = (await r.text().catch(() => "")).slice(0, 300); throw new Error("groq " + r.status + " [" + model + "] " + body); }
      const j = await r.json();
      const o = JSON.parse(j.choices[0].message.content);
      const name = clean(o.name);
      const emoji = String(o.emoji || "").trim().slice(0, 8) || "❓";
      if (!name || name.length < 2) throw new Error("bad name");
      if (name.toLowerCase() === "nothing") throw new Error("nothing");
      if (looksBad(name, a, b)) throw new Error("bad result");
      return { name, emoji };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

export default async (req) => {
  const url = new URL(req.url);
  let a = url.searchParams.get("a"), b = url.searchParams.get("b");
  if (req.method === "POST") { try { const j = await req.json(); a = j.a; b = j.b; } catch {} }
  a = clean(a); b = clean(b);
  if (!a || !b) return json({ error: "need a and b" }, 400);

  const recipes = getStore("zz-recipes");
  const items = getStore("zz-items");
  const key = pairKey(a, b);

  try {
    const hit = await recipes.get(key, { type: "json" });
    if (hit) return json({ ...hit, first: false });
  } catch {}

  let res;
  try { res = await askGroq(a, b); }
  catch (e) {
    console.error("combine failed:", a, "+", b, "->", e && e.message);
    const names = Object.keys(Netlify.env.toObject());
    return json({ error: "ai_failed", why: String(e && e.message), keyFound: !!findKey(), gskVarSeen: names.some((n) => n.startsWith("gsk_")), groqVarSeen: names.includes("GROQ_API_KEY") }, 502);
  }

  // save for everyone; onlyIfNew means the first writer wins if two players race
  let first = false;
  try {
    const { modified } = await recipes.setJSON(key, res, { onlyIfNew: true });
    if (!modified) {
      const existing = await recipes.get(key, { type: "json" });
      if (existing) return json({ ...existing, first: false });
    } else {
      const made = await items.setJSON(itemKey(res.name), { name: res.name, emoji: res.emoji, t: Date.now() }, { onlyIfNew: true });
      first = !!made.modified;
    }
  } catch {}
  return json({ ...res, first });
};

export const config = {
  path: "/api/combine",
  method: ["GET", "POST"],
  rateLimit: { action: "rate_limit", aggregateBy: ["ip", "domain"], windowSize: 60, windowLimit: 60 },
};
