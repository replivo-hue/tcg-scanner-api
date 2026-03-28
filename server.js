/**
 * TCG Price Scanner — Backend Server
 * -----------------------------------
 * Handles card identification (Claude Haiku vision) and price lookups
 * from TCGPlayer, eBay, and CardMarket / MTGGoldfish.
 *
 * Deploy on Railway, Render, or Vercel (see README.md)
 */

const express = require('express');
const cors    = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app  = express();
const port = process.env.PORT || 3000;

// ─── Anthropic client ────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Simple in-memory cache (resets on redeploy — good enough) ───────────────
const cache     = new Map();
const CACHE_TTL = 1000 * 60 * 60 * 6; // 6 hours

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL) { cache.delete(key); return null; }
  return hit.data;
}
function cacheSet(key, data) { cache.set(key, { ts: Date.now(), data }); }

// ─── Rate limiting (per IP — simple sliding window) ──────────────────────────
const rateMap = new Map();
const RATE_WINDOW = 60_000;   // 1 minute
const RATE_LIMIT  = 20;       // scans per minute per IP

function checkRate(ip) {
  const now  = Date.now();
  const hits = (rateMap.get(ip) || []).filter(t => now - t < RATE_WINDOW);
  if (hits.length >= RATE_LIMIT) return false;
  hits.push(now);
  rateMap.set(ip, hits);
  return true;
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '12mb' }));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.json({ status: 'ok', service: 'TCG Price Scanner API' }));

// ═════════════════════════════════════════════════════════════════════════════
// ROUTE: POST /identify
// Body: { imageBase64: string, mediaType?: string }
// Returns: card identification JSON
// ═════════════════════════════════════════════════════════════════════════════
app.post('/identify', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  if (!checkRate(ip)) return res.status(429).json({ error: 'Too many scans — wait a moment and try again.' });

  const { imageBase64, mediaType = 'image/jpeg' } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'No image provided.' });

  // Use first 32 chars of image as rough cache key
  const cacheKey = 'id:' + imageBase64.slice(0, 32);
  const cached = cacheGet(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: imageBase64 }
          },
          {
            type: 'text',
            text: `You are an expert trading card identifier. Analyse this image and respond ONLY with valid JSON — no markdown, no explanation.

If you can identify the card:
{
  "name": "exact full card name",
  "game": "Pokemon | Magic: The Gathering | Yu-Gi-Oh! | Lorcana | One Piece | Flesh and Blood | Sports | Other",
  "set": "set or expansion name",
  "number": "card number or null",
  "rarity": "rarity or null",
  "year": "year printed or null",
  "condition": "Mint | Near Mint | Lightly Played | Moderately Played | Heavily Played",
  "foil": true or false,
  "extra": "1st Edition / Shadowless / PSA graded / etc — or null",
  "confidence": "high | medium | low",
  "tcgplayerQuery": "best search query for TCGPlayer",
  "ebayQuery": "best search query for eBay sold listings",
  "cardmarketQuery": "best search query for Cardmarket"
}

If you cannot identify it:
{"error": "Cannot identify card"}`
          }
        ]
      }]
    });

    const raw  = response.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
    const card = JSON.parse(raw);
    if (!card.error) cacheSet(cacheKey, card);
    return res.json(card);

  } catch (err) {
    console.error('identify error:', err.message);
    return res.status(500).json({ error: err.message || 'Identification failed.' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ROUTE: POST /prices
// Body: { card: { name, game, set, number, rarity, extra, tcgplayerQuery, ebayQuery, cardmarketQuery } }
// Returns prices from all 3 sources
// ═════════════════════════════════════════════════════════════════════════════
app.post('/prices', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  if (!checkRate(ip)) return res.status(429).json({ error: 'Too many requests.' });

  const { card, ebayRegion = 'AU' } = req.body;
  if (!card?.name) return res.status(400).json({ error: 'No card data provided.' });

  const cacheKey = `prices:${card.name}:${card.set}:${card.number}:${card.extra}:${ebayRegion}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  // eBay region config
  const ebayRegions = {
    AU: { domain: 'ebay.com.au',  currency: 'AUD', label: 'eBay Australia' },
    US: { domain: 'ebay.com',     currency: 'USD', label: 'eBay USA' },
    UK: { domain: 'ebay.co.uk',   currency: 'GBP', label: 'eBay UK' },
    CA: { domain: 'ebay.ca',      currency: 'CAD', label: 'eBay Canada' },
    DE: { domain: 'ebay.de',      currency: 'EUR', label: 'eBay Germany' },
    JP: { domain: 'ebay.com',     currency: 'JPY', label: 'eBay Japan (via .com)' },
  };
  const ebayConf = ebayRegions[ebayRegion] || ebayRegions['AU'];

  // Card Kingdom covers MTG, Pokemon, Yu-Gi-Oh, Lorcana etc.
  const ckQuery = `${card.name} ${card.set || ''} site:cardkingdom.com`;

  const systemPrompt = `You are a trading card price research assistant. 
Search for real current prices using web search, then respond ONLY with a JSON object — no explanation, no markdown fences.
Always attempt all three searches before responding.`;

  const userPrompt = `Find current market prices for this trading card from three sources.

Card: ${card.name}
Game: ${card.game}
Set: ${card.set || 'unknown'}
Number: ${card.number || ''}
Rarity: ${card.rarity || ''}
Special: ${card.extra || ''}

Do three separate web searches:
1. "${card.tcgplayerQuery || card.name} tcgplayer price"
2. "${card.ebayQuery || card.name} ${ebayConf.domain} sold"
3. "${card.name} ${card.set || ''} card kingdom price"

After searching, respond with ONLY this JSON structure (no markdown, no explanation):
{
  "tcgplayer": {
    "available": true,
    "low": 5.00,
    "mid": 8.00,
    "high": 12.00,
    "market": 7.50,
    "currency": "USD",
    "url": "https://www.tcgplayer.com/..."
  },
  "ebay": {
    "available": true,
    "recentSales": [
      {"title": "card name listing", "price": 10.00, "currency": "${ebayConf.currency}", "date": "2025-03", "condition": "Near Mint"}
    ],
    "low": 8.00,
    "avg": 11.00,
    "high": 15.00,
    "currency": "${ebayConf.currency}",
    "region": "${ebayRegion}",
    "regionLabel": "${ebayConf.label}",
    "url": "https://www.${ebayConf.domain}/..."
  },
  "cardkingdom": {
    "available": true,
    "buylist": 3.00,
    "retail": 8.00,
    "currency": "USD",
    "url": "https://www.cardkingdom.com/..."
  }
}
If a source has no data, set "available": false and all prices to null.`;

  try {
    const finalText = await agenticSearch(systemPrompt, userPrompt, 8);

    let prices = parseJSON(finalText);

    if (!prices) {
      prices = {
        tcgplayer:   { available: false, low: null, mid: null, high: null, market: null, currency: 'USD' },
        ebay:        { available: false, recentSales: [], low: null, avg: null, high: null, currency: ebayConf.currency, region: ebayRegion, regionLabel: ebayConf.label },
        cardkingdom: { available: false, buylist: null, retail: null, currency: 'USD' }
      };
    }

    // Always stamp region info in case model omitted it
    if (prices.ebay) {
      prices.ebay.region      = ebayRegion;
      prices.ebay.regionLabel = ebayConf.label;
      prices.ebay.currency    = prices.ebay.currency || ebayConf.currency;
    }

    cacheSet(cacheKey, prices);
    return res.json(prices);

  } catch (err) {
    console.error('prices error:', err.message);
    return res.status(500).json({ error: err.message || 'Price lookup failed.' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// HELPER: agentic web search loop
// ═════════════════════════════════════════════════════════════════════════════
async function agenticSearch(systemPrompt, userPrompt, maxIter = 10) {
  const tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  let messages = [{ role: 'user', content: userPrompt }];
  let finalText = '';

  for (let i = 0; i < maxIter; i++) {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: systemPrompt,
      tools,
      messages
    });

    const textBlocks = response.content.filter(b => b.type === 'text');
    if (textBlocks.length) finalText = textBlocks.map(b => b.text).join('');

    if (response.stop_reason === 'end_turn') break;

    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      if (!toolUseBlocks.length) break;
      messages.push({ role: 'assistant', content: response.content });
      const toolResults = toolUseBlocks.map(b => ({
        type: 'tool_result',
        tool_use_id: b.id,
        content: 'Search completed. Use the results to answer the question.'
      }));
      messages.push({ role: 'user', content: toolResults });
      continue;
    }
    break;
  }

  return finalText;
}

function parseJSON(text) {
  try {
    const cleaned = text.replace(/```json|```/g, '').trim();
    const match = cleaned.match(/[\[{][\s\S]*[\]}]/);
    return match ? JSON.parse(match[0]) : null;
  } catch { return null; }
}

// ═════════════════════════════════════════════════════════════════════════════
// ROUTE: POST /variants
// Body: { card: { name, game, set, number, rarity } }
// Returns: array of all known set versions with avg prices
// ═════════════════════════════════════════════════════════════════════════════
app.post('/variants', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  if (!checkRate(ip)) return res.status(429).json({ error: 'Too many requests.' });

  const { card } = req.body;
  if (!card?.name) return res.status(400).json({ error: 'No card data provided.' });

  const cacheKey = `variants:${card.name}:${card.game}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    // Step 1 — find all sets this card appeared in
    const setsText = await agenticSearch(
      `You are a trading card game expert. Search for all versions of a card across every set it appeared in. Respond ONLY with a JSON array — no markdown, no explanation.`,
      `Search for every set and version that "${card.name}" (${card.game}) has appeared in.

Search: "${card.name} ${card.game} all sets versions printings"

Return a JSON array of every known version:
[
  {
    "set": "Base Set",
    "year": "1999",
    "number": "4/102",
    "rarity": "Rare Holo",
    "variant": "Shadowless",
    "ebayQuery": "Charizard Base Set Shadowless Holo Rare 4/102"
  },
  {
    "set": "Base Set 2",
    "year": "2000", 
    "number": "4/130",
    "rarity": "Rare Holo",
    "variant": null,
    "ebayQuery": "Charizard Base Set 2 Holo Rare 4/130"
  }
]

Include ALL printings: different sets, promos, alternate arts, 1st edition, unlimited, shadowless, etc.
Keep the array to a maximum of 15 most notable/valuable versions.`,
      8
    );

    let versions = parseJSON(setsText);
    if (!Array.isArray(versions) || !versions.length) {
      return res.json({ variants: [], error: 'Could not find variant data.' });
    }

    // Step 2 — fetch eBay AU avg price for each version in parallel (max 8 at once)
    const BATCH = 8;
    const results = [];

    for (let i = 0; i < Math.min(versions.length, 15); i += BATCH) {
      const batch = versions.slice(i, i + BATCH);
      const pricePromises = batch.map(async (v) => {
        const vCacheKey = `vprice:${card.name}:${v.set}:${v.variant || ''}`;
        const vCached = cacheGet(vCacheKey);
        if (vCached) return { ...v, ...vCached };

        try {
          const priceText = await agenticSearch(
            `You are a trading card price researcher. Search eBay Australia sold listings and respond ONLY with JSON — no markdown.`,
            `Search eBay Australia sold listings for: "${v.ebayQuery || `${card.name} ${v.set}`}"

Find recent sold prices on ebay.com.au for this exact card version.

Respond with ONLY this JSON (no markdown):
{
  "low": 5.00,
  "avg": 10.00,
  "high": 18.00,
  "salesCount": 3,
  "currency": "AUD",
  "available": true
}
If no sales found set available: false and all prices to null.`,
            5
          );

          const priceData = parseJSON(priceText) || { available: false, low: null, avg: null, high: null, currency: 'AUD' };
          cacheSet(vCacheKey, priceData);
          return { ...v, ...priceData };
        } catch {
          return { ...v, available: false, low: null, avg: null, high: null, currency: 'AUD' };
        }
      });

      const batchResults = await Promise.all(pricePromises);
      results.push(...batchResults);
    }

    // Sort by avg price descending (most valuable first), unavailable last
    results.sort((a, b) => {
      if (!a.available && b.available) return 1;
      if (a.available && !b.available) return -1;
      return (b.avg || 0) - (a.avg || 0);
    });

    const payload = { variants: results };
    cacheSet(cacheKey, payload);
    return res.json(payload);

  } catch (err) {
    console.error('variants error:', err.message);
    return res.status(500).json({ error: err.message || 'Variant lookup failed.' });
  }
});


// Body: { card, prices, condition, askingPrice }
// Returns: { title, description }
// ═════════════════════════════════════════════════════════════════════════════
app.post('/generate-listing', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  if (!checkRate(ip)) return res.status(429).json({ error: 'Too many requests.' });

  const { card, prices, condition, askingPrice } = req.body;
  if (!card?.name) return res.status(400).json({ error: 'No card data.' });

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `Write a compelling eBay Australia trading card listing. Respond ONLY with JSON (no markdown):
{"title":"80 char max keyword-rich eBay title","description":"150-220 word professional listing with condition, postage note, and SEO keywords"}

Card: ${card.name}
Game: ${card.game}
Set: ${card.set || ''}
Number: ${card.number || ''}
Rarity: ${card.rarity || ''}
Foil: ${card.foil ? 'Yes' : 'No'}
Special: ${card.extra || 'None'}
Condition: ${condition}
Asking price: $${askingPrice} AUD`
      }]
    });

    const raw = response.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
    const gen = JSON.parse(raw);
    return res.json(gen);

  } catch (err) {
    console.error('listing error:', err.message);
    return res.status(500).json({ error: err.message || 'Listing generation failed.' });
  }
});

app.listen(port, () => console.log(`TCG Scanner API running on port ${port}`));
