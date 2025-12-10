import { useSync } from "@tldraw/sync";
import { Tldraw } from "tldraw";
import { useParams } from "react-router-dom";
import { multiplayerAssetStore } from "./multiplayerAssetStore";
import { getBookmarkPreview } from "./getBookmarkPreview";
import "tldraw/tldraw.css";

const API_URL = import.meta.env.VITE_PUBLIC_API_URL || "http://localhost:3001";

export function Room() {
  const { roomId } = useParams<{ roomId: string }>();

  const wsUri = API_URL.replace(/^http/, "ws") + `/api/connect/${roomId}`;

  const store = useSync({
    uri: wsUri,
    assets: multiplayerAssetStore,
  });

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <Tldraw
        store={store}
        onMount={(editor) => {
          editor.registerExternalAssetHandler("url", getBookmarkPreview);
        }}
      />
    </div>
  );
}
