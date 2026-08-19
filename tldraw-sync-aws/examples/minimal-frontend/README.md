# Minimal frontend example

The smallest possible tldraw frontend wired up to the `tldraw-sync-aws` backend.
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
# From the tldraw-sync-aws/ directory
docker run -d --name tldraw-redis -p 6379:6379 redis:7-alpine
docker run -d --name tldraw-localstack -p 4566:4566 localstack/localstack:4.14.0

yarn install && yarn build
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test
docker exec tldraw-localstack awslocal s3 mb s3://tldraw-test-bucket

REDIS_URL=redis://localhost:6379 \
  S3_BUCKET_NAME=tldraw-test-bucket \
  S3_ENDPOINT=http://localhost:4566 \
  AWS_REGION=us-east-1 \
  PORT=3001 node dist/index.js
```

> `S3_ENDPOINT` points the S3 client at LocalStack — leave it unset in production,
> where the real endpoint + IRSA credentials and the real bucket are used.

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
  each room, and persists snapshots to an S3 bucket every 10 seconds.
- Large binary assets never travel over the WebSocket. The `TLAssetStore`
  uploads them to the server, which streams them into S3; only the URL is
  stored in the synced document.
- When a user pastes a URL, the registered `"url"` handler asks the server's
  `/api/unfurl` endpoint for the page's Open Graph metadata to render a rich
  bookmark card.

For a production-grade client (routing per room, error boundaries, offline
banner), see [`tldraw-client/`](../../tldraw-client/).
