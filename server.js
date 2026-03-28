/**
 * TCG Price Scanner — Backend Server v3
 * - Identify: Claude Sonnet vision (accurate, reads exact card text)
 * - Prices: Claude Haiku knowledge (always returns a price estimate)
 * - Images: Free TCG APIs (PokéTCG, Scryfall, YGOPRODeck, Lorcana)
 * - Cache: Redis (persistent) with in-memory fallback
 */

const express   = require('express');
const cors      = require('cors');
const https     = require('https');
const http      = require('http');
const Anthropic = require('@anthropic-ai/sdk');

const app  = express();
const port = process.env.PORT || 3000;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ═════════════════════════════════════════════════════════════════════════════
// CACHE
// ═════════════════════════════════════════════════════════════════════════════
let redis = null;
const mem = new Map();

async function initRedis() {
  const url = process.env.REDIS_URL || process.env.REDIS_PRIVATE_URL;
  if (!url) { console.log('[cache] in-memory only'); return; }
  try {
    let createClient;
    try { createClient = require('redis').createClient; }
    catch { console.log('[cache] redis not installed, using memory'); return; }
    redis = createClient({ url });
    redis.on('error', e => { console.error('[redis error]', e.message); });
    await redis.connect();
    console.log('[cache] Redis connected');
  } catch (e) { console.log('[cache] Redis failed:', e.message); redis = null; }
}

async function cacheGet(key) {
  try { if (redis) { const v = await redis.get(key); return v ? JSON.parse(v) : null; } }
  catch {}
  const h = mem.get(key);
  if (!h || Date.now() > h.exp) { mem.delete(key); return null; }
  return h.data;
}

async function cacheSet(key, data, ttl = 21600) {
  try { if (redis) { await redis.set(key, JSON.stringify(data), { EX: ttl }); return; } }
  catch {}
  mem.set(key, { data, exp: Date.now() + ttl * 1000 });
}

// ═════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═════════════════════════════════════════════════════════════════════════════
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get({
      hostname: u.hostname, path: u.pathname + u.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TCGScanner/1.0)',
        'Accept': 'application/json, text/html, */*',
        ...headers
      },
      timeout: 8000
    }, res => {
      // Follow redirects
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        return httpGet(res.headers.location, headers).then(resolve).catch(reject);
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function parseJSON(text) {
  try {
    const m = (text || '').replace(/```json|```/g, '').trim().match(/[\[{][\s\S]*[\]}]/);
    return m ? JSON.parse(m[0]) : null;
  } catch { return null; }
}

async function withRetry(fn, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) {
      const is429 = e?.status === 429 || String(e?.message).includes('429');
      if (is429 && i < retries) { await new Promise(r => setTimeout(r, (i+1)*3000)); continue; }
      throw e;
    }
  }
}

const delay = ms => new Promise(r => setTimeout(r, ms));

const rateMap = new Map();
function checkRate(ip, limit = 30) {
  const now = Date.now();
  const hits = (rateMap.get(ip) || []).filter(t => now - t < 60000);
  if (hits.length >= limit) return false;
  hits.push(now); rateMap.set(ip, hits); return true;
}

const EBAY_REGIONS = {
  AU: { domain: 'ebay.com.au', currency: 'AUD', label: 'eBay Australia' },
  US: { domain: 'ebay.com',    currency: 'USD', label: 'eBay USA' },
  UK: { domain: 'ebay.co.uk',  currency: 'GBP', label: 'eBay UK' },
  CA: { domain: 'ebay.ca',     currency: 'CAD', label: 'eBay Canada' },
  DE: { domain: 'ebay.de',     currency: 'EUR', label: 'eBay Germany' },
  JP: { domain: 'ebay.com',    currency: 'USD', label: 'eBay (Intl)' },
};

// ═════════════════════════════════════════════════════════════════════════════
// PRICE LOOKUP — Claude Haiku knowledge, always returns something
// Scraping is unreliable from Railway IPs; Claude knows TCG prices well
// ═════════════════════════════════════════════════════════════════════════════
async function getPricesFromClaude(card, ebayRegion = 'AU') {
  const conf = EBAY_REGIONS[ebayRegion] || EBAY_REGIONS['AU'];
  try {
    const r = await withRetry(() => anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `You are a trading card price expert. Give current approximate market prices for this card.

Card: ${card.name}
Game: ${card.game}
Set: ${card.set || 'unknown'}
Number: ${card.number || ''}
Rarity: ${card.rarity || ''}
Foil: ${card.foil ? 'Yes' : 'No'}
Special: ${card.extra || 'none'}

Respond ONLY with this JSON (no markdown). Always provide your best price estimate — never leave all prices null:
{
  "tcgplayer": {
    "available": true,
    "market": 12.50,
    "currency": "USD",
    "isEstimate": true
  },
  "ebay": {
    "available": true,
    "avg": 15.00,
    "currency": "${conf.currency}",
    "region": "${ebayRegion}",
    "regionLabel": "${conf.label}",
    "isEstimate": true
  },
  "cardkingdom": {
    "available": true,
    "retail": 11.00,
    "currency": "USD",
    "isEstimate": true
  }
}
If you genuinely have no data for a source set available:false for that source only.`
      }]
    }));
    const raw = r.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
    const data = parseJSON(raw);
    if (data) {
      // Ensure region info is always stamped
      if (data.ebay) { data.ebay.region = ebayRegion; data.ebay.regionLabel = conf.label; data.ebay.currency = conf.currency; }
      return data;
    }
  } catch (e) { console.log('[price claude]', e.message); }

  // Hard fallback — should never reach here
  return {
    tcgplayer:   { available: false, market: null, currency: 'USD' },
    ebay:        { available: false, avg: null, currency: conf.currency, region: ebayRegion, regionLabel: conf.label },
    cardkingdom: { available: false, retail: null, currency: 'USD' }
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// CARD IMAGE — free TCG APIs
// ═════════════════════════════════════════════════════════════════════════════
async function fetchCardImage(card) {
  const game = (card.game || '').toLowerCase();

  // ── Pokémon: PokéTCG API ────────────────────────────────────────────────────
  if (game.includes('pokemon')) {
    try {
      // Search by name + card number for precision
      const nameQ = card.name.replace(/[^a-zA-Z0-9 ]/g, '').trim();
      const numQ  = card.number ? card.number.split('/')[0] : '';
      const q     = encodeURIComponent(`name:"${nameQ}"${numQ ? ` number:"${numQ}"` : ''}`);
      const r = await httpGet(`https://api.pokemontcg.io/v2/cards?q=${q}&pageSize=10&orderBy=-set.releaseDate`);
      if (r.status === 200) {
        const data = JSON.parse(r.body);
        const cards = data.data || [];
        // Prefer set match
        const match = cards.find(c =>
          card.set && c.set?.name?.toLowerCase().includes(card.set.toLowerCase().split(' ')[0])
        ) || cards[0];
        const url = match?.images?.large || match?.images?.small;
        if (url) return url;
      }
    } catch (e) { console.log('[img pokemon]', e.message); }
  }

  // ── Magic: The Gathering: Scryfall ──────────────────────────────────────────
  if (game.includes('magic')) {
    try {
      const q = encodeURIComponent(`!"${card.name}"`);
      const r = await httpGet(`https://api.scryfall.com/cards/named?fuzzy=${q}`);
      if (r.status === 200) {
        const data = JSON.parse(r.body);
        const url = data?.image_uris?.normal || data?.image_uris?.small ||
                    data?.card_faces?.[0]?.image_uris?.normal;
        if (url) return url;
      }
    } catch (e) { console.log('[img scryfall]', e.message); }
  }

  // ── Yu-Gi-Oh: YGOPRODeck ────────────────────────────────────────────────────
  if (game.includes('yu-gi-oh') || game.includes('yugioh')) {
    try {
      const q = encodeURIComponent(card.name);
      const r = await httpGet(`https://db.ygoprodeck.com/api/v7/cardinfo.php?name=${q}`);
      if (r.status === 200) {
        const data = JSON.parse(r.body);
        const url = data.data?.[0]?.card_images?.[0]?.image_url;
        if (url) return url;
      }
    } catch (e) { console.log('[img yugioh]', e.message); }
  }

  // ── Lorcana ──────────────────────────────────────────────────────────────────
  if (game.includes('lorcana')) {
    try {
      const q = encodeURIComponent(card.name);
      const r = await httpGet(`https://api.lorcana-api.com/cards/fetch?search=${q}`);
      if (r.status === 200) {
        const data = JSON.parse(r.body);
        const url = data?.[0]?.Image || data?.[0]?.image;
        if (url) return url;
      }
    } catch (e) { console.log('[img lorcana]', e.message); }
  }

  return null;
}

// ═════════════════════════════════════════════════════════════════════════════
// MIDDLEWARE
// ═════════════════════════════════════════════════════════════════════════════
app.use(cors());
app.use(express.json({ limit: '12mb' }));
app.get('/', (_, res) => res.json({ status: 'ok', version: '3.0' }));

// ═════════════════════════════════════════════════════════════════════════════
// POST /identify
// ═════════════════════════════════════════════════════════════════════════════
app.post('/identify', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  if (!checkRate(ip, 20)) return res.status(429).json({ error: 'Too many scans — wait a moment.' });

  const { imageBase64, mediaType = 'image/jpeg' } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'No image provided.' });

  const len = imageBase64.length;
  const cKey = 'id3:' + imageBase64.slice(0,16) + imageBase64.slice(Math.floor(len/2), Math.floor(len/2)+16) + imageBase64.slice(-16);
  const cached = await cacheGet(cKey);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const response = await withRetry(() => anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 700,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          {
            type: 'text',
            text: `You are an expert trading card identifier. Your ONLY job is to read the exact text printed on this card image.

CRITICAL RULES — follow these exactly:
1. Read the CARD NAME exactly as printed at the top of the card
2. Read the CARD NUMBER exactly as printed (bottom right, e.g. "120/124" or "SV122")  
3. Read the SET NAME exactly as printed (bottom of card, near copyright)
4. Read the RARITY symbol (common/uncommon/rare/ultra rare/secret rare etc.)
5. Do NOT guess — if you can see text, read it. If you cannot see it clearly, say so in confidence field.
6. For Pokemon: the set name is at the very bottom near the copyright line
7. The card number tells you exactly which printing this is — read it carefully

Respond ONLY with valid JSON, no markdown:
{
  "name": "exact name from card",
  "game": "Pokemon | Magic: The Gathering | Yu-Gi-Oh! | Lorcana | One Piece | Flesh and Blood | Sports | Other",
  "set": "exact set name from card",
  "number": "exact number e.g. 120/124",
  "rarity": "rarity symbol/text or null",
  "year": "copyright year or null",
  "condition": "Mint | Near Mint | Lightly Played | Moderately Played | Heavily Played",
  "foil": true or false,
  "extra": "1st Edition / Shadowless / Full Art / Alt Art / Secret Rare / etc or null",
  "confidence": "high | medium | low",
  "tcgplayerQuery": "exact name + set + number",
  "ebayQuery": "exact name + set + number optimised for sold listings",
  "cardmarketQuery": "exact name + set"
}
If you cannot identify: {"error":"Cannot identify card"}`
          }
        ]
      }]
    }));

    const raw = response.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
    let card;
    try { card = JSON.parse(raw); }
    catch { card = parseJSON(raw) || { error: 'Could not parse response.' }; }

    if (!card.error) await cacheSet(cKey, card, 86400);
    return res.json(card);
  } catch (err) {
    console.error('identify error:', err.message);
    return res.status(500).json({ error: err.message || 'Identification failed.' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /prices — always returns a price (Claude knowledge fallback)
// ═════════════════════════════════════════════════════════════════════════════
app.post('/prices', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  if (!checkRate(ip, 30)) return res.status(429).json({ error: 'Too many requests.' });

  const { card, ebayRegion = 'AU' } = req.body;
  if (!card?.name) return res.status(400).json({ error: 'No card data.' });

  const cKey = `prices4:${card.name}:${card.set}:${card.number}:${card.extra}:${ebayRegion}`;
  const cached = await cacheGet(cKey);
  if (cached) return res.json({ ...cached, cached: true });

  const prices = await getPricesFromClaude(card, ebayRegion);
  await cacheSet(cKey, prices);
  return res.json(prices);
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /card-image
// ═════════════════════════════════════════════════════════════════════════════
app.post('/card-image', async (req, res) => {
  const { card } = req.body;
  if (!card?.name) return res.json({ imageUrl: null });

  const cKey = `img2:${card.name}:${card.set}:${card.number}`;
  const cached = await cacheGet(cKey);
  if (cached) return res.json(cached);

  const imageUrl = await fetchCardImage(card);
  const result = { imageUrl };
  if (imageUrl) await cacheSet(cKey, result, 172800); // 48hr
  return res.json(result);
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /variants — Haiku knowledge for listing, eBay scraping for prices
// ═════════════════════════════════════════════════════════════════════════════
app.post('/variants', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  if (!checkRate(ip, 10)) return res.status(429).json({ error: 'Too many requests.' });

  const { card } = req.body;
  if (!card?.name) return res.status(400).json({ error: 'No card data.' });

  const cKey = `variants4:${card.name}:${card.game}`;
  const cached = await cacheGet(cKey);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    // Step 1: Get all versions from Claude knowledge
    const r = await withRetry(() => anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `List every known printing of "${card.name}" (${card.game}) across all sets.
Include: different sets, promos, alt arts, 1st edition, regional variants, secret rares.
Order by most valuable first. Max 12 versions.
Respond ONLY with JSON array, no markdown:
[{"set":"Base Set","year":"1999","number":"4/102","rarity":"Rare Holo","variant":"Shadowless","ebayQuery":"${card.name} Base Set Shadowless Holo 4/102"}]`
      }]
    }));

    const raw = r.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
    const versions = parseJSON(raw);
    if (!Array.isArray(versions) || !versions.length) return res.json({ variants: [] });

    // Step 2: Get prices for each variant from Claude (always returns something)
    const results = await Promise.all(
      versions.slice(0, 12).map(async (v, i) => {
        await delay(i * 150);
        const vKey = `vprice4:${card.name}:${v.set}:${v.variant || ''}`;
        const vCached = await cacheGet(vKey);
        if (vCached) return { ...v, ...vCached };

        try {
          const pr = await withRetry(() => anthropic.messages.create({
            model: 'claude-haiku-4-5',
            max_tokens: 150,
            messages: [{
              role: 'user',
              content: `Average eBay Australia sold price for: ${card.name}, ${v.set}, ${v.number || ''}, ${v.rarity || ''}, ${v.variant || ''}
Respond ONLY with JSON: {"available":true,"avg":10.00,"currency":"AUD"}
If no data: {"available":false,"avg":null,"currency":"AUD"}`
            }]
          }));
          const pRaw = pr.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
          const priceData = parseJSON(pRaw) || { available: false, avg: null, currency: 'AUD' };
          await cacheSet(vKey, priceData);
          return { ...v, ...priceData };
        } catch {
          return { ...v, available: false, avg: null, currency: 'AUD' };
        }
      })
    );

    results.sort((a, b) => {
      if (!a.available && b.available) return 1;
      if (a.available && !b.available) return -1;
      return (b.avg || 0) - (a.avg || 0);
    });

    const payload = { variants: results };
    await cacheSet(cKey, payload);
    return res.json(payload);
  } catch (err) {
    console.error('variants error:', err.message);
    return res.status(500).json({ error: err.message || 'Variant lookup failed.' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /generate-listing
// ═════════════════════════════════════════════════════════════════════════════
app.post('/generate-listing', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  if (!checkRate(ip, 10)) return res.status(429).json({ error: 'Too many requests.' });

  const { card, condition, askingPrice } = req.body;
  if (!card?.name) return res.status(400).json({ error: 'No card data.' });

  try {
    const r = await withRetry(() => anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `eBay Australia trading card listing. ONLY JSON, no markdown:
{"title":"80 char title","description":"150-200 word listing with condition, postage, SEO"}
${card.name} | ${card.game} | ${card.set||''} | #${card.number||''} | ${card.rarity||''} | Foil:${card.foil} | ${card.extra||''}
Condition: ${condition} | Price: $${askingPrice} AUD`
      }]
    }));
    const raw = r.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
    return res.json(JSON.parse(raw));
  } catch (err) {
    console.error('listing error:', err.message);
    return res.status(500).json({ error: err.message || 'Listing generation failed.' });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
initRedis().then(() => {
  app.listen(port, () => console.log(`TCG Scanner API v3 running on port ${port}`));
});
