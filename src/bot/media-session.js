import pkg from "whatsapp-web.js"
import {
  DEBUG_QUOTED_MEDIA,
  DEFAULT_SELECTION_WINDOW_MS,
  GROUP_SCOPE_SENDER,
  MEDIA_STORE_RETENTION_MS,
  MAX_RECENT_IMAGES,
  MAX_VIDEO_SIZE_BYTES,
  PENDING_SELECTION_TTL_MS,
  QUOTED_BULK_WINDOW_MS,
  RECENT_IMAGE_MAX_AGE_MS,
} from "./config.js"

const { MessageMedia } = pkg

const mediaStore = new Map()
const pendingSelectionStore = new Map()
const uploadedMediaStore = new Map()
const lastUploadedAtStore = new Map()
const selectionCutoffStore = new Map()
let lastStorePruneAt = 0
const STORE_PRUNE_INTERVAL_MS = 5 * 60 * 1000

export function getMessageText(message) {
  return message.body?.trim() || ""
}

export function getSenderId(message) {
  return message.author || message.from
}

export function getSenderScopeKey(message) {
  return `${message.from}:${getSenderId(message)}`
}

function getSenderStoreKey(groupId, senderId) {
  return `${groupId}:${senderId}`
}

function getGroupScopeKey(groupId) {
  return getSenderStoreKey(groupId, GROUP_SCOPE_SENDER)
}

function pruneNumberStoreByAge(store, nowMs, maxAgeMs) {
  if (!(store instanceof Map)) return
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return

  for (const [key, value] of store.entries()) {
    const timestampMs = Number(value || 0)
    if (!timestampMs || nowMs - timestampMs > maxAgeMs) {
      store.delete(key)
    }
  }
}

function pruneGlobalStores() {
  const nowMs = Date.now()
  if (nowMs - lastStorePruneAt < STORE_PRUNE_INTERVAL_MS) return
  lastStorePruneAt = nowMs

  for (const [key, list] of mediaStore.entries()) {
    const next = (list || [])
      .filter(
        (item) =>
          item?.timestamp &&
          nowMs - Number(item.timestamp || 0) <= MEDIA_STORE_RETENTION_MS,
      )
      .slice(-MAX_RECENT_IMAGES)

    if (!next.length) {
      mediaStore.delete(key)
    } else if (next.length !== list.length) {
      mediaStore.set(key, next)
    }
  }

  for (const [key, list] of uploadedMediaStore.entries()) {
    const next = (list || []).filter(
      (item) =>
        item?.timestamp &&
        nowMs - Number(item.timestamp || 0) <= RECENT_IMAGE_MAX_AGE_MS,
    )

    if (!next.length) {
      uploadedMediaStore.delete(key)
    } else if (next.length !== list.length) {
      uploadedMediaStore.set(key, next)
    }
  }

  pruneNumberStoreByAge(lastUploadedAtStore, nowMs, MEDIA_STORE_RETENTION_MS)
  pruneNumberStoreByAge(selectionCutoffStore, nowMs, MEDIA_STORE_RETENTION_MS)
}

function getLastUploadedAt(groupId, senderId) {
  pruneGlobalStores()
  const senderKey = getSenderStoreKey(groupId, senderId)
  const groupKey = getGroupScopeKey(groupId)
  return Math.max(
    Number(lastUploadedAtStore.get(senderKey) || 0),
    Number(lastUploadedAtStore.get(groupKey) || 0),
  )
}

export function setLastUploadedAt(groupId, senderId, timestampMs) {
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
  pruneGlobalStores()
  const senderKey = getSenderStoreKey(groupId, senderId)
  const groupKey = getGroupScopeKey(groupId)
  return Math.max(
    Number(selectionCutoffStore.get(senderKey) || 0),
    Number(selectionCutoffStore.get(groupKey) || 0),
  )
}

export function setSelectionCutoff(
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

function pruneUploadedMediaForKey(key) {
  const list = uploadedMediaStore.get(key) || []
  const next = list.filter(
    (item) => Date.now() - item.timestamp <= RECENT_IMAGE_MAX_AGE_MS,
  )
  if (next.length === 0) {
    uploadedMediaStore.delete(key)
    return []
  }
  uploadedMediaStore.set(key, next)
  return next
}

function getUploadedMediaIdSet(groupId, senderId) {
  const senderKey = getSenderStoreKey(groupId, senderId)
  const groupKey = getGroupScopeKey(groupId)
  const senderList = pruneUploadedMediaForKey(senderKey)
  const groupList = pruneUploadedMediaForKey(groupKey)
  return new Set(
    [...senderList, ...groupList].map((item) => item.messageId).filter(Boolean),
  )
}

export function markMediaAsUploaded(groupId, senderId, messageIds) {
  if (!Array.isArray(messageIds) || messageIds.length === 0) return

  const now = Date.now()
  const keys = [getSenderStoreKey(groupId, senderId), getGroupScopeKey(groupId)]

  for (const key of keys) {
    const current = pruneUploadedMediaForKey(key)
    const exists = new Set(current.map((item) => item.messageId))
    const next = [...current]

    for (const messageId of messageIds) {
      if (!messageId || exists.has(messageId)) continue
      next.push({ messageId, timestamp: now })
      exists.add(messageId)
    }

    if (next.length) {
      uploadedMediaStore.set(key, next)
    }
  }
}

export function setPendingSelection(scopeKey, payload) {
  pruneGlobalStores()
  pendingSelectionStore.set(scopeKey, {
    ...payload,
    createdAt: Date.now(),
  })
}

export function getPendingSelection(scopeKey) {
  pruneGlobalStores()
  const pending = pendingSelectionStore.get(scopeKey)
  if (!pending) return null

  if (Date.now() - pending.createdAt > PENDING_SELECTION_TTL_MS) {
    pendingSelectionStore.delete(scopeKey)
    return null
  }

  return pending
}

export function clearPendingSelection(scopeKey) {
  pendingSelectionStore.delete(scopeKey)
}

export function rememberIncomingMedia(message) {
  pruneGlobalStores()
  if (!isSupportedMessageType(message)) return

  const groupId = message.from
  const senderId = getSenderId(message)
  const key = `${groupId}:${senderId}`
  const list = mediaStore.get(key) || []

  list.push({
    messageId: message.id._serialized,
    groupId,
    senderId,
    timestamp: Date.now(),
    message,
  })

  mediaStore.set(key, list.slice(-MAX_RECENT_IMAGES))
}

function getRecentMedia(
  groupId,
  senderId,
  { maxAgeMs = RECENT_IMAGE_MAX_AGE_MS } = {},
) {
  const key = `${groupId}:${senderId}`
  const list = mediaStore.get(key) || []

  return list.filter((item) => isWithinMaxAge(item.timestamp, maxAgeMs))
}

function getRecentMediaForGroup(
  groupId,
  { maxAgeMs = RECENT_IMAGE_MAX_AGE_MS } = {},
) {
  const prefix = `${groupId}:`
  const all = []

  for (const [key, list] of mediaStore.entries()) {
    if (!key.startsWith(prefix)) continue
    for (const item of list) {
      if (isWithinMaxAge(item.timestamp, maxAgeMs)) {
        all.push(item)
      }
    }
  }

  return all
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function pickNearestAlbumCandidates(candidates, targetTimestampMs) {
  if (!Array.isArray(candidates) || candidates.length === 0) return []

  const nearest = candidates.reduce((best, item) => {
    const distance = Math.abs(Number(item.timestamp || 0) - targetTimestampMs)
    if (!best || distance < best.distance) {
      return { item, distance }
    }
    return best
  }, null)

  if (!nearest?.item) return []

  const aroundNearest = candidates.filter(
    (item) =>
      Math.abs(Number(item.timestamp || 0) - Number(nearest.item.timestamp || 0)) <=
      QUOTED_BULK_WINDOW_MS,
  )

  return aroundNearest.length > 0 ? aroundNearest : [nearest.item]
}

function isWithinMaxAge(timestampMs, maxAgeMs) {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return true
  return Date.now() - timestampMs <= maxAgeMs
}

export function normalizeMessageTimestampMs(message) {
  const value = Number(message?.timestamp || 0)
  if (!Number.isFinite(value) || value <= 0) return Date.now()

  return value > 10_000_000_000 ? value : value * 1000
}

export function isSupportedMessageType(message) {
  return message?.type === "image" || message?.type === "video"
}

async function getRecentMediaFromChat(
  message,
  senderId,
  { maxAgeMs = RECENT_IMAGE_MAX_AGE_MS, limit = 50 } = {},
) {
  try {
    const chat = await message.getChat()
    const messages = await chat.fetchMessages({ limit })

    return messages
      .filter((item) => {
        if (!item?.hasMedia || item?.fromMe) return false
        if (!isSupportedMessageType(item)) return false
        if (senderId && getSenderId(item) !== senderId) return false

        const ts = normalizeMessageTimestampMs(item)
        return isWithinMaxAge(ts, maxAgeMs)
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

async function getRecentMediaFromChatForGroup(
  message,
  { maxAgeMs = RECENT_IMAGE_MAX_AGE_MS, limit = 80 } = {},
) {
  try {
    const chat = await message.getChat()
    const messages = await chat.fetchMessages({ limit })

    return messages
      .filter((item) => {
        if (!item?.hasMedia || item?.fromMe) return false
        if (!isSupportedMessageType(item)) return false

        const ts = normalizeMessageTimestampMs(item)
        return isWithinMaxAge(ts, maxAgeMs)
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

async function getSelectableRecentMediaItems(
  message,
  senderId,
  {
    commandTimestampMs = Date.now(),
    includeDefaultWindow = true,
    minTimestamp = 0,
    maxTimestamp = Number.POSITIVE_INFINITY,
    includeAllSenders = false,
    maxAgeMs = RECENT_IMAGE_MAX_AGE_MS,
    fetchLimit,
    includeUploaded = false,
    ignoreHistoryCutoff = false,
  } = {},
) {
  await sleep(1200)

  const storeItems = includeAllSenders
    ? getRecentMediaForGroup(message.from, { maxAgeMs })
    : getRecentMedia(message.from, senderId, { maxAgeMs })
  const chatItems = includeAllSenders
    ? await getRecentMediaFromChatForGroup(message, {
        maxAgeMs,
        limit: Number(fetchLimit) || 80,
      })
    : await getRecentMediaFromChat(message, senderId, {
        maxAgeMs,
        limit: Number(fetchLimit) || 50,
      })
  const uploadedIdSet = getUploadedMediaIdSet(message.from, senderId)
  const lastUploadedAt = getLastUploadedAt(message.from, senderId)
  const selectionCutoff = getSelectionCutoff(message.from, senderId)
  const defaultWindowCutoff = includeDefaultWindow
    ? Number(commandTimestampMs || Date.now()) - DEFAULT_SELECTION_WINDOW_MS
    : 0
  const effectiveCutoff = ignoreHistoryCutoff
    ? Math.max(0, defaultWindowCutoff)
    : Math.max(0, lastUploadedAt, selectionCutoff, defaultWindowCutoff)
  const normalizedMinTimestamp = Number.isFinite(minTimestamp)
    ? minTimestamp
    : 0
  const normalizedMaxTimestamp = Number.isFinite(maxTimestamp)
    ? maxTimestamp
    : Number.POSITIVE_INFINITY
  const mergedMap = new Map()

  for (const item of [...chatItems, ...storeItems]) {
    if (!item?.messageId) continue
    const alreadyUploaded = uploadedIdSet.has(item.messageId)
    if (!includeUploaded && alreadyUploaded) continue
    if (effectiveCutoff > 0 && item.timestamp <= effectiveCutoff) continue
    if (item.timestamp < normalizedMinTimestamp) continue
    if (item.timestamp > normalizedMaxTimestamp) continue

    const existing = mergedMap.get(item.messageId)
    mergedMap.set(item.messageId, {
      ...item,
      alreadyUploaded:
        Boolean(existing?.alreadyUploaded) || Boolean(item?.alreadyUploaded) || alreadyUploaded,
    })
  }

  return Array.from(mergedMap.values())
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-MAX_RECENT_IMAGES)
}

export function removeMediaFromStoreByMessageIds(messageIds) {
  if (!Array.isArray(messageIds) || messageIds.length === 0) return

  const idSet = new Set(messageIds.filter(Boolean))
  if (!idSet.size) return

  for (const [key, list] of mediaStore.entries()) {
    const next = list.filter((item) => !idSet.has(item.messageId))
    if (next.length === 0) {
      mediaStore.delete(key)
    } else if (next.length !== list.length) {
      mediaStore.set(key, next)
    }
  }
}

export function clearRecentImagesForSender(groupId, senderId) {
  const key = getSenderStoreKey(groupId, senderId)
  const current = mediaStore.get(key) || []
  mediaStore.delete(key)
  return current.length
}

export function clearUploadedImagesForSender(groupId, senderId) {
  const key = getSenderStoreKey(groupId, senderId)
  const current = uploadedMediaStore.get(key) || []
  uploadedMediaStore.delete(key)
  return current.length
}

export function clearLastUploadedAtForSender(groupId, senderId) {
  const key = getSenderStoreKey(groupId, senderId)
  lastUploadedAtStore.delete(key)
}

export function clearSelectionCutoffForSender(groupId, senderId) {
  const key = getSenderStoreKey(groupId, senderId)
  selectionCutoffStore.delete(key)
}

function isImageMedia(media) {
  return media?.mimetype?.startsWith("image/") || false
}

function isVideoMedia(media) {
  return media?.mimetype?.startsWith("video/") || false
}

function isSupportedMedia(media) {
  return isImageMedia(media) || isVideoMedia(media)
}

function getMediaSizeBytes(media) {
  const raw = media?.filesize
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : 0
}

function getMessageSizeBytes(message) {
  const raw =
    message?._data?.size ??
    message?.size ??
    message?.rawData?.size ??
    message?.mediaData?.size
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : 0
}

function formatSizeMB(sizeBytes) {
  return (Number(sizeBytes || 0) / (1024 * 1024)).toFixed(1)
}

function createVideoTooLargeError(sizeBytes) {
  const error = new Error(
    `Video melebihi batas 100 MB (terdeteksi ${formatSizeMB(sizeBytes)} MB).`,
  )
  error.code = "VIDEO_TOO_LARGE"
  error.sizeBytes = Number(sizeBytes || 0)
  return error
}

function assertVideoSizeLimit(media) {
  if (!isVideoMedia(media)) return

  const sizeBytes = getMediaSizeBytes(media)
  if (sizeBytes > MAX_VIDEO_SIZE_BYTES) {
    throw createVideoTooLargeError(sizeBytes)
  }
}

async function downloadMediaFromMessage(message) {
  if (!message?.hasMedia) return null
  if (!isSupportedMessageType(message)) return null

  const declaredSize = getMessageSizeBytes(message)
  if (message.type === "video" && declaredSize > MAX_VIDEO_SIZE_BYTES) {
    throw createVideoTooLargeError(declaredSize)
  }

  const media = await message.downloadMedia()
  if (!isSupportedMedia(media)) return null
  assertVideoSizeLimit(media)

  return media
}

async function downloadQuotedMediaFromCommand(message) {
  if (!message?.hasQuotedMsg) return null

  const result = await message.client.pupPage.evaluate(async (messageId) => {
    const msg =
      window.Store.Msg.get(messageId) ||
      (await window.Store.Msg.getMessagesById([messageId]))?.messages?.[0]

    if (!msg) return { status: "command_not_found" }

    const quoted = window.Store.QuotedMsg.getQuotedMsgObj(msg)
    if (!quoted) return { status: "quoted_not_found" }
    if (quoted.type !== "image" && quoted.type !== "video") {
      return { status: "not_supported", type: quoted.type }
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

  if (
    DEBUG_QUOTED_MEDIA ||
    ["download_error", "download_unavailable", "not_found"].includes(
      String(result?.status || ""),
    )
  ) {
    console.log("QUOTED MEDIA RESOLVE:", result)
  }

  if (result?.status !== "ok" || !result.data) return null

  const media = new MessageMedia(
    result.mimetype || "application/octet-stream",
    result.data,
    result.filename,
    result.filesize,
  )

  if (!isSupportedMedia(media)) return null
  assertVideoSizeLimit(media)
  return media
}

export async function getTargetMediaMessages(
  message,
  senderId,
  commandTimestampMs,
) {
  const uploadedIdSet = getUploadedMediaIdSet(message.from, senderId)

  if (message.hasQuotedMsg) {
    const quoted = await message.getQuotedMessage()
    const quotedTimestampMs = normalizeMessageTimestampMs(quoted)
    const quotedSenderId = getSenderId(quoted)
    const shouldScanAllSenders =
      !quotedSenderId || quotedSenderId === message.from
    const quotedMessageId = quoted?.id?._serialized

    const media =
      (await downloadMediaFromMessage(quoted)) ||
      (await downloadQuotedMediaFromCommand(message))

    if (media) {
      return [
        {
          source: "reply",
          message: quoted,
          media,
          alreadyUploaded: Boolean(
            quotedMessageId && uploadedIdSet.has(quotedMessageId),
          ),
        },
      ]
    }

    let albumCandidates = await getSelectableRecentMediaItems(
      message,
      shouldScanAllSenders ? senderId : quotedSenderId,
      {
        commandTimestampMs,
        includeDefaultWindow: false,
        minTimestamp: quotedTimestampMs - QUOTED_BULK_WINDOW_MS,
        maxTimestamp: quotedTimestampMs + QUOTED_BULK_WINDOW_MS,
        includeAllSenders: shouldScanAllSenders,
        maxAgeMs: Number.POSITIVE_INFINITY,
        fetchLimit: 250,
        includeUploaded: true,
        ignoreHistoryCutoff: true,
      },
    )

    if (albumCandidates.length === 0 && !shouldScanAllSenders) {
      albumCandidates = await getSelectableRecentMediaItems(message, senderId, {
        commandTimestampMs,
        includeDefaultWindow: false,
        minTimestamp: quotedTimestampMs - QUOTED_BULK_WINDOW_MS,
        maxTimestamp: quotedTimestampMs + QUOTED_BULK_WINDOW_MS,
        includeAllSenders: true,
        maxAgeMs: Number.POSITIVE_INFINITY,
        fetchLimit: 250,
        includeUploaded: true,
        ignoreHistoryCutoff: true,
      })
    }

    if (albumCandidates.length === 0) {
      const quotedFallbackWindowMs = 30 * 60 * 1000
      albumCandidates = await getSelectableRecentMediaItems(
        message,
        shouldScanAllSenders ? senderId : quotedSenderId,
        {
          commandTimestampMs,
          includeDefaultWindow: false,
          minTimestamp: quotedTimestampMs - quotedFallbackWindowMs,
          maxTimestamp: quotedTimestampMs + quotedFallbackWindowMs,
          includeAllSenders: shouldScanAllSenders,
          maxAgeMs: Number.POSITIVE_INFINITY,
          includeUploaded: true,
          ignoreHistoryCutoff: true,
          fetchLimit: 250,
        },
      )
    }

    if (albumCandidates.length === 0 && !shouldScanAllSenders) {
      const quotedFallbackWindowMs = 30 * 60 * 1000
      albumCandidates = await getSelectableRecentMediaItems(message, senderId, {
        commandTimestampMs,
        includeDefaultWindow: false,
        minTimestamp: quotedTimestampMs - quotedFallbackWindowMs,
        maxTimestamp: quotedTimestampMs + quotedFallbackWindowMs,
        includeAllSenders: true,
        maxAgeMs: Number.POSITIVE_INFINITY,
        includeUploaded: true,
        ignoreHistoryCutoff: true,
        fetchLimit: 250,
      })
    }

    if (albumCandidates.length === 0) {
      const broadCandidates = await getSelectableRecentMediaItems(
        message,
        shouldScanAllSenders ? senderId : quotedSenderId,
        {
          commandTimestampMs,
          includeDefaultWindow: false,
          includeAllSenders: shouldScanAllSenders,
          maxAgeMs: Number.POSITIVE_INFINITY,
          includeUploaded: true,
          ignoreHistoryCutoff: true,
          fetchLimit: 300,
        },
      )

      albumCandidates = pickNearestAlbumCandidates(
        broadCandidates,
        quotedTimestampMs,
      )
    }

    if (albumCandidates.length === 0 && !shouldScanAllSenders) {
      const broadGroupCandidates = await getSelectableRecentMediaItems(
        message,
        senderId,
        {
          commandTimestampMs,
          includeDefaultWindow: false,
          includeAllSenders: true,
          maxAgeMs: Number.POSITIVE_INFINITY,
          includeUploaded: true,
          ignoreHistoryCutoff: true,
          fetchLimit: 300,
        },
      )

      albumCandidates = pickNearestAlbumCandidates(
        broadGroupCandidates,
        quotedTimestampMs,
      )
    }

    if (albumCandidates.length > 0) {
      return albumCandidates.map((item) => ({
        source: "reply-bulk",
        message: item.message,
        media: null,
        timestamp: item.timestamp,
      }))
    }

    if (!isSupportedMessageType(quoted) && !quoted?.hasMedia) {
      throw new Error(
        "Pesan yang Anda reply bukan media yang didukung (gambar/video), dan tidak ditemukan kumpulan media terkait.",
      )
    }

    throw new Error(
      "Media yang Anda reply terdeteksi, tapi filenya tidak bisa diunduh oleh WhatsApp Web. Coba buka media itu dulu, lalu reply /kirim lagi.",
    )
  }

  const senderItems = await getSelectableRecentMediaItems(message, senderId, {
    commandTimestampMs,
    includeDefaultWindow: true,
  })
  if (senderItems.length > 0) {
    return senderItems.map((item) => ({
      source: "recent",
      message: item.message,
      media: null,
    }))
  }

  const groupItems = await getSelectableRecentMediaItems(message, senderId, {
    commandTimestampMs,
    includeDefaultWindow: true,
    includeAllSenders: true,
  })

  return groupItems.map((item) => ({
    source: "recent-group",
    message: item.message,
    media: null,
  }))
}

export async function resolveUploadMedias(targetItems) {
  const medias = []
  const messageIds = []
  let maxTimestamp = 0
  let skippedTooLargeVideos = 0

  for (const item of targetItems) {
    let media = item.media
    try {
      media = media || (await downloadMediaFromMessage(item.message))
    } catch (error) {
      if (error?.code === "VIDEO_TOO_LARGE") {
        skippedTooLargeVideos += 1
        continue
      }
      throw error
    }

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

  return { medias, messageIds, maxTimestamp, skippedTooLargeVideos }
}
