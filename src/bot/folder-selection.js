import {
  geminiClient,
  GEMINI_MIN_CONFIDENCE,
  GEMINI_MODEL,
} from "./config.js"

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

function getPathSegments(path = "") {
  return String(path || "")
    .split("/")
    .map((item) => item.trim())
    .filter(Boolean)
}

function isDirectChildPath(parentPath, childPath) {
  const parentSegments = getPathSegments(parentPath)
  const childSegments = getPathSegments(childPath)

  if (childSegments.length !== parentSegments.length + 1) return false
  for (let index = 0; index < parentSegments.length; index++) {
    if (parentSegments[index] !== childSegments[index]) return false
  }

  return true
}

export function expandCandidateFoldersWithChildren(
  candidates,
  allFolders,
  { maxCandidates = 5 } = {},
) {
  if (!Array.isArray(candidates) || !Array.isArray(allFolders)) return []

  const max = Number(maxCandidates) > 0 ? Number(maxCandidates) : 5
  const byId = new Map()
  for (const folder of allFolders) {
    if (folder?.id) byId.set(folder.id, folder)
  }

  const uniqueCandidates = []
  const candidateSeen = new Set()
  for (const folder of candidates) {
    const normalized = folder?.id ? byId.get(folder.id) || folder : folder
    if (!normalized?.id || candidateSeen.has(normalized.id)) continue
    candidateSeen.add(normalized.id)
    uniqueCandidates.push(normalized)
  }

  const result = []
  const resultSeen = new Set()
  for (const candidate of uniqueCandidates) {
    if (result.length >= max) break

    if (candidate?.id && !resultSeen.has(candidate.id)) {
      result.push(candidate)
      resultSeen.add(candidate.id)
    }

    if (result.length >= max) break

    const directChildren = allFolders
      .filter(
        (folder) =>
          folder?.id &&
          folder.id !== candidate.id &&
          isDirectChildPath(candidate.path, folder.path),
      )
      .sort((left, right) => String(left.path).localeCompare(String(right.path)))

    for (const child of directChildren) {
      if (result.length >= max) break
      if (resultSeen.has(child.id)) continue
      result.push(child)
      resultSeen.add(child.id)
    }
  }

  return result
}

export function rankFolderCandidatesByInstruction(instruction, folders) {
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

export function getDirectFolderMatches(instruction, folders) {
  const hint = normalizeText(extractFolderHint(instruction))
  if (!hint) return []

  return folders.filter((folder) => {
    const path = normalizeText(folder.path)
    return path.includes(hint)
  })
}

export function buildSelectionPrompt(candidateFolders) {
  return [
    "Saya ragu harus memilih yang mana. Anda pilih salah satu dengan instruksi */pilih <nomor>* :",
    formatFolderOptions(candidateFolders),
  ].join("\n")
}

export async function chooseFolderWithGemini({
  instruction,
  folders,
  mediaCount,
}) {
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
    "Aturan Penting: Bersikaplah SANGAT KETAT (strict). Sinonim yang wajar diperbolehkan (misal: 'pertemuan' = 'rapat').",
    "Namun, JANGAN menebak secara acak jika instruksi (contoh: 'xxxxy') berupa kata acak, gibberish, atau sama sekali tidak ada hubungannya secara semantik dengan nama folder mana pun. Jika instruksi tidak relevan, set confidence = 0 dan selectedIndex = null.",
    "Jika tidak yakin, tetap beri kandidat terbaik di candidateIndexes dan set confidence rendah.",
    "Jawab hanya JSON valid tanpa markdown dengan format:",
    '{"selectedIndex": number|null, "confidence": number, "reason": string, "candidateIndexes": number[]}',
    `Jumlah media: ${mediaCount}`,
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
