import pkg from "whatsapp-web.js"
import qrcode from "qrcode-terminal"
import dotenv from "dotenv"
import { GoogleGenAI } from "@google/genai"
import { listDriveFoldersFromRoot, uploadMediaToDrive } from "./gdrive.js"

dotenv.config()

const { Client, LocalAuth, MessageMedia } = pkg

const imageStore = new Map()
const pendingSelectionStore = new Map()
const MAX_RECENT_IMAGES = 10
const RECENT_IMAGE_MAX_AGE_MS = 10 * 60 * 1000
const PENDING_SELECTION_TTL_MS = 10 * 60 * 1000
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash"
const GEMINI_MIN_CONFIDENCE = Number(
  process.env.GEMINI_MIN_CONFIDENCE || "0.75",
)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
const geminiClient = GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: GEMINI_API_KEY })
  : null

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
  return text.replace(/^\/(?:kirim|upload-test)\b/i, "").trim()
}

function isKirimCommand(text) {
  return /^\/(?:kirim|upload-test)\b/i.test(text)
}

function parsePilihNumber(text) {
  const match = text.match(/^\/pilih\s+(\d+)\s*$/i)
  if (!match) return null

  return Number(match[1])
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

function rankFolderCandidatesByInstruction(instruction, folders) {
  const hint = normalizeText(extractFolderHint(instruction))
  if (!hint) return []

  const hintTokens = hint.split(" ").filter(Boolean)

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

      return { folder, score }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)

  return scored
}

function buildSelectionPrompt(reason, candidateFolders) {
  return [
    reason,
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

      const decryptedMedia = await window.Store.DownloadManager.downloadAndMaybeDecrypt({
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

async function getTargetImageMessages(message, senderId) {
  if (message.hasQuotedMsg) {
    const quoted = await message.getQuotedMessage()

    if (quoted?.type !== "image" && !quoted?.hasMedia) {
      throw new Error("Pesan yang Anda reply bukan gambar.")
    }

    const media =
      (await downloadImageFromMessage(quoted)) ||
      (await downloadQuotedImageFromCommand(message))

    if (!media) {
      throw new Error(
        "Gambar yang Anda reply terdeteksi, tapi medianya tidak bisa diunduh oleh WhatsApp Web. Coba buka gambar itu di WhatsApp terlebih dahulu, lalu reply /kirim lagi.",
      )
    }

    return [
      {
        source: "reply",
        message: quoted,
        media,
      },
    ]
  }

  const images = getRecentImages(message.from, senderId)

  return images.map((item) => ({
    source: "recent",
    message: item.message,
    media: null,
  }))
}

async function resolveUploadMedias(targetItems) {
  const medias = []

  for (const item of targetItems) {
    const media = item.media || (await downloadImageFromMessage(item.message))
    if (!media) continue
    medias.push(media)
  }

  return medias
}

async function uploadPreparedMediasToFolder(medias, folder) {
  let success = 0
  const uploadedFiles = []

  for (const media of medias) {
    const uploaded = await uploadMediaToDrive(media, folder.id)
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

    if (text === "/debug") {
      const quotedDebugInfo = await getQuotedDebugInfo(message)
      const pending = getPendingSelection(getSenderScopeKey(message))

      await message.reply(
        [
          "Debug:",
          `Source: ${source}`,
          `From me: ${message.fromMe}`,
          `Group: ${message.from}`,
          `Sender: ${senderId}`,
          `Type: ${message.type}`,
          `Has media: ${message.hasMedia}`,
          `Text: ${text}`,
          `Pending pilih: ${pending ? "yes" : "no"}`,
          ...quotedDebugInfo,
        ].join("\n"),
      )
      return
    }

    if (text === "/cek-gambar") {
      const images = getRecentImages(message.from, senderId)

      await message.reply(
        `Saya menemukan ${images.length} gambar terbaru dari Anda. Batas simpan: ${MAX_RECENT_IMAGES} gambar / 10 menit.`,
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

      clearPendingSelection(scopeKey)

      await message.reply(
        [
          `Berhasil upload ${success} gambar ke ${selectedFolder.path}.`,
          uploadedFiles.length ? `File: ${uploadedFiles.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
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
      const targetItems = await getTargetImageMessages(message, senderId)
      const medias = await resolveUploadMedias(targetItems)

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
      const topCandidates = rankedCandidates
        .slice(0, Math.min(5, rankedCandidates.length))
        .map((item) => item.folder)

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

        await message.reply(
          [
            `Berhasil upload ${success} gambar ke ${selectedFolder.path}.`,
            uploadedFiles.length ? `File: ${uploadedFiles.join(", ")}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
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
        })

        await message.reply(
          buildSelectionPrompt(
            "Saya menemukan beberapa folder yang mirip dari instruksi Anda.",
            topCandidates,
          ),
        )
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
        })

        await message.reply(
          buildSelectionPrompt(
            `Gemini tidak bisa menentukan folder saat ini (${geminiError.message}). Silakan pilih manual:`,
            fallbackCandidates,
          ),
        )
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
        })

        await message.reply(
          buildSelectionPrompt(
            `Saya ragu memilih folder secara otomatis. Alasan AI: ${aiChoice.reason}`,
            candidateFolders,
          ),
        )
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

      await message.reply(
        [
          `Berhasil upload ${success} gambar ke ${selectedFolder.path}.`,
          uploadedFiles.length ? `File: ${uploadedFiles.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
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
