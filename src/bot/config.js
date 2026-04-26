import dotenv from "dotenv"
import { GoogleGenAI } from "@google/genai"

dotenv.config()

export const MAX_RECENT_IMAGES = 20
export const RECENT_IMAGE_MAX_AGE_MS = 30 * 60 * 1000
export const PENDING_SELECTION_TTL_MS = 10 * 60 * 1000
export const DEFAULT_SELECTION_WINDOW_MS = 2 * 60 * 1000
export const QUOTED_BULK_WINDOW_MS = 90 * 1000
export const GROUP_SCOPE_SENDER = "__all__"
export const MAX_VIDEO_SIZE_BYTES = 100 * 1024 * 1024

export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash"
export const GEMINI_MIN_CONFIDENCE = Number(
  process.env.GEMINI_MIN_CONFIDENCE || "0.75",
)
export const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
export const geminiClient = GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: GEMINI_API_KEY })
  : null

export const DEBUG_QUOTED_MEDIA = process.env.DEBUG_QUOTED_MEDIA === "1"
export const BRAND_FOOTER = "© _2026 Arsipin AI by abdridwan_"
export const MENU_HEADER =
  "🤖 Arsipin AI - WA Bot berbasis AI untuk pengarsipan dokumentasi Humas 🤖"

export function withBranding(lines) {
  return [...lines, "", BRAND_FOOTER].join("\n")
}
