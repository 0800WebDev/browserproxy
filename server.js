const express = require("express")
const path = require("path")
const { WebSocketServer } = require("ws")
const puppeteer = require("puppeteer-core")
const { v4: uuidv4 } = require("uuid")

const app = express()

app.use(express.static(path.join(__dirname, "public")))

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"))
})

const PORT = process.env.PORT || 3000
const server = app.listen(PORT, () => console.log("Running on", PORT))

const wss = new WebSocketServer({ server })

const BROWSERLESS = `wss://chrome.browserless.io?token=${process.env.BROWSERLESS_TOKEN}`

const sessions = {}

async function createSession() {
    const browser = await puppeteer.connect({
        browserWSEndpoint: BROWSERLESS
    })

    const page = await browser.newPage()

    const id = uuidv4()
    sessions[id] = { browser, page }

    return id
}

wss.on("connection", async (ws) => {
    let sessionId = await createSession()
    let { page } = sessions[sessionId]

    await page.goto("https://example.com")

    async function stream() {
        if (ws.readyState !== 1) return
        try {
            const img = await page.screenshot({ type: "jpeg", quality: 50 })
            ws.send(img)
        } catch (e) {
            console.log("Stream error:", e.message)
        }
        setTimeout(stream, 200)
    }

    stream()

    ws.on("message", async (msg) => {
        const data = JSON.parse(msg)

        try {
            if (data.type === "goto") {
                await page.goto(data.url, { waitUntil: "networkidle2", timeout: 20000 })
            }

            if (data.type === "click") {
                await page.mouse.click(data.x, data.y)
            }

            if (data.type === "scroll") {
                await page.mouse.wheel({ deltaY: data.deltaY })
            }

            if (data.type === "keydown") {
                await page.keyboard.down(data.key)
            }

            if (data.type === "keyup") {
                await page.keyboard.up(data.key)
            }

        } catch (err) {
            console.log("Error, restarting session:", err.message)

            try {
                await sessions[sessionId].browser.close()
            } catch {}

            sessionId = await createSession()
            page = sessions[sessionId].page

            try {
                if (data.url) {
                    await page.goto(data.url)
                }
            } catch {}
        }
    })

    ws.on("close", async () => {
        if (sessions[sessionId]) {
            await sessions[sessionId].browser.close()
            delete sessions[sessionId]
        }
    })
})

// keep-alive for Render
setInterval(() => {
    console.log("alive")
}, 30000)
