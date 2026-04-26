import { listDriveFoldersFromRoot, uploadMediaToDrive } from "../gdrive.js"
import { MENU_HEADER, withBranding, geminiClient } from "./config.js"
import {
  buildSelectionPrompt,
  chooseFolderWithGemini,
  getDirectFolderMatches,
  rankFolderCandidatesByInstruction,
} from "./folder-selection.js"
import {
  clearLastUploadedAtForSender,
  clearPendingSelection,
  clearRecentImagesForSender,
  clearSelectionCutoffForSender,
  clearUploadedImagesForSender,
  getMessageText,
  getPendingSelection,
  getSenderId,
  getSenderScopeKey,
  getTargetMediaMessages,
  isSupportedMessageType,
  markMediaAsUploaded,
  normalizeMessageTimestampMs,
  rememberIncomingMedia,
  removeMediaFromStoreByMessageIds,
  resolveUploadMedias,
  setLastUploadedAt,
  setPendingSelection,
  setSelectionCutoff,
} from "./media-session.js"

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

async function uploadPreparedMediasToFolder(medias, folder) {
  let success = 0
  const uploadedFiles = []

  const folderLabel = (() => {
    const parts = String(folder?.path || "")
      .split("/")
      .map((p) => p.trim())
      .filter(Boolean)

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

export async function handleIncomingMessage(message, source = "message") {
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
      console.log("MEDIA TERDETEKSI:", { type: message.type })
      if (isSupportedMessageType(message)) {
        rememberIncomingMedia(message)
        console.log("MEDIA DISIMPAN")
      }
    }

    if (!text.startsWith("/")) return

    if (text === "/ping") {
      await message.reply("pong")
      return
    }

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
        `Antrian Anda berhasil di-reset. Dihapus: ${deletedCount} media antrian + ${uploadedDeletedCount} riwayat upload.`,
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
          "- /kirim [instruksi] - Upload media (gambar/video, video maks 100MB) dari reply atau antrian terbaru ke Drive.",
          "- /pilih <nomor> - Memilih folder saat bot meminta konfirmasi pilihan folder.",
          "- /reset - Menghapus antrian media Anda di grup ini.",
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
      await message.reply(`Oke, lanjut upload ke folder: ${selectedFolder.path}`)

      const { success, uploadedFiles } = await uploadPreparedMediasToFolder(
        pending.medias,
        selectedFolder,
      )

      if (success > 0) {
        removeMediaFromStoreByMessageIds(pending.messageIds || [])
        markMediaAsUploaded(message.from, senderId, pending.messageIds || [])
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
            `Berhasil upload ${success} media ke ${selectedFolder.path}.`,
            uploadedFiles.length ? `File: ${uploadedFiles.join(", ")}` : "",
          ].filter(Boolean),
        ),
      )
      return
    }

    if (!isKirimCommand(text)) return

    const rootFolderId = process.env.DRIVE_ROOT_FOLDER_ID
    if (!rootFolderId) {
      await message.reply("DRIVE_ROOT_FOLDER_ID belum di-set di .env")
      return
    }

    const instruction = parseKirimInstruction(text)
    const commandTimestampMs = normalizeMessageTimestampMs(message)
    const targetItems = await getTargetMediaMessages(
      message,
      senderId,
      commandTimestampMs,
    )
    const { medias, messageIds, maxTimestamp, skippedTooLargeVideos } =
      await resolveUploadMedias(targetItems)

    if (medias.length === 0) {
      if (skippedTooLargeVideos > 0) {
        await message.reply(
          `Semua video melebihi batas 100 MB. Video terlalu besar yang dilewati: ${skippedTooLargeVideos}.`,
        )
      } else {
        await message.reply(
          "Saya tidak menemukan media terbaru (gambar/video) dari Anda atau grup. Kirim media dulu, atau reply medianya dengan /kirim.",
        )
      }
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
        `Folder terpilih dari instruksi: ${selectedFolder.path}. Mulai upload ${medias.length} media...`,
      )

      const { success, uploadedFiles } = await uploadPreparedMediasToFolder(
        medias,
        selectedFolder,
      )

      if (success > 0) {
        removeMediaFromStoreByMessageIds(messageIds)
        markMediaAsUploaded(message.from, senderId, messageIds)
        setLastUploadedAt(message.from, senderId, maxTimestamp)
      }
      setSelectionCutoff(message.from, senderId, maxTimestamp || Date.now())

      await message.reply(
        withBranding(
          [
            `Berhasil upload ${success} media ke ${selectedFolder.path}.`,
            skippedTooLargeVideos > 0
              ? `Video >100MB dilewati: ${skippedTooLargeVideos}.`
              : "",
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

    const hasStrongHeuristicMatch =
      rankedCandidates.length > 0 &&
      rankedCandidates[0].score >= 80 &&
      (rankedCandidates.length === 1 ||
        rankedCandidates[0].score - rankedCandidates[1].score >= 20)

    if (hasStrongHeuristicMatch) {
      const selectedFolder = rankedCandidates[0].folder
      await message.reply(
        `Folder terpilih dari instruksi: ${selectedFolder.path}. Mulai upload ${medias.length} media...`,
      )

      const { success, uploadedFiles } = await uploadPreparedMediasToFolder(
        medias,
        selectedFolder,
      )

      if (success > 0) {
        removeMediaFromStoreByMessageIds(messageIds)
        markMediaAsUploaded(message.from, senderId, messageIds)
        setLastUploadedAt(message.from, senderId, maxTimestamp)
      }
      setSelectionCutoff(message.from, senderId, maxTimestamp || Date.now())

      await message.reply(
        withBranding(
          [
            `Berhasil upload ${success} media ke ${selectedFolder.path}.`,
            skippedTooLargeVideos > 0
              ? `Video >100MB dilewati: ${skippedTooLargeVideos}.`
              : "",
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
        mediaCount: medias.length,
      })
    } catch {
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
      `Folder terpilih: ${selectedFolder.path} (confidence ${aiChoice.confidence.toFixed(2)}). Mulai upload ${medias.length} media...`,
    )

    const { success, uploadedFiles } = await uploadPreparedMediasToFolder(
      medias,
      selectedFolder,
    )

    if (success > 0) {
      removeMediaFromStoreByMessageIds(messageIds)
      markMediaAsUploaded(message.from, senderId, messageIds)
      setLastUploadedAt(message.from, senderId, maxTimestamp)
    }
    setSelectionCutoff(message.from, senderId, maxTimestamp || Date.now())

    await message.reply(
      withBranding(
        [
          `Berhasil upload ${success} media ke ${selectedFolder.path}.`,
          skippedTooLargeVideos > 0
            ? `Video >100MB dilewati: ${skippedTooLargeVideos}.`
            : "",
          uploadedFiles.length ? `File: ${uploadedFiles.join(", ")}` : "",
        ].filter(Boolean),
      ),
    )
  } catch (error) {
    console.error("Error handler message:", error)
    try {
      await message.reply(`Terjadi error: ${error.message}`)
    } catch {}
  }
}
