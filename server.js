const path = require("path")

app.use(express.static(path.join(__dirname, "public")))

const express = require("express")
const { WebSocketServer } = require("ws")
const puppeteer = require("puppeteer-core")
const { v4: uuidv4 } = require("uuid")

const app = express()
const server = app.listen(3000)

const wss = new WebSocketServer({ server })

const BROWSERLESS = "wss://chrome.browserless.io?token=2UBJVCkwHOHI1DPb78f07999a252781c38e90ebab407a045f"

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
        const img = await page.screenshot({ type: "jpeg", quality: 50 })
        ws.send(img)
        setTimeout(stream, 100)
    }

    stream()

    ws.on("message", async (msg) => {
        const data = JSON.parse(msg)

        if (data.type === "goto") {
            await page.goto(data.url)
        }

        if (data.type === "click") {
            await page.mouse.click(data.x, data.y)
        }

        if (data.type === "scroll") {
            await page.mouse.wheel({ deltaY: data.deltaY })
        }

        if (data.type === "type") {
            await page.keyboard.type(data.text)
        }

        if (data.type === "keydown") {
            await page.keyboard.down(data.key)
        }

        if (data.type === "keyup") {
            await page.keyboard.up(data.key)
        }
    })

    ws.on("close", async () => {
        if (sessions[sessionId]) {
            await sessions[sessionId].browser.close()
            delete sessions[sessionId]
        }
    })
})
