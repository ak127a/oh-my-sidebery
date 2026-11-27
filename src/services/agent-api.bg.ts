import * as T from 'src/types'
import * as E from 'src/enums'
import * as D from 'src/defaults'
import * as Utils from 'src/utils'
import * as IPC from 'src/services/ipc'
import * as Logs from 'src/services/logs'
import * as Windows from 'src/services/windows.bg'
import * as Sidebar from 'src/services/sidebar.bg'
import * as SidebarConfig from 'src/services/sidebar-config'
import * as Tabs from 'src/services/tabs.bg'
import * as Store from 'src/services/storage.bg'
import * as Containers from 'src/services/containers'
import * as ContainersBg from 'src/services/containers.bg'
import * as SettingsBg from 'src/services/settings.bg'
import * as SnapshotsBg from 'src/services/snapshots.bg'
import * as Info from 'src/services/info.bg'

export const NATIVE_HOST_NAME = 'sidebery_api'

const PANEL_TYPE_NAMES: Record<number, string> = {
  [E.PanelType.tabs]: 'tabs',
  [E.PanelType.bookmarks]: 'bookmarks',
  [E.PanelType.history]: 'history',
  [E.PanelType.sync]: 'sync',
}

const VALID_TABS_MODES = ['attach', 'close', 'save', 'leave']

let nativePort: browser.runtime.Port | undefined
let hostReady = false
let reconnectAttempt = 0
let reconnectTimer: number | undefined

const RECONNECT_DELAYS_MS = [2000, 5000, 10000, 30000]

/**
 * Connect to the local native messaging host if installed and available.
 */
export function setupNativeHost(): void {
  if (!browser.runtime?.connectNative) return
  connectNativeHost()
}

function connectNativeHost(): void {
  clearTimeout(reconnectTimer)
  reconnectTimer = undefined

  let port: browser.runtime.Port
  try {
    port = browser.runtime.connectNative(NATIVE_HOST_NAME)
  } catch (err) {
    Logs.info('AgentApi.connectNativeHost: Native host unavailable:', String(err))
    return
  }

  nativePort = port
  hostReady = false

  port.onMessage.addListener((msg: unknown) => {
    if (!msg || typeof msg !== 'object') return
    const payload = msg as Record<string, any>

    if (payload.type === 'ready') {
      hostReady = true
      reconnectAttempt = 0
      Logs.info('AgentApi: Native host ready, pid:', payload.pid)
      return
    }

    if (typeof payload.id === 'string' && typeof payload.method === 'string') {
      const req = payload as T.AgentApiRequest
      void handleRequest(req).then(res => {
        try {
          port.postMessage(res)
        } catch (err) {
          Logs.warn('AgentApi: Failed to post response:', String(err))
        }
      })
    }
  })

  port.onDisconnect.addListener((disconnectedPort: browser.runtime.Port) => {
    const errMsg = disconnectedPort.error?.message ?? ''
    if (nativePort === disconnectedPort) nativePort = undefined

    if (!hostReady) {
      // Host exited immediately without sending ready (typically not installed yet)
      Logs.info('AgentApi: Native host not connected:', errMsg || 'disconnected')
      return
    }

    hostReady = false
    const delay =
      RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)] ?? 30000
    reconnectAttempt++
    Logs.warn(`AgentApi: Native host disconnected (${errMsg}), reconnecting in ${delay}ms`)
    reconnectTimer = setTimeout(() => {
      connectNativeHost()
    }, delay)
  })
}

function isSidebarConnected(winId: ID): boolean {
  const con = IPC.getConnection(E.InstanceType.sidebar, winId)
  if (!con) return false
  return !!((con.localPort && !con.localPort.error) || (con.remotePort && !con.remotePort.error))
}

function resolveTargetWindowId(params: Record<string, any>): ID {
  if (params.windowId !== undefined) {
    const winId = Number(params.windowId)
    if (!Windows.byId.has(winId)) throw new Error(`Window not found: ${params.windowId}`)
    return winId
  }

  const refTabId = params.tabId ?? (Array.isArray(params.tabIds) ? params.tabIds[0] : undefined)
  if (refTabId !== undefined) {
    const tab = Tabs.byId[Number(refTabId)]
    if (tab && Windows.byId.has(tab.windowId)) return tab.windowId
  }

  if (params.parentId !== undefined && params.parentId !== D.NOID) {
    const parentTab = Tabs.byId[Number(params.parentId)]
    if (parentTab && Windows.byId.has(parentTab.windowId)) return parentTab.windowId
  }

  if (Windows.lastFocusedId !== D.NOID && Windows.byId.has(Windows.lastFocusedId)) {
    return Windows.lastFocusedId
  }

  for (const [winId] of IPC.state.sidebarConnections) {
    if (Windows.byId.has(winId)) return winId
  }

  const firstWin = Windows.byId.keys().next().value
  if (firstWin !== undefined) return firstWin

  throw new Error('No open browser windows found')
}

function buildFallbackWindowState(winId: ID): T.AgentWindowState {
  const win = Windows.byId.get(winId)
  if (!win) throw new Error(`Window not found: ${winId}`)

  const cachedList = Tabs.cacheByWin[winId] ?? []
  const cacheById = new Map<ID, T.TabCache>()
  for (const c of cachedList) cacheById.set(c.id, c)

  const nativeTabs = win.tabs ?? []
  const byId = new Map<ID, T.AgentTabInfo>()
  const tabCountByPanel = new Map<ID, number>()
  const pinnedCountByPanel = new Map<ID, number>()

  for (const t of nativeTabs) {
    const cached = cacheById.get(t.id)
    const panelId = cached?.panelId ?? t.panelId ?? D.NOID
    if (panelId !== D.NOID) {
      if (t.pinned) pinnedCountByPanel.set(panelId, (pinnedCountByPanel.get(panelId) ?? 0) + 1)
      else tabCountByPanel.set(panelId, (tabCountByPanel.get(panelId) ?? 0) + 1)
    }

    const parentId = cached?.parentId ?? t.parentId ?? D.NOID
    const info: T.AgentTabInfo = {
      id: t.id,
      windowId: t.windowId,
      panelId,
      index: t.index,
      url: t.url,
      title: t.title,
      customTitle: cached?.customTitle ?? t.customTitle,
      customColor: cached?.customColor ?? t.customColor,
      active: t.active,
      pinned: t.pinned,
      hidden: t.hidden,
      discarded: !!t.discarded,
      audible: !!t.audible,
      muted: !!t.mutedInfo?.muted,
      cookieStoreId: t.cookieStoreId,
      parentId,
      lvl: 0,
      isParent: false,
      folded: !!(cached?.folded ?? t.folded),
      isGroup: !!t.isGroup || Utils.isGroupUrl(t.url),
      groupId: D.NOID,
      childrenIds: [],
    }
    byId.set(t.id, info)
  }

  const tabs: T.AgentTabInfo[] = []
  for (const t of nativeTabs) {
    const info = byId.get(t.id)
    if (!info) continue
    let curParent = byId.get(info.parentId)
    let depth = 0
    while (curParent && depth < 32) {
      depth++
      if (info.groupId === D.NOID && curParent.isGroup) info.groupId = curParent.id
      curParent = byId.get(curParent.parentId)
    }
    info.lvl = depth
    const directParent = byId.get(info.parentId)
    if (directParent) {
      directParent.isParent = true
      directParent.childrenIds.push(info.id)
    }
    tabs.push(info)
  }

  const panels: T.AgentPanelInfo[] = Sidebar.panelConfigs.map((conf, index) => ({
    id: conf.id,
    type: PANEL_TYPE_NAMES[conf.type] ?? 'unknown',
    name: conf.name,
    color: conf.color,
    iconSVG: conf.iconSVG,
    index,
    hidden: false,
    lockedPanel: conf.lockedPanel,
    newTabCtx: Utils.isTabsPanel(conf) ? conf.newTabCtx : undefined,
    tabCount: tabCountByPanel.get(conf.id) ?? 0,
    pinnedTabCount: pinnedCountByPanel.get(conf.id) ?? 0,
  }))

  const groups: T.AgentGroupInfo[] = []
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i]
    if (!tab.isGroup) continue
    const tabIds: ID[] = []
    for (let j = i + 1; j < tabs.length; j++) {
      if (tabs[j].lvl <= tab.lvl) break
      tabIds.push(tabs[j].id)
    }
    groups.push({
      id: tab.id,
      title: tab.customTitle ?? tab.title,
      windowId: tab.windowId,
      panelId: tab.panelId,
      parentId: tab.parentId,
      lvl: tab.lvl,
      folded: tab.folded,
      customColor: tab.customColor,
      tabIds,
    })
  }

  return {
    window: {
      id: winId,
      focused: win.focused,
      incognito: win.incognito,
      activePanelId: win.activePanelId,
      activeTabId: win.activeTabId,
      sidebarConnected: false,
    },
    panels,
    tabs,
    groups,
  }
}

async function getWindowState(winId: ID): Promise<T.AgentWindowState> {
  if (isSidebarConnected(winId)) {
    try {
      return await IPC.sidebar(winId, 'agentGetWindowState')
    } catch (err) {
      Logs.warn('AgentApi.getWindowState: Sidebar IPC failed, using fallback:', String(err))
    }
  }
  return buildFallbackWindowState(winId)
}

function getContainersList(): T.AgentContainerInfo[] {
  return Object.values(Containers.reactive.byId).map(c => ({
    id: c.id,
    name: c.name,
    color: c.color,
    icon: c.icon,
  }))
}

function resolvePanelIdFilter(panels: T.AgentPanelInfo[], ref: ID | string): ID | undefined {
  const refStr = String(ref)
  const refLower = refStr.toLowerCase()
  for (const p of panels) {
    if (p.id === ref || String(p.id) === refStr) return p.id
  }
  for (const p of panels) {
    if (p.name.toLowerCase() === refLower) return p.id
  }
  return undefined
}

function normalizeColorValue(color: string): string {
  const c = color.trim().toLowerCase()
  if (c === 'none' || c === 'reset' || c === 'clear' || c === '') return 'toolbar'
  if (D.COLOR_NAMES.includes(c)) return c
  throw new Error(`Invalid color: "${color}". Valid colors: ${D.COLOR_NAMES.join(', ')}, none`)
}

async function createPanelFallback(params: Record<string, any>): Promise<T.AgentPanelInfo> {
  const color = params.color !== undefined ? normalizeColorValue(String(params.color)) : 'toolbar'
  const name = typeof params.name === 'string' && params.name.trim() ? params.name.trim() : 'Tabs'
  const panelConf = SidebarConfig.createTabsPanelConfig({
    name,
    color,
    iconSVG: typeof params.iconSVG === 'string' ? params.iconSVG : undefined,
    newTabCtx:
      typeof (params.newTabCtx ?? params.container) === 'string'
        ? String(params.newTabCtx ?? params.container)
        : 'none',
  })

  const nav = [...Sidebar.nav]
  const panels: Record<ID, T.PanelConfig> = {}
  for (const [id, conf] of Object.entries(Sidebar.panelConfById)) {
    if (conf) panels[id] = conf
  }
  panels[panelConf.id] = panelConf
  let insertIndex = nav.length
  if (typeof params.index === 'number' && params.index >= 0 && params.index <= nav.length) {
    insertIndex = params.index
  } else {
    const lastTabPanelIdx = nav.findLastIndex(id => {
      const p = panels[id]
      return !!p && p.type === E.PanelType.tabs
    })
    if (lastTabPanelIdx !== -1) insertIndex = lastTabPanelIdx + 1
  }
  nav.splice(insertIndex, 0, panelConf.id)
  await Store.set({ sidebar: { panels, nav } })

  return {
    id: panelConf.id,
    type: 'tabs',
    name: panelConf.name,
    color: panelConf.color,
    iconSVG: panelConf.iconSVG,
    index: insertIndex,
    hidden: false,
    lockedPanel: panelConf.lockedPanel,
    newTabCtx: panelConf.newTabCtx,
    tabCount: 0,
    pinnedTabCount: 0,
  }
}

async function createTabFallback(
  winId: ID,
  params: Record<string, any>
): Promise<T.AgentTabInfo | T.AgentTabInfo[]> {
  const isBatch = Array.isArray(params.urls)
  const urls: string[] = isBatch ? params.urls : [params.url ?? 'about:newtab']
  if (!urls.length) throw new Error('At least one URL is required')

  const created: T.AgentTabInfo[] = []
  for (let i = 0; i < urls.length; i++) {
    const url = Utils.sanitizeUrl(urls[i], params.title)
    const active = i === 0 ? !!params.active : false
    const nativeTab = await browser.tabs.create({
      windowId: winId,
      url,
      active,
      pinned: !!params.pinned,
      index: params.index !== undefined ? Number(params.index) + i : undefined,
      cookieStoreId: params.cookieStoreId,
    })
    created.push({
      id: nativeTab.id,
      windowId: nativeTab.windowId,
      panelId: D.NOID,
      index: nativeTab.index,
      url: nativeTab.url,
      title: nativeTab.title,
      active: nativeTab.active,
      pinned: nativeTab.pinned,
      hidden: nativeTab.hidden,
      discarded: !!nativeTab.discarded,
      audible: !!nativeTab.audible,
      muted: !!nativeTab.mutedInfo?.muted,
      cookieStoreId: nativeTab.cookieStoreId,
      parentId: D.NOID,
      lvl: 0,
      isParent: false,
      folded: false,
      isGroup: Utils.isGroupUrl(nativeTab.url),
      groupId: D.NOID,
      childrenIds: [],
    })
  }
  return isBatch ? created : created[0]
}

async function callSidebarOrThrow<A extends keyof T.SidebarActions>(
  winId: ID,
  action: A,
  ...args: Parameters<T.SidebarActions[A]>
): Promise<ReturnType<T.SidebarActions[A]>> {
  if (!isSidebarConnected(winId)) {
    throw new Error(
      `Sidebery sidebar is not open in window ${winId}. Open the Sidebery sidebar in Firefox and retry.`
    )
  }
  return IPC.sidebar(winId, action, ...args)
}

/**
 * Dispatch an Agent API request and return a structured response.
 */
export async function handleRequest(req: T.AgentApiRequest): Promise<T.AgentApiResponse> {
  const params = req.params ?? {}

  try {
    const data = await dispatchMethod(req.method, params)
    return { id: req.id, ok: true, data }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { id: req.id, ok: false, error: message }
  }
}

async function dispatchMethod(method: string, params: Record<string, any>): Promise<any> {
  switch (method) {
    case 'ping': {
      return {
        ok: true,
        version: browser.runtime.getManifest().version,
        profileId: Info.getProfileId(),
        windowsCount: Windows.byId.size,
        connectedSidebars: Array.from(IPC.state.sidebarConnections.keys()),
      }
    }

    case 'listWindows': {
      const windows: T.AgentWindowInfo[] = []
      for (const win of Windows.byId.values()) {
        windows.push({
          id: win.id,
          focused: win.focused,
          incognito: win.incognito,
          activePanelId: win.activePanelId,
          activeTabId: win.activeTabId,
          sidebarConnected: isSidebarConnected(win.id),
        })
      }
      return { windows }
    }

    case 'getState': {
      const windowIds =
        params.windowId !== undefined
          ? [resolveTargetWindowId(params)]
          : Array.from(Windows.byId.keys())
      const states = await Promise.all(windowIds.map(id => getWindowState(id)))
      const snapshot: T.AgentStateSnapshot = {
        windows: states.map(s => s.window),
        containers: getContainersList(),
        panels: states.flatMap(s => s.panels),
        tabs: states.flatMap(s => s.tabs),
        groups: states.flatMap(s => s.groups),
      }
      return snapshot
    }

    case 'listPanels': {
      const winId = resolveTargetWindowId(params)
      const state = await getWindowState(winId)
      return { windowId: winId, activePanelId: state.window.activePanelId, panels: state.panels }
    }

    case 'listTabs': {
      const winId = resolveTargetWindowId(params)
      const state = await getWindowState(winId)
      let tabs = state.tabs

      const panelRef = params.panelId ?? params.panel
      if (panelRef !== undefined) {
        const panelId = resolvePanelIdFilter(state.panels, panelRef)
        if (panelId === undefined) throw new Error(`Panel not found: "${panelRef}"`)
        tabs = tabs.filter(t => t.panelId === panelId)
      }

      if (params.groupId !== undefined) {
        const gid = Number(params.groupId)
        tabs = tabs.filter(t => t.groupId === gid || t.id === gid)
      }

      if (params.color !== undefined) {
        const color = normalizeColorValue(String(params.color))
        tabs = tabs.filter(t => (color === 'toolbar' ? !t.customColor : t.customColor === color))
      }

      if (params.active) {
        tabs = tabs.filter(t => t.active)
      }

      if (typeof params.query === 'string' && params.query.trim()) {
        const q = params.query.trim().toLowerCase()
        tabs = tabs.filter(
          t =>
            t.title.toLowerCase().includes(q) ||
            (t.customTitle?.toLowerCase().includes(q) ?? false) ||
            t.url.toLowerCase().includes(q)
        )
      }

      return { windowId: winId, tabs }
    }

    case 'listGroups': {
      const winId = resolveTargetWindowId(params)
      const state = await getWindowState(winId)
      let groups = state.groups

      const panelRef = params.panelId ?? params.panel
      if (panelRef !== undefined) {
        const panelId = resolvePanelIdFilter(state.panels, panelRef)
        if (panelId === undefined) throw new Error(`Panel not found: "${panelRef}"`)
        groups = groups.filter(g => g.panelId === panelId)
      }

      return { windowId: winId, groups }
    }

    case 'createPanel': {
      const winId = resolveTargetWindowId(params)
      if (isSidebarConnected(winId)) {
        return await IPC.sidebar(winId, 'agentCreatePanel', params as T.AgentCreatePanelParams)
      }
      return await createPanelFallback(params)
    }

    case 'updatePanel': {
      const winId = resolveTargetWindowId(params)
      return await callSidebarOrThrow(winId, 'agentUpdatePanel', params as T.AgentUpdatePanelParams)
    }

    case 'deletePanel': {
      const winId = resolveTargetWindowId(params)
      if (params.tabsMode && !VALID_TABS_MODES.includes(params.tabsMode)) {
        throw new Error(
          `Invalid tabsMode: "${params.tabsMode}". Valid: ${VALID_TABS_MODES.join(', ')}`
        )
      }
      return await callSidebarOrThrow(winId, 'agentDeletePanel', params as T.AgentDeletePanelParams)
    }

    case 'switchPanel': {
      const winId = resolveTargetWindowId(params)
      return await callSidebarOrThrow(winId, 'agentSwitchPanel', params as T.AgentSwitchPanelParams)
    }

    case 'createTab': {
      const winId = resolveTargetWindowId(params)
      if (isSidebarConnected(winId)) {
        return await IPC.sidebar(winId, 'agentCreateTab', params as T.AgentCreateTabParams)
      }
      if (
        params.panelId !== undefined ||
        params.panel !== undefined ||
        params.parentId !== undefined
      ) {
        throw new Error(
          `Sidebery sidebar is not open in window ${winId}. Open the sidebar to target a panel or parent tab.`
        )
      }
      return await createTabFallback(winId, params)
    }

    case 'groupTabs': {
      const winId = resolveTargetWindowId(params)
      return await callSidebarOrThrow(winId, 'agentGroupTabs', params as T.AgentGroupTabsParams)
    }

    case 'flattenTabs': {
      const winId = resolveTargetWindowId(params)
      return await callSidebarOrThrow(winId, 'agentFlattenTabs', params as T.AgentFlattenTabsParams)
    }

    case 'moveTabs': {
      const winId = resolveTargetWindowId(params)
      return await callSidebarOrThrow(winId, 'agentMoveTabs', params as T.AgentMoveTabsParams)
    }

    case 'setTabColor': {
      const winId = resolveTargetWindowId(params)
      return await callSidebarOrThrow(winId, 'agentSetTabColor', params as T.AgentSetTabColorParams)
    }

    case 'setTabTitle': {
      const winId = resolveTargetWindowId(params)
      return await callSidebarOrThrow(winId, 'agentSetTabTitle', params as T.AgentSetTabTitleParams)
    }

    case 'activateTab': {
      const tabId = Number(params.tabId)
      if (Number.isNaN(tabId)) throw new Error('tabId is required')
      const winId = resolveTargetWindowId({ ...params, tabId })
      if (isSidebarConnected(winId)) {
        return await IPC.sidebar(winId, 'agentActivateTab', { windowId: winId, tabId })
      }
      await browser.tabs.update(tabId, { active: true })
      return { tabId }
    }

    case 'closeTabs': {
      if (!Array.isArray(params.tabIds) || !params.tabIds.length) {
        throw new Error('tabIds is required')
      }
      const winId = resolveTargetWindowId(params)
      if (isSidebarConnected(winId)) {
        return await IPC.sidebar(winId, 'agentCloseTabs', params as T.AgentCloseTabsParams)
      }
      await browser.tabs.remove(params.tabIds)
      return { tabIds: params.tabIds }
    }

    case 'importLegacyConfig': {
      return await importLegacyConfig(params)
    }

    case 'importLegacySnapshot': {
      return await importLegacySnapshot(params)
    }

    default:
      throw new Error(`Unknown method: "${method}"`)
  }
}

function mergeImportedSidebar(
  rawSidebar: T.SidebarConfig,
  containersIds: Record<string, string>
): T.SidebarConfig {
  const sidebar = Utils.clone(rawSidebar)
  const nav = Array.isArray(sidebar.nav) ? [...sidebar.nav] : []
  const panels: Record<ID, T.PanelConfig> = sidebar.panels ? { ...sidebar.panels } : {}

  for (const id of nav) {
    const panel = panels[id]
    if (!panel || !Utils.isTabsPanel(panel)) continue
    if (panel.newTabCtx && panel.newTabCtx !== 'none') {
      panel.newTabCtx = containersIds[panel.newTabCtx] ?? 'none'
    }
    if (!Array.isArray(panel.moveRules)) panel.moveRules = []
    else {
      panel.moveRules = panel.moveRules.map(rule => {
        if (rule.containerId) {
          const newId = containersIds[rule.containerId]
          if (newId) rule.containerId = newId
          else {
            rule.containerId = undefined
            rule.active = false
          }
        }
        return rule
      })
    }
  }

  const importedSet = new Set(nav)
  const extraPanels: ID[] = []
  for (const id of Sidebar.nav) {
    if (importedSet.has(id) || id === 'tabs-panel') continue
    const existingPanel = Sidebar.panelConfById[id]
    if (!existingPanel) continue
    if (existingPanel.type === E.PanelType.tabs) {
      const hasTabs = Object.values(Tabs.byId).some(t => t?.panelId === id)
      if (!hasTabs) continue
    }
    panels[id] = Utils.clone(existingPanel)
    extraPanels.push(id)
  }

  if (extraPanels.length > 0) {
    const addTpIdx = nav.indexOf('add_tp')
    if (addTpIdx !== -1) nav.splice(addTpIdx, 0, ...extraPanels)
    else nav.push(...extraPanels)
  }

  return { nav, panels }
}

async function importLegacyConfig(params: Record<string, any>) {
  let containersIds: Record<string, string> = {}
  let importedContainers = false
  let importedSidebar = false
  let importedSettings = false
  let importedContextMenu = false
  let importedStyles = false

  if (params.containers && typeof params.containers === 'object') {
    containersIds = await ContainersBg.importContainers(params.containers)
    importedContainers = true
  }

  if (params.sidebar && Array.isArray(params.sidebar.nav) && params.sidebar.panels) {
    const mergedSidebar = mergeImportedSidebar(params.sidebar as T.SidebarConfig, containersIds)
    await Store.set({ sidebar: mergedSidebar })
    importedSidebar = true
  }

  if (params.settings && typeof params.settings === 'object') {
    await SettingsBg.importSettings(params.settings as T.SettingsState)
    importedSettings = true
  }

  const extraStore: Partial<T.Stored> = {}
  if (params.contextMenu && typeof params.contextMenu === 'object') {
    extraStore.contextMenu = params.contextMenu
    importedContextMenu = true
  }
  if (typeof params.sidebarCSS === 'string' && params.sidebarCSS.trim()) {
    extraStore.sidebarCSS = params.sidebarCSS
    importedStyles = true
  }
  if (typeof params.groupCSS === 'string' && params.groupCSS.trim()) {
    extraStore.groupCSS = params.groupCSS
    importedStyles = true
  }
  if (Object.keys(extraStore).length > 0) {
    await Store.set(extraStore)
  }

  return {
    imported: {
      containers: importedContainers,
      sidebar: importedSidebar,
      settings: importedSettings,
      contextMenu: importedContextMenu,
      styles: importedStyles,
    },
  }
}

async function importLegacySnapshot(params: Record<string, any>) {
  const raw = params.snapshot
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.tabs) || !raw.sidebar) {
    throw new Error('Valid snapshot object with tabs and sidebar is required')
  }

  const snapshot = Utils.clone(raw) as T.NormalizedSnapshot
  if (!snapshot.id) snapshot.id = `import-${Date.now()}`
  if (!snapshot.time) snapshot.time = Date.now()
  if (!snapshot.containers) snapshot.containers = {}

  let tabsCount = 0
  const panelIds = new Set<ID>()
  for (const win of snapshot.tabs) {
    if (!Array.isArray(win)) continue
    for (const panel of win) {
      if (!Array.isArray(panel)) continue
      for (const tab of panel) {
        if (!tab || typeof tab.url !== 'string') continue
        tabsCount++
        if (tab.panelId !== undefined && tab.panelId !== D.NOID) panelIds.add(tab.panelId)
        if (Utils.isGroupUrl(tab.url)) tab.url = Utils.updateGroupUrlBase(tab.url)
        else if (Utils.isPlaceholderUrl(tab.url)) tab.url = Utils.updatePlaceholderUrlBase(tab.url)
      }
    }
  }

  const storedSnaps = await browser.storage.local.get<T.Stored>('snapshots').catch(() => undefined)
  const alreadyStored = storedSnaps?.snapshots?.some(s => s.id === snapshot.id)
  if (!alreadyStored) {
    await SnapshotsBg.addSnapshot(Utils.clone(snapshot))
  }

  const openWindows = params.openWindows !== false
  if (openWindows) {
    await SnapshotsBg.openWindows(Utils.clone(snapshot))
  }

  const windowsCount = snapshot.tabs.filter(
    w => Array.isArray(w) && w.some(p => Array.isArray(p) && p.length > 0)
  ).length

  return {
    snapshotId: snapshot.id,
    windowsCount,
    panelsCount: panelIds.size,
    tabsCount,
    opened: openWindows,
  }
}
