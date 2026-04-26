import pkg from "whatsapp-web.js"
import qrcode from "qrcode-terminal"
import { handleIncomingMessage } from "./bot/handler.js"

const { Client, LocalAuth } = pkg

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
