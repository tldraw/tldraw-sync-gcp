import { useSync } from "@tldraw/sync"
import { Tldraw } from "tldraw"
import { useParams } from "react-router-dom"
import { multiplayerAssetStore } from "./multiplayerAssetStore"
import { getBookmarkPreview } from "./getBookmarkPreview"
import "tldraw/tldraw.css"
import { useState, useEffect } from "react"

// 1. Environment Variable Validation
const API_URL = import.meta.env.VITE_PUBLIC_API_URL
if (!API_URL) {
  throw new Error("Configuration Error: VITE_PUBLIC_API_URL is missing.")
}

// Helper Hook: Track Network Status for Reconnection UI
function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(navigator.onLine)
  useEffect(() => {
    const handleOnline = () => setIsOnline(true)
    const handleOffline = () => setIsOnline(false)
    window.addEventListener("online", handleOnline)
    window.addEventListener("offline", handleOffline)
    return () => {
      window.removeEventListener("online", handleOnline)
      window.removeEventListener("offline", handleOffline)
    }
  }, [])
  return isOnline
}

export function Room() {
  const { roomId } = useParams<{ roomId: string }>()
  const isOnline = useOnlineStatus()

  // 2. Room ID Validation (Alphanumeric + hyphens only)
  // This prevents malicious strings from being sent to the backend
  if (!roomId || !/^[a-zA-Z0-9-_]+$/.test(roomId)) {
    return (
      <div style={{ padding: 20, color: "red" }}>
        <h2>Invalid Room ID</h2>
        <p>Room IDs must contain only letters, numbers, and hyphens.</p>
      </div>
    )
  }

  // 3. WebSocket URI Construction
  const wsUri = API_URL.replace(/^http/, "ws") + `/api/connect/${roomId}`

  // 4. Tldraw Sync Hook
  // Note: useSync handles the actual WebSocket retry/reconnection logic internally.
  const store = useSync({
    uri: wsUri,
    assets: multiplayerAssetStore,
  })

  // 5. Loading State
  // If the store hasn't initialized yet, show a loading screen.
  if (!store) {
    return (
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          height: "100vh",
        }}
      >
        <h2>Connecting to room...</h2>
      </div>
    )
  }

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      {/* 6. Reconnection UI (User Feedback) */}
      {!isOnline && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            background: "#ff4d4f",
            color: "white",
            textAlign: "center",
            padding: "8px",
            zIndex: 9999,
          }}
        >
          ⚠️ You are offline. Reconnecting...
        </div>
      )}

      <Tldraw
        store={store}
        onMount={(editor) => {
          editor.registerExternalAssetHandler("url", getBookmarkPreview)
        }}
      />
    </div>
  )
}
