import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'

function defaultWsUrl() {
  if (typeof window === 'undefined') return 'ws://127.0.0.1:3001'
  if (import.meta.env.DEV) {
    // Direct connection to the watcher avoids Vite’s WS proxy, which often logs EPIPE when the
    // upstream socket closes (reconnect, watcher restart, HMR, etc.).
    const host = import.meta.env.VITE_WATCH_HOST ?? 'localhost'
    const port = import.meta.env.VITE_WATCH_PORT ?? '3001'
    return `ws://${host}:${port}`
  }

  if (import.meta.env.VITE_USE_SAME_ORIGIN_WS === 'true') {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${window.location.host}`
  }

  return null
}

const WS_URL = import.meta.env.VITE_WS_URL ?? defaultWsUrl()

function wsConfigError() {
  if (import.meta.env.DEV) return null
  if (WS_URL) return null
  return 'Set VITE_WS_URL to your deployed watcher backend WebSocket URL, or set VITE_USE_SAME_ORIGIN_WS=true if you deploy the frontend and Node server on the same host.'
}

type TradeRow = {
  trade_id: string
  /** Kalshi public trades omit this today; populated if the API ever adds it. */
  username?: string | null
  ticker: string
  event_ticker: string
  event_title: string
  category: string
  market_label: string
  taker_side: 'yes' | 'no'
  count_fp: string
  yes_price_dollars: string
  no_price_dollars: string
  notional_usd: number
  created_time: string
  close_time: string
  hours_to_close: number | null
  rules_primary: string
}

type StatusPayload = {
  lastPollOk: string | null
  lastPollErr: string | null
  pollIteration?: number
  allowedCategories?: string[]
  minNotional?: number
  kalshiBase?: string
}

function formatUsd(n: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)
}

function formatTime(iso: string) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'medium',
    }).format(new Date(iso))
  } catch {
    return iso
  }
}

function kalshiSeriesHref(eventTicker: string) {
  const series = eventTicker.split('-')[0]?.toLowerCase() ?? ''
  return `https://kalshi.com/markets/${encodeURIComponent(series)}`
}

function byRecencyDesc(a: TradeRow, b: TradeRow) {
  return Date.parse(b.created_time) - Date.parse(a.created_time)
}

function hoursUntilClose(closeIso: string, now: number): number | null {
  const ms = Date.parse(closeIso)
  if (!Number.isFinite(ms)) return null
  return (ms - now) / 3_600_000
}

function parsePositiveHours(s: string): number | null {
  const t = s.trim()
  if (t === '') return null
  const n = Number(t)
  if (!Number.isFinite(n) || n <= 0) return null
  return n
}

/** datetime-local value → ms; treats value as local wall time. */
function parseDatetimeLocal(value: string): number | null {
  const t = value.trim()
  if (!t) return null
  const ms = new Date(t).getTime()
  return Number.isFinite(ms) ? ms : null
}

function passesCategoryFilter(
  row: TradeRow,
  allowed: string[],
  pick: Record<string, boolean>,
): boolean {
  if (allowed.length === 0) return true
  if (Object.keys(pick).length === 0) return true
  const selected = allowed.filter((c) => pick[c] !== false)
  if (selected.length === 0) return false
  if (selected.length === allowed.length) return true
  return selected.includes(row.category)
}

function passesMinNotional(row: TradeRow, minUsd: number) {
  const minC = Math.round(minUsd * 100)
  if (!Number.isFinite(minC) || minC <= 0) return true
  const rowC = Math.round(row.notional_usd * 100)
  return Number.isFinite(rowC) && rowC >= minC
}

/** Positive USD from user input, or null if empty / invalid (use server floor only). */
function parseUserMinNotionalUsd(raw: string): number | null {
  const t = raw.trim()
  if (t === '') return null
  const n = Number.parseFloat(t)
  if (!Number.isFinite(n) || n <= 0) return null
  return n
}

function passesCloseFilters(
  row: TradeRow,
  now: number,
  closeWithinHours: string,
  closeAfterLocal: string,
  closeBeforeLocal: string,
): boolean {
  const closeMs = Date.parse(row.close_time)
  if (!Number.isFinite(closeMs)) return false

  const maxWithin = parsePositiveHours(closeWithinHours)
  if (maxWithin != null) {
    const hrs = hoursUntilClose(row.close_time, now)
    if (hrs == null || hrs <= 0 || hrs > maxWithin) return false
  }

  const afterMs = parseDatetimeLocal(closeAfterLocal)
  if (afterMs != null && closeMs < afterMs) return false

  const beforeMs = parseDatetimeLocal(closeBeforeLocal)
  if (beforeMs != null && closeMs > beforeMs) return false

  return true
}

export default function App() {
  const [rows, setRows] = useState<TradeRow[]>([])
  const [conn, setConn] = useState<'connecting' | 'open' | 'closed'>('connecting')
  const [status, setStatus] = useState<StatusPayload | null>(null)
  const [disclaimer, setDisclaimer] = useState('')
  const [allowedCats, setAllowedCats] = useState<string[]>([])
  const [categoryPick, setCategoryPick] = useState<Record<string, boolean>>({})
  const [closeWithinHours, setCloseWithinHours] = useState('')
  const [closeAfterLocal, setCloseAfterLocal] = useState('')
  const [closeBeforeLocal, setCloseBeforeLocal] = useState('')
  const [userMinNotionalInput, setUserMinNotionalInput] = useState('')
  const [clock, setClock] = useState(() => Date.now())
  const [connError, setConnError] = useState<string | null>(wsConfigError)

  useEffect(() => {
    const id = window.setInterval(() => setClock(Date.now()), 30_000)
    return () => window.clearInterval(id)
  }, [])

  const mergeTrade = useCallback((t: TradeRow) => {
    setRows((prev) => {
      const next = prev.filter((r) => r.trade_id !== t.trade_id)
      next.push(t)
      next.sort(byRecencyDesc)
      return next.slice(0, 150)
    })
  }, [])

  useEffect(() => {
    if (!WS_URL) {
      setConn('closed')
      return
    }

    let stopped = false
    let ws: WebSocket | null = null
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let backoff = 800

    const connect = () => {
      if (stopped) return
      setConn('connecting')
      setConnError(null)
      ws = new WebSocket(WS_URL)

      ws.onopen = () => {
        if (stopped) return
        backoff = 800
        setConn('open')
      }

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as {
            type: string
            payload?: unknown
          }
          if (msg.type === 'hello' && msg.payload && typeof msg.payload === 'object') {
            const p = msg.payload as {
              recent?: TradeRow[]
              disclaimer?: string
              allowedCategories?: string[]
              minNotional?: number
            }
            if (p.disclaimer) setDisclaimer(p.disclaimer)
            if (Array.isArray(p.recent)) {
              setRows([...p.recent].sort(byRecencyDesc).slice(0, 150))
            }
            if (Array.isArray(p.allowedCategories) && p.allowedCategories.length > 0) {
              setAllowedCats(p.allowedCategories)
              setCategoryPick((prev) => {
                if (Object.keys(prev).length > 0) return prev
                return Object.fromEntries(p.allowedCategories!.map((c) => [c, true]))
              })
            }
            setStatus((s) => {
              const base: StatusPayload = s ?? {
                lastPollOk: null,
                lastPollErr: null,
              }
              return {
                ...base,
                allowedCategories: p.allowedCategories ?? base.allowedCategories,
                minNotional: p.minNotional ?? base.minNotional,
              }
            })
          }
          if (msg.type === 'trade' && msg.payload) {
            mergeTrade(msg.payload as TradeRow)
          }
          if (msg.type === 'status' && msg.payload) {
            setStatus(msg.payload as StatusPayload)
            const st = msg.payload as StatusPayload
            if (st.allowedCategories?.length) {
              setAllowedCats(st.allowedCategories)
              setCategoryPick((prev) => {
                if (Object.keys(prev).length > 0) return prev
                return Object.fromEntries(st.allowedCategories!.map((c) => [c, true]))
              })
            }
          }
        } catch {
          /* ignore */
        }
      }

      ws.onclose = () => {
        if (stopped) return
        setConn('closed')
        retryTimer = setTimeout(() => {
          backoff = Math.min(backoff * 1.7, 30_000)
          connect()
        }, backoff)
      }

      ws.onerror = () => {
        if (!stopped) {
          setConnError(
            `Could not connect to ${WS_URL}. On Netlify, point VITE_WS_URL at a separately deployed Node watcher backend.`,
          )
        }
        ws?.close()
      }
    }

    connect()
    return () => {
      stopped = true
      if (retryTimer) clearTimeout(retryTimer)
      ws?.close()
    }
  }, [mergeTrade])

  const allowedList = status?.allowedCategories?.length
    ? status.allowedCategories
    : allowedCats

  const minTrackedRaw = status?.minNotional
  const minTracked =
    typeof minTrackedRaw === 'number' && Number.isFinite(minTrackedRaw) && minTrackedRaw > 0
      ? minTrackedRaw
      : 100

  const userMinUsd = parseUserMinNotionalUsd(userMinNotionalInput)
  const effectiveMinNotionalUsd = Math.max(minTracked, userMinUsd ?? 0)

  const filteredRows = useMemo(() => {
    return rows
      .filter((r) => passesMinNotional(r, effectiveMinNotionalUsd))
      .filter((r) => passesCategoryFilter(r, allowedList, categoryPick))
      .filter((r) => passesCloseFilters(r, clock, closeWithinHours, closeAfterLocal, closeBeforeLocal))
      .sort(byRecencyDesc)
  }, [
    rows,
    effectiveMinNotionalUsd,
    allowedList,
    categoryPick,
    clock,
    closeWithinHours,
    closeAfterLocal,
    closeBeforeLocal,
  ])

  const subtitle = useMemo(() => {
    const cats =
      allowedList.join(', ') || 'Politics, Elections, Entertainment, Social, Economics'
    return `Server sends taker notional ≥ ${formatUsd(minTracked)} in: ${cats}. You can raise the minimum in the table filters; that applies to everything already loaded and new rows as they arrive.`
  }, [allowedList, minTracked])

  const allCategoriesSelected =
    allowedList.length === 0 || allowedList.every((c) => categoryPick[c] !== false)

  const toggleCategory = (c: string) => {
    setCategoryPick((prev) => {
      const cur = prev[c] !== false
      return { ...prev, [c]: !cur }
    })
  }

  const selectOnlyCategory = (c: string) => {
    setCategoryPick(Object.fromEntries(allowedList.map((x) => [x, x === c])))
  }

  const resetCategories = () => {
    setCategoryPick(Object.fromEntries(allowedList.map((c) => [c, true])))
  }

  const clearCloseFilters = () => {
    setCloseWithinHours('')
    setCloseAfterLocal('')
    setCloseBeforeLocal('')
  }

  const emptyMessage =
    rows.length === 0
      ? connError
        ? connError
        : `No qualifying prints yet (server requires notional ≥ ${formatUsd(minTracked)} in the allowed categories). Leave this tab open.`
      : filteredRows.length === 0
        ? effectiveMinNotionalUsd > minTracked
          ? `Nothing meets your minimum notional (${formatUsd(effectiveMinNotionalUsd)}). Try lowering “Minimum notional” or other filters.`
          : 'Nothing matches your filters. Try widening the close window or selecting more categories.'
        : null

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1 className="title">Kalshi politics, culture &amp; economics</h1>
          <p className="sub">{subtitle}</p>
        </div>
        <div className={`pill pill-${conn}`}>
          <span className="dot" aria-hidden />
          {conn === 'open'
            ? 'Live'
            : conn === 'connecting'
              ? 'Connecting…'
              : 'Reconnecting…'}
        </div>
      </header>

      <p className="disclaimer">{disclaimer}</p>

      <section className="meta">
        {status?.lastPollOk && (
          <span>
            Last poll: <time>{formatTime(status.lastPollOk)}</time>
          </span>
        )}
        {connError && (
          <span className="err">Connection: {connError}</span>
        )}
        {status?.lastPollErr && (
          <span className="err">API: {status.lastPollErr}</span>
        )}
        {WS_URL ? <span className="mono">WS {WS_URL}</span> : <span className="mono">WS not configured</span>}
      </section>

      <section className="filters" aria-label="Table filters">
        <div className="filter-block">
          <h2 className="filter-heading">Minimum notional (USD)</h2>
          <p className="filter-hint">
            Applies to <strong>all rows in memory</strong> and every <strong>new</strong> trade. The effective floor is
            the larger of the server minimum ({formatUsd(minTracked)}) and the value you enter here. Leave blank to use
            only the server floor.
          </p>
          <div className="filter-grid filter-grid-tight">
            <label className="field">
              <span className="field-label">Show trades with notional ≥</span>
              <input
                className="field-input"
                type="number"
                min={0}
                step={100}
                placeholder={`e.g. 5000 (server already ≥ ${minTracked})`}
                value={userMinNotionalInput}
                onChange={(e) => setUserMinNotionalInput(e.target.value)}
              />
            </label>
            <div className="field field-readout">
              <span className="field-label">Effective minimum</span>
              <span className="field-value mono">{formatUsd(effectiveMinNotionalUsd)}</span>
            </div>
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setUserMinNotionalInput('')}
            disabled={userMinNotionalInput.trim() === ''}
          >
            Clear notional filter
          </button>
        </div>

        <div className="filter-block">
          <h2 className="filter-heading">Categories</h2>
          <p className="filter-hint">Uncheck to hide. “Only” shows just that Kalshi series category.</p>
          <div className="filter-chips">
            {allowedList.map((c) => (
              <label key={c} className="chk">
                <input
                  type="checkbox"
                  checked={categoryPick[c] !== false}
                  onChange={() => toggleCategory(c)}
                  disabled={!allowedList.length}
                />
                {c}
              </label>
            ))}
          </div>
          <div className="filter-actions">
            <button type="button" className="btn" onClick={resetCategories} disabled={allCategoriesSelected}>
              All categories
            </button>
            {allowedList.map((c) => (
              <button key={`only-${c}`} type="button" className="btn btn-ghost" onClick={() => selectOnlyCategory(c)}>
                {c} only
              </button>
            ))}
          </div>
        </div>

        <div className="filter-block">
          <h2 className="filter-heading">Market close time</h2>
          <p className="filter-hint">
            Filters use each market’s <code className="inline-code">close_time</code> (UTC from Kalshi). Relative
            “within” uses your current clock.
          </p>
          <div className="filter-grid">
            <label className="field">
              <span className="field-label">Closing within next (hours)</span>
              <input
                className="field-input"
                type="number"
                min={0.01}
                step={0.1}
                placeholder="e.g. 4"
                value={closeWithinHours}
                onChange={(e) => setCloseWithinHours(e.target.value)}
              />
            </label>
            <label className="field">
              <span className="field-label">Market closes on/after (local)</span>
              <input
                className="field-input"
                type="datetime-local"
                value={closeAfterLocal}
                onChange={(e) => setCloseAfterLocal(e.target.value)}
              />
            </label>
            <label className="field">
              <span className="field-label">Market closes on/before (local)</span>
              <input
                className="field-input"
                type="datetime-local"
                value={closeBeforeLocal}
                onChange={(e) => setCloseBeforeLocal(e.target.value)}
              />
            </label>
          </div>
          <button type="button" className="btn btn-ghost" onClick={clearCloseFilters}>
            Clear close filters
          </button>
        </div>

        <p className="filter-count mono">
          Showing {filteredRows.length} of {rows.length} in memory — notional ≥ {formatUsd(effectiveMinNotionalUsd)}
          {effectiveMinNotionalUsd > minTracked
            ? ` (includes your ${formatUsd(effectiveMinNotionalUsd)} floor on top of the server’s ${formatUsd(minTracked)})`
            : ` (server floor ${formatUsd(minTracked)})`}
          .
        </p>
      </section>

      <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th>When</th>
              <th>Notional</th>
              <th>
                <span title="Kalshi’s public trade feed does not include account names; this column is ready if the API adds one.">
                  Username
                </span>
              </th>
              <th>Category</th>
              <th>Side</th>
              <th>Event / market</th>
              <th>Closes</th>
              <th>Δ close</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {emptyMessage ? (
              <tr>
                <td colSpan={9} className="empty">
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              filteredRows.map((r) => {
                const hLeft = hoursUntilClose(r.close_time, clock)
                return (
                  <tr key={r.trade_id}>
                    <td className="mono muted">{formatTime(r.created_time)}</td>
                    <td className="num strong">{formatUsd(r.notional_usd)}</td>
                    <td className="username-cell">
                      {r.username?.trim() ? (
                        <span className="username-known">{r.username.trim()}</span>
                      ) : (
                        <span
                          className="muted not-public"
                          title="Kalshi does not expose trader usernames on public trade endpoints (see GET /markets/trades)."
                        >
                          Not public
                        </span>
                      )}
                    </td>
                    <td>
                      <span className="cat">{r.category}</span>
                    </td>
                    <td>
                      <span className={`side side-${r.taker_side}`}>{r.taker_side.toUpperCase()}</span>
                    </td>
                    <td className="market">
                      {r.event_title ? <div className="event-title">{r.event_title}</div> : null}
                      <div className="m-title">{r.market_label}</div>
                      <div className="m-tick mono muted">{r.ticker}</div>
                      {r.rules_primary ? (
                        <div className="m-rules muted">{r.rules_primary}</div>
                      ) : null}
                    </td>
                    <td className="mono muted">{formatTime(r.close_time)}</td>
                    <td className="mono">
                      {hLeft == null ? '—' : `${Math.round(hLeft * 10) / 10}h`}
                    </td>
                    <td>
                      <a
                        className="link"
                        href={kalshiSeriesHref(r.event_ticker)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Kalshi ↗
                      </a>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      <footer className="footer">
        Data from{' '}
        <a href="https://docs.kalshi.com/getting_started/quick_start_market_data">
          Kalshi Trade API
        </a>
        . Categories use{' '}
        <a href="https://docs.kalshi.com/api-reference/market/get-series">series.category</a> (not
        event.category). Public trades do not include usernames; the Username column shows “Not
        public” unless Kalshi adds a field later. Notional is contracts × taker-side price.
      </footer>
    </div>
  )
}
