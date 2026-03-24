'use strict'

const express = require('express')
const fetch = require('node-fetch')
const { Headers, Response } = require('node-fetch')

const app = express()
const PORT = process.env.PORT || 3000

const ASSET_URL = 'https://etherdream.github.io/jsproxy'
const JS_VER = 10
const MAX_RETRY = 1

// ─── helpers ────────────────────────────────────────────────────────────────

function newUrl(urlStr) {
  try {
    return new URL(urlStr)
  } catch {
    return null
  }
}

function sendMakeRes(expressRes, body, status = 200, headers = {}) {
  headers['--ver'] = String(JS_VER)
  headers['access-control-allow-origin'] = '*'
  expressRes.status(status).set(headers).send(body)
}

// ─── preflight ───────────────────────────────────────────────────────────────

app.options('*', (req, res) => {
  res.status(204).set({
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,TRACE,DELETE,HEAD,OPTIONS',
    'access-control-max-age': '1728000',
  }).end()
})

// ─── /works ──────────────────────────────────────────────────────────────────

app.get('/works', (req, res) => {
  sendMakeRes(res, 'it works')
})

// ─── /http (legacy redirect hint) ────────────────────────────────────────────

app.get('/http', (req, res) => {
  sendMakeRes(res, '请更新 cfworker 到最新版本!')
})

// ─── /ws ─────────────────────────────────────────────────────────────────────

app.get('/ws', (req, res) => {
  sendMakeRes(res, 'not support', 400)
})

// ─── proxy core ──────────────────────────────────────────────────────────────

function isYtUrl(urlObj) {
  return (
    urlObj.host.endsWith('.googlevideo.com') &&
    urlObj.pathname.startsWith('/videoplayback')
  )
}

async function parseYtVideoRedir(urlObj, newLen, res) {
  if (newLen > 2000) return null
  if (!isYtUrl(urlObj)) return null
  try {
    const data = await res.text()
    urlObj = new URL(data)
  } catch {
    return null
  }
  if (!isYtUrl(urlObj)) return null
  return urlObj
}

async function proxy(urlObj, reqInit, acehOld, rawLen, retryTimes, expressRes) {
  const res = await fetch(urlObj.href, reqInit)
  const resHdrOld = res.headers
  const resHdrNew = new Headers(resHdrOld)

  let expose = '*'

  for (const [k, v] of resHdrOld.entries()) {
    if (
      k === 'access-control-allow-origin' ||
      k === 'access-control-expose-headers' ||
      k === 'location' ||
      k === 'set-cookie'
    ) {
      const x = '--' + k
      resHdrNew.set(x, v)
      if (acehOld) expose += ',' + x
      resHdrNew.delete(k)
    } else if (
      acehOld &&
      k !== 'cache-control' &&
      k !== 'content-language' &&
      k !== 'content-type' &&
      k !== 'expires' &&
      k !== 'last-modified' &&
      k !== 'pragma'
    ) {
      expose += ',' + k
    }
  }

  if (acehOld) {
    expose += ',--s'
    resHdrNew.set('--t', '1')
  }

  // content-length verification
  if (rawLen) {
    const newLen = resHdrOld.get('content-length') || ''
    if (rawLen !== newLen) {
      if (retryTimes < MAX_RETRY) {
        let redirectUrl = await parseYtVideoRedir(urlObj, newLen, res)
        if (redirectUrl) {
          return proxy(redirectUrl, reqInit, acehOld, rawLen, retryTimes + 1, expressRes)
        }
      }
      const errHeaders = {
        '--error': `bad len: ${newLen}, except: ${rawLen}`,
        'access-control-expose-headers': '--error',
        '--ver': String(JS_VER),
      }
      expressRes.status(400).set(errHeaders)
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
  resHdrNew.delete('content-security-policy')
  resHdrNew.delete('content-security-policy-report-only')
  resHdrNew.delete('clear-site-data')

  // shift redirect status codes like the original worker
  if ([301, 302, 303, 307, 308].includes(status)) status += 10

  const outHeaders = {}
  for (const [k, v] of resHdrNew.entries()) outHeaders[k] = v

  expressRes.status(status).set(outHeaders)
  res.body.pipe(expressRes)
}

async function httpHandler(req, pathname, expressRes) {
  const reqHdrRaw = req.headers

  // block self-referencing loops
  if (reqHdrRaw['x-jsproxy']) {
    return expressRes.status(508).send('Loop Detected')
  }

  let acehOld = false
  let rawSvr = ''
  let rawLen = ''
  let rawEtag = ''

  const reqHdrNew = new Headers(reqHdrRaw)
  reqHdrNew.set('x-jsproxy', '1')

  const refer = reqHdrNew.get('referer') || ''
  const qIdx = refer.indexOf('?')
  const query = qIdx >= 0 ? refer.substr(qIdx + 1) : ''

  if (!query) {
    return sendMakeRes(expressRes, 'missing params', 403)
  }

  const param = new URLSearchParams(query)

  for (const [k, v] of param.entries()) {
    if (k.substr(0, 2) === '--') {
      switch (k.substr(2)) {
        case 'aceh':
          acehOld = true
          break
        case 'raw-info':
          ;[rawSvr, rawLen, rawEtag] = v.split('|')
          break
      }
    } else {
      if (v) {
        reqHdrNew.set(k, v)
      } else {
        reqHdrNew.delete(k)
      }
    }
  }

  if (!param.has('referer')) reqHdrNew.delete('referer')

  // fix double-slash collapse that cfworker did
  const urlStr = pathname.replace(/^(https?):\/+/, '$1://')
  const urlObj = newUrl(urlStr)
  if (!urlObj) {
    return sendMakeRes(expressRes, 'invalid proxy url: ' + urlStr, 403)
  }

  const reqInit = {
    method: req.method,
    headers: reqHdrNew,
    redirect: 'manual',
  }

  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    reqInit.body = req
  }

  try {
    await proxy(urlObj, reqInit, acehOld, rawLen, 0, expressRes)
  } catch (err) {
    sendMakeRes(expressRes, 'proxy error:\n' + err.stack, 502)
  }
}

// ─── /http/* catch-all proxy route ───────────────────────────────────────────

app.all('/http/*', async (req, res) => {
  // req.path is like /http/https://example.com/...
  const pathname = req.path.substr('/http/'.length) +
    (req.url.includes('?') ? '?' + req.url.split('?').slice(1).join('?') : '')
  await httpHandler(req, pathname, res)
})

// ─── static fallback → upstream asset server ─────────────────────────────────

app.get('*', async (req, res) => {
  try {
    const upstream = await fetch(ASSET_URL + req.path)
    const headers = {}
    for (const [k, v] of upstream.headers.entries()) headers[k] = v
    res.status(upstream.status).set(headers)
    upstream.body.pipe(res)
  } catch (err) {
    res.status(502).send('upstream error: ' + err.message)
  }
})

// ─── start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`jsproxy running on port ${PORT}`)
})
