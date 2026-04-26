import fs from "fs/promises"
import path from "path"
import { google } from "googleapis"
import { authenticate } from "@google-cloud/local-auth"
import { Readable } from "stream"

const DRIVE_SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
]
const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder"
const DRIVE_SHORTCUT_MIME = "application/vnd.google-apps.shortcut"
const folderNameCache = new Map()
const sequenceCache = new Map()

function formatDateYYYYMMDD(date) {
  const yyyy = String(date.getFullYear()).padStart(4, "0")
  const mm = String(date.getMonth() + 1).padStart(2, "0")
  const dd = String(date.getDate()).padStart(2, "0")
  return `${yyyy}${mm}${dd}`
}

function sanitizeFolderNameForFilename(name) {
  const cleaned = String(name || "")
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^\s+|\s+$/g, "")

  return cleaned || "FOLDER"
}

async function getCachedFolderName(drive, folderId) {
  if (folderNameCache.has(folderId)) return folderNameCache.get(folderId)

  const info = await getFolderInfo(drive, folderId)
  const safeName = sanitizeFolderNameForFilename(info?.name)
  folderNameCache.set(folderId, safeName)
  return safeName
}

function mapDriveError(error, context = {}) {
  const message = String(error?.message || "")
  const status = Number(error?.status || error?.code || 0)
  const details = error?.response?.data?.error?.message || ""
  const combined = `${message} ${details}`.trim()

  if (combined.includes("insufficientPermissions")) {
    return new Error(
      "Token OAuth belum punya izin baca folder Drive. Hapus token.json lalu jalankan /kirim lagi untuk login ulang.",
    )
  }

  if (status === 404 || /file not found/i.test(combined)) {
    if (context.rootFolderId) {
      return new Error(
        `Folder root Drive tidak ditemukan atau tidak bisa diakses: ${context.rootFolderId}. Cek DRIVE_ROOT_FOLDER_ID dan pastikan akun OAuth punya akses folder tersebut.`,
      )
    }

    if (context.targetFolderId) {
      return new Error(
        `Folder tujuan upload tidak ditemukan atau tidak bisa diakses: ${context.targetFolderId}.`,
      )
    }

    return new Error(
      "Folder/file Google Drive tidak ditemukan atau akun OAuth tidak punya akses.",
    )
  }

  return error
}

function getMimeExtension(mimetype = "") {
  const subtype = mimetype.split("/")[1] || "bin"
  const normalizedSubtype = subtype.split(";")[0].trim().toLowerCase()

  if (normalizedSubtype === "jpeg") return "jpg"
  if (normalizedSubtype === "quicktime") return "mov"
  if (!normalizedSubtype) return "bin"

  return normalizedSubtype
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function loadSavedCredentials(tokenPath) {
  const exists = await fileExists(tokenPath)
  if (!exists) return null

  const content = await fs.readFile(tokenPath, "utf8")
  const credentials = JSON.parse(content)
  if (credentials?.type === "authorized_user") {
    return google.auth.fromJSON(credentials)
  }

  // Backward compatibility: older token.json may only contain raw OAuth tokens.
  if (credentials?.refresh_token || credentials?.access_token) {
    return null
  }

  return google.auth.fromJSON(credentials)
}

async function loadClientSecrets(credentialsPath) {
  const content = await fs.readFile(credentialsPath, "utf8")
  const keys = JSON.parse(content)
  const config = keys.installed || keys.web

  if (!config?.client_id || !config?.client_secret) {
    throw new Error(
      "client_secrets.json tidak valid. Pastikan file OAuth Client berisi installed/web client_id dan client_secret.",
    )
  }

  return config
}

async function saveCredentials(authClient, tokenPath, credentialsPath) {
  const config = await loadClientSecrets(credentialsPath)
  const refreshToken = authClient.credentials.refresh_token

  if (!refreshToken) {
    throw new Error(
      "OAuth Google Drive tidak mengembalikan refresh_token. Hapus token lama lalu login ulang jika perlu.",
    )
  }

  const payload = {
    type: "authorized_user",
    client_id: config.client_id,
    client_secret: config.client_secret,
    refresh_token: refreshToken,
  }

  await fs.mkdir(path.dirname(tokenPath), { recursive: true })
  await fs.writeFile(tokenPath, JSON.stringify(payload, null, 2))
}

async function getDriveOAuthClient() {
  const credentialsPath = path.resolve(
    process.env.GD_CLIENT_SECRETS_FILE || "./client_secrets.json",
  )

  const tokenPath = path.resolve(process.env.GD_TOKEN_FILE || "./token.json")

  let authClient = await loadSavedCredentials(tokenPath)

  if (!authClient) {
    const tokenExists = await fileExists(tokenPath)

    if (tokenExists) {
      const rawToken = JSON.parse(await fs.readFile(tokenPath, "utf8"))
      const config = await loadClientSecrets(credentialsPath)

      if (rawToken?.refresh_token || rawToken?.access_token) {
        const oauth2Client = new google.auth.OAuth2(
          config.client_id,
          config.client_secret,
        )

        oauth2Client.setCredentials(rawToken)
        authClient = oauth2Client

        await saveCredentials(authClient, tokenPath, credentialsPath)
        console.log(
          "Token Google Drive dimigrasikan ke format authorized_user.",
        )
      }
    }
  }

  if (!authClient) {
    authClient = await authenticate({
      scopes: DRIVE_SCOPES,
      keyfilePath: credentialsPath,
    })

    await saveCredentials(authClient, tokenPath, credentialsPath)
    console.log("Token Google Drive tersimpan:", tokenPath)
  }

  authClient.on("tokens", async (tokens) => {
    if (!tokens.refresh_token) return

    try {
      await saveCredentials(authClient, tokenPath, credentialsPath)
    } catch (error) {
      console.error("Gagal menyimpan token Google Drive:", error)
    }
  })

  return authClient
}

export async function getDriveClient() {
  const auth = await getDriveOAuthClient()
  return google.drive({ version: "v3", auth })
}

async function getFolderInfo(drive, folderId) {
  const response = await drive.files.get({
    fileId: folderId,
    fields: "id,name,mimeType,shortcutDetails(targetId,targetMimeType)",
    supportsAllDrives: true,
  })

  return response.data
}

async function resolveFolderLike(drive, fileId) {
  const info = await getFolderInfo(drive, fileId)

  if (
    info?.mimeType === DRIVE_SHORTCUT_MIME &&
    info?.shortcutDetails?.targetId
  ) {
    const target = await getFolderInfo(drive, info.shortcutDetails.targetId)
    if (target?.mimeType !== DRIVE_FOLDER_MIME) {
      throw new Error(
        `Shortcut tidak mengarah ke folder: ${info.name || info.id}`,
      )
    }
    return {
      id: target.id,
      name: info.name || target.name,
      mimeType: DRIVE_FOLDER_MIME,
      isShortcut: true,
      shortcutId: info.id,
    }
  }

  return info
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function getNextSequenceNumber(drive, folderId, baseName) {
  const cacheKey = `${folderId}:${baseName}`
  const cached = sequenceCache.get(cacheKey)
  if (cached) {
    const next = cached + 1
    sequenceCache.set(cacheKey, next)
    return next
  }

  const prefix = `${baseName}_`
  const names = []
  let pageToken

  do {
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false and name contains '${prefix.replace(/'/g, "\\'")}'`,
      fields: "nextPageToken,files(name)",
      pageSize: 100,
      pageToken,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    })

    names.push(...(response.data.files || []).map((file) => file.name || ""))
    pageToken = response.data.nextPageToken
  } while (pageToken)

  const regex = new RegExp(`^${escapeRegExp(baseName)}_(\\d{4})\\.[^.]+$`, "i")
  let max = 0
  for (const name of names) {
    const match = name.match(regex)
    if (!match) continue
    const number = Number(match[1])
    if (Number.isInteger(number) && number > max) max = number
  }

  const next = max + 1
  sequenceCache.set(cacheKey, next)
  return next
}

async function listChildFolders(drive, parentId) {
  const folders = []
  let pageToken

  do {
    const response = await drive.files.list({
      q: `'${parentId}' in parents and trashed = false and (mimeType = '${DRIVE_FOLDER_MIME}' or mimeType = '${DRIVE_SHORTCUT_MIME}')`,
      fields:
        "nextPageToken,files(id,name,mimeType,shortcutDetails(targetId,targetMimeType))",
      pageSize: 100,
      pageToken,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    })

    for (const file of response.data.files || []) {
      if (file.mimeType === DRIVE_FOLDER_MIME) {
        folders.push(file)
        continue
      }

      if (
        file.mimeType === DRIVE_SHORTCUT_MIME &&
        file.shortcutDetails?.targetId
      ) {
        folders.push({
          id: file.shortcutDetails.targetId,
          name: file.name,
          mimeType: DRIVE_FOLDER_MIME,
          isShortcut: true,
          shortcutId: file.id,
        })
      }
    }
    pageToken = response.data.nextPageToken
  } while (pageToken)

  return folders
}

export async function listDriveFoldersFromRoot(
  rootFolderId,
  { maxDepth = 3, maxFolders = 200 } = {},
) {
  if (!rootFolderId) {
    throw new Error("Folder root Google Drive belum diisi.")
  }

  const drive = await getDriveClient()
  let rootInfo

  try {
    rootInfo = await resolveFolderLike(drive, rootFolderId)
  } catch (error) {
    throw mapDriveError(error, { rootFolderId })
  }

  if (rootInfo.mimeType !== DRIVE_FOLDER_MIME) {
    throw new Error("DRIVE_ROOT_FOLDER_ID bukan folder.")
  }

  const folders = [
    {
      id: rootInfo.id,
      name: rootInfo.name,
      path: rootInfo.name,
      depth: 0,
    },
  ]

  const queue = [{ id: rootInfo.id, path: rootInfo.name, depth: 0 }]
  const visited = new Set([rootInfo.id])

  while (queue.length > 0 && folders.length < maxFolders) {
    const current = queue.shift()
    if (!current) break
    if (current.depth >= maxDepth) continue

    let children = []
    try {
      children = await listChildFolders(drive, current.id)
    } catch (error) {
      throw mapDriveError(error, { rootFolderId })
    }

    for (const child of children) {
      if (visited.has(child.id)) continue
      visited.add(child.id)

      const childPath = `${current.path}/${child.name}`
      const node = {
        id: child.id,
        name: child.name,
        path: childPath,
        depth: current.depth + 1,
      }

      folders.push(node)
      if (folders.length >= maxFolders) break

      queue.push({
        id: child.id,
        path: childPath,
        depth: current.depth + 1,
      })
    }
  }

  return folders
}

export async function uploadMediaToDrive(media, folderId, options = {}) {
  if (!folderId) {
    throw new Error("Folder ID Google Drive belum diisi.")
  }

  if (!media?.data) {
    throw new Error("Media kosong atau tidak valid.")
  }

  const drive = await getDriveClient()
  let effectiveFolderId = folderId
  try {
    const resolved = await resolveFolderLike(drive, folderId)
    effectiveFolderId = resolved.id
  } catch (error) {
    throw mapDriveError(error, { targetFolderId: folderId })
  }

  const datePart = formatDateYYYYMMDD(new Date())
  let folderPart = "FOLDER"
  try {
    const hinted = sanitizeFolderNameForFilename(options.folderLabel)
    folderPart =
      options.folderLabel && hinted !== "FOLDER"
        ? hinted
        : await getCachedFolderName(drive, folderId)
  } catch (error) {
    throw mapDriveError(error, { targetFolderId: folderId })
  }

  const baseName = `${datePart}_${folderPart}`
  let sequence = 1
  try {
    sequence = await getNextSequenceNumber(drive, effectiveFolderId, baseName)
  } catch (error) {
    throw mapDriveError(error, { targetFolderId: folderId })
  }
  const extension = getMimeExtension(media.mimetype)
  const sequencePart = String(sequence).padStart(4, "0")
  const fileName = `${baseName}_${sequencePart}.${extension}`
  const buffer = Buffer.from(media.data, "base64")

  let response
  try {
    response = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [effectiveFolderId],
      },
      media: {
        mimeType: media.mimetype,
        body: Readable.from(buffer),
      },
      fields: "id,name,webViewLink",
      supportsAllDrives: true,
    })
  } catch (error) {
    throw mapDriveError(error, { targetFolderId: folderId })
  }

  return response.data
}
