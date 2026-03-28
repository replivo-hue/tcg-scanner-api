/**
 * TCG Price Scanner — Backend Server v3
 * - Identify: Claude Sonnet vision (accurate, reads exact card text)
 * - Prices: Real TCG APIs (PokéTCG, Scryfall, YGOPRODeck) — never fabricated
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
// PRICE LOOKUP — Real APIs only. NEVER fabricate prices.
// Pokemon: PokéTCG API (has real TCGPlayer market prices)
// MTG: Scryfall (has real USD market prices)
// YGO: YGOPRODeck (has real TCGPlayer prices)
// eBay: surface a direct sold-listings search URL — never scrape/invent a number
// Returns available:false with null values when real data is not found.
// ═════════════════════════════════════════════════════════════════════════════

// ── PokéTCG prices (Pokemon only) ────────────────────────────────────────────
async function fetchPokemonPrices(card) {
  try {
    const nameQ = card.name.replace(/[^a-zA-Z0-9 '\-]/g, '').trim();
    const numQ  = card.number ? card.number.split('/')[0].replace(/[^a-zA-Z0-9]/g, '') : '';
    let apiCard = null;

    // Strategy 1: name + number (most precise)
    if (numQ) {
      const q = encodeURIComponent(`name:"${nameQ}" number:${numQ}`);
      const r = await httpGet(`https://api.pokemontcg.io/v2/cards?q=${q}&pageSize=20`);
      if (r.status === 200) {
        const cards = JSON.parse(r.body).data || [];
        const setWord = (card.set || '').toLowerCase().split(' ')[0];
        apiCard = cards.find(c => setWord && c.set?.name?.toLowerCase().includes(setWord)) || cards[0] || null;
      }
    }
    // Strategy 2: name only, filter by set word
    if (!apiCard) {
      const q2 = encodeURIComponent(`name:"${nameQ}"`);
      const r2 = await httpGet(`https://api.pokemontcg.io/v2/cards?q=${q2}&pageSize=20&orderBy=-set.releaseDate`);
      if (r2.status === 200) {
        const cards = JSON.parse(r2.body).data || [];
        const setWord = (card.set || '').toLowerCase().split(' ')[0];
        apiCard = cards.find(c => setWord && c.set?.name?.toLowerCase().includes(setWord)) || cards[0] || null;
      }
    }

    if (!apiCard) return null;
    const p = apiCard.tcgplayer?.prices;
    if (!p) return null;
    const tier = p.holoRare || p.reverseHoloRare || p.rare || p['1stEditionHoloRare'] || p.normal || p.unlimited || null;
    if (!tier) return null;

    return {
      market:   tier.market   ?? tier.mid   ?? null,
      low:      tier.low      ?? null,
      high:     tier.high     ?? null,
      currency: 'USD',
      source:   'TCGPlayer via PokéTCG API',
      imageUrl: apiCard.images?.large || apiCard.images?.small || null
    };
  } catch (e) { console.log('[price pokemon]', e.message); return null; }
}

// ── Scryfall prices (Magic only) ──────────────────────────────────────────────
async function fetchScryfallPrices(card) {
  try {
    const q = encodeURIComponent(card.name);
    let r = null;
    if (card.set) {
      const setSlug = card.set.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6);
      r = await httpGet(`https://api.scryfall.com/cards/named?fuzzy=${q}&set=${encodeURIComponent(setSlug)}`);
    }
    if (!r || r.status !== 200) {
      r = await httpGet(`https://api.scryfall.com/cards/named?fuzzy=${q}`);
    }
    if (r.status !== 200) return null;
    const data = JSON.parse(r.body);
    const prices = data?.prices;
    if (!prices) return null;
    const market = parseFloat(prices.usd) || parseFloat(prices.usd_foil) || null;
    if (market == null) return null;
    return {
      market, low: null, high: null, currency: 'USD', source: 'Scryfall',
      imageUrl: data?.image_uris?.normal || data?.card_faces?.[0]?.image_uris?.normal || null
    };
  } catch (e) { console.log('[price scryfall]', e.message); return null; }
}

// ── YGOPRODeck prices (Yu-Gi-Oh only) ────────────────────────────────────────
async function fetchYGOPrices(card) {
  try {
    const q = encodeURIComponent(card.name);
    const r = await httpGet(`https://db.ygoprodeck.com/api/v7/cardinfo.php?name=${q}`);
    if (r.status !== 200) return null;
    const cardData = JSON.parse(r.body).data?.[0];
    if (!cardData) return null;
    const prices = cardData.card_prices?.[0];
    const market = parseFloat(prices?.tcgplayer_price) || null;
    if (market == null) return null;
    return {
      market, low: null, high: null, currency: 'USD', source: 'YGOPRODeck/TCGPlayer',
      imageUrl: cardData.card_images?.[0]?.image_url || null
    };
  } catch (e) { console.log('[price ygo]', e.message); return null; }
}

function buildEbaySearchUrl(card, domain) {
  const parts = [card.name, card.set, card.number, card.rarity].filter(Boolean);
  return `https://www.${domain}/sch/i.html?_nkw=${encodeURIComponent(parts.join(' '))}&LH_Sold=1&LH_Complete=1`;
}

// ── Main price resolver: REAL DATA ONLY, never fabricate ─────────────────────
async function getRealPrices(card, ebayRegion = 'AU') {
  const conf = EBAY_REGIONS[ebayRegion] || EBAY_REGIONS['AU'];
  const game = (card.game || '').toLowerCase();

  let tcgData = null;
  if (game.includes('pokemon'))                            tcgData = await fetchPokemonPrices(card);
  else if (game.includes('magic'))                         tcgData = await fetchScryfallPrices(card);
  else if (game.includes('yu-gi-oh') || game.includes('yugioh')) tcgData = await fetchYGOPrices(card);

  const tcgplayer = tcgData
    ? { available: true, market: tcgData.market, low: tcgData.low, high: tcgData.high, currency: tcgData.currency, source: tcgData.source, isEstimate: false }
    : { available: false, market: null, currency: 'USD', isEstimate: false };

  // eBay: never scrape/fabricate — give user a direct sold-listings link instead
  const ebay = {
    available: false,
    avg: null,
    currency: conf.currency,
    region: ebayRegion,
    regionLabel: conf.label,
    searchUrl: buildEbaySearchUrl(card, conf.domain),
    isEstimate: false
  };

  return { tcgplayer, ebay, cardkingdom: { available: false, retail: null, currency: 'USD', isEstimate: false } };
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
  const cKey = 'id4:' + imageBase64.slice(0,16) + imageBase64.slice(Math.floor(len/2), Math.floor(len/2)+16) + imageBase64.slice(-16);
  const cached = await cacheGet(cKey);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const response = await withRetry(() => anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          {
            type: 'text',
            text: `You are a trading card identification system. You have TWO jobs: (1) visually recognise the card from its artwork and layout, and (2) read the printed text to confirm exact details.

STEP 1 — VISUAL RECOGNITION (use the image):
- Identify the game from card frame/border/layout (Pokemon yellow border; MTG coloured mana frame; YGO dark border with ATK/DEF)
- Recognise the card artwork to get the card name
- Identify the set symbol icon (bottom-left area of most cards)
- Check if the surface is holographic/foil

STEP 2 — READ THE TEXT (zoom in mentally on each area):
- TOP of card: card name (read exactly, including punctuation like Farfetch'd, Pikachu ex, etc.)
- BOTTOM-RIGHT: card number (e.g. "110/113", "SV122", "SWSH Black Star Promo 001") — READ EVERY CHARACTER
- BOTTOM of card near copyright: set name (Pokemon: tiny text like "Noble Victories" or "Scarlet & Violet—Paradox Rift")
- BOTTOM-LEFT: set symbol (visual icon)
- Rarity symbol: circle=common, diamond=uncommon, star=rare, star+H=holo rare

ABSOLUTE RULES — violation means app shows wrong data to users:
- The card number + set name together UNIQUELY identify the card. A card "110/113 Noble Victories" MUST exist in the Noble Victories set which has exactly 113 cards. If your number exceeds the set's total, you have misread it — set number to null.
- NEVER invent or guess a set name. If you cannot clearly read it, return null for set.
- NEVER invent or guess a card number. If you cannot clearly read it, return null for number.  
- If confidence is low for any field, set it to null rather than guessing.
- If the image is too blurry, too dark, or not a trading card: return {"error":"Cannot identify card"}

Respond ONLY with valid JSON, no markdown:
{
  "name": "exact card name as printed",
  "game": "Pokemon | Magic: The Gathering | Yu-Gi-Oh! | Lorcana | One Piece | Flesh and Blood | Sports | Other",
  "set": "exact set name as printed or null if unreadable",
  "number": "exact number as printed e.g. 110/113 or null if unreadable",
  "rarity": "rarity text/symbol or null",
  "year": "copyright year or null",
  "condition": "Mint | Near Mint | Lightly Played | Moderately Played | Heavily Played",
  "foil": true or false,
  "extra": "1st Edition / Shadowless / Full Art / Alt Art / Secret Rare / Promo / etc or null",
  "confidence": "high | medium | low",
  "tcgplayerQuery": "name set number",
  "ebayQuery": "name set number rarity optimised for eBay sold listings",
  "cardmarketQuery": "name set"
}
If image is unreadable or not a card: {"error":"Cannot identify card"}`
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
// POST /prices — real API data only, never fabricated
// ═════════════════════════════════════════════════════════════════════════════
app.post('/prices', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  if (!checkRate(ip, 30)) return res.status(429).json({ error: 'Too many requests.' });

  const { card, ebayRegion = 'AU' } = req.body;
  if (!card?.name) return res.status(400).json({ error: 'No card data.' });

  const cKey = `prices5:${card.name}:${card.set}:${card.number}:${card.extra}:${ebayRegion}`;
  const cached = await cacheGet(cKey);
  if (cached) return res.json({ ...cached, cached: true });

  const prices = await getRealPrices(card, ebayRegion);
  await cacheSet(cKey, prices, 3600); // 1hr cache — prices change
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
// POST /variants — real printings from TCG APIs, real prices, no fabrication
// ═════════════════════════════════════════════════════════════════════════════
// ═════════════════════════════════════════════════════════════════════════════
// POST /variants — real printings from TCG APIs, real prices, no fabrication
// Pokemon: PokéTCG API returns real card list with real TCGPlayer prices
// MTG/YGO/other: returns empty (fabricating variants is worse than nothing)
// ═════════════════════════════════════════════════════════════════════════════
app.post('/variants', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  if (!checkRate(ip, 10)) return res.status(429).json({ error: 'Too many requests.' });

  const { card } = req.body;
  if (!card?.name) return res.status(400).json({ error: 'No card data.' });

  const game = (card.game || '').toLowerCase();
  const cKey = `variants5:${card.name}:${card.game}`;
  const cached = await cacheGet(cKey);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    let variants = [];

    if (game.includes('pokemon')) {
      // PokéTCG API: get ALL real printings of this card
      const nameQ = card.name.replace(/[^a-zA-Z0-9 '\-]/g, '').trim();
      const q = encodeURIComponent(`name:"${nameQ}"`);
      const r = await httpGet(`https://api.pokemontcg.io/v2/cards?q=${q}&pageSize=50&orderBy=-set.releaseDate`);
      if (r.status === 200) {
        const cards = JSON.parse(r.body).data || [];
        variants = cards.map(c => {
          const p = c.tcgplayer?.prices;
          const tier = p && (p.holoRare || p.reverseHoloRare || p.rare || p['1stEditionHoloRare'] || p.normal || p.unlimited);
          return {
            set:      c.set?.name    || null,
            year:     c.set?.releaseDate?.slice(0,4) || null,
            number:   c.number      || null,
            rarity:   c.rarity      || null,
            variant:  null,
            imageUrl: c.images?.small || null,
            available: !!(tier?.market),
            avg:      tier?.market   ?? null,
            low:      tier?.low      ?? null,
            high:     tier?.high     ?? null,
            currency: 'USD',
            source:   'TCGPlayer via PokéTCG',
            ebayQuery: `${card.name} ${c.set?.name || ''} ${c.number || ''}`.trim()
          };
        }).filter(v => v.set); // skip any blank entries
      }
    } else if (game.includes('magic')) {
      // Scryfall: get all printings of this card
      const q = encodeURIComponent(card.name);
      const r = await httpGet(`https://api.scryfall.com/cards/search?q=!"${q}"&unique=prints&order=released&dir=desc`);
      if (r.status === 200) {
        const data = JSON.parse(r.body);
        variants = (data.data || []).slice(0, 30).map(c => {
          const market = parseFloat(c.prices?.usd) || parseFloat(c.prices?.usd_foil) || null;
          return {
            set:      c.set_name    || null,
            year:     c.released_at?.slice(0,4) || null,
            number:   c.collector_number || null,
            rarity:   c.rarity      || null,
            variant:  c.frame_effects?.join(', ') || null,
            imageUrl: c.image_uris?.small || c.card_faces?.[0]?.image_uris?.small || null,
            available: market != null,
            avg:      market,
            currency: 'USD',
            source:   'Scryfall',
            ebayQuery: `${card.name} ${c.set_name || ''}`.trim()
          };
        }).filter(v => v.set);
      }
    }
    // For all other games: return empty — fabricating variants is dangerous

    // Sort by price descending, unknowns last
    variants.sort((a, b) => {
      if (!a.available && b.available) return 1;
      if (a.available && !b.available) return -1;
      return (b.avg || 0) - (a.avg || 0);
    });

    const payload = { variants };
    if (variants.length) await cacheSet(cKey, payload, 3600);
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
