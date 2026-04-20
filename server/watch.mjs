/**
 * Polls Kalshi public trades, keeps those whose series category is in an allow-list
 * (default: politics + elections, economics, culture via Entertainment + Social),
 * with taker notional ≥ MIN_NOTIONAL_USD, newest first.
 *
 * Env:
 *   PORT                      — HTTP + WS port (default 3001)
 *   KALSHI_BASE               — API base (default https://api.elections.kalshi.com/trade-api/v2)
 *   MIN_NOTIONAL_USD          — minimum trade notional in USD (default 100)
 *   ALLOWED_EVENT_CATEGORIES  — comma-separated series categories (default below)
 *   POLL_MS                   — trade poll interval (default 2500)
 *   MARKET_CACHE_MS           — GET /markets/{ticker} cache TTL (default 600000)
 *   EVENT_CACHE_MS            — GET /events/{ticker} cache TTL (default 300000)
 *   SERIES_CACHE_MS           — GET /series/{ticker} cache TTL (default 600000)
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import cors from 'cors'
import { WebSocketServer } from 'ws'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')

const PORT = Number(process.env.PORT || 3001)
const KALSHI_BASE = (process.env.KALSHI_BASE || 'https://api.elections.kalshi.com/trade-api/v2').replace(/\/$/, '')
const _minParsed = Number(process.env.MIN_NOTIONAL_USD)
const MIN_NOTIONAL_USD =
  Number.isFinite(_minParsed) && _minParsed > 0 ? _minParsed : 100
/** Integer cents for threshold compare (avoids float edge cases vs raw USD). */
const MIN_NOTIONAL_CENTS = Math.round(MIN_NOTIONAL_USD * 100)
const POLL_MS = Number(process.env.POLL_MS || 2500)
const MARKET_CACHE_MS = Number(process.env.MARKET_CACHE_MS || 600_000)
const EVENT_CACHE_MS = Number(process.env.EVENT_CACHE_MS || 300_000)
const SERIES_CACHE_MS = Number(process.env.SERIES_CACHE_MS || 600_000)

/** Politics + elections; culture maps to Entertainment + Social on Kalshi; Economics. */
const DEFAULT_ALLOWED =
  'Politics,Elections,Entertainment,Social,Economics'

const ALLOWED = new Set(
  (process.env.ALLOWED_EVENT_CATEGORIES || DEFAULT_ALLOWED)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
)

/** @type {Set<string>} */
const seenTradeIds = new Set()
/** @type {Map<string, { at: number, data: object | null }>} */
const marketCache = new Map()
/** @type {Map<string, number>} */
const marketBackoffUntil = new Map()
/** @type {Map<string, { at: number, data: object | null }>} */
const eventCache = new Map()
/** @type {Map<string, number>} */
const eventBackoffUntil = new Map()
/** @type {Map<string, { at: number, category: string }>} */
const seriesCategoryCache = new Map()
/** @type {Map<string, number>} */
const seriesBackoffUntil = new Map()

/** @type {object[]} */
const recentAlerts = []
const MAX_RECENT = 200
const MAX_SEEN = 80_000

let lastPollOk = null
let lastPollErr = null
let pollIteration = 0

function pruneSeen() {
  if (seenTradeIds.size <= MAX_SEEN) return
  const toDrop = seenTradeIds.size - MAX_SEEN
  const it = seenTradeIds.values()
  for (let i = 0; i < toDrop; i++) {
    const v = it.next().value
    if (v) seenTradeIds.delete(v)
  }
}

/**
 * @param {object} t
 * @returns {number}
 */
function tradeNotionalUsd(t) {
  const count = Number.parseFloat(t.count_fp)
  const yes = Number.parseFloat(t.yes_price_dollars)
  const no = Number.parseFloat(t.no_price_dollars)
  if (!Number.isFinite(count)) return 0
  const px = t.taker_side === 'yes' ? yes : no
  if (!Number.isFinite(px)) return 0
  return count * px
}

/**
 * @param {string} ticker
 */
async function fetchMarket(ticker) {
  const now = Date.now()
  const backoff = marketBackoffUntil.get(ticker)
  if (backoff && now < backoff) return null

  const hit = marketCache.get(ticker)
  if (hit && now - hit.at < MARKET_CACHE_MS) return hit.data

  const url = `${KALSHI_BASE}/markets/${encodeURIComponent(ticker)}`
  const res = await fetch(url)
  if (!res.ok) {
    lastPollErr = `market ${ticker}: ${res.status}`
    marketBackoffUntil.set(ticker, now + 60_000)
    return null
  }
  const body = await res.json()
  const m = body.market
  marketCache.set(ticker, { at: now, data: m })
  marketBackoffUntil.delete(ticker)
  return m
}

/**
 * @param {string} eventTicker
 */
async function fetchEvent(eventTicker) {
  const now = Date.now()
  const backoff = eventBackoffUntil.get(eventTicker)
  if (backoff && now < backoff) return null

  const hit = eventCache.get(eventTicker)
  if (hit && now - hit.at < EVENT_CACHE_MS) return hit.data

  const url = `${KALSHI_BASE}/events/${encodeURIComponent(eventTicker)}`
  const res = await fetch(url)
  if (!res.ok) {
    lastPollErr = `event ${eventTicker}: ${res.status}`
    eventBackoffUntil.set(eventTicker, now + 60_000)
    return null
  }
  const body = await res.json()
  const ev = body.event
  eventCache.set(eventTicker, { at: now, data: ev })
  eventBackoffUntil.delete(eventTicker)
  return ev
}

/**
 * Series `category` is what Kalshi uses in browse (event.category can disagree).
 * @param {string} seriesTicker
 * @returns {Promise<string | undefined>} category string, empty if unset, undefined on fetch error
 */
async function fetchSeriesCategory(seriesTicker) {
  const now = Date.now()
  const sb = seriesBackoffUntil.get(seriesTicker)
  if (sb && now < sb) return undefined

  const hit = seriesCategoryCache.get(seriesTicker)
  if (hit && now - hit.at < SERIES_CACHE_MS) return hit.category

  const url = `${KALSHI_BASE}/series/${encodeURIComponent(seriesTicker)}`
  const res = await fetch(url)
  if (!res.ok) {
    lastPollErr = `series ${seriesTicker}: ${res.status}`
    seriesBackoffUntil.set(seriesTicker, now + 60_000)
    return undefined
  }
  const body = await res.json()
  const cat = typeof body.series?.category === 'string' ? body.series.category : ''
  seriesCategoryCache.set(seriesTicker, { at: now, category: cat })
  seriesBackoffUntil.delete(seriesTicker)
  return cat
}

function sortRecentByTimeDesc() {
  recentAlerts.sort((a, b) => Date.parse(b.created_time) - Date.parse(a.created_time))
}

/**
 * @param {object} trade
 */
async function maybeAlertFromTrade(trade) {
  if (seenTradeIds.has(trade.trade_id)) return

  const market = await fetchMarket(trade.ticker)
  if (!market) return

  const event = await fetchEvent(market.event_ticker)
  if (!event?.series_ticker) return

  const category = await fetchSeriesCategory(event.series_ticker)
  if (category === undefined) return

  if (!ALLOWED.has(category)) {
    seenTradeIds.add(trade.trade_id)
    pruneSeen()
    return
  }

  const notionalUsd = tradeNotionalUsd(trade)
  if (!Number.isFinite(notionalUsd)) {
    seenTradeIds.add(trade.trade_id)
    pruneSeen()
    return
  }
  const tradeCents = Math.round(notionalUsd * 100)
  if (tradeCents < MIN_NOTIONAL_CENTS) {
    seenTradeIds.add(trade.trade_id)
    pruneSeen()
    return
  }

  seenTradeIds.add(trade.trade_id)
  pruneSeen()

  const closeMs = Date.parse(market.close_time)
  const now = Date.now()
  const hoursToClose = Number.isFinite(closeMs)
    ? Math.round(((closeMs - now) / 3_600_000) * 10) / 10
    : null

  const titleParts = [market.yes_sub_title, market.no_sub_title].filter(Boolean)
  const label = titleParts.length ? titleParts.join(' / ') : trade.ticker

  const alert = {
    trade_id: trade.trade_id,
    username:
      typeof trade.username === 'string' && trade.username.trim()
        ? trade.username.trim()
        : null,
    ticker: trade.ticker,
    event_ticker: market.event_ticker,
    event_title: typeof event.title === 'string' ? event.title : '',
    category,
    market_label: label,
    taker_side: trade.taker_side,
    count_fp: trade.count_fp,
    yes_price_dollars: trade.yes_price_dollars,
    no_price_dollars: trade.no_price_dollars,
    notional_usd: tradeCents / 100,
    created_time: trade.created_time,
    close_time: market.close_time,
    hours_to_close: hoursToClose,
    rules_primary: typeof market.rules_primary === 'string' ? market.rules_primary.slice(0, 280) : '',
  }

  recentAlerts.unshift(alert)
  if (recentAlerts.length > MAX_RECENT) recentAlerts.length = MAX_RECENT
  sortRecentByTimeDesc()

  broadcast({ type: 'trade', payload: alert })
}

async function pollTradesOnce() {
  pollIteration += 1
  const minTs = Math.floor(Date.now() / 1000) - 300
  const url = `${KALSHI_BASE}/markets/trades?limit=1000&min_ts=${minTs}`
  const res = await fetch(url)
  if (!res.ok) {
    lastPollErr = `trades ${res.status}`
    broadcast({ type: 'status', payload: { lastPollErr, pollIteration } })
    return
  }
  const body = await res.json()
  const trades = body.trades || []
  lastPollOk = new Date().toISOString()
  lastPollErr = null

  const sorted = [...trades].sort(
    (a, b) => Date.parse(a.created_time) - Date.parse(b.created_time),
  )
  for (const t of sorted) {
    await maybeAlertFromTrade(t)
  }

  broadcast({
    type: 'status',
    payload: {
      lastPollOk,
      lastPollErr,
      pollIteration,
      allowedCategories: [...ALLOWED],
      minNotional: MIN_NOTIONAL_USD,
      kalshiBase: KALSHI_BASE,
    },
  })
}

/** @type {import('ws').WebSocket[]} */
const clients = []

function broadcast(obj) {
  const s = JSON.stringify(obj)
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(s)
  }
}

const app = express()
app.use(cors({ origin: true }))
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    clients: clients.length,
    lastPollOk,
    lastPollErr,
    allowedCategories: [...ALLOWED],
    minNotional: MIN_NOTIONAL_USD,
  })
})

const distPath = path.join(ROOT, 'dist')
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath))
  // Express 5 / path-to-regexp v8: bare '*' is invalid; use a catch-all middleware for SPA fallback.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    res.sendFile(path.join(distPath, 'index.html'))
  })
}

const server = http.createServer(app)
const wss = new WebSocketServer({ server })

wss.on('connection', (ws) => {
  clients.push(ws)
  sortRecentByTimeDesc()
  ws.send(
    JSON.stringify({
      type: 'hello',
      payload: {
        recent: recentAlerts,
        allowedCategories: [...ALLOWED],
        minNotional: MIN_NOTIONAL_USD,
        disclaimer: `Kalshi public trades do not include account or username. Notional ≈ contracts × taker-side price. Categories come from GET /series (series.category). “Culture” uses Entertainment and Social. Only prints with notional ≥ $${MIN_NOTIONAL_USD.toFixed(2)} (taker premium, cents-rounded) are tracked server-side.`,
      },
    }),
  )
  ws.on('close', () => {
    const i = clients.indexOf(ws)
    if (i !== -1) clients.splice(i, 1)
  })
})

server.listen(PORT, () => {
  console.log(
    `[kalshi-watch] http://localhost:${PORT}  ws://localhost:${PORT}  min $${MIN_NOTIONAL_USD}  categories=[${[...ALLOWED].join(', ')}]`,
  )
  pollTradesOnce().catch((e) => {
    lastPollErr = String(e)
    console.error(e)
  })
  setInterval(() => {
    pollTradesOnce().catch((e) => {
      lastPollErr = String(e)
      console.error(e)
    })
  }, POLL_MS)
})
