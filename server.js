const express = require("express")
const path = require("path")
const { WebSocketServer } = require("ws")
const puppeteer = require("puppeteer-core")
const { v4: uuidv4 } = require("uuid")

// Global error handlers
process.on("unhandledRejection", (reason) => console.log("UNHANDLED REJECTION:", reason))
process.on("uncaughtException", (err) => console.log("UNCAUGHT EXCEPTION:", err))

// Express setup
const app = express()
app.use(express.static(path.join(__dirname, "public")))

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public/index.html"))
})

const PORT = process.env.PORT || 3000
const server = app.listen(PORT, () => console.log("Running on port", PORT))

// WebSocket + Browserless
const wss = new WebSocketServer({ server })
const BROWSERLESS = `wss://chrome.browserless.io?token=${process.env.BROWSERLESS_TOKEN}`

const sessions = {}

async function createSession() {
    const browser = await puppeteer.connect({ browserWSEndpoint: BROWSERLESS })
    const page = await browser.newPage()
    const id = uuidv4()
    sessions[id] = { browser, page }
    return id
}

wss.on("connection", async (ws) => {
    console.log("Client connected")

    let sessionId, page, browser

    // Try to create session
    try {
        sessionId = await createSession()
        ({ page, browser } = sessions[sessionId])
        await page.goto("https://example.com", { waitUntil: "networkidle2", timeout: 60000 })
        console.log("Initial page loaded")
    } catch (err) {
        console.log("Failed to create session or load page:", err.message)
    }

    // Screenshot streaming
    async function stream() {
        if (ws.readyState !== 1) return
        try {
            const img = await page.screenshot({ type: "jpeg", quality: 35 })
            ws.send(img)
        } catch (err) {
            console.log("Stream error:", err.message)
        }
        setTimeout(stream, 400)
    }

    stream()

    // Handle incoming messages
    ws.on("message", async (msg) => {
        try {
            const data = JSON.parse(msg)

            if (data.type === "goto") {
                console.log("Navigating to:", data.url)
                try {
                    await page.goto(data.url, { waitUntil: "networkidle2", timeout: 60000 })
                } catch (err) {
                    console.log("Goto failed, restarting session:", err.message)
                    try { await browser.close() } catch {}
                    delete sessions[sessionId]
                    sessionId = await createSession()
                    ({ page, browser } = sessions[sessionId])
                    await page.goto(data.url, { waitUntil: "networkidle2", timeout: 60000 })
                        .catch(err => console.log("Retry goto failed:", err.message))
                }
            }

            if (data.type === "click") await page.mouse.click(data.x, data.y)
            if (data.type === "scroll") await page.mouse.wheel({ deltaY: data.deltaY })
            if (data.type === "keydown") await page.keyboard.down(data.key)
            if (data.type === "keyup") await page.keyboard.up(data.key)

        } catch (err) {
            console.log("Message handler error:", err.message)
        }
    })

    ws.on("close", async () => {
        console.log("Client disconnected")
        try { if (browser) await browser.close() } catch {}
        if (sessions[sessionId]) delete sessions[sessionId]
    })
})

// Keep alive for Render free tier
setInterval(() => console.log("Alive ping"), 30000)
