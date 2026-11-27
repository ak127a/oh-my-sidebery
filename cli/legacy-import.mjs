import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const LEGACY_SIDEBERY_ID = '{3c078156-979c-498b-8990-85f7987dd929}'
const SNAP_UNCHANGED = 1
const PANEL_TYPE_TABS = 2
const NOID = -1

const SCTAG_FLOAT_MAX = 0xfff00000
const SCTAG_HEADER = 0xfff10000
const SCTAG_NULL = 0xffff0000
const SCTAG_UNDEFINED = 0xffff0001
const SCTAG_BOOLEAN = 0xffff0002
const SCTAG_INT32 = 0xffff0003
const SCTAG_STRING = 0xffff0004
const SCTAG_DATE_OBJECT = 0xffff0005
const SCTAG_ARRAY_OBJECT = 0xffff0007
const SCTAG_OBJECT_OBJECT = 0xffff0008
const SCTAG_BOOLEAN_OBJECT = 0xffff000a
const SCTAG_STRING_OBJECT = 0xffff000b
const SCTAG_NUMBER_OBJECT = 0xffff000c
const SCTAG_BACK_REFERENCE_OBJECT = 0xffff000d
const SCTAG_END_OF_KEYS = 0xffff0013

const IMPORT_STORAGE_KEYS = new Set([
  'ver',
  'settings',
  'sidebar',
  'containers',
  'snapshots',
  'tabsDataCache',
  'contextMenu',
  'sidebarCSS',
  'groupCSS',
  'keybindings',
])

/**
 * Decompress a Snappy-framed buffer used by Firefox IndexedDB object_data blobs.
 */
export function unsnappy(src) {
  let pos = 0
  let len = 0
  let shift = 0
  while (pos < src.length) {
    const b = src[pos++]
    len |= (b & 0x7f) << shift
    if ((b & 0x80) === 0) break
    shift += 7
  }

  const out = Buffer.allocUnsafe(len)
  let outPos = 0

  while (pos < src.length) {
    const tag = src[pos++]
    const type = tag & 0x03

    if (type === 0) {
      let litLen = tag >>> 2
      if (litLen < 60) {
        litLen += 1
      } else {
        const extra = litLen - 59
        litLen = 0
        for (let i = 0; i < extra; i++) {
          litLen |= src[pos++] << (i * 8)
        }
        litLen += 1
      }
      src.copy(out, outPos, pos, pos + litLen)
      pos += litLen
      outPos += litLen
    } else {
      let copyLen
      let offset
      if (type === 1) {
        copyLen = ((tag >>> 2) & 0x07) + 4
        offset = ((tag & 0xe0) << 3) | src[pos++]
      } else if (type === 2) {
        copyLen = (tag >>> 2) + 1
        offset = src[pos] | (src[pos + 1] << 8)
        pos += 2
      } else {
        copyLen = (tag >>> 2) + 1
        offset =
          (src[pos] | (src[pos + 1] << 8) | (src[pos + 2] << 16) | (src[pos + 3] << 24)) >>> 0
        pos += 4
      }
      for (let i = 0; i < copyLen; i++) {
        out[outPos] = out[outPos - offset]
        outPos++
      }
    }
  }

  return out.subarray(0, outPos)
}

/**
 * Decode a Firefox IndexedDB string key (encoded with type byte 0x30 and +1 byte shift).
 */
export function decodeIdbKey(buf) {
  if (!buf || buf.length === 0 || buf[0] !== 0x30) return null
  let str = ''
  for (let i = 1; i < buf.length; i++) {
    const b = buf[i]
    if (b === 0) break
    if (b <= 0x7f) str += String.fromCharCode(b - 1)
    else return null
  }
  return str
}

/**
 * Decode SpiderMonkey StructuredClone payload from Firefox IndexedDB.
 */
export function decodeStructuredClone(buf) {
  let pos = 0

  const readPair = () => {
    const data = buf.readUInt32LE(pos)
    const tag = buf.readUInt32LE(pos + 4)
    pos += 8
    return { data, tag }
  }

  const readString = data => {
    const isLatin1 = (data & 0x80000000) !== 0
    const len = data & 0x7fffffff
    if (isLatin1) {
      const s = buf.toString('latin1', pos, pos + len)
      pos += Math.ceil(len / 8) * 8
      return s
    }
    const s = buf.toString('utf16le', pos, pos + len * 2)
    pos += Math.ceil((len * 2) / 8) * 8
    return s
  }

  if (pos + 8 <= buf.length && buf.readUInt32LE(pos + 4) === SCTAG_HEADER) {
    pos += 8
  }

  const allObjs = []
  const stack = []

  const readAtom = () => {
    const startPos = pos
    const { data, tag } = readPair()
    if (tag <= SCTAG_FLOAT_MAX) {
      return { kind: 'val', val: buf.readDoubleLE(startPos) }
    }
    switch (tag) {
      case SCTAG_NULL:
        return { kind: 'val', val: null }
      case SCTAG_UNDEFINED:
        return { kind: 'val', val: undefined }
      case SCTAG_BOOLEAN:
        return { kind: 'val', val: data !== 0 }
      case SCTAG_INT32:
        return { kind: 'val', val: data | 0 }
      case SCTAG_STRING:
        return { kind: 'val', val: readString(data) }
      case SCTAG_DATE_OBJECT: {
        const ms = buf.readDoubleLE(pos)
        pos += 8
        const d = new Date(ms)
        allObjs.push(d)
        return { kind: 'val', val: d }
      }
      case SCTAG_BOOLEAN_OBJECT: {
        const b = Boolean(data)
        allObjs.push(b)
        return { kind: 'val', val: b }
      }
      case SCTAG_STRING_OBJECT: {
        const s = readString(data)
        allObjs.push(s)
        return { kind: 'val', val: s }
      }
      case SCTAG_NUMBER_OBJECT: {
        const n = buf.readDoubleLE(pos)
        pos += 8
        allObjs.push(n)
        return { kind: 'val', val: n }
      }
      case SCTAG_BACK_REFERENCE_OBJECT:
        return { kind: 'val', val: allObjs[data] }
      case SCTAG_ARRAY_OBJECT: {
        const arr = new Array(data)
        allObjs.push(arr)
        return { kind: 'container', val: arr }
      }
      case SCTAG_OBJECT_OBJECT: {
        const obj = {}
        allObjs.push(obj)
        return { kind: 'container', val: obj }
      }
      case SCTAG_END_OF_KEYS:
        return { kind: 'end' }
      default:
        throw new Error(
          `Unsupported StructuredClone tag 0x${tag.toString(16)} at offset ${startPos}`
        )
    }
  }

  const first = readAtom()
  const root = first.val
  if (first.kind === 'container') {
    stack.push({ container: first.val, key: undefined, hasKey: false })
  }

  while (stack.length > 0 && pos < buf.length) {
    const top = stack[stack.length - 1]
    if (!top.hasKey) {
      const k = readAtom()
      if (k.kind === 'end') {
        stack.pop()
        continue
      }
      top.key = k.val
      top.hasKey = true
    } else {
      const v = readAtom()
      top.container[top.key] = v.val
      top.hasKey = false
      if (v.kind === 'container') {
        stack.push({ container: v.val, key: undefined, hasKey: false })
      }
    }
  }

  return root
}

/**
 * Return candidate Firefox / Gecko profile root directories across Windows, macOS, and Linux.
 */
export function getFirefoxProfileRoots(options = {}) {
  const platform = options.platform ?? process.platform
  const homeDir = options.homeDir ?? os.homedir()
  const appDataDir =
    options.appDataDir ?? process.env.APPDATA ?? path.join(homeDir, 'AppData', 'Roaming')
  const xdgConfigHome =
    options.xdgConfigHome ?? process.env.XDG_CONFIG_HOME ?? path.join(homeDir, '.config')

  if (platform === 'win32') {
    return [
      path.join(appDataDir, 'Mozilla', 'Firefox'),
      path.join(appDataDir, 'LibreWolf'),
      path.join(appDataDir, 'Floorp'),
      path.join(appDataDir, 'zen'),
    ]
  }
  if (platform === 'darwin') {
    const appSupport = path.join(homeDir, 'Library', 'Application Support')
    return [
      path.join(appSupport, 'Firefox'),
      path.join(appSupport, 'LibreWolf'),
      path.join(appSupport, 'Floorp'),
      path.join(appSupport, 'zen'),
    ]
  }
  return [
    path.join(homeDir, '.mozilla', 'firefox'),
    path.join(xdgConfigHome, 'mozilla', 'firefox'),
    path.join(homeDir, 'snap', 'firefox', 'common', '.mozilla', 'firefox'),
    path.join(homeDir, '.var', 'app', 'org.mozilla.firefox', '.mozilla', 'firefox'),
    path.join(homeDir, '.librewolf'),
    path.join(homeDir, '.floorp'),
    path.join(homeDir, '.zen'),
  ]
}

/**
 * Parse a Firefox profiles.ini file into profile entries.
 */
export function parseProfilesIni(iniText, rootDir) {
  const profiles = []
  let current = null

  const flush = () => {
    if (!current || !current.Path) return
    const isRelative = current.IsRelative !== '0'
    const resolvedPath = isRelative
      ? path.resolve(rootDir, current.Path)
      : path.resolve(current.Path)
    profiles.push({
      name: current.Name || path.basename(resolvedPath),
      path: resolvedPath,
      isDefault: current.Default === '1',
      root: rootDir,
    })
  }

  for (const rawLine of iniText.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    if (line.startsWith('[') && line.endsWith(']')) {
      flush()
      const section = line.slice(1, -1)
      current = section.startsWith('Profile') ? {} : null
      continue
    }
    if (!current) continue
    const eqIdx = line.indexOf('=')
    if (eqIdx === -1) continue
    const key = line.slice(0, eqIdx).trim()
    const val = line.slice(eqIdx + 1).trim()
    current[key] = val
  }
  flush()

  return profiles
}

/**
 * Discover all Firefox / Gecko profile directories containing prefs.js.
 */
export function discoverFirefoxProfiles(options = {}) {
  const roots = options.roots ?? getFirefoxProfileRoots(options)
  const seen = new Set()
  const profiles = []

  const addProfile = entry => {
    if (!entry.path || !fs.existsSync(path.join(entry.path, 'prefs.js'))) return
    let real
    try {
      real = fs.realpathSync(entry.path)
    } catch {
      real = path.resolve(entry.path)
    }
    if (seen.has(real)) return
    seen.add(real)
    profiles.push({
      name: entry.name || path.basename(real),
      path: real,
      isDefault: !!entry.isDefault,
      root: entry.root,
    })
  }

  for (const rootDir of roots) {
    if (!fs.existsSync(rootDir)) continue

    const iniPath = path.join(rootDir, 'profiles.ini')
    if (fs.existsSync(iniPath)) {
      try {
        const iniText = fs.readFileSync(iniPath, 'utf8')
        for (const p of parseProfilesIni(iniText, rootDir)) addProfile(p)
      } catch {
        // Ignore unreadable profiles.ini
      }
    }

    for (const scanBase of [rootDir, path.join(rootDir, 'Profiles')]) {
      if (!fs.existsSync(scanBase)) continue
      let entries = []
      try {
        entries = fs.readdirSync(scanBase, { withFileTypes: true })
      } catch {
        continue
      }
      for (const d of entries) {
        if (!d.isDirectory()) continue
        addProfile({ name: d.name, path: path.join(scanBase, d.name), isDefault: false, root: rootDir })
      }
    }
  }

  return profiles
}

/**
 * Extract the internal moz-extension UUID for an add-on ID from Firefox's prefs.js.
 */
export function extractExtensionUuidFromPrefs(prefsText, extensionId = LEGACY_SIDEBERY_ID) {
  const match = prefsText.match(
    /user_pref\(\s*"extensions\.webextensions\.uuids"\s*,\s*("(?:\\.|[^"\\])*")\s*\)\s*;/
  )
  if (!match) return null
  try {
    const rawJson = JSON.parse(match[1])
    const uuidMap = JSON.parse(rawJson)
    return typeof uuidMap[extensionId] === 'string' ? uuidMap[extensionId] : null
  } catch {
    return null
  }
}

/**
 * Locate the IndexedDB SQLite file backing browser.storage.local for an extension UUID.
 */
export function findExtensionStorageDb(profileDir, uuid) {
  const storageRoot = path.join(profileDir, 'storage', 'default')
  const candidates = [
    path.join(storageRoot, `moz-extension+++${uuid}^userContextId=4294967295`, 'idb'),
    path.join(storageRoot, `moz-extension+++${uuid}`, 'idb'),
  ]

  for (const idbDir of candidates) {
    if (!fs.existsSync(idbDir)) continue
    let files = []
    try {
      files = fs.readdirSync(idbDir, { withFileTypes: true })
    } catch {
      continue
    }
    const sqliteFiles = files
      .filter(f => f.isFile() && f.name.endsWith('.sqlite'))
      .map(f => {
        const fullPath = path.join(idbDir, f.name)
        const stat = fs.statSync(fullPath)
        return { fullPath, size: stat.size, mtimeMs: stat.mtimeMs }
      })
      .sort((a, b) => b.size - a.size)

    if (sqliteFiles.length > 0) {
      return sqliteFiles[0]
    }
  }

  return null
}

/**
 * Safely copy and read a Firefox WebExtension IndexedDB SQLite file using node:sqlite.
 */
export async function readFirefoxExtensionStorage(dbPath) {
  let DatabaseSync
  try {
    ;({ DatabaseSync } = await import('node:sqlite'))
  } catch (err) {
    throw new Error(
      `Reading Firefox storage directly requires Node.js >= 22.5 with node:sqlite (${err instanceof Error ? err.message : String(err)}). You can still export from Sidebery and pass --file <backup.json>.`
    )
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebery-import-'))
  const baseName = path.basename(dbPath)
  const tempDbPath = path.join(tempDir, baseName)

  let db
  try {
    fs.copyFileSync(dbPath, tempDbPath)
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${dbPath}${suffix}`
      if (fs.existsSync(sidecar)) {
        fs.copyFileSync(sidecar, `${tempDbPath}${suffix}`)
      }
    }

    try {
      db = new DatabaseSync(tempDbPath, { readOnly: true })
    } catch {
      db = new DatabaseSync(tempDbPath)
    }

    const rows = db.prepare('SELECT key, data FROM object_data').all()
    const result = {}

    for (const row of rows) {
      const key = decodeIdbKey(Buffer.from(row.key))
      if (!key || !IMPORT_STORAGE_KEYS.has(key)) continue
      try {
        const raw = unsnappy(Buffer.from(row.data))
        result[key] = decodeStructuredClone(raw)
      } catch {
        // Skip individual corrupt/unreadable optional keys
      }
    }

    return result
  } finally {
    try {
      db?.close()
    } catch {
      // Ignore close error
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup error
    }
  }
}

function cloneJson(val) {
  return val === undefined ? undefined : JSON.parse(JSON.stringify(val))
}

/**
 * Resolve SnapStoreMode.Unchanged (1) deltas in stored snapshots into full snapshots.
 */
export function normalizeSnapshots(rawSnapshots) {
  if (!Array.isArray(rawSnapshots) || rawSnapshots.length === 0) return []
  const snapshots = cloneJson(rawSnapshots)
  const normalized = []

  for (let index = 0; index < snapshots.length; index++) {
    const snapshot = snapshots[index]
    if (!snapshot || typeof snapshot !== 'object') continue

    if (snapshot.containers === SNAP_UNCHANGED) {
      for (let i = index; i--;) {
        const prev = snapshots[i]
        if (prev && prev.containers !== SNAP_UNCHANGED) {
          snapshot.containers = prev.containers
          break
        }
      }
    }

    if (snapshot.sidebar === SNAP_UNCHANGED) {
      for (let i = index; i--;) {
        const prev = snapshots[i]
        if (prev && prev.sidebar !== SNAP_UNCHANGED) {
          snapshot.sidebar = prev.sidebar
          break
        }
      }
    }

    if (!Array.isArray(snapshot.tabs)) continue
    let missingTabRef = false
    for (let wi = 0; wi < snapshot.tabs.length; wi++) {
      const win = snapshot.tabs[wi]
      if (!Array.isArray(win)) continue
      for (let pi = 0; pi < win.length; pi++) {
        const panel = win[pi]
        if (!Array.isArray(panel)) continue
        for (let ti = 0; ti < panel.length; ti++) {
          const tab = panel[ti]
          if (tab === SNAP_UNCHANGED) {
            if (index === 0) {
              missingTabRef = true
              break
            }
            let resolved = false
            for (let i = index; i--;) {
              const prev = snapshots[i]
              const prevTab = prev?.tabs?.[wi]?.[pi]?.[ti]
              if (prevTab && prevTab !== SNAP_UNCHANGED) {
                panel[ti] = prevTab
                resolved = true
                break
              }
            }
            if (!resolved) {
              missingTabRef = true
              break
            }
          }
        }
        if (missingTabRef) break
      }
      if (missingTabRef) break
    }

    if (missingTabRef) continue
    if (!snapshot.sidebar || snapshot.sidebar === SNAP_UNCHANGED) continue
    if (!snapshot.containers || snapshot.containers === SNAP_UNCHANGED) continue

    normalized.push(cloneJson(snapshot))
  }

  return normalized
}

/**
 * Synthesize a NormalizedSnapshot from Sidebery's live tabsDataCache + sidebar + containers.
 */
export function buildSnapshotFromTabsCache(tabsDataCache, sidebar, containers, timestamp = Date.now()) {
  if (!Array.isArray(tabsDataCache) || tabsDataCache.length === 0 || !sidebar) return null

  const validContainers = containers || {}
  const windows = []

  for (const winCache of tabsDataCache) {
    if (!Array.isArray(winCache) || winCache.length === 0) continue

    const byId = new Map()
    for (const c of winCache) {
      if (c && c.id !== undefined) byId.set(c.id, c)
    }

    const winTabs = []
    let currentGroup = null
    let targetGroup = ''

    for (const tab of winCache) {
      if (!tab || !tab.url) continue

      let panelId = tab.panelId !== undefined ? tab.panelId : NOID
      if (tab.pin && panelId === NOID) panelId = NOID
      else if (panelId !== NOID && !sidebar.panels?.[panelId]) panelId = NOID

      let lvl = 0
      let curParentId = tab.parentId
      const seen = new Set([tab.id])
      while (curParentId !== undefined && curParentId !== NOID && !seen.has(curParentId) && lvl < 32) {
        seen.add(curParentId)
        const parent = byId.get(curParentId)
        if (!parent || parent.panelId !== tab.panelId) break
        lvl++
        curParentId = parent.parentId
      }

      const snapTab = {
        url: tab.url,
        title: tab.customTitle || tab.url,
        panelId,
      }
      if (lvl > 0) snapTab.lvl = lvl
      if (tab.pin) snapTab.pinned = true
      if (tab.folded) snapTab.folded = true
      if (tab.ctx && validContainers[tab.ctx]) snapTab.containerId = tab.ctx
      if (tab.customTitle) snapTab.customTitle = tab.customTitle
      if (tab.customColor) snapTab.customColor = tab.customColor

      if (tab.pin && targetGroup !== 'pinned') {
        currentGroup = []
        winTabs.push(currentGroup)
        targetGroup = 'pinned'
      } else if (!tab.pin && targetGroup !== panelId) {
        currentGroup = []
        winTabs.push(currentGroup)
        targetGroup = panelId
      }

      if (currentGroup) currentGroup.push(snapTab)
    }

    if (winTabs.length > 0) windows.push(winTabs)
  }

  if (windows.length === 0) return null

  return {
    id: 'live-cache',
    time: timestamp,
    containers: cloneJson(validContainers),
    sidebar: cloneJson(sidebar),
    tabs: windows,
  }
}

/**
 * Compute windows, panels, and tabs counts for a normalized snapshot.
 */
export function summarizeSnapshot(snapshot, meta = {}) {
  const windows = Array.isArray(snapshot.tabs)
    ? snapshot.tabs.filter(w => Array.isArray(w) && w.some(p => Array.isArray(p) && p.length > 0))
    : []
  const windowsCount = windows.length

  const panelNames = []
  const panelIds = new Set()
  const nav = Array.isArray(snapshot.sidebar?.nav) ? snapshot.sidebar.nav : []
  const panelsMap = snapshot.sidebar?.panels || {}

  for (const id of nav) {
    const p = panelsMap[id]
    if (p && (p.type === PANEL_TYPE_TABS || p.type === 'tabs')) {
      panelIds.add(id)
      panelNames.push(p.name || String(id))
    }
  }

  if (panelIds.size === 0) {
    for (const win of windows) {
      for (const group of win) {
        for (const tab of group) {
          if (tab?.panelId !== undefined && tab.panelId !== NOID && !panelIds.has(tab.panelId)) {
            panelIds.add(tab.panelId)
            const p = panelsMap[tab.panelId]
            panelNames.push(p?.name || String(tab.panelId))
          }
        }
      }
    }
  }

  let tabsCount = 0
  for (const win of windows) {
    for (const group of win) {
      tabsCount += Array.isArray(group) ? group.length : 0
    }
  }

  const time = typeof snapshot.time === 'number' ? snapshot.time : Date.now()
  return {
    id: String(snapshot.id ?? meta.id ?? 'unknown'),
    time,
    isoTime: new Date(time).toISOString(),
    source: meta.source || 'snapshot',
    windowsCount,
    panelsCount: panelIds.size,
    panelNames,
    tabsCount,
  }
}

/**
 * Build selectable snapshot entries from storage data, ordered most recent first.
 */
export function collectSelectableSnapshots(storageData, fallbackTime = Date.now()) {
  const entries = []

  const normalized = normalizeSnapshots(storageData.snapshots)
  for (const snap of normalized) {
    entries.push({
      summary: summarizeSnapshot(snap, { source: 'snapshot' }),
      snapshot: snap,
    })
  }

  if (storageData.tabsDataCache && storageData.sidebar) {
    const liveSnap = buildSnapshotFromTabsCache(
      storageData.tabsDataCache,
      storageData.sidebar,
      storageData.containers,
      fallbackTime
    )
    if (liveSnap) {
      entries.push({
        summary: summarizeSnapshot(liveSnap, { source: 'live-cache' }),
        snapshot: liveSnap,
      })
    }
  }

  entries.sort((a, b) => {
    if (b.summary.time !== a.summary.time) return b.summary.time - a.summary.time
    if (a.summary.source === 'live-cache' && b.summary.source !== 'live-cache') return -1
    if (b.summary.source === 'live-cache' && a.summary.source !== 'live-cache') return 1
    return 0
  })

  return entries
}

/**
 * Load Sidebery backup or single-snapshot JSON from a file path.
 */
export function loadLegacyDataFromFile(filePath) {
  const resolved = path.resolve(filePath)
  const raw = fs.readFileSync(resolved, 'utf8')
  const parsed = JSON.parse(raw)

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid JSON structure in "${resolved}"`)
  }

  // Single exported snapshot JSON (sidebery-snapshot-*.json)
  if (parsed.id && parsed.time && parsed.tabs && parsed.sidebar && parsed.ver === undefined) {
    const data = {
      sidebar: parsed.sidebar,
      containers: parsed.containers || {},
      snapshots: [parsed],
    }
    return {
      sourceType: 'file-snapshot',
      filePath: resolved,
      data,
      snapshots: collectSelectableSnapshots(data, parsed.time),
    }
  }

  // Full Sidebery backup JSON (sidebery-data-*.json)
  if (
    parsed.ver !== undefined ||
    parsed.sidebar !== undefined ||
    parsed.settings !== undefined ||
    parsed.snapshots !== undefined
  ) {
    const mtime = fs.statSync(resolved).mtimeMs
    return {
      sourceType: 'file-backup',
      filePath: resolved,
      data: parsed,
      snapshots: collectSelectableSnapshots(parsed, Math.round(mtime)),
    }
  }

  throw new Error(`File "${resolved}" does not look like a Sidebery backup or snapshot JSON`)
}

/**
 * Discover earlier Sidebery storage across local Firefox profiles.
 */
export async function discoverLegacySideberySources(options = {}) {
  const sourceExtensionId = options.sourceExtensionId || LEGACY_SIDEBERY_ID

  const candidateProfiles = options.profile
    ? [{ name: path.basename(path.resolve(options.profile)), path: path.resolve(options.profile), isDefault: true }]
    : discoverFirefoxProfiles(options)

  const found = []

  for (const profile of candidateProfiles) {
    const prefsPath = path.join(profile.path, 'prefs.js')
    if (!fs.existsSync(prefsPath)) continue

    let prefsText
    try {
      prefsText = fs.readFileSync(prefsPath, 'utf8')
    } catch {
      continue
    }

    const uuid = extractExtensionUuidFromPrefs(prefsText, sourceExtensionId)
    if (!uuid) continue

    const dbInfo = findExtensionStorageDb(profile.path, uuid)
    if (!dbInfo) continue

    const data = await readFirefoxExtensionStorage(dbInfo.fullPath)
    const snapshots = collectSelectableSnapshots(data, Math.round(dbInfo.mtimeMs))

    found.push({
      sourceType: 'firefox-profile',
      profileName: profile.name,
      profilePath: profile.path,
      isDefault: profile.isDefault,
      extensionId: sourceExtensionId,
      extensionUuid: uuid,
      dbPath: dbInfo.fullPath,
      dbUpdatedAt: new Date(dbInfo.mtimeMs).toISOString(),
      data,
      snapshots,
    })
  }

  found.sort((a, b) => {
    const aTime = a.snapshots[0]?.summary.time ?? 0
    const bTime = b.snapshots[0]?.summary.time ?? 0
    return bTime - aTime
  })

  return found
}

function formatLocalDateTime(ms) {
  const d = new Date(ms)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * Format a selectable snapshot line for interactive CLI prompts and --list output.
 */
export function formatSnapshotChoiceLine(summary, oneBasedIndex) {
  const label = summary.source === 'live-cache' ? '[Live session]' : `[Snapshot ${summary.id}]`
  const winLabel = `${summary.windowsCount} ${summary.windowsCount === 1 ? 'window' : 'windows'}`
  const panelLabel = `${summary.panelsCount} ${summary.panelsCount === 1 ? 'panel' : 'panels'}`
  const namesSuffix =
    summary.panelNames.length > 0
      ? ` (${summary.panelNames.slice(0, 6).join(', ')}${summary.panelNames.length > 6 ? ', ...' : ''})`
      : ''
  const tabLabel = `${summary.tabsCount} ${summary.tabsCount === 1 ? 'tab' : 'tabs'}`
  return `  ${oneBasedIndex}) ${formatLocalDateTime(summary.time)}  ${label} — ${winLabel}, ${panelLabel}${namesSuffix}, ${tabLabel}`
}
