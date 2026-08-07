# Minimal frontend example

The smallest possible tldraw frontend wired up to the `tldraw-sync-gke` backend.
Everything lives in [`src/App.tsx`](src/App.tsx) (~100 lines, mostly comments) and
shows the three integration points:

| #   | What                | Client API                               | Server endpoint             |
| --- | ------------------- | ---------------------------------------- | --------------------------- |
| 1   | Real-time sync      | `useSync({ uri })`                       | `WS /api/connect/:roomId`   |
| 2   | Image/video uploads | `TLAssetStore` passed to `useSync`       | `POST/GET /api/uploads/:id` |
| 3   | Bookmark previews   | `registerExternalAssetHandler("url", …)` | `GET /api/unfurl?url=…`     |

## Run it

### 1. Start the backend

Either point at a deployed instance (skip to step 2), or run the full stack
locally with emulators:

```sh
# From the tldraw-sync-gcp/tldraw-sync-gke/ directory
docker run -d --name tldraw-redis -p 6379:6379 redis:7-alpine
docker run -d --name tldraw-gcs -p 4443:4443 fsouza/fake-gcs-server \
  -scheme http -port 4443 -public-host localhost:4443 -external-url http://localhost:4443
curl -X POST "http://localhost:4443/storage/v1/b?project=test" \
  -H "Content-Type: application/json" -d '{"name":"tldraw-test-bucket"}'

yarn install && yarn build
REDIS_URL=redis://localhost:6379 \
  GCS_BUCKET_NAME=tldraw-test-bucket \
  GCS_API_ENDPOINT=http://localhost:4443 \
  PORT=3001 node dist/index.js
```

> `GCS_API_ENDPOINT` points the GCS client at the emulator — leave it unset in
> production, where the default credentials + real bucket are used.

### 2. Start the frontend

```sh
cd examples/minimal-frontend
npm install
npm run dev
```

Open http://localhost:5173 in **two browser windows** — draw in one, watch it
appear in the other. Append a hash to switch rooms, e.g.
http://localhost:5173#my-other-room.

To point at a deployed backend instead of localhost:

```sh
VITE_PUBLIC_API_URL=https://your-server.example.com npm run dev
```

## How it works

- `useSync` opens a WebSocket to `/api/connect/:roomId` and returns a
  `TLStore` that stays in sync with every other client in the room. The
  server (see `src/roomManager.ts`) uses a Redis lock so exactly one pod owns
  each room, and persists snapshots to a GCS bucket every 10 seconds.
- Large binary assets never travel over the WebSocket. The `TLAssetStore`
  uploads them to the server, which streams them into GCS; only the URL is
  stored in the synced document.
- When a user pastes a URL, the registered `"url"` handler asks the server's
  `/api/unfurl` endpoint for the page's Open Graph metadata to render a rich
  bookmark card.

For a production-grade client (routing per room, error boundaries, offline
banner), see [`tldraw-client/`](../../tldraw-client/).
