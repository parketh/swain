import * as NodePath from "node:path"

export type MediaKind = "text" | "image" | "pdf" | "binary"

export interface MediaInfo {
  readonly kind: MediaKind
  readonly supported: boolean
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico"])

/**
 * Classifies file bytes as text or an unsupported media kind. Text is the only
 * supported kind for read/edit; images, PDFs, and binaries report metadata only.
 */
export const classify = (path: string, bytes: Uint8Array): MediaInfo => {
  const extension = NodePath.extname(path).toLowerCase()
  if (IMAGE_EXTENSIONS.has(extension)) return { kind: "image", supported: false }
  if (extension === ".pdf") return { kind: "pdf", supported: false }
  const sample = bytes.subarray(0, 8192)
  if (sample.includes(0)) return { kind: "binary", supported: false }
  return { kind: "text", supported: true }
}
