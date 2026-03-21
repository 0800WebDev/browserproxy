const express = require("express")
const path = require("path")
const { WebSocketServer } = require("ws")
const puppeteer = require("puppeteer-core")

process.on("unhandledRejection", e => console.log("UNHANDLED:", e))
process.on("uncaughtException", e => console.log("CRASH:", e))

const app = express()
app.use(express.static(path.join(__dirname, "public")))

const server = app.listen(process.env.PORT || 3000, () => {
    console.log("Server running")
})

const wss = new WebSocketServer({ server })
const BROWSERLESS = `wss://chrome.browserless.io?token=${process.env.BROWSERLESS_TOKEN}`

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms))
}

async function connectBrowser() {
    for (let i = 0; i < 3; i++) {
        try {
            return await puppeteer.connect({ browserWSEndpoint: BROWSERLESS })
        } catch (e) {
            console.log("Connect fail, retrying...", e.message)
            await sleep(1000)
        }
    }
    throw new Error("Failed to connect to Browserless")
}

wss.on("connection", async (ws) => {
    let browser, page
    let lastOk = Date.now()
    let running = true

    let currentUrl = "https://google.com"
    let savedLocalStorage = {}
    let savedCookies = []

    async function saveStorage() {
        if (!page) return
        try {
            savedCookies = await page.cookies()
            savedLocalStorage = await page.evaluate(() => {
                function getAllStorage(win) {
                    let data = {}
                    try {
                        for (let i = 0; i < win.localStorage.length; i++) {
                            const k = win.localStorage.key(i)
                            data[k] = win.localStorage.getItem(k)
                        }
                        for (const f of win.frames) {
                            Object.assign(data, getAllStorage(f))
                        }
                    } catch {}
                    return data
                }
                return getAllStorage(window)
            })
            currentUrl = await page.evaluate(() => window.location.href)
        } catch (e) {
            console.log("Save storage error:", e.message)
        }
    }

    async function start(url) {
        const isNewUrl = !!url
        if (isNewUrl) currentUrl = url

        // Save storage only if restarting old page
        if (!isNewUrl) await saveStorage()

        try { if (browser) await browser.close() } catch {}

        browser = await connectBrowser()
        page = await browser.newPage()
        await page.setViewport({ width: 1280, height: 720 })
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36")

        // Handle new tabs by redirecting to same session
        page.on("popup", async popup => {
            try {
                const url = popup.url()
                await start(url)
            } catch {}
        })

        try {
            await page.goto(currentUrl, { waitUntil: "domcontentloaded", timeout: 0 })
            await page.evaluate(() => window.stop())

            // Restore storage only if this was NOT a user Go click
            if (!isNewUrl && savedLocalStorage && savedCookies.length) {
                await page.setCookie(...savedCookies)
                await page.evaluate((data) => {
                    for (const k in data) localStorage.setItem(k, data[k])
                }, savedLocalStorage)
                await page.reload({ waitUntil: "domcontentloaded", timeout: 0 })
                await page.evaluate(() => window.stop())
            }

        } catch (e) {
            console.log("Goto error:", e.message)
        }

        lastOk = Date.now()
    }

    try { await start() } catch (e) { console.log("Startup failed:", e.message) }

    async function stream() {
        while (running && ws.readyState === 1) {
            try {
                if (page) {
                    const img = await page.screenshot({ type: "jpeg", quality: 30 })
                    ws.send(img)
                    lastOk = Date.now()
                }
            } catch (e) { console.log("Stream error:", e.message) }

            if (Date.now() - lastOk > 10000 && page) {
                console.log("Frozen → reloading SAME page")
                try { await page.reload({ waitUntil: "domcontentloaded", timeout: 0 }); await page.evaluate(() => window.stop()); lastOk = Date.now() } catch (e) { console.log("Reload failed:", e.message) }
            }

            await sleep(300)
        }
    }

    stream()

    ws.on("message", async (msg) => {
        try {
            const data = JSON.parse(msg)
            if (!page) return

            if (data.type === "goto") {
                await start(data.url) // now Go button always navigates first try
            }

            if (data.type === "click") await page.mouse.click(data.x, data.y)
            if (data.type === "scroll") await page.mouse.wheel({ deltaY: data.deltaY })
            if (data.type === "keydown") await page.keyboard.down(data.key)
            if (data.type === "keyup") await page.keyboard.up(data.key)
            if (data.type === "type") await page.keyboard.type(data.text)

        } catch (e) { console.log("MSG ERR:", e.message) }
    })

    ws.on("close", async () => {
        running = false
        try { if (browser) await browser.close() } catch {}
        console.log("Client disconnected")
    })
})

setInterval(() => console.log("alive"), 30000)
