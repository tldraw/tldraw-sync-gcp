import { AssetRecordType, type TLAsset, type TLBookmarkAsset, getHashForString } from "tldraw"

const API_URL = import.meta.env.VITE_PUBLIC_API_URL || "http://localhost:3001"
const FETCH_TIMEOUT_MS = 5000 // 5 Second Timeout

// 1. Type Definitions (No more 'any')
interface UnfurlResponse {
  title?: string
  description?: string
  image?: string
  favicon?: string
}

export async function getBookmarkPreview({ url }: { url: string }): Promise<TLAsset> {
  const asset: TLBookmarkAsset = {
    id: AssetRecordType.createId(getHashForString(url)),
    typeName: "asset",
    type: "bookmark",
    meta: {},
    props: {
      src: url,
      description: "",
      image: "",
      favicon: "",
      title: "",
    },
  }

  try {
    // 2. Fetch Timeout Implementation
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

    const response = await fetch(`${API_URL}/api/unfurl?url=${encodeURIComponent(url)}`, {
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    // 3. Response Validation
    if (!response.ok) {
      throw new Error(`Server returned ${response.status} ${response.statusText}`)
    }

    const data = (await response.json()) as UnfurlResponse

    // 4. Data Validation & Assignment
    asset.props.description = data?.description ?? ""
    asset.props.image = data?.image ?? ""
    asset.props.favicon = data?.favicon ?? ""
    asset.props.title = data?.title ?? "Untitled Link"
  } catch (e: unknown) {
    // 5. Error Handling & User Feedback
    console.error(`Failed to unfurl URL: ${url}`, e)

    // Provide visual feedback in the asset itself so the user knows it failed
    asset.props.title = "Preview Unavailable"
    asset.props.description = e instanceof Error ? e.message : "Connection failed"
  }

  return asset
}
