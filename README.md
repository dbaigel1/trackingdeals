# Kalshi Bets Watcher

This project has two runtime pieces:

- A Vite/React frontend.
- A Node watcher backend in [`server/watch.mjs`](/Users/danielbaigel/Desktop/projects/kalshi/kalshi-bets/server/watch.mjs) that polls Kalshi and streams updates over WebSocket.

## Local development

```bash
npm install
npm run dev
```

In development, the frontend connects to `ws://localhost:3001` by default.

## Why Netlify was failing

In production, Netlify only serves the frontend unless you separately deploy the Node backend. A WebSocket URL like:

```text
wss://trackingdeals.netlify.app/
```

points back at the static site, not your watcher process, so the socket fails.

## Production options

Use one of these setups:

1. Deploy the frontend to Netlify and the Node watcher to a separate Node host such as Render, Railway, or Fly.io.
2. Deploy the frontend and backend together on one Node host, letting [`server/watch.mjs`](/Users/danielbaigel/Desktop/projects/kalshi/kalshi-bets/server/watch.mjs) serve `dist/`.

### Netlify frontend + separate backend

Deploy the backend somewhere that supports a long-lived Node process and WebSockets, then set this environment variable in Netlify before building:

```text
VITE_WS_URL=wss://your-backend.example.com
```

The frontend will use that WebSocket endpoint in production.

This repo now includes [`render.yaml`](/Users/danielbaigel/Desktop/projects/kalshi/kalshi-bets/render.yaml:1) so Render can create the backend service with the correct commands automatically.

### Email alerts for bets over $10,000

The watcher can also email `chessboychef@gmail.com` whenever a tracked trade is at or above `$10,000.00` notional.

Set these backend environment variables on the server that runs [`server/watch.mjs`](/Users/danielbaigel/Desktop/projects/kalshi/kalshi-bets/server/watch.mjs):

```text
EMAIL_ALERT_THRESHOLD_USD=10000
ALERT_EMAIL_TO=chessboychef@gmail.com
RESEND_API_KEY=your_resend_api_key
ALERT_EMAIL_FROM=alerts@your-verified-domain.com
```

Notes:

1. `RESEND_API_KEY` and `ALERT_EMAIL_FROM` are required to actually send mail.
2. `ALERT_EMAIL_FROM` must be a sender/domain verified in Resend.
3. Each qualifying trade is only processed once by its `trade_id`, so it will only email once per trade.
4. The email includes the amount bet, market, side, category, trade time, close time, prices, tickers, and any market rules excerpt available from Kalshi.

### Single-host Node deployment

Build the frontend, then run the Node server:

```bash
npm install
npm run build
npm start
```

If the frontend and backend share the same origin in production, set:

```text
VITE_USE_SAME_ORIGIN_WS=true
```

That tells the frontend to connect back to its own host for WebSockets.
