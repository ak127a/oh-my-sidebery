import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createNativeMessageReader, encodeNativeMessage } from './protocol.mjs'
import { startBridge } from './host.mjs'
import {
  LEGACY_SIDEBERY_ID,
  buildSnapshotFromTabsCache,
  collectSelectableSnapshots,
  decodeIdbKey,
  decodeStructuredClone,
  discoverLegacySideberySources,
  extractExtensionUuidFromPrefs,
  formatSnapshotChoiceLine,
  getFirefoxProfileRoots,
  loadLegacyDataFromFile,
  normalizeSnapshots,
  parseProfilesIni,
  summarizeSnapshot,
  unsnappy,
} from './legacy-import.mjs'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI_PATH = path.resolve(__dirname, 'sidebery.mjs')

function encodeVarint(n) {
  const bytes = []
  let v = n >>> 0
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  bytes.push(v)
  return Buffer.from(bytes)
}

function encodeSnappyLiteralOnly(raw) {
  const header = encodeVarint(raw.length)
  if (raw.length === 0) return header
  if (raw.length <= 60) {
    return Buffer.concat([header, Buffer.from([(raw.length - 1) << 2]), raw])
  }
  if (raw.length <= 256) {
    return Buffer.concat([header, Buffer.from([60 << 2, raw.length - 1]), raw])
  }
  const lenBuf = Buffer.allocUnsafe(2)
  lenBuf.writeUInt16LE(raw.length - 1, 0)
  return Buffer.concat([header, Buffer.from([61 << 2]), lenBuf, raw])
}

function encodeIdbKey(str) {
  const out = [0x30]
  for (let i = 0; i < str.length; i++) {
    out.push(str.charCodeAt(i) + 1)
  }
  return Buffer.from(out)
}

function encodeStructuredClone(value) {
  const chunks = []
  const pushPair = (data, tag) => {
    const b = Buffer.allocUnsafe(8)
    b.writeUInt32LE(data >>> 0, 0)
    b.writeUInt32LE(tag >>> 0, 4)
    chunks.push(b)
  }
  const pushString = str => {
    const isLatin1 = /^[\x00-\xff]*$/.test(str)
    if (isLatin1) {
      pushPair(0x80000000 | str.length, 0xffff0004)
      const padded = Math.ceil(str.length / 8) * 8
      const b = Buffer.alloc(padded)
      b.write(str, 0, 'latin1')
      chunks.push(b)
    } else {
      pushPair(str.length, 0xffff0004)
      const byteLen = str.length * 2
      const padded = Math.ceil(byteLen / 8) * 8
      const b = Buffer.alloc(padded)
      b.write(str, 0, 'utf16le')
      chunks.push(b)
    }
  }
  const writeVal = v => {
    if (v === null) return pushPair(0, 0xffff0000)
    if (v === undefined) return pushPair(0, 0xffff0001)
    if (typeof v === 'boolean') return pushPair(v ? 1 : 0, 0xffff0002)
    if (typeof v === 'number') {
      if (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647 && !Object.is(v, -0)) {
        return pushPair(v | 0, 0xffff0003)
      }
      const b = Buffer.allocUnsafe(8)
      b.writeDoubleLE(v, 0)
      chunks.push(b)
      return
    }
    if (typeof v === 'string') return pushString(v)
    if (Array.isArray(v)) {
      pushPair(v.length, 0xffff0007)
      for (let i = 0; i < v.length; i++) {
        writeVal(i)
        writeVal(v[i])
      }
      return pushPair(0, 0xffff0013)
    }
    if (typeof v === 'object') {
      pushPair(0, 0xffff0008)
      for (const [k, val] of Object.entries(v)) {
        if (val === undefined) continue
        writeVal(k)
        writeVal(val)
      }
      return pushPair(0, 0xffff0013)
    }
  }

  pushPair(0, 0xfff10000) // SCTAG_HEADER
  writeVal(value)
  return Buffer.concat(chunks)
}

test('unsnappy, decodeIdbKey, and decodeStructuredClone handle complex objects and Unicode', () => {
  const sample = {
    str: 'hello',
    uni: '日本語🚀',
    num: 1732700000123.5,
    int: -42,
    bool: true,
    nil: null,
    arr: [1, 'two', { nested: false }],
  }
  const encoded = encodeStructuredClone(sample)
  const snappy = encodeSnappyLiteralOnly(encoded)
  const decoded = decodeStructuredClone(unsnappy(snappy))
  assert.deepEqual(decoded, sample)

  assert.equal(decodeIdbKey(encodeIdbKey('sidebar')), 'sidebar')
  assert.equal(decodeIdbKey(Buffer.from([0x10, 0x20])), null)

  // Verify copy tag (type=1) in unsnappy: "abcdabcd"
  const copyTest = Buffer.from([
    8, // uncompressed length = 8
    3 << 2, 0x61, 0x62, 0x63, 0x64, // 4-byte literal "abcd"
    ((4 - 4) << 2) | 1, 4, // type=1 copy len=4 offset=4
  ])
  assert.equal(unsnappy(copyTest).toString('utf8'), 'abcdabcd')
})

test('getFirefoxProfileRoots returns OS-specific Firefox roots', () => {
  const winRoots = getFirefoxProfileRoots({
    platform: 'win32',
    homeDir: 'C:\\Users\\ak',
    appDataDir: 'C:\\Users\\ak\\AppData\\Roaming',
  })
  assert.ok(winRoots.some(r => r.endsWith(path.join('Mozilla', 'Firefox'))))

  const macRoots = getFirefoxProfileRoots({
    platform: 'darwin',
    homeDir: '/Users/ak',
  })
  assert.ok(macRoots.some(r => r.endsWith(path.join('Library', 'Application Support', 'Firefox'))))

  const linuxRoots = getFirefoxProfileRoots({
    platform: 'linux',
    homeDir: '/home/ak',
    xdgConfigHome: '/home/ak/.config',
  })
  assert.ok(linuxRoots.some(r => r.endsWith(path.join('.mozilla', 'firefox'))))
  assert.ok(linuxRoots.some(r => r.endsWith(path.join('.config', 'mozilla', 'firefox'))))
})

test('parseProfilesIni and extractExtensionUuidFromPrefs parse Firefox profile metadata', () => {
  const ini = `
[General]
StartWithLastProfile=1

[Profile0]
Name=default-release
IsRelative=1
Path=abc123.default-release
Default=1

[Profile1]
Name=abs-profile
IsRelative=0
Path=/opt/ff-profile
`
  const profiles = parseProfilesIni(ini, '/home/ak/.mozilla/firefox')
  assert.equal(profiles.length, 2)
  assert.equal(profiles[0].path, path.resolve('/home/ak/.mozilla/firefox/abc123.default-release'))
  assert.equal(profiles[0].isDefault, true)
  assert.equal(profiles[1].path, path.resolve('/opt/ff-profile'))

  const prefs = `user_pref("extensions.webextensions.uuids", "{\\"${LEGACY_SIDEBERY_ID}\\":\\"uuid-old-123\\",\\"other@ext\\":\\"uuid-2\\"}");`
  assert.equal(extractExtensionUuidFromPrefs(prefs, LEGACY_SIDEBERY_ID), 'uuid-old-123')
  assert.equal(extractExtensionUuidFromPrefs(prefs, 'missing@ext'), null)
})

test('normalizeSnapshots, buildSnapshotFromTabsCache, and collectSelectableSnapshots order most recent first', () => {
  const sidebar = {
    nav: ['p1', 'p2', 'add_tp'],
    panels: {
      p1: { id: 'p1', type: 2, name: 'Work' },
      p2: { id: 'p2', type: 2, name: 'Research' },
    },
  }
  const containers = { 'firefox-container-1': { id: 'firefox-container-1', name: 'Work' } }

  const rawSnapshots = [
    {
      id: 'snap-older',
      time: 1000,
      containers,
      sidebar,
      tabs: [[[{ url: 'https://a.com', title: 'A', panelId: 'p1' }]]],
    },
    {
      id: 'snap-newer',
      time: 2000,
      containers: 1, // SnapStoreMode.Unchanged
      sidebar: 1, // SnapStoreMode.Unchanged
      tabs: [
        [
          [1, { url: 'https://b.com', title: 'B', panelId: 'p2' }],
        ],
      ],
    },
  ]

  const norm = normalizeSnapshots(rawSnapshots)
  assert.equal(norm.length, 2)
  assert.equal(norm[1].sidebar.panels.p2.name, 'Research')
  assert.equal(norm[1].tabs[0][0][0].url, 'https://a.com')

  const liveTabsCache = [
    [
      { id: 1, url: 'https://x.com', panelId: 'p1', ctx: 'firefox-container-1' },
      { id: 2, url: 'https://y.com', panelId: 'p1', parentId: 1, customTitle: 'Child' },
      { id: 3, url: 'https://z.com', panelId: 'p2' },
    ],
  ]

  const liveSnap = buildSnapshotFromTabsCache(liveTabsCache, sidebar, containers, 3000)
  assert.equal(liveSnap.tabs[0].length, 2)
  assert.equal(liveSnap.tabs[0][0][1].lvl, 1)
  assert.equal(liveSnap.tabs[0][0][0].containerId, 'firefox-container-1')

  const selectable = collectSelectableSnapshots(
    { snapshots: rawSnapshots, tabsDataCache: liveTabsCache, sidebar, containers },
    3000
  )
  assert.equal(selectable.length, 3)
  assert.equal(selectable[0].summary.id, 'live-cache')
  assert.equal(selectable[1].summary.id, 'snap-newer')
  assert.equal(selectable[2].summary.id, 'snap-older')
  assert.equal(selectable[0].summary.windowsCount, 1)
  assert.equal(selectable[0].summary.panelsCount, 2)
  assert.equal(selectable[0].summary.tabsCount, 3)

  const line = formatSnapshotChoiceLine(selectable[0].summary, 1)
  assert.match(line, /1\).*\[Live session\].*1 window.*2 panels \(Work, Research\).*3 tabs/)
})

test('loadLegacyDataFromFile supports both full backup and single snapshot JSON', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebery-file-test-'))
  try {
    const snapPath = path.join(tmpDir, 'sidebery-snapshot-1.json')
    fs.writeFileSync(
      snapPath,
      JSON.stringify({
        id: 'single-1',
        time: 5000,
        containers: {},
        sidebar: { nav: ['p1'], panels: { p1: { id: 'p1', type: 2, name: 'Main' } } },
        tabs: [[[{ url: 'https://example.com', title: 'Ex', panelId: 'p1' }]]],
      })
    )
    const loadedSnap = loadLegacyDataFromFile(snapPath)
    assert.equal(loadedSnap.sourceType, 'file-snapshot')
    assert.equal(loadedSnap.snapshots.length, 1)
    assert.equal(loadedSnap.snapshots[0].summary.panelsCount, 1)

    const backupPath = path.join(tmpDir, 'sidebery-data-1.json')
    fs.writeFileSync(
      backupPath,
      JSON.stringify({
        ver: '5.6.1',
        sidebar: { nav: ['p1', 'p2'], panels: { p1: { id: 'p1', type: 2, name: 'A' }, p2: { id: 'p2', type: 2, name: 'B' } } },
        settings: { theme: 'proton' },
        snapshots: [
          {
            id: 's1',
            time: 1000,
            containers: {},
            sidebar: { nav: ['p1', 'p2'], panels: { p1: { id: 'p1', type: 2, name: 'A' }, p2: { id: 'p2', type: 2, name: 'B' } } },
            tabs: [[[{ url: 'https://a.com', title: 'A', panelId: 'p1' }]]],
          },
        ],
      })
    )
    const loadedBackup = loadLegacyDataFromFile(backupPath)
    assert.equal(loadedBackup.sourceType, 'file-backup')
    assert.equal(loadedBackup.snapshots[0].summary.panelsCount, 2)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('end-to-end discovery from SQLite IndexedDB and sidebery-cli import via bridge', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebery-e2e-import-'))
  const profileDir = path.join(tmpDir, 'test.default-release')
  const uuid = 'b7e49c7d-d7ab-4cd2-a20b-c2cb30da6df9'
  const idbDir = path.join(
    profileDir,
    'storage',
    'default',
    `moz-extension+++${uuid}^userContextId=4294967295`,
    'idb'
  )
  fs.mkdirSync(idbDir, { recursive: true })
  fs.writeFileSync(
    path.join(profileDir, 'prefs.js'),
    `user_pref("extensions.webextensions.uuids", "{\\"${LEGACY_SIDEBERY_ID}\\":\\"${uuid}\\"}");\n`
  )

  const sidebar = {
    nav: ['pWork', 'pDocs', 'add_tp'],
    panels: {
      pWork: { id: 'pWork', type: 2, name: 'Work', color: 'blue' },
      pDocs: { id: 'pDocs', type: 2, name: 'Docs', color: 'green' },
    },
  }
  const snapshots = [
    {
      id: 'snap-old',
      time: 1700000000000,
      containers: {},
      sidebar,
      tabs: [[[{ url: 'https://old.example', title: 'Old', panelId: 'pWork' }]]],
    },
    {
      id: 'snap-latest',
      time: 1700000500000,
      containers: 1,
      sidebar: 1,
      tabs: [
        [
          [{ url: 'https://work.example', title: 'Work', panelId: 'pWork' }],
          [{ url: 'https://docs.example', title: 'Docs', panelId: 'pDocs' }],
        ],
      ],
    },
  ]

  const dbPath = path.join(idbDir, 'test.sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE object_data(object_store_id INTEGER, key BLOB, data BLOB)')
  const insert = db.prepare('INSERT INTO object_data(object_store_id, key, data) VALUES (1, ?, ?)')
  for (const [k, v] of Object.entries({
    ver: '5.6.1',
    sidebar,
    containers: {},
    settings: { theme: 'proton' },
    snapshots,
  })) {
    insert.run(encodeIdbKey(k), encodeSnappyLiteralOnly(encodeStructuredClone(v)))
  }
  db.close()

  const discovered = await discoverLegacySideberySources({ profile: profileDir })
  assert.equal(discovered.length, 1)
  assert.equal(discovered[0].snapshots[0].summary.id, 'snap-latest')
  assert.equal(discovered[0].snapshots[0].summary.panelsCount, 2)

  // Test CLI --list
  const listRes = await execFileAsync(process.execPath, [
    CLI_PATH,
    'import',
    '--list',
    '--profile',
    profileDir,
  ])
  const listJson = JSON.parse(listRes.stdout)
  assert.equal(listJson.sources[0].snapshots[0].id, 'snap-latest')
  assert.equal(listJson.sources[0].snapshots[0].panelsCount, 2)
  assert.equal(listJson.sources[0].snapshots[0].windowsCount, 1)

  // Test CLI import via mock bridge
  const inputToBridge = new PassThrough()
  const outputFromBridge = new PassThrough()
  const receivedCalls = []

  const stopMock = createNativeMessageReader(outputFromBridge, msg => {
    if (msg.type === 'ready') return
    receivedCalls.push(msg)
    let data = {}
    if (msg.method === 'importLegacyConfig') {
      data = { imported: { containers: true, sidebar: true, settings: true } }
    } else if (msg.method === 'importLegacySnapshot') {
      data = {
        snapshotId: msg.params.snapshot.id,
        windowsCount: 1,
        panelsCount: 2,
        tabsCount: 2,
        opened: true,
      }
    }
    inputToBridge.write(encodeNativeMessage({ id: msg.id, ok: true, data }))
  })

  const stateFilePath = path.join(tmpDir, 'bridge-state.json')
  const bridge = await startBridge({
    input: inputToBridge,
    output: outputFromBridge,
    port: 0,
    socketPath: null,
    stateFilePath,
  })

  try {
    const impRes = await execFileAsync(
      process.execPath,
      [CLI_PATH, 'import', '--profile', profileDir, '--snapshot', '1'],
      { env: { ...process.env, SIDEBERY_API_URL: `http://127.0.0.1:${bridge.port}` } }
    )
    const impJson = JSON.parse(impRes.stdout)
    assert.equal(impJson.ok, true)
    assert.equal(impJson.snapshot.snapshotId, 'snap-latest')
    assert.equal(receivedCalls.length, 2)
    assert.equal(receivedCalls[0].method, 'importLegacyConfig')
    assert.equal(receivedCalls[1].method, 'importLegacySnapshot')
    assert.equal(receivedCalls[1].params.snapshot.id, 'snap-latest')
  } finally {
    stopMock()
    await bridge.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
