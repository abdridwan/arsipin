import pkg from "whatsapp-web.js"
import qrcode from "qrcode-terminal"
import dotenv from "dotenv"
import { GoogleGenAI } from "@google/genai"
import { listDriveFoldersFromRoot, uploadMediaToDrive } from "./gdrive.js"

dotenv.config()

const { Client, LocalAuth, MessageMedia } = pkg

const imageStore = new Map()
const pendingSelectionStore = new Map()
const uploadedImageStore = new Map()
const lastUploadedAtStore = new Map()
const selectionCutoffStore = new Map()
const MAX_RECENT_IMAGES = 20
const RECENT_IMAGE_MAX_AGE_MS = 30 * 60 * 1000
const PENDING_SELECTION_TTL_MS = 10 * 60 * 1000
const DEFAULT_SELECTION_WINDOW_MS = 2 * 60 * 1000
const QUOTED_BULK_WINDOW_MS = 90 * 1000
const GROUP_SCOPE_SENDER = "__all__"
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash"
const GEMINI_MIN_CONFIDENCE = Number(
  process.env.GEMINI_MIN_CONFIDENCE || "0.75",
)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
const geminiClient = GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: GEMINI_API_KEY })
  : null
const BRAND_FOOTER = "© _2026 Arsipin AI by abdridwan_"
const MENU_HEADER =
  "🤖 Arsipin AI - WA Bot berbasis AI untuk pengarsipan dokumentasi Humas 🤖"

function getMessageText(message) {
  return message.body?.trim() || ""
}

function getSenderId(message) {
  return message.author || message.from
}

function getSenderScopeKey(message) {
  return `${message.from}:${getSenderId(message)}`
}

function parseKirimInstruction(text) {
  return text.replace(/^\/(?:kirim)\b/i, "").trim()
}

function isKirimCommand(text) {
  return /^\/(?:kirim)\b/i.test(text)
}

function parsePilihNumber(text) {
  const match = text.match(/^\/pilih\s+(\d+)\s*$/i)
  if (!match) return null

  return Number(match[1])
}

function withBranding(lines) {
  return [...lines, "", BRAND_FOOTER].join("\n")
}

function setPendingSelection(scopeKey, payload) {
  pendingSelectionStore.set(scopeKey, {
    ...payload,
    createdAt: Date.now(),
  })
}

function getPendingSelection(scopeKey) {
  const pending = pendingSelectionStore.get(scopeKey)
  if (!pending) return null

  if (Date.now() - pending.createdAt > PENDING_SELECTION_TTL_MS) {
    pendingSelectionStore.delete(scopeKey)
    return null
  }

  return pending
}

function clearPendingSelection(scopeKey) {
  pendingSelectionStore.delete(scopeKey)
}

function getSenderStoreKey(groupId, senderId) {
  return `${groupId}:${senderId}`
}

function getGroupScopeKey(groupId) {
  return getSenderStoreKey(groupId, GROUP_SCOPE_SENDER)
}

function getLastUploadedAt(groupId, senderId) {
  const senderKey = getSenderStoreKey(groupId, senderId)
  const groupKey = getGroupScopeKey(groupId)
  return Math.max(
    Number(lastUploadedAtStore.get(senderKey) || 0),
    Number(lastUploadedAtStore.get(groupKey) || 0),
  )
}

function setLastUploadedAt(groupId, senderId, timestampMs) {
  const next = Number(timestampMs || 0)
  if (!next) return

  const senderKey = getSenderStoreKey(groupId, senderId)
  const senderCurrent = Number(lastUploadedAtStore.get(senderKey) || 0)
  if (next > senderCurrent) {
    lastUploadedAtStore.set(senderKey, next)
  }

  const groupKey = getGroupScopeKey(groupId)
  const groupCurrent = Number(lastUploadedAtStore.get(groupKey) || 0)
  if (next > groupCurrent) {
    lastUploadedAtStore.set(groupKey, next)
  }
}

function getSelectionCutoff(groupId, senderId) {
  const senderKey = getSenderStoreKey(groupId, senderId)
  const groupKey = getGroupScopeKey(groupId)
  return Math.max(
    Number(selectionCutoffStore.get(senderKey) || 0),
    Number(selectionCutoffStore.get(groupKey) || 0),
  )
}

function setSelectionCutoff(
  groupId,
  senderId,
  timestampMs,
  { updateGroupScope = true } = {},
) {
  const next = Number(timestampMs || 0)
  if (!next) return

  const senderKey = getSenderStoreKey(groupId, senderId)
  const senderCurrent = Number(selectionCutoffStore.get(senderKey) || 0)
  if (next > senderCurrent) {
    selectionCutoffStore.set(senderKey, next)
  }

  if (!updateGroupScope) return

  const groupKey = getGroupScopeKey(groupId)
  const groupCurrent = Number(selectionCutoffStore.get(groupKey) || 0)
  if (next > groupCurrent) {
    selectionCutoffStore.set(groupKey, next)
  }
}

function pruneUploadedImagesForKey(key) {
  const list = uploadedImageStore.get(key) || []
  const next = list.filter(
    (item) => Date.now() - item.timestamp <= RECENT_IMAGE_MAX_AGE_MS,
  )
  if (next.length === 0) {
    uploadedImageStore.delete(key)
    return []
  }
  uploadedImageStore.set(key, next)
  return next
}

function getUploadedImageIdSet(groupId, senderId) {
  const senderKey = getSenderStoreKey(groupId, senderId)
  const groupKey = getGroupScopeKey(groupId)
  const senderList = pruneUploadedImagesForKey(senderKey)
  const groupList = pruneUploadedImagesForKey(groupKey)
  return new Set(
    [...senderList, ...groupList].map((item) => item.messageId).filter(Boolean),
  )
}

function markImagesAsUploaded(groupId, senderId, messageIds) {
  if (!Array.isArray(messageIds) || messageIds.length === 0) return

  const now = Date.now()
  const keys = [getSenderStoreKey(groupId, senderId), getGroupScopeKey(groupId)]

  for (const key of keys) {
    const current = pruneUploadedImagesForKey(key)
    const exists = new Set(current.map((item) => item.messageId))
    const next = [...current]

    for (const messageId of messageIds) {
      if (!messageId || exists.has(messageId)) continue
      next.push({ messageId, timestamp: now })
      exists.add(messageId)
    }

    if (next.length) {
      uploadedImageStore.set(key, next)
    }
  }
}

function parseJsonSafe(rawText = "") {
  const cleaned = rawText
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "")

  if (!cleaned) return null

  try {
    return JSON.parse(cleaned)
  } catch {
    return null
  }
}

function normalizeCandidateIndexes(indexes, max) {
  if (!Array.isArray(indexes)) return []

  const unique = new Set()
  for (const value of indexes) {
    const n = Number(value)
    if (!Number.isInteger(n)) continue
    if (n < 1 || n > max) continue
    unique.add(n)
  }

  return Array.from(unique)
}

function formatFolderOptions(folders) {
  return folders.map((folder, idx) => `${idx + 1}. ${folder.path}`).join("\n")
}

function normalizeText(value = "") {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s/]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function extractFolderHint(instruction = "") {
  const cleaned = instruction.trim()
  if (!cleaned) return ""

  return cleaned.replace(/^ke\s+/i, "").trim()
}

function isLikelyAcronym(value = "") {
  const cleaned = String(value || "").trim()
  return /^[A-Z0-9]{2,8}$/.test(cleaned)
}

function folderAcronym(value = "") {
  const cleaned = String(value || "")
    .replace(/[/_]/g, " ")
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()

  if (!cleaned) return ""

  const tokens = cleaned.split(" ").filter(Boolean)
  return tokens
    .map((t) => t[0] || "")
    .join("")
    .toUpperCase()
}

function rankFolderCandidatesByInstruction(instruction, folders) {
  const hint = normalizeText(extractFolderHint(instruction))
  if (!hint) return []

  const hintTokens = hint.split(" ").filter(Boolean)
  const rawHint = extractFolderHint(instruction).trim()
  const hintAcronym = isLikelyAcronym(rawHint) ? rawHint.toUpperCase() : ""

  const scored = folders
    .map((folder) => {
      const haystack = normalizeText(folder.path)
      let score = 0

      if (haystack === hint) score += 100
      if (haystack.endsWith(`/${hint}`)) score += 60
      if (haystack.includes(hint)) score += 40

      for (const token of hintTokens) {
        if (token.length < 2) continue
        if (haystack.includes(token)) score += 8
      }

      if (hintAcronym) {
        const pathAcronym = folderAcronym(folder.path)
        if (pathAcronym === hintAcronym) score += 70
        else if (pathAcronym.includes(hintAcronym)) score += 40
      }

      return { folder, score }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)

  return scored
}

function getDirectFolderMatches(instruction, folders) {
  const hint = normalizeText(extractFolderHint(instruction))
  if (!hint) return []

  return folders.filter((folder) => {
    const path = normalizeText(folder.path)
    return path.includes(hint)
  })
}

function buildSelectionPrompt(candidateFolders) {
  return [
    "Pilih salah satu dengan command /pilih <nomor>:",
    formatFolderOptions(candidateFolders),
  ].join("\n")
}

function rememberImage(message) {
  const groupId = message.from
  const senderId = getSenderId(message)
  const key = `${groupId}:${senderId}`

  const list = imageStore.get(key) || []

  list.push({
    messageId: message.id._serialized,
    groupId,
    senderId,
    timestamp: Date.now(),
    message,
  })

  imageStore.set(key, list.slice(-MAX_RECENT_IMAGES))
}

function getRecentImages(groupId, senderId) {
  const key = `${groupId}:${senderId}`
  const list = imageStore.get(key) || []

  return list.filter(
    (item) => Date.now() - item.timestamp <= RECENT_IMAGE_MAX_AGE_MS,
  )
}

function getRecentImagesForGroup(groupId) {
  const prefix = `${groupId}:`
  const all = []

  for (const [key, list] of imageStore.entries()) {
    if (!key.startsWith(prefix)) continue
    for (const item of list) {
      if (Date.now() - item.timestamp <= RECENT_IMAGE_MAX_AGE_MS) {
        all.push(item)
      }
    }
  }

  return all
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeMessageTimestampMs(message) {
  const value = Number(message?.timestamp || 0)
  if (!Number.isFinite(value) || value <= 0) return Date.now()

  // whatsapp-web.js timestamp is usually seconds.
  return value > 10_000_000_000 ? value : value * 1000
}

async function getRecentImagesFromChat(message, senderId) {
  try {
    const chat = await message.getChat()
    const messages = await chat.fetchMessages({ limit: 50 })

    return messages
      .filter((item) => {
        if (!item?.hasMedia || item?.fromMe) return false
        if (item.type !== "image") return false
        if (getSenderId(item) !== senderId) return false

        const ts = normalizeMessageTimestampMs(item)
        return Date.now() - ts <= RECENT_IMAGE_MAX_AGE_MS
      })
      .map((item) => ({
        messageId: item.id?._serialized,
        groupId: message.from,
        senderId,
        timestamp: normalizeMessageTimestampMs(item),
        message: item,
      }))
  } catch {
    return []
  }
}

async function getRecentImagesFromChatForGroup(message) {
  try {
    const chat = await message.getChat()
    const messages = await chat.fetchMessages({ limit: 80 })

    return messages
      .filter((item) => {
        if (!item?.hasMedia || item?.fromMe) return false
        if (item.type !== "image") return false

        const ts = normalizeMessageTimestampMs(item)
        return Date.now() - ts <= RECENT_IMAGE_MAX_AGE_MS
      })
      .map((item) => ({
        messageId: item.id?._serialized,
        groupId: message.from,
        senderId: getSenderId(item),
        timestamp: normalizeMessageTimestampMs(item),
        message: item,
      }))
  } catch {
    return []
  }
}

async function getSelectableRecentImageItems(
  message,
  senderId,
  {
    commandTimestampMs = Date.now(),
    includeDefaultWindow = true,
    minTimestamp = 0,
    maxTimestamp = Number.POSITIVE_INFINITY,
    includeAllSenders = false,
  } = {},
) {
  // Give WhatsApp event stream a short time to flush album/bulk image messages.
  await sleep(1200)

  const storeImages = includeAllSenders
    ? getRecentImagesForGroup(message.from)
    : getRecentImages(message.from, senderId)
  const chatImages = includeAllSenders
    ? await getRecentImagesFromChatForGroup(message)
    : await getRecentImagesFromChat(message, senderId)
  const uploadedIdSet = getUploadedImageIdSet(message.from, senderId)
  const lastUploadedAt = getLastUploadedAt(message.from, senderId)
  const selectionCutoff = getSelectionCutoff(message.from, senderId)
  const defaultWindowCutoff = includeDefaultWindow
    ? Number(commandTimestampMs || Date.now()) - DEFAULT_SELECTION_WINDOW_MS
    : 0
  const effectiveCutoff = Math.max(
    0,
    lastUploadedAt,
    selectionCutoff,
    defaultWindowCutoff,
  )
  const normalizedMinTimestamp = Number.isFinite(minTimestamp)
    ? minTimestamp
    : 0
  const normalizedMaxTimestamp = Number.isFinite(maxTimestamp)
    ? maxTimestamp
    : Number.POSITIVE_INFINITY
  const mergedMap = new Map()

  for (const item of [...chatImages, ...storeImages]) {
    if (!item?.messageId) continue
    if (uploadedIdSet.has(item.messageId)) continue
    if (effectiveCutoff > 0 && item.timestamp <= effectiveCutoff) continue
    if (item.timestamp < normalizedMinTimestamp) continue
    if (item.timestamp > normalizedMaxTimestamp) continue
    mergedMap.set(item.messageId, item)
  }

  return Array.from(mergedMap.values())
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-MAX_RECENT_IMAGES)
}

function removeImagesFromStoreByMessageIds(messageIds) {
  if (!Array.isArray(messageIds) || messageIds.length === 0) return

  const idSet = new Set(messageIds.filter(Boolean))
  if (!idSet.size) return

  for (const [key, list] of imageStore.entries()) {
    const next = list.filter((item) => !idSet.has(item.messageId))
    if (next.length === 0) {
      imageStore.delete(key)
    } else if (next.length !== list.length) {
      imageStore.set(key, next)
    }
  }
}

function clearRecentImagesForSender(groupId, senderId) {
  const key = getSenderStoreKey(groupId, senderId)
  const current = imageStore.get(key) || []
  imageStore.delete(key)
  return current.length
}

function clearUploadedImagesForSender(groupId, senderId) {
  const key = getSenderStoreKey(groupId, senderId)
  const current = uploadedImageStore.get(key) || []
  uploadedImageStore.delete(key)
  return current.length
}

function clearLastUploadedAtForSender(groupId, senderId) {
  const key = getSenderStoreKey(groupId, senderId)
  lastUploadedAtStore.delete(key)
}

function clearSelectionCutoffForSender(groupId, senderId) {
  const key = getSenderStoreKey(groupId, senderId)
  selectionCutoffStore.delete(key)
}

function isImageMedia(media) {
  return media?.mimetype?.startsWith("image/") || false
}

async function downloadImageFromMessage(message) {
  if (!message?.hasMedia) return null

  const media = await message.downloadMedia()
  if (!isImageMedia(media)) return null

  return media
}

async function downloadQuotedImageFromCommand(message) {
  if (!message?.hasQuotedMsg) return null

  const result = await message.client.pupPage.evaluate(async (messageId) => {
    const msg =
      window.Store.Msg.get(messageId) ||
      (await window.Store.Msg.getMessagesById([messageId]))?.messages?.[0]

    if (!msg) return { status: "command_not_found" }

    const quoted = window.Store.QuotedMsg.getQuotedMsgObj(msg)
    if (!quoted) return { status: "quoted_not_found" }
    if (quoted.type !== "image") {
      return { status: "not_image", type: quoted.type }
    }
    if (!quoted.mediaData) {
      return { status: "media_data_missing", type: quoted.type }
    }
    if (quoted.mediaData.mediaStage === "REUPLOADING") {
      return { status: "media_reuploading", type: quoted.type }
    }

    if (quoted.mediaData.mediaStage !== "RESOLVED") {
      await quoted.downloadMedia({
        downloadEvenIfExpensive: true,
        rmrReason: 1,
      })
    }

    if (
      quoted.mediaData.mediaStage?.includes("ERROR") ||
      quoted.mediaData.mediaStage === "FETCHING"
    ) {
      return {
        status: "download_unavailable",
        type: quoted.type,
        mediaStage: quoted.mediaData.mediaStage,
      }
    }

    try {
      const mockQpl = {
        addAnnotations() {
          return this
        },
        addPoint() {
          return this
        },
      }

      const decryptedMedia =
        await window.Store.DownloadManager.downloadAndMaybeDecrypt({
          directPath: quoted.directPath,
          encFilehash: quoted.encFilehash,
          filehash: quoted.filehash,
          mediaKey: quoted.mediaKey,
          mediaKeyTimestamp: quoted.mediaKeyTimestamp,
          type: quoted.type,
          signal: new AbortController().signal,
          downloadQpl: mockQpl,
        })

      const data = await window.WWebJS.arrayBufferToBase64Async(decryptedMedia)

      return {
        status: "ok",
        data,
        mimetype: quoted.mimetype,
        filename: quoted.filename,
        filesize: quoted.size,
        type: quoted.type,
      }
    } catch (error) {
      if (error?.status === 404) {
        return { status: "not_found", type: quoted.type }
      }

      return {
        status: "download_error",
        type: quoted.type,
        message: error?.message || String(error),
      }
    }
  }, message.id._serialized)

  console.log("QUOTED MEDIA RESOLVE:", result)

  if (result?.status !== "ok" || !result.data) return null

  const media = new MessageMedia(
    result.mimetype || "image/jpeg",
    result.data,
    result.filename,
    result.filesize,
  )

  return isImageMedia(media) ? media : null
}

async function getTargetImageMessages(message, senderId, commandTimestampMs) {
  if (message.hasQuotedMsg) {
    const quoted = await message.getQuotedMessage()
    const quotedTimestampMs = normalizeMessageTimestampMs(quoted)
    const quotedSenderId = getSenderId(quoted) || senderId

    const media =
      (await downloadImageFromMessage(quoted)) ||
      (await downloadQuotedImageFromCommand(message))

    if (media) {
      return [
        {
          source: "reply",
          message: quoted,
          media,
        },
      ]
    }

    // Reply can point to album/caption text; in that case collect nearby images from same sender.
    const albumCandidates = await getSelectableRecentImageItems(
      message,
      quotedSenderId,
      {
        commandTimestampMs,
        includeDefaultWindow: false,
        minTimestamp: quotedTimestampMs - QUOTED_BULK_WINDOW_MS,
        maxTimestamp: quotedTimestampMs + QUOTED_BULK_WINDOW_MS,
      },
    )

    if (albumCandidates.length > 0) {
      return albumCandidates.map((item) => ({
        source: "reply-bulk",
        message: item.message,
        media: null,
        timestamp: item.timestamp,
      }))
    }

    if (quoted?.type !== "image" && !quoted?.hasMedia) {
      throw new Error(
        "Pesan yang Anda reply bukan gambar, dan tidak ditemukan kumpulan gambar terkait.",
      )
    }

    throw new Error(
      "Gambar yang Anda reply terdeteksi, tapi medianya tidak bisa diunduh oleh WhatsApp Web. Coba buka gambar itu di WhatsApp terlebih dahulu, lalu reply /kirim lagi.",
    )
  }

  const images = await getSelectableRecentImageItems(message, senderId, {
    commandTimestampMs,
    includeDefaultWindow: true,
  })
  if (images.length > 0) {
    return images.map((item) => ({
      source: "recent",
      message: item.message,
      media: null,
    }))
  }

  const groupImages = await getSelectableRecentImageItems(message, senderId, {
    commandTimestampMs,
    includeDefaultWindow: true,
    includeAllSenders: true,
  })

  return groupImages.map((item) => ({
    source: "recent-group",
    message: item.message,
    media: null,
  }))
}

async function resolveUploadMedias(targetItems) {
  const medias = []
  const messageIds = []
  let maxTimestamp = 0

  for (const item of targetItems) {
    const media = item.media || (await downloadImageFromMessage(item.message))
    if (!media) continue
    medias.push(media)

    const messageId = item?.message?.id?._serialized
    if (messageId) messageIds.push(messageId)

    const ts = Number(
      item?.timestamp || normalizeMessageTimestampMs(item?.message),
    )
    if (Number.isFinite(ts) && ts > maxTimestamp) {
      maxTimestamp = ts
    }
  }

  return { medias, messageIds, maxTimestamp }
}

async function uploadPreparedMediasToFolder(medias, folder) {
  let success = 0
  const uploadedFiles = []

  const folderLabel = (() => {
    const parts = String(folder?.path || "")
      .split("/")
      .map((p) => p.trim())
      .filter(Boolean)

    // Expected: Root/Category/Leaf... -> use Category; fallback to last segment.
    if (parts.length >= 2) return parts[1]
    if (parts.length === 1) return parts[0]
    return ""
  })()

  for (const media of medias) {
    const uploaded = await uploadMediaToDrive(media, folder.id, {
      folderLabel,
    })
    uploadedFiles.push(uploaded.name || uploaded.id)
    success++
  }

  return { success, uploadedFiles }
}

async function chooseFolderWithGemini({ instruction, folders, imageCount }) {
  if (!geminiClient) {
    throw new Error("GEMINI_API_KEY belum di-set di .env")
  }

  if (!folders.length) {
    throw new Error("Daftar folder Drive kosong.")
  }

  const folderListPrompt = folders
    .map((folder, idx) => `${idx + 1}. ${folder.path} (id: ${folder.id})`)
    .join("\n")

  const prompt = [
    "Konteks: struktur folder ini adalah milik kantor BPS (Badan Pusat Statistik).",
    "User bisa menyebut nama folder lengkap atau singkatan/akronim (mis. PSS = Pembinaan Statistik Sektoral).",
    "Anda memilih folder Google Drive untuk bot WhatsApp.",
    "Tugas: pilih satu folder paling relevan berdasarkan instruksi user.",
    "Jika tidak yakin, tetap beri kandidat terbaik dan confidence rendah.",
    "Jawab hanya JSON valid tanpa markdown dengan format:",
    '{"selectedIndex": number|null, "confidence": number, "reason": string, "candidateIndexes": number[]}',
    `Jumlah gambar: ${imageCount}`,
    `Instruksi user: ${instruction || "(tidak ada instruksi tambahan)"}`,
    "Daftar folder:",
    folderListPrompt,
  ].join("\n")

  const response = await geminiClient.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
    },
  })

  const parsed = parseJsonSafe(response.text)
  if (!parsed) {
    throw new Error("Respons Gemini tidak valid JSON.")
  }

  const selectedIndex = Number(parsed.selectedIndex)
  const hasValidSelection =
    Number.isInteger(selectedIndex) &&
    selectedIndex >= 1 &&
    selectedIndex <= folders.length

  const confidence = Number(parsed.confidence)
  const normalizedConfidence = Number.isFinite(confidence) ? confidence : 0

  let candidateIndexes = normalizeCandidateIndexes(
    parsed.candidateIndexes,
    folders.length,
  )

  if (hasValidSelection && !candidateIndexes.includes(selectedIndex)) {
    candidateIndexes = [selectedIndex, ...candidateIndexes]
  }

  if (!candidateIndexes.length) {
    candidateIndexes = folders
      .slice(0, Math.min(5, folders.length))
      .map((_, idx) => idx + 1)
  }

  const candidateFolders = candidateIndexes.map((idx) => folders[idx - 1])
  const selectedFolder = hasValidSelection ? folders[selectedIndex - 1] : null
  const reason =
    typeof parsed.reason === "string" && parsed.reason.trim()
      ? parsed.reason.trim()
      : "Gemini tidak memberikan alasan."

  return {
    selectedFolder,
    confidence: normalizedConfidence,
    reason,
    candidateFolders,
    shouldConfirm:
      !selectedFolder || normalizedConfidence < GEMINI_MIN_CONFIDENCE,
  }
}

async function getQuotedDebugInfo(message) {
  if (!message.hasQuotedMsg) return ["Quoted: no"]

  const quoted = await message.getQuotedMessage()

  return [
    "Quoted: yes",
    `Quoted type: ${quoted?.type || "-"}`,
    `Quoted has media: ${quoted?.hasMedia || false}`,
  ]
}

async function handleIncomingMessage(message, source = "message") {
  try {
    const chat = await message.getChat()
    if (!chat.isGroup) return

    const senderId = getSenderId(message)
    const text = getMessageText(message)

    console.log("PESAN MASUK:", {
      source,
      fromMe: message.fromMe,
      from: message.from,
      sender: senderId,
      type: message.type,
      hasMedia: message.hasMedia,
      body: text,
    })

    if (message.hasMedia) {
      const media = await downloadImageFromMessage(message)

      console.log("MEDIA TERDETEKSI:", {
        type: message.type,
        mimetype: media?.mimetype,
      })

      if (media) {
        rememberImage(message)
        console.log("GAMBAR DISIMPAN")
      }
    }

    if (!text.startsWith("/")) return

    if (text === "/ping") {
      await message.reply("pong")
      return
    }

    // if (text === "/debug") {
    //   const quotedDebugInfo = await getQuotedDebugInfo(message)
    //   const pending = getPendingSelection(getSenderScopeKey(message))
    //
    //   await message.reply(
    //     [
    //       "Debug:",
    //       `Source: ${source}`,
    //       `From me: ${message.fromMe}`,
    //       `Group: ${message.from}`,
    //       `Sender: ${senderId}`,
    //       `Type: ${message.type}`,
    //       `Has media: ${message.hasMedia}`,
    //       `Text: ${text}`,
    //       `Pending pilih: ${pending ? "yes" : "no"}`,
    //       ...quotedDebugInfo,
    //     ].join("\n"),
    //   )
    //   return
    // }

    // if (text === "/cek-gambar") {
    //   const images = getRecentImages(message.from, senderId)
    //
    //   await message.reply(
    //     `Saya menemukan ${images.length} gambar terbaru dari Anda. Batas simpan: ${MAX_RECENT_IMAGES} gambar / 30 menit.`,
    //   )
    //
    //   return
    // }

    if (text === "/reset") {
      const deletedCount = clearRecentImagesForSender(message.from, senderId)
      const uploadedDeletedCount = clearUploadedImagesForSender(
        message.from,
        senderId,
      )
      clearLastUploadedAtForSender(message.from, senderId)
      clearSelectionCutoffForSender(message.from, senderId)
      setSelectionCutoff(message.from, senderId, Date.now(), {
        updateGroupScope: false,
      })
      await message.reply(
        `Antrian Anda berhasil di-reset. Dihapus: ${deletedCount} gambar antrian + ${uploadedDeletedCount} riwayat upload.`,
      )
      return
    }

    if (text === "/menu") {
      await message.reply(
        withBranding([
          MENU_HEADER,
          "",
          "Daftar command:",
          "- /menu - Menampilkan daftar command bot.",
          "- /ping - Cek respons bot (balas: pong).",
          "- /kirim [instruksi] - Upload gambar reply atau antrian terbaru Anda ke Drive.",
          "- /pilih <nomor> - Memilih folder saat bot meminta konfirmasi pilihan folder.",
          "- /reset - Menghapus antrian gambar Anda di grup ini.",
        ]),
      )
      return
    }

    const pilihNumber = parsePilihNumber(text)
    if (pilihNumber !== null) {
      const scopeKey = getSenderScopeKey(message)
      const pending = getPendingSelection(scopeKey)

      if (!pending) {
        await message.reply(
          "Tidak ada pilihan folder yang menunggu konfirmasi. Jalankan /kirim dulu.",
        )
        return
      }

      if (pilihNumber < 1 || pilihNumber > pending.candidateFolders.length) {
        await message.reply(
          `Nomor tidak valid. Pilih 1-${pending.candidateFolders.length}.`,
        )
        return
      }

      const selectedFolder = pending.candidateFolders[pilihNumber - 1]
      await message.reply(
        `Oke, lanjut upload ke folder: ${selectedFolder.path}`,
      )

      const { success, uploadedFiles } = await uploadPreparedMediasToFolder(
        pending.medias,
        selectedFolder,
      )

      if (success > 0) {
        removeImagesFromStoreByMessageIds(pending.messageIds || [])
        markImagesAsUploaded(message.from, senderId, pending.messageIds || [])
        setLastUploadedAt(message.from, senderId, pending.maxTimestamp || 0)
      }
      setSelectionCutoff(
        message.from,
        senderId,
        pending.maxTimestamp || Date.now(),
      )

      clearPendingSelection(scopeKey)

      await message.reply(
        withBranding(
          [
            `Berhasil upload ${success} gambar ke ${selectedFolder.path}.`,
            uploadedFiles.length ? `File: ${uploadedFiles.join(", ")}` : "",
          ].filter(Boolean),
        ),
      )
      return
    }

    if (isKirimCommand(text)) {
      const rootFolderId = process.env.DRIVE_ROOT_FOLDER_ID

      if (!rootFolderId) {
        await message.reply("DRIVE_ROOT_FOLDER_ID belum di-set di .env")
        return
      }

      const instruction = parseKirimInstruction(text)
      const commandTimestampMs = normalizeMessageTimestampMs(message)
      const targetItems = await getTargetImageMessages(
        message,
        senderId,
        commandTimestampMs,
      )
      const { medias, messageIds, maxTimestamp } =
        await resolveUploadMedias(targetItems)

      if (medias.length === 0) {
        await message.reply(
          "Saya tidak menemukan gambar terbaru dari Anda. Kirim gambar dulu, atau reply gambar dengan /kirim.",
        )
        return
      }

      const folders = await listDriveFoldersFromRoot(rootFolderId, {
        maxDepth: 3,
        maxFolders: 200,
      })

      if (!folders.length) {
        await message.reply("Folder Drive dari root tidak ditemukan.")
        return
      }

      const rankedCandidates = rankFolderCandidatesByInstruction(
        instruction,
        folders,
      )
      const directMatches = getDirectFolderMatches(instruction, folders)
      const topCandidates = rankedCandidates
        .slice(0, Math.min(5, rankedCandidates.length))
        .map((item) => item.folder)

      if (directMatches.length === 1) {
        const selectedFolder = directMatches[0]
        await message.reply(
          `Folder terpilih dari instruksi: ${selectedFolder.path}. Mulai upload ${medias.length} gambar...`,
        )

        const { success, uploadedFiles } = await uploadPreparedMediasToFolder(
          medias,
          selectedFolder,
        )

        if (success > 0) {
          removeImagesFromStoreByMessageIds(messageIds)
          markImagesAsUploaded(message.from, senderId, messageIds)
          setLastUploadedAt(message.from, senderId, maxTimestamp)
        }
        setSelectionCutoff(message.from, senderId, maxTimestamp || Date.now())

        await message.reply(
          withBranding(
            [
              `Berhasil upload ${success} gambar ke ${selectedFolder.path}.`,
              uploadedFiles.length ? `File: ${uploadedFiles.join(", ")}` : "",
            ].filter(Boolean),
          ),
        )
        return
      }

      if (directMatches.length > 1) {
        const scopeKey = getSenderScopeKey(message)
        const candidateFolders = directMatches.slice(0, 5)
        setPendingSelection(scopeKey, {
          medias,
          candidateFolders,
          messageIds,
          maxTimestamp,
        })

        await message.reply(buildSelectionPrompt(candidateFolders))
        return
      }

      // If user gives explicit target and we get a very strong unique match, use it directly.
      const hasStrongHeuristicMatch =
        rankedCandidates.length > 0 &&
        rankedCandidates[0].score >= 80 &&
        (rankedCandidates.length === 1 ||
          rankedCandidates[0].score - rankedCandidates[1].score >= 20)

      if (hasStrongHeuristicMatch) {
        const selectedFolder = rankedCandidates[0].folder
        await message.reply(
          `Folder terpilih dari instruksi: ${selectedFolder.path}. Mulai upload ${medias.length} gambar...`,
        )

        const { success, uploadedFiles } = await uploadPreparedMediasToFolder(
          medias,
          selectedFolder,
        )

        if (success > 0) {
          removeImagesFromStoreByMessageIds(messageIds)
          markImagesAsUploaded(message.from, senderId, messageIds)
          setLastUploadedAt(message.from, senderId, maxTimestamp)
        }
        setSelectionCutoff(message.from, senderId, maxTimestamp || Date.now())

        await message.reply(
          withBranding(
            [
              `Berhasil upload ${success} gambar ke ${selectedFolder.path}.`,
              uploadedFiles.length ? `File: ${uploadedFiles.join(", ")}` : "",
            ].filter(Boolean),
          ),
        )
        return
      }

      if (!geminiClient) {
        if (!topCandidates.length) {
          await message.reply(
            "Folder tujuan belum jelas dan GEMINI_API_KEY belum di-set. Coba /kirim ke <nama folder> yang lebih spesifik.",
          )
          return
        }

        const scopeKey = getSenderScopeKey(message)
        setPendingSelection(scopeKey, {
          medias,
          candidateFolders: topCandidates,
          messageIds,
          maxTimestamp,
        })

        await message.reply(buildSelectionPrompt(topCandidates))
        return
      }

      let aiChoice
      try {
        aiChoice = await chooseFolderWithGemini({
          instruction,
          folders,
          imageCount: medias.length,
        })
      } catch (geminiError) {
        const fallbackCandidates =
          topCandidates.length > 0
            ? topCandidates
            : folders.slice(0, Math.min(5, folders.length))

        const scopeKey = getSenderScopeKey(message)
        setPendingSelection(scopeKey, {
          medias,
          candidateFolders: fallbackCandidates,
          messageIds,
          maxTimestamp,
        })

        await message.reply(buildSelectionPrompt(fallbackCandidates))
        return
      }

      if (aiChoice.shouldConfirm) {
        const scopeKey = getSenderScopeKey(message)
        const candidateFolders =
          aiChoice.candidateFolders.length > 0
            ? aiChoice.candidateFolders
            : topCandidates

        setPendingSelection(scopeKey, {
          medias,
          candidateFolders,
          messageIds,
          maxTimestamp,
        })

        await message.reply(buildSelectionPrompt(candidateFolders))
        return
      }

      const selectedFolder = aiChoice.selectedFolder
      await message.reply(
        `Folder terpilih: ${selectedFolder.path} (confidence ${aiChoice.confidence.toFixed(2)}). Mulai upload ${medias.length} gambar...`,
      )

      const { success, uploadedFiles } = await uploadPreparedMediasToFolder(
        medias,
        selectedFolder,
      )

      if (success > 0) {
        removeImagesFromStoreByMessageIds(messageIds)
        markImagesAsUploaded(message.from, senderId, messageIds)
        setLastUploadedAt(message.from, senderId, maxTimestamp)
      }
      setSelectionCutoff(message.from, senderId, maxTimestamp || Date.now())

      await message.reply(
        withBranding(
          [
            `Berhasil upload ${success} gambar ke ${selectedFolder.path}.`,
            uploadedFiles.length ? `File: ${uploadedFiles.join(", ")}` : "",
          ].filter(Boolean),
        ),
      )
      return
    }
  } catch (error) {
    console.error("Error handler message:", error)

    try {
      await message.reply(`Terjadi error: ${error.message}`)
    } catch {}
  }
}

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: "arsipin-bot",
    dataPath: ".wwebjs_auth",
  }),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  },
})

client.on("qr", (qr) => {
  console.log("Scan QR berikut dengan WhatsApp bot:")
  qrcode.generate(qr, { small: true })
})

client.on("ready", () => {
  console.log("Bot berhasil terhubung ke WhatsApp.")
})

client.on("authenticated", () => {
  console.log("Session berhasil diautentikasi.")
})

client.on("auth_failure", (message) => {
  console.error("Auth gagal:", message)
})

client.on("disconnected", (reason) => {
  console.log("Bot terputus:", reason)
})

client.on("message", async (message) => {
  await handleIncomingMessage(message, "message")
})

client.initialize()
