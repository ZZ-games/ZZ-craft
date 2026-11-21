// ZZ Craft shared brain: every combination is generated once by AI, then saved for ALL players.
import { getStore } from "@netlify/blobs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });

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

async function askGroq(a, b) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY not set");
  const models = [process.env.GROQ_MODEL || "llama-3.3-70b-versatile", "llama-3.1-8b-instant"];
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
          max_tokens: 60,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: `${a} + ${b}` },
          ],
        }),
      });
      clearTimeout(t);
      if (!r.ok) throw new Error("groq " + r.status);
      const j = await r.json();
      const o = JSON.parse(j.choices[0].message.content);
      const name = clean(o.name);
      const emoji = String(o.emoji || "").trim().slice(0, 8) || "❓";
      if (!name || name.length < 2) throw new Error("bad name");
      if (name.toLowerCase() === "nothing") throw new Error("nothing");
      return { name, emoji };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
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
  catch (e) { return json({ error: "ai_failed" }, 502); }

  // save for everyone (don't overwrite if another player raced us)
  let first = false;
  try {
    const existing = await recipes.get(key, { type: "json" });
    if (existing) return json({ ...existing, first: false });
    await recipes.setJSON(key, res);
    const ik = itemKey(res.name);
    const seen = await items.get(ik, { type: "json" });
    if (!seen) { first = true; await items.setJSON(ik, { name: res.name, emoji: res.emoji, t: Date.now() }); }
  } catch {}
  return json({ ...res, first });
};

export const config = { path: "/api/combine" };
