import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { PassThrough } from 'node:stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createNativeMessageReader, encodeNativeMessage } from './protocol.mjs'
import { startBridge } from './host.mjs'
import { installHost, uninstallHost } from './install-host.mjs'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI_PATH = path.resolve(__dirname, 'sidebery.mjs')

function httpRequest({ host = '127.0.0.1', port, socketPath, method = 'GET', reqPath, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined
    const reqHeaders = { ...headers }
    if (payload !== undefined) {
      reqHeaders['Content-Type'] = 'application/json'
      reqHeaders['Content-Length'] = Buffer.byteLength(payload, 'utf8')
    }
    const opts = socketPath
      ? { socketPath, path: reqPath, method, headers: reqHeaders }
      : { hostname: host, port, path: reqPath, method, headers: reqHeaders }

    const req = http.request(opts, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode, body: JSON.parse(raw) })
      })
    })
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

function createMockExtension(inputToBridge, outputFromBridge) {
  const calls = []
  const state = {
    windows: [{ id: 1, focused: true, incognito: false, activePanelId: 'p1', activeTabId: 10, sidebarConnected: true }],
    containers: [{ id: 'firefox-default', name: 'Default', color: 'toolbar', icon: '' }],
    panels: [{ id: 'p1', type: 'tabs', name: 'Tabs', color: 'toolbar', iconSVG: 'icon_tabs', index: 0, hidden: false, lockedPanel: false, newTabCtx: 'none', tabCount: 1, pinnedTabCount: 0 }],
    tabs: [{ id: 10, windowId: 1, panelId: 'p1', index: 0, url: 'https://example.com', title: 'Example', active: true, pinned: false, hidden: false, discarded: false, audible: false, muted: false, cookieStoreId: 'firefox-default', parentId: -1, lvl: 0, isParent: false, folded: false, isGroup: false, groupId: -1, childrenIds: [] }],
    groups: [],
  }

  let nextPanelId = 2
  let nextTabId = 11
  const readyMessages = []

  const stop = createNativeMessageReader(outputFromBridge, msg => {
    if (msg.type === 'ready') {
      readyMessages.push(msg)
      return
    }
    calls.push(msg)
    const { id, method, params = {} } = msg
    let data
    if (method === 'ping') {
      data = { ok: true, version: '5.6.1', windowsCount: 1, connectedSidebars: [1] }
    } else if (method === 'getState') {
      data = state
    } else if (method === 'listPanels') {
      data = { windowId: 1, activePanelId: 'p1', panels: state.panels }
    } else if (method === 'listTabs') {
      data = { windowId: 1, tabs: state.tabs }
    } else if (method === 'createPanel') {
      const panel = {
        id: `p${nextPanelId++}`,
        type: 'tabs',
        name: params.name || 'Tabs',
        color: params.color || 'toolbar',
        iconSVG: 'icon_tabs',
        index: state.panels.length,
        hidden: false,
        lockedPanel: false,
        newTabCtx: 'none',
        tabCount: 0,
        pinnedTabCount: 0,
      }
      state.panels.push(panel)
      data = panel
    } else if (method === 'createTab') {
      const tab = {
        id: nextTabId++,
        windowId: 1,
        panelId: params.panel || 'p1',
        index: state.tabs.length,
        url: params.url || 'about:newtab',
        title: params.title || params.url || 'New Tab',
        customColor: params.color,
        active: !!params.active,
        pinned: false,
        hidden: false,
        discarded: false,
        audible: false,
        muted: false,
        cookieStoreId: 'firefox-default',
        parentId: -1,
        lvl: 0,
        isParent: false,
        folded: false,
        isGroup: false,
        groupId: -1,
        childrenIds: [],
      }
      state.tabs.push(tab)
      data = tab
    } else if (method === 'groupTabs') {
      const groupTab = {
        id: nextTabId++,
        windowId: 1,
        panelId: 'p1',
        index: state.tabs.length,
        url: `moz-extension://x/sidebery/group.html#${params.title || 'Group'}`,
        title: params.title || 'Group',
        customColor: params.color,
        active: false,
        pinned: false,
        hidden: false,
        discarded: false,
        audible: false,
        muted: false,
        cookieStoreId: 'firefox-default',
        parentId: -1,
        lvl: 0,
        isParent: true,
        folded: false,
        isGroup: true,
        groupId: -1,
        childrenIds: params.tabIds,
      }
      state.tabs.push(groupTab)
      state.groups.push({
        id: groupTab.id,
        title: groupTab.title,
        windowId: 1,
        panelId: 'p1',
        parentId: -1,
        lvl: 0,
        folded: false,
        customColor: groupTab.customColor,
        tabIds: params.tabIds,
      })
      data = { groupTab, tabIds: params.tabIds }
    } else if (method === 'setTabColor') {
      const ids = params.tabIds || [10]
      for (const tab of state.tabs) {
        if (ids.includes(tab.id)) tab.customColor = params.color === 'toolbar' ? undefined : params.color
      }
      data = { tabIds: ids, color: params.color === 'toolbar' ? null : params.color }
    } else {
      data = { method, params }
    }

    inputToBridge.write(encodeNativeMessage({ id, ok: true, data }))
  })

  return { calls, readyMessages, state, stop }
}

test('native messaging framing handles split chunks and multiple frames', () => {
  const stream = new PassThrough()
  const received = []
  const stop = createNativeMessageReader(stream, msg => received.push(msg))

  const f1 = encodeNativeMessage({ id: '1', ok: true, data: { hello: 'world' } })
  const f2 = encodeNativeMessage({ id: '2', ok: true, data: { n: 42 } })
  const combined = Buffer.concat([f1, f2])

  // Split across an arbitrary boundary mid-header and mid-payload
  stream.write(combined.subarray(0, 2))
  stream.write(combined.subarray(2, f1.length + 3))
  stream.write(combined.subarray(f1.length + 3))
  stop()

  assert.deepEqual(received, [
    { id: '1', ok: true, data: { hello: 'world' } },
    { id: '2', ok: true, data: { n: 42 } },
  ])
})

test('bridge HTTP/Unix API, security guards, and CLI subprocess work end-to-end', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebery-api-test-'))
  const socketPath = path.join(tmpDir, 'sidebery-api.sock')
  const stateFilePath = path.join(tmpDir, 'sidebery-api.json')

  const inputToBridge = new PassThrough()
  const outputFromBridge = new PassThrough()
  const mockExt = createMockExtension(inputToBridge, outputFromBridge)

  const bridge = await startBridge({
    input: inputToBridge,
    output: outputFromBridge,
    port: 0,
    socketPath,
    stateFilePath,
    requestTimeoutMs: 5000,
  })

  try {
    // Allow ready message to flush
    await new Promise(r => setTimeout(r, 20))
    assert.equal(mockExt.readyMessages.length, 1)

    // 1. CSRF security checks on TCP endpoint
    const originRes = await httpRequest({
      port: bridge.port,
      reqPath: '/api/health',
      headers: { Origin: 'https://evil.example' },
    })
    assert.equal(originRes.status, 403)

    const fetchSiteRes = await httpRequest({
      port: bridge.port,
      reqPath: '/api/health',
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    })
    assert.equal(fetchSiteRes.status, 403)

    // 2. Direct HTTP endpoints
    const healthRes = await httpRequest({ port: bridge.port, reqPath: '/api/health' })
    assert.equal(healthRes.status, 200)
    assert.equal(healthRes.body.ok, true)
    assert.equal(healthRes.body.data.version, '5.6.1')

    const stateRes = await httpRequest({ socketPath, reqPath: '/api/state' })
    assert.equal(stateRes.status, 200)
    assert.equal(stateRes.body.data.tabs.length, 1)

    // 3. CLI subprocess over discovery file / Unix socket
    const env = { ...process.env, SIDEBERY_API_DIR: tmpDir }

    const pingCli = await execFileAsync(process.execPath, [CLI_PATH, 'ping'], { env })
    assert.equal(JSON.parse(pingCli.stdout).version, '5.6.1')

    const panelCli = await execFileAsync(
      process.execPath,
      [CLI_PATH, 'panel', 'create', 'Agents', '--color', 'purple', '--activate'],
      { env }
    )
    const createdPanel = JSON.parse(panelCli.stdout)
    assert.equal(createdPanel.name, 'Agents')
    assert.equal(createdPanel.color, 'purple')

    const tabCli = await execFileAsync(
      process.execPath,
      [CLI_PATH, 'tab', 'create', 'https://openai.com', '--panel', 'Agents', '--color', 'blue'],
      { env }
    )
    const createdTab = JSON.parse(tabCli.stdout)
    assert.equal(createdTab.url, 'https://openai.com')
    assert.equal(createdTab.customColor, 'blue')

    const groupCli = await execFileAsync(
      process.execPath,
      [CLI_PATH, 'tab', 'group', '10', String(createdTab.id), '--title', 'AI', '--color', 'turquoise'],
      { env }
    )
    const grouped = JSON.parse(groupCli.stdout)
    assert.equal(grouped.groupTab.title, 'AI')
    assert.equal(grouped.groupTab.customColor, 'turquoise')

    const colorCli = await execFileAsync(
      process.execPath,
      [CLI_PATH, 'tab', 'color', 'red', '10'],
      { env }
    )
    assert.deepEqual(JSON.parse(colorCli.stdout), { tabIds: [10], color: 'red' })

    const treeCli = await execFileAsync(
      process.execPath,
      [CLI_PATH, 'tabs', '--tree'],
      { env }
    )
    assert.match(treeCli.stdout, /\[PANEL\] Tabs/)
    assert.match(treeCli.stdout, /#10 .*Example — https:\/\/example\.com/)

    const rpcCli = await execFileAsync(
      process.execPath,
      [CLI_PATH, 'rpc', 'customPing', '{"hello":"agent"}'],
      { env }
    )
    assert.deepEqual(JSON.parse(rpcCli.stdout), { method: 'customPing', params: { hello: 'agent' } })
  } finally {
    mockExt.stop()
    await bridge.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('installHost and uninstallHost support linux, darwin, and win32', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `sidebery-install-${platform}-`))
    const appDataDir = path.join(homeDir, 'AppData', 'Roaming')
    const localAppDataDir = path.join(homeDir, 'AppData', 'Local')

    // Pre-create optional agent directories to verify skill installation
    fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true })
    fs.mkdirSync(path.join(homeDir, '.gemini', 'config'), { recursive: true })
    if (platform === 'win32') {
      fs.mkdirSync(path.join(appDataDir, 'npm'), { recursive: true })
    }

    try {
      const res = installHost({
        homeDir,
        platform,
        appDataDir,
        localAppDataDir,
        skipRegistry: true,
      })

      assert.ok(fs.existsSync(res.wrapperPath))
      assert.ok(fs.existsSync(res.cliPath))
      assert.ok(res.installedManifests.length >= 1)
      for (const manifestPath of res.installedManifests) {
        assert.ok(fs.existsSync(manifestPath))
        const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        assert.equal(parsed.name, 'sidebery_api')
        assert.equal(parsed.path, res.wrapperPath)
        assert.deepEqual(parsed.allowed_extensions, [
          'sidebery-ai@ak127a',
          '{3c078156-979c-498b-8990-85f7987dd929}',
        ])
      }

      assert.ok(fs.existsSync(path.join(homeDir, '.agents', 'skills', 'sidebery', 'SKILL.md')))
      assert.ok(fs.existsSync(path.join(homeDir, '.claude', 'skills', 'sidebery', 'SKILL.md')))
      assert.ok(
        fs.existsSync(path.join(homeDir, '.gemini', 'config', 'skills', 'sidebery', 'SKILL.md'))
      )

      const uninst = uninstallHost({
        homeDir,
        platform,
        appDataDir,
        localAppDataDir,
        skipRegistry: true,
      })
      assert.ok(uninst.removed.length >= 4)
      assert.equal(fs.existsSync(res.cliPath), false)
      assert.equal(fs.existsSync(res.installDir), false)
      assert.equal(fs.existsSync(path.join(homeDir, '.agents', 'skills', 'sidebery')), false)
      for (const manifestPath of res.installedManifests) {
        assert.equal(fs.existsSync(manifestPath), false)
      }
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true })
    }
  }
})
