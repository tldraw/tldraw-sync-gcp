import { PassThrough } from "stream"
import type { Request, Response } from "express"

// Minimal express Request stand-in. It is a real readable stream, so handlers
// that pipe the request body (asset uploads) work against it unchanged.
export function fakeRequest({
  params = {},
  query = {},
  headers = {},
  body,
}: {
  params?: Record<string, string>
  query?: Record<string, unknown>
  headers?: Record<string, string>
  body?: string | Buffer
} = {}): Request {
  const req = new PassThrough() as unknown as Request & PassThrough
  Object.assign(req, { params, query, headers })
  if (body !== undefined) req.end(body)
  return req
}

export type FakeResponse = Response & {
  headers: Record<string, string>
  body: unknown
  // Bytes written by handlers that pipe a storage stream instead of calling send().
  streamed: () => string
  // Resolves once the response stream has ended.
  whenFinished: () => Promise<void>
}

// Minimal express Response stand-in. It is a real writable stream, so handlers
// that pipe storage streams into the response work against it unchanged.
// Built untyped and cast once at the end: Response and PassThrough have
// conflicting members (`finished` is a boolean on Response), so the
// intersection cannot be assigned to piecemeal.
export function fakeResponse(): FakeResponse {
  const chunks: Buffer[] = []
  const stream = new PassThrough()
  const res = stream as unknown as Record<string, unknown>

  res.statusCode = 200
  res.headers = {}
  res.body = undefined
  stream.on("data", (chunk: Buffer) => chunks.push(chunk))

  res.setHeader = (name: string, value: unknown) => {
    ;(res.headers as Record<string, string>)[name.toLowerCase()] = String(value)
    return res
  }
  res.status = (code: number) => {
    res.statusCode = code
    return res
  }
  const respondWith = (payload: unknown) => {
    res.body = payload
    stream.end()
    return res
  }
  res.send = respondWith
  res.json = respondWith
  res.streamed = () => Buffer.concat(chunks).toString()
  res.whenFinished = () =>
    new Promise<void>((resolve) => {
      if (stream.writableEnded) return resolve()
      stream.on("finish", () => resolve())
    })

  return res as unknown as FakeResponse
}
