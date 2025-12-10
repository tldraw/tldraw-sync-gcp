import {
  AssetRecordType,
  type TLAsset,
  type TLBookmarkAsset,
  getHashForString,
} from "tldraw";
const API_URL = import.meta.env.VITE_PUBLIC_API_URL || "http://localhost:3001";

export async function getBookmarkPreview({
  url,
}: {
  url: string;
}): Promise<TLAsset> {
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
  };

  try {
    const response = await fetch(
      `${API_URL}/api/unfurl?url=${encodeURIComponent(url)}`
    );
    const data: any = await response.json();

    asset.props.description = data?.description ?? "";
    asset.props.image = data?.image ?? "";
    asset.props.favicon = data?.favicon ?? "";
    asset.props.title = data?.title ?? "";
  } catch (e) {}

  return asset;
}
