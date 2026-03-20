const express = require("express")
const path = require("path")
const { WebSocketServer } = require("ws")
const puppeteer = require("puppeteer-core")
const { v4: uuidv4 } = require("uuid")

process.on("unhandledRejection", (reason) => {
  console.log("UNHANDLED REJECTION:", reason)
})

process.on("uncaughtException", (err) => {
  console.log("UNCAUGHT EXCEPTION:", err)
})

const app = express()
app.use(express.static(path.join(__dirname, "public")))

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"))
})

const PORT = process.env.PORT || 3000
const server = app.listen(PORT, () => {
  console.log("Running on port", PORT)
})

const wss = new WebSocketServer({ server })

const BROWSERLESS_WS =
  process.env.BROWSERLESS_WS ||
  (process.env.BROWSERLESS_TOKEN
    ? `wss://chrome.browserless.io?token=${process.env.BROWSERLESS_TOKEN}`
    : "")

if (!BROWSERLESS_WS) {
  console.log("Missing BROWSERLESS_WS or BROWSERLESS_TOKEN")
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function normalizeUrl(raw) {
  const text = String(raw || "").trim()
  if (!text) return null
  try {
    return new URL(text).toString()
  } catch {}
  try {
    return new URL(`https://${text}`).toString()
  } catch {
    return null
  }
}

async function connectBrowserless() {
  let lastErr = null

  for (let i = 0; i < 3; i++) {
    try {
      const browser = await puppeteer.connect({
        browserWSEndpoint: BROWSERLESS_WS,
        defaultViewport: { width: 1280, height: 720 }
      })
      return browser
    } catch (err) {
      lastErr = err
      console.log(`Browserless connect attempt ${i + 1} failed:`, err.message)
      await sleep(1000 * (i + 1))
    }
  }

  throw lastErr
}

wss.on("connection", async (ws) => {
  console.log("Client connected")
  ws.send(JSON.stringify({ type: "status", text: "connecting browser..." }))

  let browser = null
  let page = null
  let alive = true

  async function createSession(startUrl = "https://example.com") {
    browser = await connectBrowserless()
    page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 720 })
    await page.setCacheEnabled(false)
    await page.goto(startUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    })
  }

  async function restartSession(url) {
    try {
      if (browser) await browser.close()
    } catch {}
    browser = null
    page = null
    await createSession(url)
  }

  try {
    await createSession()
    ws.send(JSON.stringify({ type: "status", text: "ready" }))
  } catch (err) {
    console.log("Startup failed:", err.message)
    ws.send(JSON.stringify({ type: "status", text: `startup failed: ${err.message}` }))
  }

  ;(async function streamLoop() {
    while (alive && ws.readyState === WebSocketServer.OPEN ? false : true) {}
  })()

  const stream = async () => {
    while (alive && ws.readyState === 1) {
      try {
        if (page) {
          const img = await page.screenshot({
            type: "jpeg",
            quality: 35,
            fullPage: false,
            captureBeyondViewport: false
          })
          if (ws.readyState === 1) ws.send(img)
        }
      } catch (err) {
        console.log("Stream error:", err.message)
        try {
          ws.send(JSON.stringify({ type: "status", text: `stream error: ${err.message}` }))
        } catch {}
      }

      await sleep(400)
    }
  }

  stream().catch((err) => {
    console.log("Stream loop crashed:", err.message)
  })

  ws.on("message", async (buf) => {
    let data
    try {
      data = JSON.parse(buf.toString())
    } catch {
      return
    }

    try {
      if (!page) return

      if (data.type === "goto") {
        const url = normalizeUrl(data.url)
        if (!url) {
          ws.send(JSON.stringify({ type: "status", text: "bad url" }))
          return
        }

        ws.send(JSON.stringify({ type: "status", text: `loading ${url}` }))

        try {
          await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: 60000
          })
        } catch (err) {
          console.log("Goto failed:", err.message)
          ws.send(JSON.stringify({ type: "status", text: `load failed: ${err.message}` }))
          try {
            await restartSession(url)
            ws.send(JSON.stringify({ type: "status", text: "session restarted" }))
          } catch (restartErr) {
            console.log("Restart failed:", restartErr.message)
            ws.send(JSON.stringify({ type: "status", text: `restart failed: ${restartErr.message}` }))
          }
        }
      }

      if (data.type === "click") {
        await page.mouse.click(Number(data.x), Number(data.y))
      }

      if (data.type === "scroll") {
        await page.mouse.wheel({ deltaY: Number(data.deltaY || 0) })
      }

      if (data.type === "keydown" && data.key) {
        await page.keyboard.down(data.key)
      }

      if (data.type === "keyup" && data.key) {
        await page.keyboard.up(data.key)
      }

      if (data.type === "text" && typeof data.text === "string" && data.text) {
        await page.keyboard.type(data.text)
      }

      if (data.type === "reload") {
        await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 })
      }

      if (data.type === "back") {
        await page.goBack({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {})
      }
    } catch (err) {
      console.log("Message handler error:", err.message)
      ws.send(JSON.stringify({ type: "status", text: `action failed: ${err.message}` }))
    }
  })

  ws.on("close", async () => {
    alive = false
    console.log("Client disconnected")
    try {
      if (browser) await browser.close()
    } catch {}
  })
})

setInterval(() => {
  console.log("Alive ping")
}, 30000)
