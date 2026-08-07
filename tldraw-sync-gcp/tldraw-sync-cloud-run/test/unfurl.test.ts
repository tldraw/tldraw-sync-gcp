import { beforeEach, describe, expect, it, vi } from "vitest"
import { fakeRequest, fakeResponse } from "./helpers/http.js"

const ogs = vi.fn()
vi.mock("open-graph-scraper", () => ({ default: (options: unknown) => ogs(options) }))

const { handleUnfurlRequest } = await import("../src/unfurl.js")

beforeEach(() => {
  ogs.mockReset()
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("handleUnfurlRequest", () => {
  it.each([
    ["missing", {}],
    ["an array", { url: ["a", "b"] }],
  ])("rejects a request with %s url", async (_label, query) => {
    const res = fakeResponse()

    await handleUnfurlRequest(fakeRequest({ query }), res)

    expect(res.statusCode).toBe(400)
    expect(ogs).not.toHaveBeenCalled()
  })

  it("maps open graph fields onto the preview", async () => {
    ogs.mockResolvedValue({
      error: false,
      result: {
        ogTitle: "Title",
        ogDescription: "Description",
        ogImage: [{ url: "https://example.com/i.png" }],
        favicon: "https://example.com/f.ico",
      },
    })

    const res = fakeResponse()
    await handleUnfurlRequest(fakeRequest({ query: { url: "https://example.com" } }), res)

    expect(res.body).toEqual({
      title: "Title",
      description: "Description",
      image: "https://example.com/i.png",
      favicon: "https://example.com/f.ico",
    })
  })

  it("falls back to twitter fields", async () => {
    ogs.mockResolvedValue({
      error: false,
      result: {
        twitterTitle: "T",
        twitterDescription: "D",
        twitterImage: [{ url: "https://example.com/t.png" }],
      },
    })

    const res = fakeResponse()
    await handleUnfurlRequest(fakeRequest({ query: { url: "https://example.com" } }), res)

    expect(res.body).toEqual({
      title: "T",
      description: "D",
      image: "https://example.com/t.png",
      favicon: "",
    })
  })

  it("returns empty strings when the page has no metadata", async () => {
    ogs.mockResolvedValue({ error: false, result: {} })

    const res = fakeResponse()
    await handleUnfurlRequest(fakeRequest({ query: { url: "https://example.com" } }), res)

    expect(res.body).toEqual({ title: "", description: "", image: "", favicon: "" })
  })

  it("does not leak upstream failure detail to the caller", async () => {
    ogs.mockResolvedValue({ error: true, result: { error: "getaddrinfo ENOTFOUND internal.host" } })

    const res = fakeResponse()
    await handleUnfurlRequest(fakeRequest({ query: { url: "http://internal.host" } }), res)

    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({ error: "Failed to fetch URL metadata" })
  })

  it("returns 500 when the scraper throws", async () => {
    ogs.mockRejectedValue(new Error("boom"))

    const res = fakeResponse()
    await handleUnfurlRequest(fakeRequest({ query: { url: "https://example.com" } }), res)

    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({ error: "Internal server error during unfurl" })
  })
})
