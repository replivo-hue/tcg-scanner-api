/**
 * TCG Price Scanner — Backend Server v4
 * - Identify: Claude Sonnet vision (two-pass: visual + text)
 * - Prices + Images: Real TCG APIs only — PokéTCG, Scryfall, YGOPRODeck, Lorcana
 * - eBay: direct sold-listings search URL (no scraping, no fabrication)
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

// ─── Cache ────────────────────────────────────────────────────────────────────
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
    redis.on('error', e => console.error('[redis]', e.message));
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

// ─── Helpers ──────────────────────────────────────────────────────────────────
function httpGet(url, headers = {}, binary = false) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get({
      hostname: u.hostname, path: u.pathname + u.search,
      headers: { 'User-Agent': 'TCGScanner/4.0', 'Accept': binary ? 'image/*' : 'application/json', ...headers },
      timeout: 10000
    }, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location)
        return httpGet(res.headers.location, headers, binary).then(resolve).catch(reject);
      const chunks = [];
      res.on('data', c => chunks.push(typeof c === 'string' ? Buffer.from(c) : c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, body: binary ? buf.toString('base64') : buf.toString('utf8') });
      });
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

function buildEbayUrl(card, domain) {
  const q = [card.name, card.set, card.number, card.rarity].filter(Boolean).join(' ');
  return `https://www.${domain}/sch/i.html?_nkw=${encodeURIComponent(q)}&LH_Sold=1&LH_Complete=1`;
}

// ─── UNIFIED card lookup: returns { imageUrl, priceData } in one API call ────
// Each function hits one external API and extracts both image + price together.

async function lookupPokemon(card) {
  const name = card.name.replace(/[^a-zA-Z0-9 '\-éèêëàâùûîïôœ]/gi, '').trim();
  const num  = card.number ? card.number.split('/')[0].replace(/[^a-zA-Z0-9]/g, '') : '';

  // Try three progressively looser searches
  const queries = [];
  if (num) queries.push(`name:"${name}" number:${num}`);
  queries.push(`name:"${name}"`);
  // Fuzzy: strip special chars for last resort
  const plain = name.replace(/[^a-zA-Z0-9 ]/g, '').trim();
  if (plain !== name) queries.push(`name:"${plain}"`);

  for (const qStr of queries) {
    try {
      const r = await httpGet(`https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(qStr)}&pageSize=20&orderBy=-set.releaseDate`);
      if (r.status !== 200) continue;
      const cards = JSON.parse(r.body).data || [];
      if (!cards.length) continue;

      // Score: prefer set name match, then number match, else first result
      const setWord = (card.set || '').toLowerCase().split(' ')[0];
      let best = cards[0];
      if (setWord) {
        const setMatch = cards.find(c => c.set?.name?.toLowerCase().includes(setWord));
        if (setMatch) best = setMatch;
      }

      // Extract prices — try every tier
      const p = best.tcgplayer?.prices || {};
      const tier = p.holoRare || p['1stEditionHoloRare'] || p.reverseHoloRare ||
                   p.rare || p.normal || p.unlimited || p.holoRareH || Object.values(p)[0] || null;

      return {
        imageUrl:  best.images?.large || best.images?.small || null,
        tcgmarket: tier?.market ?? tier?.mid ?? null,
        tcglow:    tier?.low   ?? null,
        tcghigh:   tier?.high  ?? null,
        currency:  'USD',
        source:    'TCGPlayer via PokéTCG',
        cardId:    best.id
      };
    } catch (e) { console.log('[pokemon lookup]', e.message); }
  }
  return null;
}

async function lookupScryfall(card) {
  const name = encodeURIComponent(card.name);
  const attempts = [];
  // Try with set code first, then without
  if (card.set) {
    const setSlug = card.set.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6);
    attempts.push(`https://api.scryfall.com/cards/named?fuzzy=${name}&set=${setSlug}`);
  }
  attempts.push(`https://api.scryfall.com/cards/named?fuzzy=${name}`);

  for (const url of attempts) {
    try {
      const r = await httpGet(url);
      if (r.status !== 200) continue;
      const d = JSON.parse(r.body);
      const imgUri = d.image_uris || d.card_faces?.[0]?.image_uris;
      const market = parseFloat(d.prices?.usd) || parseFloat(d.prices?.usd_foil) || null;
      return {
        imageUrl:  imgUri?.normal || imgUri?.large || imgUri?.small || null,
        tcgmarket: market,
        tcglow:    null,
        tcghigh:   null,
        currency:  'USD',
        source:    'Scryfall'
      };
    } catch (e) { console.log('[scryfall lookup]', e.message); }
  }
  return null;
}

async function lookupYGO(card) {
  try {
    const q = encodeURIComponent(card.name);
    const r = await httpGet(`https://db.ygoprodeck.com/api/v7/cardinfo.php?name=${q}`);
    if (r.status !== 200) return null;
    const d = JSON.parse(r.body).data?.[0];
    if (!d) return null;
    const market = parseFloat(d.card_prices?.[0]?.tcgplayer_price) || null;
    return {
      imageUrl:  d.card_images?.[0]?.image_url || null,
      tcgmarket: market,
      tcglow:    null,
      tcghigh:   null,
      currency:  'USD',
      source:    'YGOPRODeck/TCGPlayer'
    };
  } catch (e) { console.log('[ygo lookup]', e.message); return null; }
}

async function lookupLorcana(card) {
  try {
    const q = encodeURIComponent(card.name);
    const r = await httpGet(`https://api.lorcana-api.com/cards/fetch?search=${q}`);
    if (r.status !== 200) return null;
    const d = JSON.parse(r.body);
    const item = Array.isArray(d) ? d[0] : d;
    return {
      imageUrl:  item?.Image || item?.image || null,
      tcgmarket: null, tcglow: null, tcghigh: null,
      currency:  'USD', source: 'Lorcana API'
    };
  } catch (e) { console.log('[lorcana lookup]', e.message); return null; }
}

// ── PriceCharting — build a direct search URL for the card
// Their API requires a paid subscription token so we can't call it directly.
// Instead we return a search URL so the user can tap through to see the price.
function buildPriceChartingUrl(card) {
  const parts = [card.name, card.set, card.number].filter(Boolean);
  const q = encodeURIComponent(parts.join(' '));
  return `https://www.pricecharting.com/search-products?q=${q}&type=prices&sort=popularity&broad-category=trading-cards`;
}

// Master lookup — primary TCG API per game
async function lookupCard(card) {
  const game = (card.game || '').toLowerCase();
  if (game.includes('pokemon'))                                   return lookupPokemon(card);
  if (game.includes('magic'))                                     return lookupScryfall(card);
  if (game.includes('yu-gi-oh') || game.includes('yugioh'))      return lookupYGO(card);
  if (game.includes('lorcana'))                                   return lookupLorcana(card);
  return lookupScryfall(card);
}

// ─── Card number verification ────────────────────────────────────────────────
// Fetches the official card image and asks Claude to read the number from it.
// If it doesn't match what /identify returned, we correct it.
// Only runs when: official image exists + card has a number + not cached.
async function verifyCardNumber(card, officialImageUrl) {
  // Nothing to verify if no number was found or no official image
  if (!card.number || !officialImageUrl) return null;

  try {
    // Fetch official image as base64 directly
    const r = await httpGet(officialImageUrl, {}, true);  // binary=true
    if (r.status !== 200) return null;

    const imgBase64 = r.body;  // already base64 from httpGet binary mode

    // Detect media type from URL
    const mediaType = officialImageUrl.includes('.png') ? 'image/png' : 'image/jpeg';

    // Ask Claude to read just the number from the official image
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',   // Haiku is fast + cheap for this simple read
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imgBase64 } },
          { type: 'text',  text: `What is the card number printed on this trading card? It appears in the bottom-right corner (e.g. "4/102", "110/113", "SV122").
Respond ONLY with JSON: {"number":"4/102"} or {"number":null} if unreadable.` }
        ]
      }]
    });

    const raw = response.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
    const result = JSON.parse(raw);
    const officialNumber = result?.number || null;

    if (!officialNumber) return null;

    // Compare — normalise both to remove spaces/dashes for comparison
    const norm = s => (s || '').replace(/[\s\-]/g, '').toLowerCase();
    const matches = norm(officialNumber) === norm(card.number);

    console.log(`[verify] scan="${card.number}" official="${officialNumber}" match=${matches}`);

    return {
      officialNumber,
      matches,
      corrected: !matches   // flag so frontend knows it was corrected
    };
  } catch (e) {
    console.log('[verify] error:', e.message);
    return null;   // verification failed — don't block the response
  }
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '12mb' }));
app.get('/', (_, res) => res.json({ status: 'ok', version: '4.0' }));

// ─── POST /identify ───────────────────────────────────────────────────────────
app.post('/identify', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  if (!checkRate(ip, 20)) return res.status(429).json({ error: 'Too many scans — wait a moment.' });

  const { imageBase64, mediaType = 'image/jpeg' } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'No image provided.' });

  const len = imageBase64.length;
  const cKey = 'id7:' + imageBase64.slice(0,16) + imageBase64.slice(Math.floor(len/2), Math.floor(len/2)+16) + imageBase64.slice(-16);
  const cached = await cacheGet(cKey);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    // ── PASS 1: Observation — force Claude to read every part of the card ─────
    // Sending the image ONCE with a description-only prompt.
    // Crucially: we ask it to READ TEXT literally, not identify the card yet.
    // This prevents it jumping straight to "Mew → must be SV 232/232".
    const obsResp = await withRetry(() => anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          { type: 'text', text: `You are a document scanner, not a card identifier. Your only job right now is to READ and DESCRIBE what is physically printed on this card — do NOT try to identify or name the card yet.

Report exactly what you can SEE for each area. If text is partially obscured, read what you can and note it. Do not fill in gaps from memory.

1. BORDER COLOUR & LAYOUT: Describe the colour of the outer border and the overall card frame style.
2. ARTWORK: Describe the creature/character/scene depicted — physical appearance, colours, pose, background.
3. NAME TEXT (top of card): Transcribe every character printed at the top, letter by letter.
4. HP / TYPE (top-right): What number and symbol appears in the top-right corner?
5. CARD NUMBER (bottom-right): Transcribe the exact digits — e.g. "4/102" or "120/124". Read each digit individually.
6. COPYRIGHT LINE (very bottom): Read the full copyright text printed at the very bottom edge.
7. SET SYMBOL SHAPE (bottom-left): Describe the exact shape of the small icon — is it a flame, snowflake, sun, crown, sword, shield, star burst, leaf, wave, etc?
8. RARITY SYMBOL: What shape is next to the card number — circle, diamond, star, two stars, three stars?
9. CARD TYPE / ABILITIES TEXT: Read any ability names or attack names you can make out in the card body.
10. SURFACE FINISH: Flat matte, holo, full-art rainbow holo, textured?

Respond with numbered points only. Quote text exactly as printed.` }
        ]
      }]
    }));

    const observations = obsResp.content.map(b => b.text || '').join('').trim();
    if (!observations) throw new Error('Observation pass empty');
    console.log('[identify pass1]', observations.slice(0, 300));

    // ── PASS 2: Identification — continue the SAME conversation ──────────────
    // The image is already in context. We just add the commit instruction.
    // Claude cannot re-hallucinate because it's constrained by its own observations.
    const response = await withRetry(() => anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
            { type: 'text', text: `You are a document scanner, not a card identifier. Your only job right now is to READ and DESCRIBE what is physically printed on this card — do NOT try to identify or name the card yet.

Report exactly what you can SEE for each area. If text is partially obscured, read what you can and note it. Do not fill in gaps from memory.

1. BORDER COLOUR & LAYOUT: Describe the colour of the outer border and the overall card frame style.
2. ARTWORK: Describe the creature/character/scene depicted — physical appearance, colours, pose, background.
3. NAME TEXT (top of card): Transcribe every character printed at the top, letter by letter.
4. HP / TYPE (top-right): What number and symbol appears in the top-right corner?
5. CARD NUMBER (bottom-right): Transcribe the exact digits — e.g. "4/102" or "120/124". Read each digit individually.
6. COPYRIGHT LINE (very bottom): Read the full copyright text printed at the very bottom edge.
7. SET SYMBOL SHAPE (bottom-left): Describe the exact shape of the small icon — is it a flame, snowflake, sun, crown, sword, shield, star burst, leaf, wave, etc?
8. RARITY SYMBOL: What shape is next to the card number — circle, diamond, star, two stars, three stars?
9. CARD TYPE / ABILITIES TEXT: Read any ability names or attack names you can make out in the card body.
10. SURFACE FINISH: Flat matte, holo, full-art rainbow holo, textured?

Respond with numbered points only. Quote text exactly as printed.` }
          ]
        },
        // Inject Pass 1 observations as the assistant turn — Claude must honour these
        { role: 'assistant', content: observations },
        {
          role: 'user',
          content: `Now use ONLY what you transcribed above to identify this card. Do not add information from memory that contradicts your observations.

RULES:
- "name" = exactly what you read in point 3 (name text)
- "number" = exactly what you read in point 5 — if you read "120/124" write "120/124", not something else
- "set" = derive from copyright line (point 6) and set symbol shape (point 7) together
- If your observed number exceeds the set total (e.g. you wrote 232/124) that is a misread — set number to null
- "extra" = Full Art if the artwork covers the whole card; Secret Rare only if number exceeds the set's printed total
- Set any field to null if your observations were unclear — never substitute from memory

Respond ONLY with valid JSON, no markdown:
{
  "name": "from point 3",
  "game": "Pokemon | Magic: The Gathering | Yu-Gi-Oh! | Lorcana | One Piece | Flesh and Blood | Sports | Other",
  "set": "derived from points 6 and 7, or null",
  "number": "from point 5, or null",
  "rarity": "from point 8, or null",
  "year": "from copyright in point 6, or null",
  "condition": "Mint | Near Mint | Lightly Played | Moderately Played | Heavily Played",
  "foil": true or false,
  "extra": "Full Art | Alt Art | Secret Rare | 1st Edition | Shadowless | Promo | null",
  "confidence": "high | medium | low",
  "tcgplayerQuery": "name set number",
  "ebayQuery": "name set number for eBay sold listings",
  "cardmarketQuery": "name set"
}
If image is not a trading card or completely unreadable: {"error":"Cannot identify card"}`
        }
      ]
    }));

    const raw = response.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
    let card;
    try { card = JSON.parse(raw); }
    catch { card = parseJSON(raw) || { error: 'Could not parse response.' }; }

    if (!card.error) await cacheSet(cKey, card, 21600);
    return res.json(card);
  } catch (err) {
    console.error('identify error:', err.message);
    return res.status(500).json({ error: err.message || 'Identification failed.' });
  }
});

// ─── POST /prices ─────────────────────────────────────────────────────────────
// Returns real TCG prices. Also piggybacks the official image URL so the
// frontend only needs one extra round-trip instead of two.
app.post('/prices', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  if (!checkRate(ip, 30)) return res.status(429).json({ error: 'Too many requests.' });

  const { card, ebayRegion = 'AU' } = req.body;
  if (!card?.name) return res.status(400).json({ error: 'No card data.' });

  const conf = EBAY_REGIONS[ebayRegion] || EBAY_REGIONS['AU'];
  const cKey = `prices6:${card.name}:${card.set}:${card.number}:${card.foil}:${ebayRegion}`;
  const cached = await cacheGet(cKey);
  if (cached) return res.json({ ...cached, cached: true });

  const lookup = await lookupCard(card);

  const tcgplayer = (lookup?.tcgmarket != null)
    ? { available: true, market: lookup.tcgmarket, low: lookup.tcglow, high: lookup.tcghigh, currency: lookup.currency || 'USD', source: lookup.source, isEstimate: false }
    : { available: false, market: null, currency: 'USD', isEstimate: false };

  // eBay: direct sold-listings search link
  const ebay = {
    available: false,
    avg: null,
    currency: conf.currency,
    region: ebayRegion,
    regionLabel: conf.label,
    searchUrl: buildEbayUrl(card, conf.domain),
    isEstimate: false
  };

  // PriceCharting: search link (their API requires a paid token)
  const pricecharting = {
    available: false,
    market: null,
    currency: 'USD',
    searchUrl: buildPriceChartingUrl(card),
    isEstimate: false
  };

  const officialImageUrl = lookup?.imageUrl || null;

  // ── Number verification: compare scanned number vs number on the official image
  let numberVerification = null;
  if (officialImageUrl && card.number) {
    numberVerification = await verifyCardNumber(card, officialImageUrl);
    if (numberVerification && !numberVerification.matches && numberVerification.officialNumber) {
      console.log(`[verify] Correcting number: "${card.number}" -> "${numberVerification.officialNumber}"`);
    }
  }

  const verifiedNumber = (numberVerification && !numberVerification.matches && numberVerification.officialNumber)
    ? numberVerification.officialNumber
    : card.number;

  const result = {
    tcgplayer,
    ebay,
    pricecharting,
    officialImageUrl,
    numberVerification: numberVerification ? {
      scannedNumber:  card.number,
      officialNumber: numberVerification.officialNumber,
      matches:        numberVerification.matches,
      corrected:      numberVerification.corrected,
      verifiedNumber
    } : null
  };

  await cacheSet(cKey, result, 3600);
  return res.json(result);
});

// ─── POST /card-image ─────────────────────────────────────────────────────────
app.post('/card-image', async (req, res) => {
  const { card } = req.body;
  if (!card?.name) return res.json({ imageUrl: null });

  const cKey = `img4:${card.name}:${card.set}:${card.number}`;
  const cached = await cacheGet(cKey);
  if (cached) return res.json(cached);

  const lookup = await lookupCard(card);
  const result = { imageUrl: lookup?.imageUrl || null };
  if (result.imageUrl) await cacheSet(cKey, result, 172800);
  return res.json(result);
});

// ─── POST /variants ───────────────────────────────────────────────────────────
app.post('/variants', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  if (!checkRate(ip, 10)) return res.status(429).json({ error: 'Too many requests.' });

  const { card } = req.body;
  if (!card?.name) return res.status(400).json({ error: 'No card data.' });

  const game = (card.game || '').toLowerCase();
  const cKey = `variants6:${card.name}:${card.game}`;
  const cached = await cacheGet(cKey);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    let variants = [];

    if (game.includes('pokemon')) {
      const name = card.name.replace(/[^a-zA-Z0-9 '\-éèêëàâùûîïôœ]/gi, '').trim();
      const r = await httpGet(`https://api.pokemontcg.io/v2/cards?q=${encodeURIComponent(`name:"${name}"`)}&pageSize=50&orderBy=-set.releaseDate`);
      if (r.status === 200) {
        const cards = JSON.parse(r.body).data || [];
        variants = cards.map(c => {
          const p = c.tcgplayer?.prices || {};
          const tier = p.holoRare || p['1stEditionHoloRare'] || p.reverseHoloRare ||
                       p.rare || p.normal || p.unlimited || Object.values(p)[0] || null;
          return {
            set: c.set?.name || null, year: c.set?.releaseDate?.slice(0,4) || null,
            number: c.number || null, rarity: c.rarity || null, variant: null,
            imageUrl: c.images?.small || null,
            available: !!(tier?.market), avg: tier?.market ?? null,
            low: tier?.low ?? null, high: tier?.high ?? null,
            currency: 'USD', source: 'TCGPlayer via PokéTCG',
            ebayQuery: `${card.name} ${c.set?.name || ''} ${c.number || ''}`.trim()
          };
        }).filter(v => v.set);
      }
    } else if (game.includes('magic')) {
      const q = encodeURIComponent(card.name);
      const r = await httpGet(`https://api.scryfall.com/cards/search?q=!"${q}"&unique=prints&order=released&dir=desc`);
      if (r.status === 200) {
        variants = (JSON.parse(r.body).data || []).slice(0, 30).map(c => {
          const market = parseFloat(c.prices?.usd) || parseFloat(c.prices?.usd_foil) || null;
          return {
            set: c.set_name || null, year: c.released_at?.slice(0,4) || null,
            number: c.collector_number || null, rarity: c.rarity || null,
            variant: c.frame_effects?.join(', ') || null,
            imageUrl: c.image_uris?.small || c.card_faces?.[0]?.image_uris?.small || null,
            available: market != null, avg: market, currency: 'USD', source: 'Scryfall',
            ebayQuery: `${card.name} ${c.set_name || ''}`.trim()
          };
        }).filter(v => v.set);
      }
    }

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

// ─── POST /generate-listing ───────────────────────────────────────────────────
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
  app.listen(port, () => console.log(`TCG Scanner API v4 running on port ${port}`));
});
