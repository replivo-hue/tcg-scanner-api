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
const cache      = new Map();
const CACHE_TTL  = 1000 * 60 * 60 * 6;  // 6 hours — for prices
const ID_TTL     = 1000 * 60 * 60 * 1;  // 1 hour  — for identifications

function cacheGet(key, ttl = CACHE_TTL) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > ttl) { cache.delete(key); return null; }
  return hit.data;
}
function cacheSet(key, data) { cache.set(key, { ts: Date.now(), data }); }

// ─── Rate limiting (per IP — simple sliding window) ──────────────────────────
const rateMap = new Map();
const RATE_WINDOW = 60_000;   // 1 minute
const RATE_LIMIT  = 60;       // requests per minute per IP

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

  // Use a more unique cache key — sample from middle and end of image, not just the start
  // (JPEG headers are identical across photos from the same camera)
  const len = imageBase64.length;
  const cacheKey = 'id:' + imageBase64.slice(0, 16) + imageBase64.slice(Math.floor(len/2), Math.floor(len/2)+16) + imageBase64.slice(-16);
  const cached = cacheGet(cacheKey, ID_TTL);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 400,
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
// Runs all 3 source lookups in parallel for maximum speed
// ═════════════════════════════════════════════════════════════════════════════
app.post('/prices', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  if (!checkRate(ip)) return res.status(429).json({ error: 'Too many requests.' });

  const { card, ebayRegion = 'AU' } = req.body;
  if (!card?.name) return res.status(400).json({ error: 'No card data provided.' });

  const cacheKey = `prices:${card.name}:${card.set}:${card.number}:${card.extra}:${ebayRegion}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  const ebayRegions = {
    AU: { domain: 'ebay.com.au', currency: 'AUD', label: 'eBay Australia' },
    US: { domain: 'ebay.com',    currency: 'USD', label: 'eBay USA' },
    UK: { domain: 'ebay.co.uk',  currency: 'GBP', label: 'eBay UK' },
    CA: { domain: 'ebay.ca',     currency: 'CAD', label: 'eBay Canada' },
    DE: { domain: 'ebay.de',     currency: 'EUR', label: 'eBay Germany' },
    JP: { domain: 'ebay.com',    currency: 'JPY', label: 'eBay Japan (via .com)' },
  };
  const ebayConf = ebayRegions[ebayRegion] || ebayRegions['AU'];

  // ── Search functions — each runs independently in parallel ──────────────────

  async function searchTCGPlayer() {
    const cKey = `tcg:${card.name}:${card.set}:${card.number}`;
    const hit = cacheGet(cKey);
    if (hit) return hit;
    try {
      const text = await agenticSearch(
        'You are a trading card price researcher. Search and respond ONLY with JSON, no markdown.',
        `Search TCGPlayer for the current market price of this card:
Card: ${card.name}, Set: ${card.set || ''}, Number: ${card.number || ''}, Rarity: ${card.rarity || ''}
Search: "${card.tcgplayerQuery || card.name} tcgplayer"

Respond ONLY with this JSON:
{"available":true,"market":7.50,"currency":"USD","url":"https://www.tcgplayer.com/..."}
If not found: {"available":false,"market":null,"currency":"USD"}`, 5
      );
      const result = parseJSON(text) || { available: false, market: null, currency: 'USD' };
      cacheSet(cKey, result);
      return result;
    } catch { return { available: false, market: null, currency: 'USD' }; }
  }

  async function searchEbay() {
    const cKey = `ebay:${card.name}:${card.set}:${card.number}:${ebayRegion}`;
    const hit = cacheGet(cKey);
    if (hit) return hit;
    try {
      const text = await agenticSearch(
        'You are a trading card price researcher. Search eBay sold listings and respond ONLY with JSON, no markdown.',
        `Search ${ebayConf.label} sold listings for this card and find the average sold price:
Card: ${card.name}, Set: ${card.set || ''}, Number: ${card.number || ''}
Search: "${card.ebayQuery || card.name} ${ebayConf.domain} sold"

Respond ONLY with this JSON:
{"available":true,"avg":11.00,"currency":"${ebayConf.currency}","region":"${ebayRegion}","regionLabel":"${ebayConf.label}","url":"https://www.${ebayConf.domain}/..."}
If not found: {"available":false,"avg":null,"currency":"${ebayConf.currency}","region":"${ebayRegion}","regionLabel":"${ebayConf.label}"}`, 5
      );
      const result = parseJSON(text) || { available: false, avg: null, currency: ebayConf.currency, region: ebayRegion, regionLabel: ebayConf.label };
      result.region      = ebayRegion;
      result.regionLabel = ebayConf.label;
      result.currency    = result.currency || ebayConf.currency;
      cacheSet(cKey, result);
      return result;
    } catch { return { available: false, avg: null, currency: ebayConf.currency, region: ebayRegion, regionLabel: ebayConf.label }; }
  }

  async function searchCardKingdom() {
    const cKey = `ck:${card.name}:${card.set}`;
    const hit = cacheGet(cKey);
    if (hit) return hit;
    try {
      const text = await agenticSearch(
        'You are a trading card price researcher. Search Card Kingdom and respond ONLY with JSON, no markdown.',
        `Search Card Kingdom for the current retail price of this card:
Card: ${card.name}, Set: ${card.set || ''}
Search: "${card.name} ${card.set || ''} card kingdom"

Respond ONLY with this JSON:
{"available":true,"retail":8.00,"currency":"USD","url":"https://www.cardkingdom.com/..."}
If not found: {"available":false,"retail":null,"currency":"USD"}`, 5
      );
      const result = parseJSON(text) || { available: false, retail: null, currency: 'USD' };
      cacheSet(cKey, result);
      return result;
    } catch { return { available: false, retail: null, currency: 'USD' }; }
  }

  try {
    // Run all 3 in parallel — total time = slowest single search, not sum of all 3
    const [tcgplayer, ebay, cardkingdom] = await Promise.all([
      searchTCGPlayer(),
      searchEbay(),
      searchCardKingdom()
    ]);

    const prices = { tcgplayer, ebay, cardkingdom };
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
async function agenticSearch(systemPrompt, userPrompt, maxIter = 6) {
  const tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  let messages = [{ role: 'user', content: userPrompt }];
  let finalText = '';

  for (let i = 0; i < maxIter; i++) {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: systemPrompt,
      tools,
      messages
    });

    console.log(`[agenticSearch] iter=${i} stop_reason=${response.stop_reason} content_types=${response.content.map(b=>b.type).join(',')}`);

    // Collect text from this turn
    const textBlocks = response.content.filter(b => b.type === 'text');
    if (textBlocks.length) {
      finalText = textBlocks.map(b => b.text).join('');
      console.log(`[agenticSearch] text preview: ${finalText.slice(0,200)}`);
    }

    if (response.stop_reason === 'end_turn') break;

    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      if (!toolUseBlocks.length) break;

      console.log(`[agenticSearch] tool_use blocks: ${toolUseBlocks.map(b=>b.name).join(',')}`);

      // Add the full assistant message to history
      messages.push({ role: 'assistant', content: response.content });

      // Check for inline tool_result blocks first
      const toolResultBlocks = response.content.filter(b => b.type === 'tool_result');
      console.log(`[agenticSearch] inline tool_result blocks: ${toolResultBlocks.length}`);

      if (toolResultBlocks.length) {
        messages.push({ role: 'user', content: toolResultBlocks });
      } else {
        // Acknowledge each tool use to continue the loop
        messages.push({
          role: 'user',
          content: toolUseBlocks.map(b => ({
            type: 'tool_result',
            tool_use_id: b.id,
            content: 'No results returned.'
          }))
        });
      }
      continue;
    }
    break;
  }

  console.log(`[agenticSearch] finalText length: ${finalText.length}`);
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
Find the average sold price. Respond with ONLY this JSON:
{"available":true,"avg":10.00,"currency":"AUD"}
If no sales found: {"available":false,"avg":null,"currency":"AUD"}`,
            5
          );
          const priceData = parseJSON(priceText) || { available: false, avg: null, currency: 'AUD' };
          cacheSet(vCacheKey, priceData);
          return { ...v, ...priceData };
        } catch {
          return { ...v, available: false, avg: null, currency: 'AUD' };
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
