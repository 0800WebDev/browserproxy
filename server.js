const express = require("express")
const path = require("path")
const { WebSocketServer } = require("ws")
const puppeteer = require("puppeteer-core")

process.on("unhandledRejection", e => console.log("UNHANDLED:", e))
process.on("uncaughtException", e => console.log("CRASH:", e))

const app = express()
app.use(express.static(path.join(__dirname, "public")))

const server = app.listen(process.env.PORT || 3000)

const wss = new WebSocketServer({ server })

const BROWSERLESS = `wss://chrome.browserless.io?token=${process.env.BROWSERLESS_TOKEN}`

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms))
}

async function newBrowser() {
    return await puppeteer.connect({ browserWSEndpoint: BROWSERLESS })
}

wss.on("connection", async (ws) => {
    let browser, page

    async function start(url = "https://example.com") {
        try { if (browser) await browser.close() } catch {}

        browser = await newBrowser()
        page = await browser.newPage()

        await page.setViewport({ width: 1280, height: 720 })

        try {
            await page.goto(url, {
                waitUntil: "domcontentloaded",
                timeout: 0
            })

            await page.evaluate(() => window.stop())
        } catch {}
    }

    try {
        await start()
    } catch (e) {
        console.log("START FAIL:", e.message)
    }

    async function stream() {
        while (ws.readyState === 1) {
            try {
                if (page) {
                    const img = await page.screenshot({
                        type: "jpeg",
                        quality: 30
                    })
                    ws.send(img)
                }
            } catch {}

            await sleep(300)
        }
    }

    stream()

    ws.on("message", async (msg) => {
        try {
            const data = JSON.parse(msg)

            if (data.type === "goto") {
                await start(data.url)
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

            if (data.type === "type") {
                await page.keyboard.type(data.text)
            }

        } catch (e) {
            console.log("MSG ERR:", e.message)
        }
    })

    ws.on("close", async () => {
        try { if (browser) await browser.close() } catch {}
    })
})

setInterval(() => console.log("alive"), 30000)
