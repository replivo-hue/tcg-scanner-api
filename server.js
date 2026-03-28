/**
 * TCG Price Scanner — Backend Server
 * ------------------------------------
 * - Card ID:     Claude Sonnet vision (~$0.004/scan)
 * - Prices:      Direct scraping — NO web search fees ($0)
 * - Cache:       Redis (persistent across redeploys) with in-memory fallback
 * - Variants:    Claude Haiku knowledge (no web search)
 */

const express   = require('express');
const cors      = require('cors');
const https     = require('https');
const http      = require('http');
const Anthropic = require('@anthropic-ai/sdk');

const app  = express();
const port = process.env.PORT || 3000;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Redis cache (persistent) with in-memory fallback ────────────────────────
let redisClient = null;
const memCache  = new Map();
const PRICE_TTL = 60 * 60 * 6;   // 6 hours
const ID_TTL    = 60 * 60 * 24;  // 24 hours

async function initRedis() {
  const url = process.env.REDIS_URL || process.env.REDIS_PRIVATE_URL;
  if (!url) { console.log('[cache] No REDIS_URL — using in-memory'); return; }
  try {
    let createClient;
    try { createClient = require('redis').createClient; }
    catch { console.log('[cache] redis package not installed — using in-memory'); return; }
    redisClient = createClient({ url });
    redisClient.on('error', e => { console.error('[redis]', e.message); redisClient = null; });
    await redisClient.connect();
    console.log('[cache] Redis connected');
  } catch (e) {
    console.log('[cache] Redis failed, using memory:', e.message);
    redisClient = null;
  }
}

async function cacheGet(key) {
  try {
    if (redisClient) {
      const val = await redisClient.get(key);
      return val ? JSON.parse(val) : null;
    }
  } catch {}
  const hit = memCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) { memCache.delete(key); return null; }
  return hit.data;
}

async function cacheSet(key, data, ttl = PRICE_TTL) {
  try {
    if (redisClient) { await redisClient.set(key, JSON.stringify(data), { EX: ttl }); return; }
  } catch {}
  memCache.set(key, { data, exp: Date.now() + ttl * 1000 });
}

// ─── HTTP GET helper ─────────────────────────────────────────────────────────
function httpGet(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/json,*/*',
        'Accept-Language': 'en-AU,en;q=0.9',
        ...extraHeaders
      },
      timeout: 10000
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ─── Scrapers ────────────────────────────────────────────────────────────────
async function scrapeTCGPlayer(card) {
  try {
    const q = encodeURIComponent(`${card.name} ${card.set || ''} ${card.number || ''}`);
    const res = await httpGet(`https://www.tcgplayer.com/search/all/product?q=${q}&view=grid`);
    if (res.status !== 200) return { available: false, market: null, currency: 'USD' };
    const m = res.body.match(/"price"\s*:\s*"?([\d.]+)"?/) ||
              res.body.match(/market-price[^>]*>\$?\s*([\d.]+)/) ||
              res.body.match(/data-price="([\d.]+)"/);
    if (m) return { available: true, market: parseFloat(m[1]), currency: 'USD' };
    return { available: false, market: null, currency: 'USD' };
  } catch (e) {
    console.log('[tcg]', e.message);
    return { available: false, market: null, currency: 'USD' };
  }
}

const EBAY_REGIONS = {
  AU: { domain: 'ebay.com.au', currency: 'AUD', label: 'eBay Australia' },
  US: { domain: 'ebay.com',    currency: 'USD', label: 'eBay USA' },
  UK: { domain: 'ebay.co.uk',  currency: 'GBP', label: 'eBay UK' },
  CA: { domain: 'ebay.ca',     currency: 'CAD', label: 'eBay Canada' },
  DE: { domain: 'ebay.de',     currency: 'EUR', label: 'eBay Germany' },
  JP: { domain: 'ebay.com',    currency: 'USD', label: 'eBay (Intl)' },
};

async function scrapeEbay(card, region = 'AU') {
  const conf = EBAY_REGIONS[region] || EBAY_REGIONS['AU'];
  try {
    const q = encodeURIComponent(card.ebayQuery || `${card.name} ${card.set || ''} ${card.number || ''}`);
    const url = `https://www.${conf.domain}/sch/i.html?_nkw=${q}&LH_Sold=1&LH_Complete=1&_sop=13&rt=nc&_ipg=20`;
    const res = await httpGet(url);
    if (res.status !== 200) return { available: false, avg: null, currency: conf.currency, region, regionLabel: conf.label };

    const prices = [...res.body.matchAll(/s-item__price[^>]*>[^<]*?([\d,]+\.\d{2})/g)]
      .map(m => parseFloat(m[1].replace(/,/g, '')))
      .filter(p => p > 0.5 && p < 50000);

    if (!prices.length) return { available: false, avg: null, currency: conf.currency, region, regionLabel: conf.label };
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    return { available: true, avg: Math.round(avg * 100) / 100, currency: conf.currency, region, regionLabel: conf.label };
  } catch (e) {
    console.log('[ebay]', e.message);
    return { available: false, avg: null, currency: conf.currency, region, regionLabel: conf.label };
  }
}

async function scrapeCardKingdom(card) {
  try {
    const q = encodeURIComponent(`${card.name} ${card.set || ''}`);
    const res = await httpGet(`https://www.cardkingdom.com/catalog/search?search=header&filter%5Bname%5D=${q}`);
    if (res.status !== 200) return { available: false, retail: null, currency: 'USD' };
    const m = res.body.match(/class="productItemPrice"[^>]*>\s*\$([\d.]+)/) ||
              res.body.match(/addToCart[^$]*\$([\d.]+)/) ||
              res.body.match(/\$\s*([\d]+\.\d{2})/);
    if (m) return { available: true, retail: parseFloat(m[1]), currency: 'USD' };
    return { available: false, retail: null, currency: 'USD' };
  } catch (e) {
    console.log('[ck]', e.message);
    return { available: false, retail: null, currency: 'USD' };
  }
}

// Fallback: Claude Haiku price estimate from training data (no web search)
async function claudePriceFallback(card, ebayRegion = 'AU') {
  const currency = EBAY_REGIONS[ebayRegion]?.currency || 'AUD';
  const label    = EBAY_REGIONS[ebayRegion]?.label    || 'eBay';
  try {
    const r = await withRetry(() => anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 250,
      messages: [{
        role: 'user',
        content: `Approximate market prices for: ${card.name}, ${card.set || ''}, ${card.number || ''}, ${card.rarity || ''}
Respond ONLY with JSON (no markdown):
{"tcgplayer":{"available":true,"market":5.00,"currency":"USD","isEstimate":true},"ebay":{"available":true,"avg":8.00,"currency":"${currency}","region":"${ebayRegion}","regionLabel":"${label}","isEstimate":true},"cardkingdom":{"available":true,"retail":6.00,"currency":"USD","isEstimate":true}}
Use null and available:false for anything you don't know.`
      }]
    }));
    const raw = r.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
    return parseJSON(raw) || defaultPrices(currency, ebayRegion, label);
  } catch { return defaultPrices(currency, ebayRegion, label); }
}

function defaultPrices(currency, region, label) {
  return {
    tcgplayer:   { available: false, market: null, currency: 'USD' },
    ebay:        { available: false, avg: null, currency, region, regionLabel: label },
    cardkingdom: { available: false, retail: null, currency: 'USD' }
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
const rateMap = new Map();
function checkRate(ip, limit = 30) {
  const now  = Date.now();
  const hits = (rateMap.get(ip) || []).filter(t => now - t < 60000);
  if (hits.length >= limit) return false;
  hits.push(now);
  rateMap.set(ip, hits);
  return true;
}

async function withRetry(fn, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (err) {
      const is429 = err?.status === 429 || String(err?.message).includes('429');
      if (is429 && i < retries) { await new Promise(r => setTimeout(r, (i + 1) * 3000)); continue; }
      throw err;
    }
  }
}

function parseJSON(text) {
  try {
    const m = (text || '').replace(/```json|```/g, '').trim().match(/[\[{][\s\S]*[\]}]/);
    return m ? JSON.parse(m[0]) : null;
  } catch { return null; }
}

const delay = ms => new Promise(r => setTimeout(r, ms));

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '12mb' }));
app.get('/', (_, res) => res.json({ status: 'ok', service: 'TCG Price Scanner API' }));

// ═════════════════════════════════════════════════════════════════════════════
// POST /identify
// ═════════════════════════════════════════════════════════════════════════════
app.post('/identify', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  if (!checkRate(ip, 20)) return res.status(429).json({ error: 'Too many scans — wait a moment.' });

  const { imageBase64, mediaType = 'image/jpeg' } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'No image provided.' });

  const len = imageBase64.length;
  const cacheKey = 'id:' + imageBase64.slice(0, 16) + imageBase64.slice(Math.floor(len / 2), Math.floor(len / 2) + 16) + imageBase64.slice(-16);
  const cached = await cacheGet(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const response = await withRetry(() => anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          {
            type: 'text',
            text: `You are an expert trading card identifier. READ THE EXACT TEXT printed on this card.

RULES:
- Read card number exactly as printed (e.g. "120/124")
- Read set name exactly as printed at the bottom
- Read card name exactly as printed at the top
- Do NOT confuse similar cards

Respond ONLY with JSON, no markdown:
{"name":"exact name","game":"Pokemon | Magic: The Gathering | Yu-Gi-Oh! | Lorcana | One Piece | Flesh and Blood | Sports | Other","set":"exact set name","number":"exact number e.g. 120/124","rarity":"rarity or null","year":"year or null","condition":"Mint | Near Mint | Lightly Played | Moderately Played | Heavily Played","foil":true,"extra":"1st Edition or null","confidence":"high | medium | low","tcgplayerQuery":"name set number","ebayQuery":"name set number for ebay","cardmarketQuery":"name set"}
If cannot identify: {"error":"Cannot identify card"}`
          }
        ]
      }]
    }));

    const raw  = response.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
    let card;
    try { card = JSON.parse(raw); }
    catch { card = parseJSON(raw) || { error: 'Could not parse card data — try again.' }; }
    if (!card.error) await cacheSet(cacheKey, card, ID_TTL);
    return res.json(card);
  } catch (err) {
    console.error('identify error:', err.message);
    return res.status(500).json({ error: err.message || 'Identification failed.' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /card-image
// Fetches official card image from free databases (PokéTCG, Scryfall, YGOPRODeck)
// ═════════════════════════════════════════════════════════════════════════════
app.post('/card-image', async (req, res) => {
  const { card } = req.body;
  if (!card?.name) return res.status(400).json({ imageUrl: null });

  const cacheKey = `img:${card.name}:${card.set}:${card.number}`;
  const cached = await cacheGet(cacheKey, 60 * 60 * 48); // 48hr cache for images
  if (cached) return res.json(cached);

  let imageUrl = null;

  try {
    const game = (card.game || '').toLowerCase();

    // ── Pokémon: PokéTCG API (free, no key for basic) ───────────────────────
    if (game.includes('pokemon')) {
      const q = encodeURIComponent(`name:"${card.name}"${card.number ? ` number:"${card.number.split('/')[0]}"` : ''}`);
      const r = await httpGet(`https://api.pokemontcg.io/v2/cards?q=${q}&pageSize=5`, {
        'Accept': 'application/json'
      });
      if (r.status === 200) {
        const data = JSON.parse(r.body);
        const cards = data.data || [];
        // Try to match by set name if possible
        const match = cards.find(c =>
          card.set && c.set?.name?.toLowerCase().includes(card.set.toLowerCase())
        ) || cards[0];
        if (match?.images?.large) imageUrl = match.images.large;
        else if (match?.images?.small) imageUrl = match.images.small;
      }
    }

    // ── Magic: The Gathering: Scryfall API (free) ────────────────────────────
    else if (game.includes('magic')) {
      const q = encodeURIComponent(`!"${card.name}"${card.set ? ` set:"${card.set}"` : ''}`);
      const r = await httpGet(`https://api.scryfall.com/cards/search?q=${q}&order=released&dir=asc`, {
        'Accept': 'application/json'
      });
      if (r.status === 200) {
        const data = JSON.parse(r.body);
        const match = data.data?.[0];
        imageUrl = match?.image_uris?.normal || match?.image_uris?.small ||
                   match?.card_faces?.[0]?.image_uris?.normal || null;
      }
    }

    // ── Yu-Gi-Oh: YGOPRODeck API (free) ─────────────────────────────────────
    else if (game.includes('yu-gi-oh') || game.includes('yugioh')) {
      const q = encodeURIComponent(card.name);
      const r = await httpGet(`https://db.ygoprodeck.com/api/v7/cardinfo.php?name=${q}`, {
        'Accept': 'application/json'
      });
      if (r.status === 200) {
        const data = JSON.parse(r.body);
        imageUrl = data.data?.[0]?.card_images?.[0]?.image_url || null;
      }
    }

    // ── Lorcana: Lorcana API ─────────────────────────────────────────────────
    else if (game.includes('lorcana')) {
      const q = encodeURIComponent(card.name);
      const r = await httpGet(`https://api.lorcana-api.com/cards/fetch?search=${q}`, {
        'Accept': 'application/json'
      });
      if (r.status === 200) {
        const data = JSON.parse(r.body);
        imageUrl = data?.[0]?.Image || null;
      }
    }

  } catch (e) {
    console.log('[card-image]', e.message);
  }

  const result = { imageUrl };
  if (imageUrl) await cacheSet(cacheKey, result, 60 * 60 * 48);
  return res.json(result);
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /prices  — scrape first, Claude fallback if scraping fails
// ═════════════════════════════════════════════════════════════════════════════
app.post('/prices', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  if (!checkRate(ip, 30)) return res.status(429).json({ error: 'Too many requests.' });

  const { card, ebayRegion = 'AU' } = req.body;
  if (!card?.name) return res.status(400).json({ error: 'No card data.' });

  const cacheKey = `prices3:${card.name}:${card.set}:${card.number}:${ebayRegion}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  const [tcgplayer, ebay, cardkingdom] = await Promise.all([
    scrapeTCGPlayer(card),
    delay(300).then(() => scrapeEbay(card, ebayRegion)),
    delay(600).then(() => scrapeCardKingdom(card))
  ]);

  let prices = { tcgplayer, ebay, cardkingdom };

  if (!tcgplayer.available && !ebay.available && !cardkingdom.available) {
    console.log('[prices] all scrapers failed, using Claude fallback');
    prices = await claudePriceFallback(card, ebayRegion);
  }

  await cacheSet(cacheKey, prices);
  return res.json(prices);
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /variants  — Claude Haiku knowledge + eBay scraping
// ═════════════════════════════════════════════════════════════════════════════
app.post('/variants', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  if (!checkRate(ip, 10)) return res.status(429).json({ error: 'Too many requests.' });

  const { card } = req.body;
  if (!card?.name) return res.status(400).json({ error: 'No card data.' });

  const cacheKey = `variants3:${card.name}:${card.game}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const response = await withRetry(() => anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `List every known printing of: ${card.name} (${card.game})
Return JSON array, max 12, most valuable first. No markdown:
[{"set":"Base Set","year":"1999","number":"4/102","rarity":"Rare Holo","variant":"Shadowless","ebayQuery":"${card.name} Base Set Shadowless Holo 4/102"}]
Include: different sets, promos, alt arts, 1st edition, regional variants.`
      }]
    }));

    const raw = response.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
    const versions = parseJSON(raw);
    if (!Array.isArray(versions) || !versions.length) return res.json({ variants: [] });

    const results = await Promise.all(
      versions.slice(0, 12).map(async (v, i) => {
        await delay(i * 250);
        const vKey = `vprice3:${card.name}:${v.set}:${v.variant || ''}`;
        const vCached = await cacheGet(vKey);
        if (vCached) return { ...v, ...vCached };
        const priceData = await scrapeEbay({ ...card, ebayQuery: v.ebayQuery || `${card.name} ${v.set}` }, 'AU');
        await cacheSet(vKey, priceData);
        return { ...v, ...priceData };
      })
    );

    results.sort((a, b) => {
      if (!a.available && b.available) return 1;
      if (a.available && !b.available) return -1;
      return (b.avg || 0) - (a.avg || 0);
    });

    const payload = { variants: results };
    await cacheSet(cacheKey, payload);
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
    const response = await withRetry(() => anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `Write an eBay Australia trading card listing. ONLY JSON, no markdown:
{"title":"80 char eBay title","description":"150-200 word listing with condition, postage, SEO"}
Card: ${card.name}, ${card.game}, ${card.set || ''}, #${card.number || ''}, ${card.rarity || ''}, Foil:${card.foil}, ${card.extra || ''}
Condition: ${condition}, Price: $${askingPrice} AUD`
      }]
    }));

    const raw = response.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
    return res.json(JSON.parse(raw));
  } catch (err) {
    console.error('listing error:', err.message);
    return res.status(500).json({ error: err.message || 'Listing generation failed.' });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
initRedis().then(() => {
  app.listen(port, () => console.log(`TCG Scanner API running on port ${port}`));
});
