/**
 * Minimal example: hooking a tldraw frontend up to the tldraw-sync-aws backend.
 *
 * There are exactly three integration points:
 *
 *   1. The sync WebSocket   → useSync({ uri })        ws(s)://<server>/api/connect/<roomId>
 *   2. Uploaded assets      → TLAssetStore            POST/GET <server>/api/uploads/<id>
 *   3. Bookmark previews    → "url" asset handler     GET <server>/api/unfurl?url=<url>
 *
 * Everything else (presence, cursors, reconnection, conflict resolution) is
 * handled for you by @tldraw/sync.
 */
import { useSync } from "@tldraw/sync"
import {
  AssetRecordType,
  getHashForString,
  TLAssetStore,
  TLBookmarkAsset,
  Tldraw,
  uniqueId,
} from "tldraw"
import "tldraw/tldraw.css"

// Where the tldraw-sync-aws server is running. In production this is your
// AWS load balancer URL (e.g. https://aws-sync.example.com).
const SERVER_URL = import.meta.env.VITE_PUBLIC_API_URL ?? "http://localhost:3001"

// Everyone who opens the app with the same room id sees the same canvas.
// Here we take it from the URL hash so you can try multiple rooms easily.
const roomId = window.location.hash.slice(1) || "example-room"

// --- 2. Assets -------------------------------------------------------------
// Images/videos dropped onto the canvas are too big to send over the sync
// WebSocket, so tldraw asks us to store them. We POST the file to the
// server, which streams it into the S3 bucket, and hand back the URL.
const assetStore: TLAssetStore = {
  async upload(_asset, file) {
    const objectName = `${uniqueId()}-${file.name}`.replace(/[^a-zA-Z0-9.]/g, "-")
    const url = `${SERVER_URL}/api/uploads/${objectName}`

    const response = await fetch(url, { method: "POST", body: file })
    if (!response.ok) throw new Error(`Failed to upload asset: ${response.statusText}`)

    // Whatever we return here is stored in the shared document, so every
    // other client resolves the same S3-backed URL.
    return { src: url }
  },

  resolve(asset) {
    return asset.props.src
  },
}

// --- 3. Bookmark previews --------------------------------------------------
// When a user pastes a URL, tldraw creates a bookmark shape. The server's
// /api/unfurl endpoint fetches the page's title/description/image for us
// (browsers can't do this cross-origin themselves).
async function createBookmarkPreview({ url }: { url: string }): Promise<TLBookmarkAsset> {
  const asset: TLBookmarkAsset = {
    id: AssetRecordType.createId(getHashForString(url)),
    typeName: "asset",
    type: "bookmark",
    meta: {},
    props: { src: url, title: "", description: "", image: "", favicon: "" },
  }

  try {
    const response = await fetch(`${SERVER_URL}/api/unfurl?url=${encodeURIComponent(url)}`)
    const data = await response.json()
    asset.props.title = data?.title ?? ""
    asset.props.description = data?.description ?? ""
    asset.props.image = data?.image ?? ""
    asset.props.favicon = data?.favicon ?? ""
  } catch {
    // Unfurling is best-effort; a bare bookmark is fine.
  }

  return asset
}

// --- 1. The synced canvas ---------------------------------------------------
export default function App() {
  // useSync connects to the server, keeps the store in sync with everyone
  // else in the room, and handles reconnection. It returns a store whose
  // status is "loading" until the first sync completes.
  const store = useSync({
    uri: `${SERVER_URL.replace(/^http/, "ws")}/api/connect/${roomId}`,
    assets: assetStore,
  })

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <Tldraw
        store={store}
        onMount={(editor) => {
          editor.registerExternalAssetHandler("url", createBookmarkPreview)
        }}
      />
    </div>
  )
}
