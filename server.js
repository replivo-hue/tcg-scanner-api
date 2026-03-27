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

  const { card } = req.body;
  if (!card?.name) return res.status(400).json({ error: 'No card data provided.' });

  const cacheKey = `prices:${card.name}:${card.set}:${card.number}:${card.extra}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    // Use Claude with web search to fetch prices from all 3 sources simultaneously
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 2000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{
        role: 'user',
        content: `Search for current prices for this trading card from three specific sources. Search all three and return results.

Card: ${card.name}
Game: ${card.game}
Set: ${card.set || ''}
Number: ${card.number || ''}
Rarity: ${card.rarity || ''}
Special: ${card.extra || ''}

Search queries to use:
1. TCGPlayer: site:tcgplayer.com "${card.tcgplayerQuery || card.name}"
2. eBay Australia sold: site:ebay.com.au "${card.ebayQuery || card.name}" sold
3. ${card.game === 'Magic: The Gathering' ? 'MTGGoldfish: site:mtggoldfish.com "' + (card.name) + '"' : 'Cardmarket: site:cardmarket.com "' + (card.cardmarketQuery || card.name) + '"'}

Respond ONLY with this JSON (no markdown):
{
  "tcgplayer": {
    "available": true or false,
    "low": number or null,
    "mid": number or null,
    "high": number or null,
    "market": number or null,
    "currency": "USD",
    "url": "direct URL or null",
    "lastUpdated": "today's date or null"
  },
  "ebay": {
    "available": true or false,
    "recentSales": [
      {"title": "", "price": 0, "currency": "AUD", "date": "", "condition": ""}
    ],
    "low": number or null,
    "avg": number or null,
    "high": number or null,
    "currency": "AUD",
    "url": "search URL or null"
  },
  "cardmarket": {
    "available": true or false,
    "low": number or null,
    "trend": number or null,
    "avg30": number or null,
    "currency": "EUR",
    "url": "direct URL or null",
    "sourceName": "${card.game === 'Magic: The Gathering' ? 'MTGGoldfish' : 'Cardmarket'}"
  }
}`
      }]
    });

    const raw = response.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
    let prices;
    try {
      prices = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      prices = match ? JSON.parse(match[0]) : { tcgplayer: { available: false }, ebay: { available: false }, cardmarket: { available: false } };
    }

    cacheSet(cacheKey, prices);
    return res.json(prices);

  } catch (err) {
    console.error('prices error:', err.message);
    return res.status(500).json({ error: err.message || 'Price lookup failed.' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ROUTE: POST /generate-listing
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
