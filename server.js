'use strict'

const express = require('express')
const fetch   = require('node-fetch')
const { Headers } = require('node-fetch')

const app  = express()
const PORT = process.env.PORT || 3000

const ASSET_URL = 'https://etherdream.github.io/jsproxy'
const JS_VER    = 10
const MAX_RETRY = 1

// ── ヘッダーから圧縮関連を除去するユーティリティ ──────────────────────────────
// node-fetch v2 はgzip/brを自動展開するが content-encoding ヘッダーは残す。
// そのヘッダーをそのままブラウザに返すと Safari が二重デコードしようとして
// "Rawデータをデコードできません" になる。全レスポンスで必ず呼ぶ。
const STRIP_RES_HEADERS = new Set([
  'content-encoding',
  'transfer-encoding',
  'content-security-policy',
  'content-security-policy-report-only',
  'clear-site-data',
])

function stripResHeaders(headers) {
  for (const key of STRIP_RES_HEADERS) headers.delete(key)
}

// node-fetch に圧縮を要求しない共通オプション
// compress:false → accept-encoding を送らない / 自動展開しない
const FETCH_BASE = { compress: false }

// ── helpers ────────────────────────────────────────────────────────────────

function newUrl(urlStr) {
  try { return new URL(urlStr) } catch { return null }
}

function sendText(res, body, status = 200, extra = {}) {
  res.status(status).set({
    '--ver': String(JS_VER),
    'access-control-allow-origin': '*',
    ...extra,
  }).send(body)
}

// ── preflight ─────────────────────────────────────────────────────────────

app.options('*', (_req, res) => {
  res.status(204).set({
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,TRACE,DELETE,HEAD,OPTIONS',
    'access-control-max-age': '1728000',
  }).end()
})

// ── 固定エンドポイント ─────────────────────────────────────────────────────

app.get('/works', (_req, res) => sendText(res, 'it works'))
app.get('/http',  (_req, res) => sendText(res, '请更新 cfworker 到最新版本!'))
app.get('/ws',    (_req, res) => sendText(res, 'not support', 400))

// ── YouTube リダイレクト補助 ───────────────────────────────────────────────

function isYtUrl(u) {
  return u.host.endsWith('.googlevideo.com') && u.pathname.startsWith('/videoplayback')
}

async function parseYtVideoRedir(urlObj, newLen, res) {
  if (newLen > 2000 || !isYtUrl(urlObj)) return null
  try {
    const u = new URL(await res.text())
    return isYtUrl(u) ? u : null
  } catch { return null }
}

// ── プロキシ本体 ──────────────────────────────────────────────────────────

async function proxy(urlObj, reqInit, acehOld, rawLen, retryTimes, expressRes) {
  const res       = await fetch(urlObj.href, { ...FETCH_BASE, ...reqInit })
  const resHdrOld = res.headers
  const resHdrNew = new Headers(resHdrOld)

  let expose = '*'

  for (const [k, v] of resHdrOld.entries()) {
    if (['access-control-allow-origin', 'access-control-expose-headers',
         'location', 'set-cookie'].includes(k)) {
      const x = '--' + k
      resHdrNew.set(x, v)
      if (acehOld) expose += ',' + x
      resHdrNew.delete(k)
    } else if (acehOld && !['cache-control','content-language','content-type',
                             'expires','last-modified','pragma'].includes(k)) {
      expose += ',' + k
    }
  }

  if (acehOld) {
    expose += ',--s'
    resHdrNew.set('--t', '1')
  }

  // content-length 検証
  if (rawLen) {
    const newLen = resHdrOld.get('content-length') || ''
    if (rawLen !== newLen) {
      if (retryTimes < MAX_RETRY) {
        const redir = await parseYtVideoRedir(urlObj, newLen, res)
        if (redir) return proxy(redir, reqInit, acehOld, rawLen, retryTimes + 1, expressRes)
      }
      stripResHeaders(resHdrNew)
      expressRes.status(400).set({
        '--error': `bad len: ${newLen}, except: ${rawLen}`,
        'access-control-expose-headers': '--error',
        '--ver': String(JS_VER),
      })
      res.body.pipe(expressRes)
      return
    }
    if (retryTimes > 1) resHdrNew.set('--retry', String(retryTimes))
  }

  let status = res.status

  resHdrNew.set('access-control-expose-headers', expose)
  resHdrNew.set('access-control-allow-origin', '*')
  resHdrNew.set('--s', String(status))
  resHdrNew.set('--ver', String(JS_VER))

  // ★ 圧縮・セキュリティ系ヘッダーを除去
  stripResHeaders(resHdrNew)

  // 3xx → ステータスを +10 してリダイレクトを透過
  if ([301,302,303,307,308].includes(status)) status += 10

  const outHeaders = {}
  for (const [k, v] of resHdrNew.entries()) outHeaders[k] = v

  expressRes.status(status).set(outHeaders)
  res.body.pipe(expressRes)
}

// ── /http/* リクエストハンドラ ─────────────────────────────────────────────

async function httpHandler(req, pathname, expressRes) {
  if (req.headers['x-jsproxy']) return expressRes.status(508).send('Loop Detected')

  let acehOld = false, rawLen = ''

  const reqHdrNew = new Headers(req.headers)
  reqHdrNew.set('x-jsproxy', '1')
  // ★ 圧縮を要求しない（compress:false と合わせて二重対策）
  reqHdrNew.delete('accept-encoding')

  const refer = reqHdrNew.get('referer') || ''
  const qIdx  = refer.indexOf('?')
  const query = qIdx >= 0 ? refer.slice(qIdx + 1) : ''

  if (!query) return sendText(expressRes, 'missing params', 403)

  const param = new URLSearchParams(query)
  for (const [k, v] of param.entries()) {
    if (k.startsWith('--')) {
      if (k === '--aceh') acehOld = true
      if (k === '--raw-info') rawLen = v.split('|')[1] || ''
    } else {
      v ? reqHdrNew.set(k, v) : reqHdrNew.delete(k)
    }
  }
  if (!param.has('referer')) reqHdrNew.delete('referer')

  const urlStr = pathname.replace(/^(https?):\/+/, '$1://')
  const urlObj = newUrl(urlStr)
  if (!urlObj) return sendText(expressRes, 'invalid proxy url: ' + urlStr, 403)

  const reqInit = {
    method:   req.method,
    headers:  reqHdrNew,
    redirect: 'manual',
  }
  if (['POST','PUT','PATCH'].includes(req.method)) reqInit.body = req

  try {
    await proxy(urlObj, reqInit, acehOld, rawLen, 0, expressRes)
  } catch (err) {
    sendText(expressRes, 'proxy error:\n' + err.stack, 502)
  }
}

app.all('/http/*', async (req, res) => {
  const pathname = req.path.slice('/http/'.length) +
    (req.url.includes('?') ? '?' + req.url.split('?').slice(1).join('?') : '')
  await httpHandler(req, pathname, res)
})

// ── 静的ファイルフォールバック ─────────────────────────────────────────────

app.get('*', async (req, res) => {
  try {
    const upstream = await fetch(ASSET_URL + req.path, FETCH_BASE)
    const headers  = {}
    for (const [k, v] of upstream.headers.entries()) {
      // ★ 圧縮ヘッダーは除去してから転送
      if (!STRIP_RES_HEADERS.has(k)) headers[k] = v
    }
    res.status(upstream.status).set(headers)
    upstream.body.pipe(res)
  } catch (err) {
    res.status(502).send('upstream error: ' + err.message)
  }
})

// ── 起動 ─────────────────────────────────────────────────────────────────

app.listen(PORT, () => console.log(`jsproxy running on port ${PORT}`))
