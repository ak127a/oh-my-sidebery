#!/usr/bin/env node
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import {
  DEFAULT_PORT,
  createNativeMessageReader,
  encodeNativeMessage,
  getSocketPath,
  getStateFilePath,
} from './protocol.mjs'

const MAX_BODY_BYTES = 2 * 1024 * 1024

function sendJson(res, statusCode, body) {
  const json = JSON.stringify(body)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json, 'utf8'),
    'Cache-Control': 'no-store',
  })
  res.end(json)
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0

    req.on('data', chunk => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        const err = new Error('Request body too large')
        err.statusCode = 413
        reject(err)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) return resolve({})
      try {
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          const err = new Error('JSON body must be an object')
          err.statusCode = 400
          return reject(err)
        }
        resolve(parsed)
      } catch {
        const err = new Error('Invalid JSON request body')
        err.statusCode = 400
        reject(err)
      }
    })

    req.on('error', reject)
  })
}

function checkSecurity(req, isTcp) {
  if (!isTcp) return null
  if (req.headers.origin !== undefined) {
    return 'Cross-origin requests are forbidden'
  }
  const fetchSite = req.headers['sec-fetch-site']
  if (fetchSite !== undefined && fetchSite !== 'none') {
    return 'Cross-site browser requests are forbidden'
  }
  const host = req.headers.host
  if (host && !/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(host)) {
    return 'Invalid Host header'
  }
  return null
}

function parseQuery(searchParams) {
  const params = {}
  for (const [key, val] of searchParams.entries()) {
    if (key === 'windowId' || key === 'groupId') {
      const n = Number(val)
      params[key] = Number.isNaN(n) ? val : n
    } else if (key === 'active') {
      params[key] = val === '' || val === 'true' || val === '1'
    } else {
      params[key] = val
    }
  }
  return params
}

function resolveRoute(method, pathname, query, body) {
  if (method === 'GET' && pathname === '/api/health') {
    return { method: 'ping', params: query }
  }
  if (method === 'GET' && pathname === '/api/state') {
    return { method: 'getState', params: query }
  }
  if (method === 'GET' && pathname === '/api/windows') {
    return { method: 'listWindows', params: query }
  }
  if (method === 'GET' && pathname === '/api/panels') {
    return { method: 'listPanels', params: query }
  }
  if (method === 'POST' && pathname === '/api/panels') {
    return { method: 'createPanel', params: { ...query, ...body } }
  }
  const panelActivateMatch = pathname.match(/^\/api\/panels\/([^/]+)\/activate$/)
  if (method === 'POST' && panelActivateMatch) {
    return {
      method: 'switchPanel',
      params: { ...query, ...body, panelId: decodeURIComponent(panelActivateMatch[1]) },
    }
  }
  const panelMatch = pathname.match(/^\/api\/panels\/([^/]+)$/)
  if (method === 'PATCH' && panelMatch) {
    return {
      method: 'updatePanel',
      params: { ...query, ...body, panelId: decodeURIComponent(panelMatch[1]) },
    }
  }
  if (method === 'DELETE' && panelMatch) {
    return {
      method: 'deletePanel',
      params: { ...query, ...body, panelId: decodeURIComponent(panelMatch[1]) },
    }
  }
  if (method === 'GET' && pathname === '/api/tabs') {
    return { method: 'listTabs', params: query }
  }
  if (method === 'POST' && pathname === '/api/tabs') {
    return { method: 'createTab', params: { ...query, ...body } }
  }
  if (method === 'POST' && pathname === '/api/tabs/group') {
    return { method: 'groupTabs', params: { ...query, ...body } }
  }
  if (method === 'POST' && pathname === '/api/tabs/flatten') {
    return { method: 'flattenTabs', params: { ...query, ...body } }
  }
  if (method === 'POST' && pathname === '/api/tabs/move') {
    return { method: 'moveTabs', params: { ...query, ...body } }
  }
  if (method === 'POST' && pathname === '/api/tabs/color') {
    return { method: 'setTabColor', params: { ...query, ...body } }
  }
  if (method === 'POST' && pathname === '/api/tabs/title') {
    return { method: 'setTabTitle', params: { ...query, ...body } }
  }
  if (method === 'POST' && pathname === '/api/tabs/close') {
    return { method: 'closeTabs', params: { ...query, ...body } }
  }
  const tabActivateMatch = pathname.match(/^\/api\/tabs\/([^/]+)\/activate$/)
  if (method === 'POST' && tabActivateMatch) {
    const tabId = Number(decodeURIComponent(tabActivateMatch[1]))
    return {
      method: 'activateTab',
      params: { ...query, ...body, tabId },
    }
  }
  if (method === 'GET' && pathname === '/api/groups') {
    return { method: 'listGroups', params: query }
  }
  if (method === 'POST' && pathname === '/api/rpc') {
    if (typeof body.method !== 'string' || !body.method) {
      const err = new Error('RPC body requires a "method" string')
      err.statusCode = 400
      throw err
    }
    return { method: body.method, params: body.params ?? {} }
  }

  return null
}

function listenServer(server, ...args) {
  return new Promise((resolve, reject) => {
    const onError = err => {
      server.off('listening', onListening)
      reject(err)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(...args)
  })
}

export async function startBridge(options = {}) {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const requestedPort =
    options.port !== undefined
      ? options.port
      : process.env.SIDEBERY_API_PORT !== undefined
        ? Number(process.env.SIDEBERY_API_PORT)
        : DEFAULT_PORT
  const socketPath = options.socketPath !== undefined ? options.socketPath : getSocketPath()
  const stateFilePath =
    options.stateFilePath !== undefined ? options.stateFilePath : getStateFilePath()
  const requestTimeoutMs = options.requestTimeoutMs ?? 30000

  const pending = new Map()
  let closed = false

  const stopReading = createNativeMessageReader(
    input,
    msg => {
      if (!msg || typeof msg.id !== 'string') return
      const entry = pending.get(msg.id)
      if (!entry) return
      pending.delete(msg.id)
      clearTimeout(entry.timer)
      if (msg.ok) entry.resolve(msg.data)
      else entry.reject(new Error(msg.error || 'Unknown extension error'))
    },
    err => {
      process.stderr.write(`sidebery-host native read error: ${err.message}\n`)
    }
  )

  function callExtension(method, params) {
    if (closed) return Promise.reject(new Error('Bridge is closed'))

    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Extension request timed out after ${requestTimeoutMs}ms: ${method}`))
      }, requestTimeoutMs)

      pending.set(id, { resolve, reject, timer })
      try {
        output.write(encodeNativeMessage({ id, method, params }))
      } catch (err) {
        pending.delete(id)
        clearTimeout(timer)
        reject(err)
      }
    })
  }

  function createRequestHandler(isTcp) {
    return async (req, res) => {
      const secErr = checkSecurity(req, isTcp)
      if (secErr) return sendJson(res, 403, { ok: false, error: secErr })

      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const query = parseQuery(url.searchParams)
        const body =
          req.method === 'GET' || req.method === 'HEAD' ? {} : await readJsonBody(req)

        const route = resolveRoute(req.method || 'GET', url.pathname, query, body)
        if (!route) return sendJson(res, 404, { ok: false, error: `Not found: ${url.pathname}` })

        const data = await callExtension(route.method, route.params)
        sendJson(res, 200, { ok: true, data })
      } catch (err) {
        const statusCode = err && typeof err.statusCode === 'number' ? err.statusCode : 400
        sendJson(res, statusCode, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  const tcpServer = http.createServer(createRequestHandler(true))
  try {
    await listenServer(tcpServer, requestedPort, '127.0.0.1')
  } catch (err) {
    if (err && err.code === 'EADDRINUSE' && requestedPort !== 0) {
      await listenServer(tcpServer, 0, '127.0.0.1')
    } else {
      throw err
    }
  }
  const actualPort = tcpServer.address().port

  let unixServer = null
  if (socketPath && process.platform !== 'win32') {
    fs.mkdirSync(path.dirname(socketPath), { recursive: true })
    try {
      fs.unlinkSync(socketPath)
    } catch {
      // Ignore missing stale socket
    }
    unixServer = http.createServer(createRequestHandler(false))
    await listenServer(unixServer, socketPath)
    try {
      fs.chmodSync(socketPath, 0o600)
    } catch {
      // Ignore chmod failures on non-POSIX filesystems
    }
  }

  if (stateFilePath) {
    fs.mkdirSync(path.dirname(stateFilePath), { recursive: true })
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify(
        {
          pid: process.pid,
          host: '127.0.0.1',
          port: actualPort,
          socket: unixServer ? socketPath : null,
          startedAt: new Date().toISOString(),
        },
        null,
        2
      ),
      { mode: 0o600 }
    )
  }

  output.write(encodeNativeMessage({ type: 'ready', pid: process.pid }))

  async function close() {
    if (closed) return
    closed = true
    stopReading()

    for (const [id, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error('Bridge shutting down'))
      pending.delete(id)
    }

    const closing = []
    closing.push(new Promise(resolve => tcpServer.close(() => resolve())))
    if (unixServer) {
      closing.push(new Promise(resolve => unixServer.close(() => resolve())))
    }
    await Promise.all(closing)

    if (unixServer && socketPath) {
      try {
        fs.unlinkSync(socketPath)
      } catch {
        // Ignore cleanup errors
      }
    }
    if (stateFilePath) {
      try {
        const raw = fs.readFileSync(stateFilePath, 'utf8')
        const parsed = JSON.parse(raw)
        if (parsed.pid === process.pid) fs.unlinkSync(stateFilePath)
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  return {
    port: actualPort,
    socketPath: unixServer ? socketPath : null,
    stateFilePath,
    close,
  }
}

function isMainModule() {
  if (!process.argv[1]) return false
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href
  } catch {
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  }
}

if (isMainModule()) {
  startBridge()
    .then(bridge => {
      const shutdown = async () => {
        await bridge.close()
        process.exit(0)
      }
      process.stdin.on('end', shutdown)
      process.stdin.on('close', shutdown)
      process.on('SIGTERM', shutdown)
      process.on('SIGINT', shutdown)
    })
    .catch(err => {
      process.stderr.write(`sidebery-host failed to start: ${err instanceof Error ? err.stack : err}\n`)
      process.exit(1)
    })
}
