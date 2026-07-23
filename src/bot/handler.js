import { listDriveFoldersFromRoot, uploadMediaToDrive } from "../gdrive.js"
import { MENU_HEADER, withBranding, geminiClient } from "./config.js"
import {
  buildSelectionPrompt,
  chooseFolderWithGemini,
  expandCandidateFoldersWithChildren,
  getDirectFolderMatches,
  rankFolderCandidatesByInstruction,
} from "./folder-selection.js"
import {
  clearLastUploadedAtForSender,
  clearPendingSelection,
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

function buildResendConfirmationPrompt(mediaCount) {
  return withBranding([
    `Terdeteksi ${mediaCount} media yang pernah di-upload sebelumnya.`,
    "Apakah ingin kirim ulang?",
    "Ketik */pilih 1* untuk Ya (kirim ulang).",
    "Ketik */pilih 2* untuk Tidak (batal).",
  ])
}

async function continueUploadFlow({
  message,
  senderId,
  instruction,
  medias,
  messageIds,
  maxTimestamp,
  skippedTooLargeVideos,
  skippedUnavailableMedia,
}) {
  const rootFolderId = process.env.DRIVE_ROOT_FOLDER_ID
  if (!rootFolderId) {
    await message.reply("DRIVE_ROOT_FOLDER_ID belum di-set di .env")
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

  const rankedCandidates = rankFolderCandidatesByInstruction(instruction, folders)
  const directMatches = getDirectFolderMatches(instruction, folders)
  const topCandidates = rankedCandidates
    .slice(0, Math.min(5, rankedCandidates.length))
    .map((item) => item.folder)
  const toSelectionCandidates = (candidates) =>
    expandCandidateFoldersWithChildren(candidates, folders, { maxCandidates: 5 })

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
          skippedUnavailableMedia > 0
            ? `Media gagal diunduh/dibuka saat proses: ${skippedUnavailableMedia}.`
            : "",
          uploadedFiles.length ? `File: ${uploadedFiles.join(", ")}` : "",
        ].filter(Boolean),
      ),
    )
    return
  }

  if (directMatches.length > 1) {
    const scopeKey = getSenderScopeKey(message)
    const candidateFolders = toSelectionCandidates(directMatches.slice(0, 5))
    setPendingSelection(scopeKey, {
      type: "folder-selection",
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
          skippedUnavailableMedia > 0
            ? `Media gagal diunduh/dibuka saat proses: ${skippedUnavailableMedia}.`
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
    const candidateFolders = toSelectionCandidates(topCandidates)
    setPendingSelection(scopeKey, {
      type: "folder-selection",
      medias,
      candidateFolders,
      messageIds,
      maxTimestamp,
    })

    await message.reply(buildSelectionPrompt(candidateFolders))
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
    const candidateFolders = toSelectionCandidates(fallbackCandidates)

    const scopeKey = getSenderScopeKey(message)
    setPendingSelection(scopeKey, {
      type: "folder-selection",
      medias,
      candidateFolders,
      messageIds,
      maxTimestamp,
    })

    await message.reply(buildSelectionPrompt(candidateFolders))
    return
  }

  if (aiChoice.shouldConfirm) {
    const scopeKey = getSenderScopeKey(message)
    const candidateFolders =
      aiChoice.candidateFolders.length > 0
        ? aiChoice.candidateFolders
        : topCandidates
    const expandedCandidates = toSelectionCandidates(candidateFolders)

    setPendingSelection(scopeKey, {
      type: "folder-selection",
      medias,
      candidateFolders: expandedCandidates,
      messageIds,
      maxTimestamp,
    })

    await message.reply(buildSelectionPrompt(expandedCandidates))
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
        skippedUnavailableMedia > 0
          ? `Media gagal diunduh/dibuka saat proses: ${skippedUnavailableMedia}.`
          : "",
        uploadedFiles.length ? `File: ${uploadedFiles.join(", ")}` : "",
      ].filter(Boolean),
    ),
  )
}

export async function handleIncomingMessage(message, source = "message") {
  try {
    const isGroup = message.from && message.from.endsWith('@g.us')
    if (!isGroup) return

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
        `Status upload Anda berhasil di-reset. Riwayat upload yang dihapus: ${uploadedDeletedCount}. Media di memori tetap disimpan agar bisa dipakai upload ulang.`,
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
          "- /reset - Reset riwayat upload Anda (media memori tetap disimpan).",
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

      if (pending.type === "resend-confirm") {
        if (pilihNumber < 1 || pilihNumber > 2) {
          await message.reply("Nomor tidak valid. Pilih 1 (ya) atau 2 (tidak).")
          return
        }

        clearPendingSelection(scopeKey)

        if (pilihNumber === 2) {
          await message.reply("Baik, kirim ulang dibatalkan.")
          return
        }

        await message.reply("Oke, lanjut kirim ulang media.")
        await continueUploadFlow({
          message,
          senderId,
          instruction: pending.instruction || "",
          medias: pending.medias || [],
          messageIds: pending.messageIds || [],
          maxTimestamp: pending.maxTimestamp || 0,
          skippedTooLargeVideos: pending.skippedTooLargeVideos || 0,
          skippedUnavailableMedia: pending.skippedUnavailableMedia || 0,
        })
        return
      }

      if (!Array.isArray(pending.candidateFolders) || !pending.candidateFolders.length) {
        clearPendingSelection(scopeKey)
        await message.reply(
          "Data pilihan tidak valid atau sudah kedaluwarsa. Jalankan /kirim lagi.",
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

    const instruction = parseKirimInstruction(text)
    const commandTimestampMs = normalizeMessageTimestampMs(message)
    const targetItems = await getTargetMediaMessages(
      message,
      senderId,
      commandTimestampMs,
    )
    const {
      medias,
      messageIds,
      maxTimestamp,
      skippedTooLargeVideos,
      skippedUnavailableMedia,
    } =
      await resolveUploadMedias(targetItems)

    if (medias.length === 0) {
      if (skippedTooLargeVideos > 0) {
        await message.reply(
          `Semua video melebihi batas 100 MB. Video terlalu besar yang dilewati: ${skippedTooLargeVideos}.`,
        )
      } else if (skippedUnavailableMedia > 0) {
        await message.reply(
          `Media terdeteksi, tetapi tidak bisa diunduh seluruhnya. Media gagal diunduh: ${skippedUnavailableMedia}. Coba /kirim ulang 3-5 detik lagi.`,
        )
      } else {
        await message.reply(
          "Saya tidak menemukan media terbaru (gambar/video) dari Anda atau grup. Kirim media dulu, atau reply medianya dengan /kirim.",
        )
      }
      return
    }

    const alreadyUploadedCount = targetItems.filter(
      (item) => item?.alreadyUploaded,
    ).length

    if (alreadyUploadedCount > 0) {
      const scopeKey = getSenderScopeKey(message)
      setPendingSelection(scopeKey, {
        type: "resend-confirm",
        instruction,
        medias,
        messageIds,
        maxTimestamp,
        skippedTooLargeVideos,
        skippedUnavailableMedia,
      })

      await message.reply(buildResendConfirmationPrompt(alreadyUploadedCount))
      return
    }

    await continueUploadFlow({
      message,
      senderId,
      instruction,
      medias,
      messageIds,
      maxTimestamp,
      skippedTooLargeVideos,
      skippedUnavailableMedia,
    })
  } catch (error) {
    console.error("Error handler message:", error)
    try {
      await message.reply(`Terjadi error: ${error.message}`)
    } catch {}
  }
}
