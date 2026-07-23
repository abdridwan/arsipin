import pkg from "whatsapp-web.js"
import qrcode from "qrcode-terminal"
import { handleIncomingMessage } from "./bot/handler.js"

const { Client, LocalAuth } = pkg
const RECONNECT_DELAY_MS = 5000
let isInitializing = false
let reconnectTimer = null

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: "arsipin-bot",
    dataPath: ".wwebjs_auth",
  }),
  webVersionCache: {
    type: "remote",
    remotePath: "https://raw.githubusercontent.com/wppconnect-team/wa-version/7f959f352158729c6e88dd77cf7d38447d7be713/html/2.2412.54.html",
  },
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
  scheduleReconnect("auth_failure")
})

client.on("disconnected", (reason) => {
  console.log("Bot terputus:", reason)
  scheduleReconnect(String(reason || "disconnected"))
})

client.on("message", async (message) => {
  try {
    await handleIncomingMessage(message, "message")
  } catch (error) {
    console.error("Gagal memproses pesan:", error)
  }
})

function scheduleReconnect(source) {
  if (reconnectTimer) return

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null
    console.log(`Mencoba koneksi ulang (${source})...`)
    await initializeClient()
  }, RECONNECT_DELAY_MS)
}

async function initializeClient() {
  if (isInitializing) return
  isInitializing = true
  try {
    await client.initialize()
  } catch (error) {
    const message = String(error?.message || error)
    console.error("Inisialisasi client gagal:", message)
    scheduleReconnect("initialize_error")
  } finally {
    isInitializing = false
  }
}

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason)
  scheduleReconnect("unhandled_rejection")
})

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error)
  scheduleReconnect("uncaught_exception")
})

initializeClient()
