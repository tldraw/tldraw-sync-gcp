import type { Request, Response } from "express";
import ogs from "open-graph-scraper";

export async function handleUnfurlRequest(req: Request, res: Response) {
  const url = req.query.url;

  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Missing url query parameter" });
  }

  try {
    const { result, error } = await ogs({ url });

    if (error) {
      return res.status(500).json({ error: "Failed to fetch URL metadata" });
    }

    const preview = {
      title: result.ogTitle || result.twitterTitle || "",
      description: result.ogDescription || result.twitterDescription || "",
      image: result.ogImage?.[0]?.url || result.twitterImage?.[0]?.url || "",
      favicon: result.favicon || "",
    };

    res.json(preview);
  } catch (err: any) {
    res.status(500).json({ error: "Internal server error during unfurl" });
  }
}
