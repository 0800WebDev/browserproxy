const express = require("express")
const path = require("path")
const { WebSocketServer } = require("ws")
const puppeteer = require("puppeteer-core")
const { v4: uuidv4 } = require("uuid")

// ----------------------
// Global error handlers
// ----------------------
process.on("unhandledRejection", (reason) => console.log("UNHANDLED REJECTION:", reason))
process.on("uncaughtException", (err) => console.log("UNCAUGHT EXCEPTION:", err))

// ----------------------
// Express setup
// ----------------------
const app = express()
app.use(express.static(path.join(__dirname, "public")))

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public/index.html"))
})

const PORT = process.env.PORT || 3000
const server = app.listen(PORT, () => console.log("Running on port", PORT))

// ----------------------
// WebSocket + Browserless
// ----------------------
const wss = new WebSocketServer({ server })
const BROWSERLESS = `wss://chrome.browserless.io?token=${process.env.BROWSERLESS_TOKEN}`

// Store active sessions per WebSocket
const sessions = {}

async function createSession() {
    try {
        const browser = await puppeteer.connect({ browserWSEndpoint: BROWSERLESS })
        const page = await browser.newPage()
        const id = uuidv4()
        sessions[id] = { browser, page }
        return id
    } catch (err) {
        console.log("Failed to create session:", err.message)
        throw err
    }
}

// Handle WebSocket connections
wss.on("connection", async (ws) => {
    console.log("Client connected")

    let sessionId, page, browser

    // Try to create a session
    try {
        sessionId = await createSession()
        ({ page, browser } = sessions[sessionId])
        await page.goto("https://google.com").catch(err => console.log("Initial goto failed:", err.message))
    } catch (err) {
        console.log("Could not create initial session:", err.message)
    }

    // Screenshot streaming
    async function stream() {
        if (ws.readyState !== 1) return
        try {
            const img = await page.screenshot({ type: "jpeg", quality: 40 })
            ws.send(img)
        } catch (err) {
            console.log("Stream error:", err.message)
        }
        setTimeout(stream, 250) // throttled
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
                    // Close old session safely
                    try { await browser.close() } catch {}
                    delete sessions[sessionId]

                    // Start new session
                    sessionId = await createSession()
                    ({ page, browser } = sessions[sessionId])
                    await page.goto(data.url).catch(err => console.log("Retry goto failed:", err.message))
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

// Keep-alive for Render free tier (prevents cold sleep)
setInterval(() => console.log("Alive ping"), 30000)
