/**
 * PriceHunt — a public price-comparison site in one Cloudflare Worker.
 *
 * Setup (Cloudflare dashboard, no install):
 *   1. Paste this whole file into the Worker's code editor and Deploy.
 *   2. Settings → Variables and Secrets → Add → type "Secret",
 *      name SERPAPI_KEY, value = your SerpApi key.
 *   3. (Optional, recommended) Add a KV namespace binding named PRICE_CACHE.
 *      It makes caching and the per-visitor limit reliable. The site works
 *      without it.
 *
 * Routes:
 *   GET /                 the search page
 *   GET /api/search?q=…   JSON results (cached, rate limited)
 */

// ---------- Settings you can change ----------
const CACHE_HOURS = 6;            // how long a search result is reused (with KV)
const SEARCHES_PER_HOUR = 10;     // per visitor
const MAX_QUERY_LENGTH = 100;
const SITE_NAME = "PriceHunt";
const INCLUDE_AMAZON = true;      // also search Amazon. Each new search then uses
                                  // 2 SerpApi searches instead of 1. Set to false to turn off.
const AMAZON_MAX_RESULTS = 24;
// ---------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "Method not allowed." }, 405);
    }
    if (url.pathname === "/api/search") {
      return handleSearch(url, request, env, ctx);
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(PAGE_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=300",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy":
            "default-src 'self'; img-src https: data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
        },
      });
    }
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    return new Response("Not found", { status: 404 });
  },
};

// ---------- Search API ----------

// In-memory fallbacks (per Worker instance; best effort when no KV is bound).
const memCache = new Map();   // key -> { expires, body }
const memHits = new Map();    // ip  -> { windowStart, count }

async function handleSearch(url, request, env, ctx) {
  const raw = (url.searchParams.get("q") || "").trim();
  if (!raw) return json({ error: "Type a product to search for." }, 400);
  if (raw.length > MAX_QUERY_LENGTH) {
    return json({ error: `Keep searches under ${MAX_QUERY_LENGTH} characters.` }, 400);
  }
  if (!env.SERPAPI_KEY) {
    return json({ error: "The site owner hasn't added the SERPAPI_KEY secret yet." }, 500);
  }

  // Normalize so identical searches share a cache entry (SerpApi also caches
  // identical queries for 1 hour for free).
  const q = raw.toLowerCase().replace(/\s+/g, " ");
  const cacheKey = `search:v2:${INCLUDE_AMAZON ? "a" : "g"}:` + q;

  // 1) Cached result? Cached results don't count against the visitor limit.
  const cached = await cacheGet(env, cacheKey);
  if (cached) {
    return json({ ...cached, cached: true }, 200, { "cache-control": "public, max-age=600" });
  }

  // 2) Per-visitor limit.
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const limit = await checkRateLimit(env, ip);
  if (!limit.ok) {
    return json(
      { error: `You've hit the limit of ${SEARCHES_PER_HOUR} new searches an hour. Try again in about ${limit.retryMinutes} min.` },
      429,
      { "retry-after": String(limit.retryMinutes * 60) },
    );
  }

  // 3) Ask SerpApi: Google Shopping, plus Amazon if turned on, at the same time.
  const [google, amazon] = await Promise.all([
    callSerpApi({ engine: "google_shopping", q, gl: "us", hl: "en" }, env.SERPAPI_KEY),
    INCLUDE_AMAZON
      ? callSerpApi({ engine: "amazon", k: q, amazon_domain: "amazon.com", language: "en_US" }, env.SERPAPI_KEY)
      : Promise.resolve(null),
  ]);

  // Show whatever came back; only fail if every source failed.
  if (!google.ok && !(amazon && amazon.ok)) {
    const err = google.error === "network"
      ? "Couldn't reach the price service. Try again in a moment."
      : friendlyApiError(google.status, google.error);
    return json({ error: err }, google.status === 429 ? 503 : 502);
  }

  const result = buildResult(raw, google.ok ? google.data : {}, amazon && amazon.ok ? amazon.data : null);
  result.sources = { google: google.ok, amazon: amazon ? amazon.ok : null };
  if (result.items.length) {
    ctx.waitUntil(cachePut(env, cacheKey, result));
  }
  return json({ ...result, cached: false }, 200, { "cache-control": "public, max-age=600" });
}

async function callSerpApi(params, key) {
  const api = new URL("https://serpapi.com/search.json");
  for (const [k, v] of Object.entries(params)) api.searchParams.set(k, v);
  api.searchParams.set("api_key", key);
  try {
    const res = await fetch(api.toString(), { headers: { accept: "application/json" } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) return { ok: false, status: res.status, error: data.error || "" };
    return { ok: true, data };
  } catch {
    return { ok: false, status: 0, error: "network" };
  }
}

function friendlyApiError(status, message = "") {
  const m = String(message).toLowerCase();
  if (m.includes("run out of searches") || status === 429) {
    return "This site has used up its free searches for the month. Searches people already made still work.";
  }
  if (m.includes("invalid api key") || status === 401) {
    return "The site's API key isn't valid. (Site owner: check the SERPAPI_KEY secret.)";
  }
  if (m.includes("hasn't returned any results")) {
    return "No listings found. Try a simpler or more common product name.";
  }
  return "The price service had a problem. Try again in a moment.";
}

// ---------- Turn SerpApi's response into clean listings ----------

// Amazon results, reshaped to look like Google Shopping rows.
function amazonRows(data) {
  if (!data) return [];
  return (data.organic_results || []).slice(0, AMAZON_MAX_RESULTS).map((r) => {
    const delivery = Array.isArray(r.delivery) ? r.delivery.join(" · ") : r.delivery;
    return {
      title: r.title,
      source: "Amazon",
      extracted_price: r.extracted_price ?? r.price,
      extracted_old_price: r.extracted_old_price ?? r.old_price,
      product_link: r.link_clean || r.link,
      thumbnail: r.thumbnail,
      rating: r.rating,
      reviews: r.reviews,
      delivery: delivery || (r.prime ? "Free shipping with Prime" : null),
      extensions: [...(r.badges || []), ...(r.tags || [])],
    };
  });
}

function normalizeStore(s) {
  const store = String(s || "Unknown store").trim();
  return /^amazon(\.com)?\b/i.test(store) ? "Amazon" : store;
}

function buildResult(query, data, amazonData) {
  const pools = [
    ...amazonRows(amazonData),   // first, so direct amazon.com links win over duplicates
    ...(data.shopping_results || []),
    ...(data.categorized_shopping_results || []).flatMap((g) => g.shopping_results || []),
    ...(data.inline_shopping_results || []),
  ];

  const seen = new Set();
  const items = [];
  for (const r of pools) {
    const price = toNumber(r.extracted_price ?? r.price);
    if (!price || price <= 0) continue;
    const link = safeUrl(r.product_link || r.link);
    if (!link) continue;
    const store = normalizeStore(r.source);
    const title = String(r.title || "").trim();
    if (!title) continue;

    // Skip repeats: same product id at the same store, or same title, store
    // and price (catches Amazon showing up in both Google and Amazon results).
    const keys = [`${title.toLowerCase().replace(/[^a-z0-9]/g, "")}|${store.toLowerCase()}|${price}`];
    if (r.product_id) keys.push(`${r.product_id}|${store}`);
    if (keys.some((k) => seen.has(k))) continue;
    keys.forEach((k) => seen.add(k));

    const textBits = [title, r.snippet, r.tag, ...(r.extensions || []), r.second_hand_condition]
      .filter(Boolean).join(" ");
    const shipping = parseShipping(r.delivery);

    items.push({
      title,
      store,
      price,
      oldPrice: toNumber(r.extracted_old_price ?? r.old_price) || null,
      shipping,                          // number, 0 for free, or null if unknown
      delivery: r.delivery ? String(r.delivery) : null,
      total: shipping == null ? price : round2(price + shipping),
      condition: detectCondition(textBits),
      rating: toNumber(r.rating) || null,
      reviews: toNumber(r.reviews) || null,
      thumbnail: safeUrl(r.thumbnail || r.serpapi_thumbnail),
      link,
      relevance: relevance(query, title),
    });
  }

  markLikelyMismatches(items);
  items.sort((a, b) => a.total - b.total);

  return {
    query,
    fetchedAt: new Date().toISOString(),
    count: items.length,
    stores: [...new Set(items.map((i) => i.store))].sort((a, b) => a.localeCompare(b)),
    items,
  };
}

function detectCondition(text) {
  const t = text.toLowerCase();
  if (/\b(refurb|refurbished|renewed|reconditioned)\b/.test(t)) return "Refurbished";
  if (/\bopen[- ]box\b/.test(t)) return "Open box";
  if (/\b(used|pre-?owned|second[- ]hand)\b/.test(t)) return "Used";
  return "New";
}

function parseShipping(delivery) {
  if (!delivery) return null;
  const d = String(delivery).toLowerCase();
  if (d.includes("free")) return 0;
  const m = d.match(/\$\s?(\d+(?:\.\d{1,2})?)/);
  return m ? Number(m[1]) : null;
}

const STOP = new Set(["the", "a", "an", "and", "or", "for", "with", "of", "in", "on", "to", "by", "new"]);
function tokens(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/)
    .filter((w) => w && !STOP.has(w));
}
// Share of search words found in the title. Hyphens and spacing are ignored,
// so "WH-1000XM5" matches "WH1000XM5" and "WH 1000XM5".
function relevance(query, title) {
  const q = String(query).toLowerCase().split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ""))
    .filter((w) => w && !STOP.has(w));
  if (!q.length) return 1;
  const t = new Set(tokens(title));
  const squashed = String(title).toLowerCase().replace(/[^a-z0-9]/g, "");
  const hits = q.filter((w) => t.has(w) || (w.length >= 3 && squashed.includes(w))).length;
  return round2(hits / q.length);
}

// Flag listings that are probably accessories or a different product:
// they miss most of the search words, or cost far less than the typical listing.
function markLikelyMismatches(items) {
  if (!items.length) return;
  const strong = items.filter((i) => i.relevance >= 0.6).map((i) => i.price).sort((a, b) => a - b);
  const median = strong.length ? strong[Math.floor(strong.length / 2)] : null;
  const ACCESSORY = /\b(case|cover|skin|protector|charger|cable|strap|band|replacement|ear ?tips?|cushions?|stand|mount|adapter|sticker|decal)\b/i;
  for (const i of items) {
    const tooCheap = median != null && i.price < median * 0.3;
    const accessoryWord = ACCESSORY.test(i.title);
    i.likelyMismatch = i.relevance < 0.5 || (tooCheap && (accessoryWord || i.relevance < 0.8));
  }
}

function toNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v !== "string") return 0;
  const m = v.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : 0;
}
function round2(n) { return Math.round(n * 100) / 100; }
function safeUrl(u) {
  try {
    const p = new URL(String(u));
    return p.protocol === "https:" || p.protocol === "http:" ? p.toString() : null;
  } catch { return null; }
}

// ---------- Cache + rate limit (KV if bound, otherwise in-memory) ----------

async function cacheGet(env, key) {
  if (env.PRICE_CACHE) {
    try { return await env.PRICE_CACHE.get(key, "json"); } catch { /* fall through */ }
  }
  const hit = memCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.body;
  memCache.delete(key);
  return null;
}

async function cachePut(env, key, body) {
  const ttl = CACHE_HOURS * 3600;
  if (env.PRICE_CACHE) {
    try { await env.PRICE_CACHE.put(key, JSON.stringify(body), { expirationTtl: ttl }); return; } catch { /* fall through */ }
  }
  if (memCache.size > 200) memCache.delete(memCache.keys().next().value);
  memCache.set(key, { expires: Date.now() + ttl * 1000, body });
}

async function checkRateLimit(env, ip) {
  const hour = Math.floor(Date.now() / 3600000);
  const minutesLeft = 60 - new Date().getUTCMinutes();
  if (env.PRICE_CACHE) {
    const key = `rl:${hour}:${ip}`;
    try {
      const count = Number((await env.PRICE_CACHE.get(key)) || 0);
      if (count >= SEARCHES_PER_HOUR) return { ok: false, retryMinutes: minutesLeft };
      await env.PRICE_CACHE.put(key, String(count + 1), { expirationTtl: 3700 });
      return { ok: true };
    } catch { /* fall through to memory */ }
  }
  const rec = memHits.get(ip);
  if (!rec || rec.hour !== hour) {
    if (memHits.size > 5000) memHits.clear();
    memHits.set(ip, { hour, count: 1 });
    return { ok: true };
  }
  if (rec.count >= SEARCHES_PER_HOUR) return { ok: false, retryMinutes: minutesLeft };
  rec.count++;
  return { ok: true };
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff", ...extra },
  });
}

// ---------- The page ----------

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${SITE_NAME} — compare prices across stores</title>
<meta name="description" content="Search any product and compare prices from stores across the US, cheapest first.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#f6f4ef; --panel:#ffffff; --ink:#16181d; --muted:#626873; --line:#e3e0d8;
  --accent:#0f7b5a; --accent-ink:#ffffff; --deal:#e8f5ef; --warn:#a15c00; --warn-bg:#fff4e0;
  --strike:#8b8f97; --shadow:0 1px 2px rgba(0,0,0,.05),0 6px 20px rgba(0,0,0,.05); --scrim:rgba(10,12,16,.45);
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#111317; --panel:#1a1d23; --ink:#eceef2; --muted:#9aa0ab; --line:#2a2e36;
    --accent:#3ccf9a; --accent-ink:#0b1712; --deal:#14281f; --warn:#f0b35a; --warn-bg:#2b2213;
    --strike:#727782; --shadow:none; --scrim:rgba(0,0,0,.6);
  }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 Inter,system-ui,sans-serif}
body.locked{overflow:hidden}
a{color:inherit}
button{font:600 14px Inter,sans-serif;cursor:pointer}
.wrap{max-width:1160px;margin:0 auto;padding:0 16px}
.top{display:flex;justify-content:space-between;align-items:center;padding-top:20px}
.brand{font:700 15px "Space Grotesk",sans-serif;letter-spacing:.04em;text-transform:uppercase;color:var(--accent)}
.cartbtn{display:flex;align-items:center;gap:8px;border:1.5px solid var(--line);background:var(--panel);color:var(--ink);border-radius:999px;padding:8px 14px}
.cartbtn:hover{border-color:var(--accent)}
.badge{min-width:22px;height:22px;border-radius:999px;background:var(--accent);color:var(--accent-ink);font-size:12px;display:inline-grid;place-items:center;padding:0 6px}
.badge[hidden]{display:none}
header{padding:28px 0 24px}
h1{font:700 clamp(28px,5vw,44px)/1.1 "Space Grotesk",sans-serif;margin:0 0 6px;letter-spacing:-.02em}
.sub{color:var(--muted);margin:0 0 22px}
form#f{display:flex;gap:8px;max-width:640px}
input[type=search]{flex:1;min-width:0;padding:14px 16px;font:inherit;font-size:16px;border:1.5px solid var(--line);border-radius:12px;background:var(--panel);color:var(--ink);outline:none}
input[type=search]:focus,input[type=number]:focus{border-color:var(--accent);outline:none}
.primary{border:0;border-radius:12px;padding:0 20px;background:var(--accent);color:var(--accent-ink);font-size:15px}
.primary:disabled{opacity:.6;cursor:default}
.examples{margin-top:12px;display:flex;flex-wrap:wrap;gap:6px;color:var(--muted);font-size:13px;align-items:center}
.chip{border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:999px;padding:4px 11px;font-weight:500;font-size:13px}
.chip:hover{border-color:var(--accent)}
main{padding-bottom:64px}
.status{padding:28px 0;color:var(--muted)}
.error{background:var(--warn-bg);color:var(--warn);padding:14px 16px;border-radius:12px;margin:8px 0}

/* layout */
.layout{display:grid;grid-template-columns:250px minmax(0,1fr);gap:24px;align-items:start}
.filters{position:sticky;top:16px;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:16px;max-height:calc(100vh - 32px);overflow:auto}
.filters summary{display:none}
.fgroup{padding:12px 0;border-bottom:1px solid var(--line)}
.fgroup:first-of-type{padding-top:0}
.fgroup:last-child{border-bottom:0;padding-bottom:0}
.fhead{display:flex;justify-content:space-between;align-items:baseline;font:700 13px "Space Grotesk",sans-serif;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px}
.links{display:flex;gap:10px}
.link{background:none;border:0;padding:0;color:var(--accent);font-size:12px;font-weight:600;text-transform:none;letter-spacing:0}
.range{display:flex;align-items:center;gap:6px}
.money{position:relative;flex:1}
.money span{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--muted);font-size:14px}
.money input{width:100%;padding:8px 8px 8px 22px;font:inherit;font-size:14px;border:1px solid var(--line);border-radius:9px;background:var(--bg);color:var(--ink)}
.hint{font-size:12px;color:var(--muted);margin-top:6px}
.check{display:flex;align-items:center;gap:8px;font-size:14px;padding:4px 0;cursor:pointer}
.check input{accent-color:var(--accent);width:16px;height:16px;margin:0;flex:none}
.check .n{margin-left:auto;color:var(--muted);font-size:12px;white-space:nowrap}
.check .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stores{max-height:300px;overflow:auto;margin-right:-6px;padding-right:6px}
select{font:inherit;font-size:14px;padding:7px 10px;border-radius:9px;border:1px solid var(--line);background:var(--panel);color:var(--ink);width:100%}
.reset{width:100%;margin-top:4px;border:1px solid var(--line);background:none;color:var(--ink);border-radius:9px;padding:8px}

/* results */
.best{display:grid;grid-template-columns:96px 1fr auto;gap:18px;align-items:center;background:var(--deal);border:1.5px solid var(--accent);border-radius:16px;padding:18px;margin-bottom:16px}
.best img,.best .ph{width:96px;height:96px;object-fit:contain;background:#fff;border-radius:10px}
.best .label{font:700 12px "Space Grotesk",sans-serif;text-transform:uppercase;letter-spacing:.06em;color:var(--accent)}
.best .t{font-weight:600;margin:2px 0}
.best .price{font:700 32px "Space Grotesk",sans-serif;text-align:right}
.btns{display:flex;gap:8px;justify-content:flex-end;margin-top:6px;flex-wrap:wrap}
.go{display:inline-block;background:var(--accent);color:var(--accent-ink);text-decoration:none;font-weight:600;padding:8px 14px;border-radius:10px;font-size:14px}
.add{border:1.5px solid var(--accent);background:var(--panel);color:var(--accent);border-radius:10px;padding:6px 12px}
.add.in{background:var(--accent);color:var(--accent-ink)}
.bar{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;justify-content:space-between;margin-bottom:12px}
.summary{display:flex;flex-wrap:wrap;gap:4px 16px;color:var(--muted);font-size:14px}
.summary b{color:var(--ink)}
.bar select{width:auto}
.list{display:grid;gap:10px}
.row{display:grid;grid-template-columns:72px 1fr auto;gap:14px;align-items:center;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px;box-shadow:var(--shadow)}
.row img,.row .ph{width:72px;height:72px;object-fit:contain;background:#fff;border-radius:8px}
.ph{background:var(--line)!important}
.row .t{font-weight:500;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.meta{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:13px;color:var(--muted);margin-top:3px}
.store{font-weight:600;color:var(--ink)}
.tag{font-size:12px;font-weight:600;padding:1px 8px;border-radius:999px;background:var(--warn-bg);color:var(--warn)}
.right{text-align:right;white-space:nowrap}
.p{font:700 20px "Space Grotesk",sans-serif}
.old{color:var(--strike);text-decoration:line-through;font-size:13px;margin-right:6px}
.ship{font-size:12px;color:var(--muted)}
.view{font-size:13px;font-weight:600;color:var(--accent);text-decoration:none;padding:6px 4px}
.row .add{font-size:13px;padding:5px 10px}
.foot{color:var(--muted);font-size:13px;margin-top:22px}
.skel{height:96px;border-radius:14px;background:linear-gradient(90deg,var(--panel),var(--line),var(--panel));background-size:200% 100%;animation:sh 1.2s infinite;margin-bottom:10px}
@keyframes sh{to{background-position:-200% 0}}

/* cart drawer */
.scrim{position:fixed;inset:0;background:var(--scrim);opacity:0;pointer-events:none;transition:opacity .2s;z-index:20}
.drawer{position:fixed;top:0;right:0;height:100%;width:min(420px,100%);background:var(--panel);border-left:1px solid var(--line);z-index:21;transform:translateX(100%);transition:transform .25s ease;display:flex;flex-direction:column}
.open .scrim{opacity:1;pointer-events:auto}
.open .drawer{transform:none}
.dhead{display:flex;justify-content:space-between;align-items:center;padding:18px 18px 12px;border-bottom:1px solid var(--line)}
.dhead h2{font:700 20px "Space Grotesk",sans-serif;margin:0}
.x{border:0;background:none;color:var(--muted);font-size:24px;line-height:1;padding:4px 8px}
.dbody{flex:1;overflow:auto;padding:8px 18px}
.group{padding:12px 0;border-bottom:1px solid var(--line)}
.ghead{display:flex;justify-content:space-between;font-weight:700;margin-bottom:6px}
.citem{display:grid;grid-template-columns:48px 1fr auto;gap:10px;align-items:center;padding:6px 0}
.citem img,.citem .ph{width:48px;height:48px;object-fit:contain;background:#fff;border-radius:6px}
.citem .t{font-size:13px;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;text-decoration:none}
.citem .t:hover{text-decoration:underline}
.qty{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:8px;margin-top:4px}
.qty button{border:0;background:none;color:var(--ink);width:26px;height:24px;font-size:15px}
.qty span{min-width:20px;text-align:center;font-size:13px}
.rm{border:0;background:none;color:var(--muted);font-size:12px;font-weight:500;margin-left:8px;text-decoration:underline}
.cprice{text-align:right;font-weight:600;font-size:14px}
.dfoot{border-top:1px solid var(--line);padding:16px 18px}
.tot{display:flex;justify-content:space-between;align-items:baseline;font:700 22px "Space Grotesk",sans-serif}
.dfoot .hint{margin:4px 0 12px}
.clear{border:1px solid var(--line);background:none;color:var(--ink);border-radius:10px;padding:8px 12px;width:100%}
.empty{color:var(--muted);text-align:center;padding:48px 8px}
.toast{position:fixed;left:50%;bottom:20px;transform:translate(-50%,20px);background:var(--ink);color:var(--bg);padding:10px 16px;border-radius:10px;font-size:14px;opacity:0;transition:.2s;pointer-events:none;z-index:30}
.toast.show{opacity:1;transform:translate(-50%,0)}

@media (max-width:820px){
  .layout{grid-template-columns:1fr;gap:12px}
  .filters{position:static;max-height:none;padding:0}
  .filters summary{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;font-weight:600;cursor:pointer;list-style:none}
  .filters summary::-webkit-details-marker{display:none}
  .filters summary::after{content:"+";font-size:20px;color:var(--muted)}
  .filters[open] summary::after{content:"−"}
  .filters .fbody{padding:0 16px 16px}
}
@media (max-width:620px){
  .best{grid-template-columns:72px 1fr}.best img,.best .ph{width:72px;height:72px}
  .best .right{grid-column:1/-1;text-align:left}.best .price{text-align:left}.btns{justify-content:flex-start}
  .row{grid-template-columns:56px 1fr}.row img,.row .ph{width:56px;height:56px}
  .row .right{grid-column:2;text-align:left;display:flex;gap:6px 10px;align-items:center;flex-wrap:wrap}
}
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <div class="brand">${SITE_NAME}</div>
    <button class="cartbtn" id="cartBtn" type="button" aria-label="Open cart">Cart <span class="badge" id="cartCount" hidden>0</span></button>
  </div>
  <header>
    <h1>Find the cheapest place to buy it.</h1>
    <p class="sub">Search any product and compare prices from stores across the US, cheapest first.</p>
    <form id="f" role="search">
      <input id="q" type="search" placeholder="e.g. Sony WH-1000XM5" maxlength="${MAX_QUERY_LENGTH}" autocomplete="off" aria-label="Product to search for" required>
      <button class="primary" id="go" type="submit">Search</button>
    </form>
    <div class="examples">Try:
      <button class="chip" type="button">AirPods Pro 2</button>
      <button class="chip" type="button">Nintendo Switch OLED</button>
      <button class="chip" type="button">Stanley Quencher 40oz</button>
    </div>
  </header>
  <main id="out"></main>
</div>

<div id="cartUi">
  <div class="scrim" data-act="close-cart"></div>
  <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="cartTitle" aria-hidden="true">
    <div class="dhead"><h2 id="cartTitle">Your cart</h2><button class="x" type="button" data-act="close-cart" aria-label="Close cart">×</button></div>
    <div class="dbody" id="cartBody"></div>
    <div class="dfoot" id="cartFoot"></div>
  </aside>
</div>
<div class="toast" id="toast" role="status" aria-live="polite"></div>

<script>
(function () {
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var out = $("#out"), qEl = $("#q"), goBtn = $("#go");
  var data = null, byId = {};
  var view;
  function freshView() {
    return { sort: "total", cond: "all", excluded: {}, min: null, max: null, freeShip: false, showAll: false };
  }
  view = freshView();

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function money(n) {
    return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function shipText(i) {
    if (i.shipping === 0) return "Free shipping";
    if (i.shipping) return "+" + money(i.shipping) + " shipping";
    return i.delivery ? esc(i.delivery) : "Shipping not listed";
  }
  function img(i) {
    return i.thumbnail
      ? '<img src="' + esc(i.thumbnail) + '" alt="" loading="lazy" referrerpolicy="no-referrer">'
      : '<div class="ph"></div>';
  }

  // ---------- Cart (saved in this browser) ----------
  var CART_KEY = "pricehunt-cart-v1";
  var cart = loadCart();
  function loadCart() {
    try {
      var c = JSON.parse(localStorage.getItem(CART_KEY) || "[]");
      return Array.isArray(c) ? c.filter(function (x) { return x && x.id && x.link; }) : [];
    } catch (e) { return []; }
  }
  function saveCart() {
    try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch (e) {}
    renderCart();
    syncAddButtons();
  }
  function inCart(id) {
    for (var k = 0; k < cart.length; k++) if (cart[k].id === id) return cart[k];
    return null;
  }
  function addToCart(item) {
    var have = inCart(item.link);
    if (have) { have.qty += 1; }
    else {
      cart.push({
        id: item.link, link: item.link, title: item.title, store: item.store,
        price: item.price, shipping: item.shipping, thumbnail: item.thumbnail,
        condition: item.condition, qty: 1, addedAt: Date.now()
      });
    }
    saveCart();
    toast("Added to cart");
  }
  function setQty(id, d) {
    var it = inCart(id);
    if (!it) return;
    it.qty += d;
    if (it.qty <= 0) cart = cart.filter(function (x) { return x.id !== id; });
    saveCart();
  }
  function removeItem(id) {
    cart = cart.filter(function (x) { return x.id !== id; });
    saveCart();
  }

  function renderCart() {
    var count = cart.reduce(function (s, x) { return s + x.qty; }, 0);
    var badge = $("#cartCount");
    badge.textContent = count;
    badge.hidden = count === 0;

    var body = $("#cartBody"), foot = $("#cartFoot");
    if (!cart.length) {
      body.innerHTML = '<div class="empty">Your cart is empty.<br>Add listings with the <b>+ Cart</b> button.</div>';
      foot.innerHTML = "";
      return;
    }
    var groups = {};
    cart.forEach(function (x) { (groups[x.store] = groups[x.store] || []).push(x); });
    var names = Object.keys(groups).sort();
    var total = 0, unknownShip = false, h = "";
    names.forEach(function (name) {
      var sub = 0;
      var rows = groups[name].map(function (x) {
        var line = x.price * x.qty + (x.shipping || 0);
        if (x.shipping == null) unknownShip = true;
        sub += line;
        return '<div class="citem">' + img(x) +
          '<div><a class="t" href="' + esc(x.link) + '" target="_blank" rel="noopener nofollow">' + esc(x.title) + '</a>' +
          '<div><span class="qty"><button type="button" data-act="dec" data-id="' + esc(x.id) + '" aria-label="Fewer">−</button><span>' + x.qty + '</span>' +
          '<button type="button" data-act="inc" data-id="' + esc(x.id) + '" aria-label="More">+</button></span>' +
          '<button class="rm" type="button" data-act="rm" data-id="' + esc(x.id) + '">Remove</button></div></div>' +
          '<div class="cprice">' + money(x.price * x.qty) + '<div class="ship">' + shipText(x) + '</div></div></div>';
      }).join("");
      total += sub;
      h += '<div class="group"><div class="ghead"><span>' + esc(name) + '</span><span>' + money(sub) + '</span></div>' + rows + '</div>';
    });
    body.innerHTML = h;
    foot.innerHTML =
      '<div class="tot"><span>Total</span><span>' + money(total) + '</span></div>' +
      '<div class="hint">' + count + (count === 1 ? " item" : " items") + " from " + names.length + (names.length === 1 ? " store" : " stores") +
      ". Prices are from when you added them" + (unknownShip ? "; some shipping isn't included" : "") +
      ". You check out on each store's site.</div>" +
      '<button class="clear" type="button" data-act="clear">Empty cart</button>';
  }

  var lastFocus = null;
  function openCart() {
    lastFocus = document.activeElement;
    $("#toast").classList.remove("show");
    document.getElementById("cartUi").classList.add("open");
    $(".drawer").setAttribute("aria-hidden", "false");
    document.body.classList.add("locked");
    $(".drawer .x").focus();
  }
  function closeCart() {
    document.getElementById("cartUi").classList.remove("open");
    $(".drawer").setAttribute("aria-hidden", "true");
    document.body.classList.remove("locked");
    if (lastFocus) lastFocus.focus();
  }
  var toastTimer;
  function toast(msg) {
    var t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 1600);
  }
  function addBtn(i) {
    var c = inCart(i.link);
    return '<button class="add' + (c ? " in" : "") + '" type="button" data-act="add" data-id="' + esc(i.link) + '">' +
      (c ? "In cart (" + c.qty + ")" : "+ Cart") + "</button>";
  }
  function syncAddButtons() {
    out.querySelectorAll('button[data-act="add"]').forEach(function (b) {
      var c = inCart(b.getAttribute("data-id"));
      b.classList.toggle("in", !!c);
      b.textContent = c ? "In cart (" + c.qty + ")" : "+ Cart";
    });
  }

  // ---------- Search ----------
  function search(q) {
    q = q.trim();
    if (!q) return;
    qEl.value = q;
    var u = new URL(location.href); u.searchParams.set("q", q); history.replaceState(null, "", u);
    goBtn.disabled = true;
    out.innerHTML = '<div class="status">Checking stores for <b>' + esc(q) + "</b>…</div>" + new Array(5).join('<div class="skel"></div>');
    fetch("/api/search?q=" + encodeURIComponent(q))
      .then(function (res) {
        return res.json().catch(function () { return { error: "Something went wrong. Try again." }; })
          .then(function (body) {
            if (!res.ok || body.error) throw new Error(body.error || "Something went wrong.");
            return body;
          });
      })
      .then(function (body) {
        data = body;
        byId = {};
        data.items.forEach(function (i) { byId[i.link] = i; });
        view = freshView();
        renderShell();
      })
      .catch(function (e) { out.innerHTML = '<div class="error">' + esc(e.message) + "</div>"; })
      .then(function () { goBtn.disabled = false; });
  }

  function passes(i, ignoreStore) {
    if (!view.showAll && i.likelyMismatch) return false;
    if (view.cond === "new" && i.condition !== "New") return false;
    if (view.cond === "used" && i.condition === "New") return false;
    if (view.freeShip && i.shipping !== 0) return false;
    if (view.min != null && i.total < view.min) return false;
    if (view.max != null && i.total > view.max) return false;
    if (!ignoreStore && view.excluded[i.store]) return false;
    return true;
  }
  function visible() {
    var items = data.items.filter(function (i) { return passes(i); });
    var by = {
      total: function (a, b) { return a.total - b.total; },
      high: function (a, b) { return b.total - a.total; },
      rating: function (a, b) { return (b.rating || 0) - (a.rating || 0) || a.total - b.total; },
      saving: function (a, b) { return saving(b) - saving(a) || a.total - b.total; }
    }[view.sort];
    return items.sort(by);
  }
  function saving(i) { return i.oldPrice && i.oldPrice > i.price ? i.oldPrice - i.price : 0; }

  // Filters panel is drawn once per search so typing in it never loses focus.
  function renderShell() {
    if (!data.items.length) {
      out.innerHTML = '<div class="status">No listings found for <b>' + esc(data.query) + "</b>. Try a simpler or more common name.</div>";
      return;
    }
    var stats = {};
    data.items.forEach(function (i) {
      if (!view.showAll && i.likelyMismatch) return;
      var s = stats[i.store] || (stats[i.store] = { n: 0, min: Infinity });
      s.n++; s.min = Math.min(s.min, i.total);
    });
    var storeNames = Object.keys(stats).sort(function (a, b) { return stats[a].min - stats[b].min; });
    var hidden = data.items.filter(function (i) { return i.likelyMismatch; }).length;
    var prices = data.items.filter(function (i) { return !i.likelyMismatch; }).map(function (i) { return i.total; });
    var lo = prices.length ? Math.min.apply(null, prices) : 0;
    var hi = prices.length ? Math.max.apply(null, prices) : 0;
    var wide = window.matchMedia("(min-width: 821px)").matches;

    var f = '<details class="filters" id="filters"' + (wide ? " open" : "") + '><summary>Filters <span id="fcount"></span></summary><div class="fbody">' +
      '<div class="fgroup"><div class="fhead">Price</div><div class="range">' +
      '<label class="money"><span>$</span><input id="min" type="number" inputmode="decimal" min="0" placeholder="Min" aria-label="Minimum price"' + (view.min != null ? ' value="' + view.min + '"' : "") + "></label>–" +
      '<label class="money"><span>$</span><input id="max" type="number" inputmode="decimal" min="0" placeholder="Max" aria-label="Maximum price"' + (view.max != null ? ' value="' + view.max + '"' : "") + "></label></div>" +
      '<div class="hint">Listings run ' + money(lo) + " to " + money(hi) + ", including shipping where known.</div></div>" +
      '<div class="fgroup"><div class="fhead">Stores <span class="links"><button class="link" type="button" data-act="stores-all">All</button><button class="link" type="button" data-act="stores-none">None</button></span></div><div class="stores">' +
      storeNames.map(function (s) {
        return '<label class="check"><input type="checkbox" data-store="' + esc(s) + '"' + (view.excluded[s] ? "" : " checked") + '><span class="nm">' + esc(s) +
          '</span><span class="n">' + stats[s].n + " · from " + money(stats[s].min) + "</span></label>";
      }).join("") + "</div></div>" +
      '<div class="fgroup"><div class="fhead">Condition</div><select id="cond" aria-label="Condition">' +
      '<option value="all">Any condition</option><option value="new">New only</option><option value="used">Used / refurbished</option></select></div>' +
      '<div class="fgroup"><label class="check"><input type="checkbox" id="free"' + (view.freeShip ? " checked" : "") + "> Free shipping only</label>" +
      (hidden ? '<label class="check"><input type="checkbox" id="all"' + (view.showAll ? " checked" : "") + "> Show " + hidden + " likely accessories</label>" : "") +
      '<button class="reset" type="button" data-act="reset">Reset filters</button></div></div></details>';

    out.innerHTML = '<div class="layout">' + f + '<section id="results"></section></div>';
    $("#cond").value = view.cond;

    var timer;
    function readRange() {
      clearTimeout(timer);
      timer = setTimeout(function () {
        var a = parseFloat($("#min").value), b = parseFloat($("#max").value);
        view.min = isNaN(a) ? null : a;
        view.max = isNaN(b) ? null : b;
        renderResults();
      }, 250);
    }
    $("#min").addEventListener("input", readRange);
    $("#max").addEventListener("input", readRange);
    $("#cond").addEventListener("change", function (e) { view.cond = e.target.value; renderResults(); });
    $("#free").addEventListener("change", function (e) { view.freeShip = e.target.checked; renderResults(); });
    var all = $("#all");
    if (all) all.addEventListener("change", function (e) { view.showAll = e.target.checked; renderShell(); });
    out.querySelectorAll("input[data-store]").forEach(function (cb) {
      cb.addEventListener("change", function () {
        var s = cb.getAttribute("data-store");
        if (cb.checked) delete view.excluded[s]; else view.excluded[s] = true;
        renderResults();
      });
    });
    renderResults();
  }

  function activeFilterCount() {
    var n = Object.keys(view.excluded).length ? 1 : 0;
    if (view.min != null || view.max != null) n++;
    if (view.cond !== "all") n++;
    if (view.freeShip) n++;
    return n;
  }

  function renderResults() {
    var box = $("#results");
    if (!box) return;
    var items = visible();
    var n = activeFilterCount();
    $("#fcount").textContent = n ? "(" + n + " on)" : "";
    var newOnes = items.filter(function (i) { return i.condition === "New"; });
    var best = newOnes[0] && view.sort === "total" ? newOnes[0] : items.slice().sort(function (a, b) { return a.total - b.total; })[0];
    var stores = {};
    items.forEach(function (i) { stores[i.store] = 1; });
    var h = "";

    if (best) {
      h += '<section class="best">' + img(best) +
        '<div><div class="label">Best ' + (best.condition === "New" ? "new " : "") + "price" + (n ? " with your filters" : "") + "</div>" +
        '<div class="t">' + esc(best.title) + "</div>" +
        '<div class="meta"><span class="store">' + esc(best.store) + "</span><span>" + shipText(best) + "</span></div></div>" +
        '<div class="right"><div class="price">' + money(best.total) + '</div><div class="btns">' + addBtn(best) +
        '<a class="go" href="' + esc(best.link) + '" target="_blank" rel="noopener nofollow">View deal ↗</a></div></div></section>';
    }
    h += '<div class="bar"><div class="summary"><span><b>' + items.length + "</b> of " + data.items.length + " listings</span><span><b>" +
      Object.keys(stores).length + "</b> stores</span><span>" + (data.cached ? "From a recent search" : "Just checked") + " · " +
      new Date(data.fetchedAt).toLocaleString([], { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" }) + "</span></div>" +
      '<select id="sort" aria-label="Sort"><option value="total">Cheapest first</option><option value="high">Most expensive first</option>' +
      '<option value="rating">Best rated</option><option value="saving">Biggest discount</option></select></div><div class="list">';

    items.forEach(function (i) {
      var off = saving(i);
      h += '<article class="row">' + img(i) +
        '<div><div class="t">' + esc(i.title) + '</div><div class="meta"><span class="store">' + esc(i.store) + "</span>" +
        (i.condition !== "New" ? '<span class="tag">' + esc(i.condition) + "</span>" : "") +
        (i.likelyMismatch ? '<span class="tag">May not match</span>' : "") +
        (off ? '<span class="tag">Save ' + money(off) + "</span>" : "") +
        (i.rating ? "<span>★ " + i.rating + (i.reviews ? " (" + Number(i.reviews).toLocaleString() + ")" : "") + "</span>" : "") +
        '</div></div><div class="right"><div>' + (off ? '<span class="old">' + money(i.oldPrice) + "</span>" : "") +
        '<span class="p">' + money(i.price) + '</span></div><div class="ship">' + shipText(i) + "</div>" +
        '<div class="btns">' + addBtn(i) + '<a class="view" href="' + esc(i.link) + '" target="_blank" rel="noopener nofollow">View ↗</a></div></div></article>';
    });
    if (!items.length) h += '<div class="status">Nothing matches these filters. <button class="link" type="button" data-act="reset">Reset filters</button></div>';
    h += '</div><p class="foot">Prices come from Google Shopping' + (data.sources && data.sources.amazon ? " and Amazon" : "") +
      " listings and can change. Check the store before you buy.</p>";
    box.innerHTML = h;
    $("#sort").value = view.sort;
    $("#sort").addEventListener("change", function (e) { view.sort = e.target.value; renderResults(); });
  }

  // ---------- Clicks (one listener for the whole page) ----------
  document.addEventListener("click", function (e) {
    var el = e.target.closest("[data-act]");
    if (!el) return;
    var act = el.getAttribute("data-act"), id = el.getAttribute("data-id");
    if (act === "add") {
      if (inCart(id)) openCart(); else if (byId[id]) addToCart(byId[id]);
    } else if (act === "inc") setQty(id, 1);
    else if (act === "dec") setQty(id, -1);
    else if (act === "rm") removeItem(id);
    else if (act === "clear") { if (confirm("Empty your cart?")) { cart = []; saveCart(); } }
    else if (act === "close-cart") closeCart();
    else if (act === "stores-all" || act === "stores-none") {
      out.querySelectorAll("input[data-store]").forEach(function (cb) {
        cb.checked = act === "stores-all";
        var s = cb.getAttribute("data-store");
        if (cb.checked) delete view.excluded[s]; else view.excluded[s] = true;
      });
      renderResults();
    } else if (act === "reset") {
      var keepSort = view.sort;
      view = freshView(); view.sort = keepSort;
      renderShell();
    }
  });
  $("#cartBtn").addEventListener("click", openCart);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && document.getElementById("cartUi").classList.contains("open")) closeCart();
  });
  window.addEventListener("storage", function (e) {
    if (e.key === CART_KEY) { cart = loadCart(); renderCart(); syncAddButtons(); }
  });

  $("#f").addEventListener("submit", function (e) { e.preventDefault(); search(qEl.value); });
  document.querySelectorAll(".chip").forEach(function (c) {
    c.addEventListener("click", function () { search(c.textContent); });
  });
  renderCart();
  var start = new URL(location.href).searchParams.get("q");
  if (start) search(start); else qEl.focus();
})();
</script>
</body>
</html>`;
