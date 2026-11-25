import * as T from 'src/types'
import * as E from 'src/enums'
import * as D from 'src/defaults'
import * as Utils from 'src/utils'
import * as Windows from 'src/services/windows.fg'
import * as Sidebar from 'src/services/sidebar.fg'
import * as Tabs from 'src/services/tabs.fg'
import * as Containers from 'src/services/containers'
import * as Logs from 'src/services/logs'

const PANEL_TYPE_NAMES: Record<number, string> = {
  [E.PanelType.tabs]: 'tabs',
  [E.PanelType.bookmarks]: 'bookmarks',
  [E.PanelType.history]: 'history',
  [E.PanelType.sync]: 'sync',
}

/**
 * Validate and normalize a Sidebery color name.
 */
export function normalizeColor(color: string): string {
  const c = color.trim().toLowerCase()
  if (c === 'none' || c === 'reset' || c === 'clear' || c === '') return 'toolbar'
  if (D.COLOR_NAMES.includes(c)) return c
  throw new Error(`Invalid color: "${color}". Valid colors: ${D.COLOR_NAMES.join(', ')}, none`)
}

function resolveTabsPanel(panelRef?: ID | string): T.TabsPanel | undefined {
  if (panelRef === undefined) return undefined

  const direct = Sidebar.panelsById[panelRef]
  if (Utils.isTabsPanel(direct)) return direct

  const refStr = String(panelRef)
  const refLower = refStr.toLowerCase()
  for (const panel of Sidebar.panels) {
    if (!Utils.isTabsPanel(panel)) continue
    if (String(panel.id) === refStr) return panel
  }
  for (const panel of Sidebar.panels) {
    if (!Utils.isTabsPanel(panel)) continue
    if (panel.name.toLowerCase() === refLower) return panel
  }
  return undefined
}

function resolveAnyPanel(panelRef: ID | string): T.Panel | undefined {
  const direct = Sidebar.panelsById[panelRef]
  if (direct) return direct

  const refStr = String(panelRef)
  const refLower = refStr.toLowerCase()
  for (const panel of Sidebar.panels) {
    if (String(panel.id) === refStr) return panel
  }
  for (const panel of Sidebar.panels) {
    if (panel.name.toLowerCase() === refLower) return panel
  }
  return undefined
}

function resolveContainer(containerRef?: string): string | undefined {
  if (!containerRef || containerRef === 'none') return undefined
  const lower = containerRef.trim().toLowerCase()
  if (containerRef === D.DEFAULT_CONTAINER_ID || lower === 'default') {
    return D.DEFAULT_CONTAINER_ID
  }
  if (Containers.reactive.byId[containerRef]) return containerRef

  for (const c of Object.values(Containers.reactive.byId)) {
    if (c.name.toLowerCase() === lower) return c.id
  }
  throw new Error(`Container not found: "${containerRef}"`)
}

function serializePanel(panel: T.Panel): T.AgentPanelInfo {
  const isTabs = Utils.isTabsPanel(panel)
  return {
    id: panel.id,
    type: PANEL_TYPE_NAMES[panel.type] ?? 'unknown',
    name: panel.name,
    color: panel.color,
    iconSVG: panel.iconSVG,
    index: panel.index,
    hidden: panel.hidden,
    lockedPanel: panel.lockedPanel,
    newTabCtx: isTabs ? panel.newTabCtx : undefined,
    tabCount: isTabs ? panel.tabs.length : 0,
    pinnedTabCount: isTabs ? panel.pinnedTabs.length : 0,
  }
}

function serializeTab(tab: T.Tab, childrenByParent?: Map<ID, ID[]>): T.AgentTabInfo {
  const groupTab = Tabs.getGroupTab(tab)
  let childrenIds: ID[]
  if (childrenByParent) {
    childrenIds = childrenByParent.get(tab.id) ?? []
  } else {
    childrenIds = []
    for (const t of Tabs.list) {
      if (t.parentId === tab.id) childrenIds.push(t.id)
    }
  }

  return {
    id: tab.id,
    windowId: tab.windowId,
    panelId: tab.panelId,
    index: tab.index,
    url: tab.url,
    title: tab.title,
    customTitle: tab.customTitle,
    customColor: tab.customColor,
    active: tab.active,
    pinned: tab.pinned,
    hidden: tab.hidden,
    discarded: !!tab.discarded,
    audible: !!tab.audible,
    muted: !!tab.mutedInfo?.muted,
    cookieStoreId: tab.cookieStoreId,
    parentId: tab.parentId,
    lvl: tab.lvl,
    isParent: tab.isParent,
    folded: tab.folded,
    isGroup: tab.isGroup,
    groupId: groupTab ? groupTab.id : D.NOID,
    childrenIds,
  }
}

async function waitForTabInList(tabId: ID, timeoutMs = 250): Promise<T.Tab | undefined> {
  const existing = Tabs.byId[tabId]
  if (existing) return existing

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await Utils.sleep(10)
    const tab = Tabs.byId[tabId]
    if (tab) return tab
  }
  return Tabs.byId[tabId]
}

/**
 * Return current window panels, tabs, and groups state for the Agent API.
 */
export function getWindowState(): T.AgentWindowState {
  const childrenByParent = new Map<ID, ID[]>()
  for (const tab of Tabs.list) {
    if (tab.parentId !== D.NOID) {
      let arr = childrenByParent.get(tab.parentId)
      if (!arr) {
        arr = []
        childrenByParent.set(tab.parentId, arr)
      }
      arr.push(tab.id)
    }
  }

  const panels = Sidebar.panels.map(serializePanel)
  const tabs = Tabs.list.map(t => serializeTab(t, childrenByParent))

  const groups: T.AgentGroupInfo[] = []
  for (let i = 0; i < Tabs.list.length; i++) {
    const tab = Tabs.list[i]
    if (!tab.isGroup) continue

    const tabIds: ID[] = []
    for (let j = i + 1; j < Tabs.list.length; j++) {
      const child = Tabs.list[j]
      if (child.lvl <= tab.lvl) break
      tabIds.push(child.id)
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
      id: Windows.id,
      focused: Windows.focused,
      incognito: Windows.incognito,
      activePanelId: Sidebar.activePanelId,
      activeTabId: Tabs.activeId,
      sidebarConnected: true,
    },
    panels,
    tabs,
    groups,
  }
}

/**
 * Create a new tabs panel in the current sidebar.
 */
export async function createPanel(
  params: T.AgentCreatePanelParams = {}
): Promise<T.AgentPanelInfo> {
  const color = params.color !== undefined ? normalizeColor(params.color) : 'toolbar'
  const containerRef = params.newTabCtx ?? params.container
  const newTabCtx = containerRef ? (resolveContainer(containerRef) ?? 'none') : 'none'
  const name = params.name?.trim() || Sidebar.getPanelAutoName(E.PanelType.tabs) || 'Tabs'

  const conf: Partial<T.TabsPanelConfig> = {
    name,
    color,
    newTabCtx,
  }
  if (params.iconSVG) conf.iconSVG = params.iconSVG

  const panel = Sidebar.createTabsPanel(conf)

  let index = Sidebar.getIndexForNewTabsPanel(true)
  if (
    params.index !== undefined &&
    params.index >= 0 &&
    params.index <= Sidebar.reactive.nav.length
  ) {
    index = params.index
  }

  Sidebar.addPanel(index, panel)
  Sidebar.recalcPanels()
  Sidebar.recalcTabsPanels()
  await Sidebar.saveSidebar()

  if (params.activate) Sidebar.activatePanel(panel.id)
  if (!Tabs.ready) await Tabs.load()

  return serializePanel(panel)
}

/**
 * Update an existing panel's properties.
 */
export async function updatePanel(params: T.AgentUpdatePanelParams): Promise<T.AgentPanelInfo> {
  const ref = params.panelId ?? params.panel
  if (ref === undefined) throw new Error('panelId or panel is required')

  const panel = resolveAnyPanel(ref)
  if (!panel) throw new Error(`Panel not found: "${ref}"`)

  if (params.name !== undefined) {
    panel.name = params.name
    panel.reactive.name = params.name
  }
  if (params.color !== undefined) {
    const color = normalizeColor(params.color)
    panel.color = color
    panel.reactive.color = color
  }
  if (params.iconSVG !== undefined) {
    panel.iconSVG = params.iconSVG
    panel.reactive.iconSVG = params.iconSVG
  }

  Sidebar.recalcPanels()
  await Sidebar.saveSidebar()

  return serializePanel(panel)
}

/**
 * Delete a panel without triggering interactive confirmation popups.
 */
export async function deletePanel(
  params: T.AgentDeletePanelParams
): Promise<{ deletedPanelId: ID }> {
  const ref = params.panelId ?? params.panel
  if (ref === undefined) throw new Error('panelId or panel is required')

  const panel = resolveAnyPanel(ref)
  if (!panel) throw new Error(`Panel not found: "${ref}"`)

  if (Utils.isTabsPanel(panel)) {
    const tabsPanelsCount = Sidebar.panels.filter(Utils.isTabsPanel).length
    if (tabsPanelsCount <= 1) throw new Error('Cannot delete the last tabs panel')
  }

  const tabsMode = params.tabsMode ?? 'attach'
  await Sidebar.removePanel(panel.id, { tabsMode })

  return { deletedPanelId: panel.id }
}

/**
 * Switch the active panel in the current sidebar.
 */
export async function switchPanel(
  params: T.AgentSwitchPanelParams
): Promise<{ activePanelId: ID }> {
  const ref = params.panelId ?? params.panel
  if (ref === undefined) throw new Error('panelId or panel is required')

  const panel = resolveAnyPanel(ref)
  if (!panel) throw new Error(`Panel not found: "${ref}"`)

  Sidebar.switchToPanel(panel.id, false, false)

  return { activePanelId: panel.id }
}

/**
 * Create one or more tabs in a target panel or under a parent tab.
 */
export async function createTab(
  params: T.AgentCreateTabParams = {}
): Promise<T.AgentTabInfo | T.AgentTabInfo[]> {
  const isBatch = Array.isArray(params.urls)
  const urls = isBatch ? (params.urls ?? []) : [params.url ?? 'about:newtab']
  if (!urls.length) throw new Error('At least one URL is required')

  const normalizedColor = params.color !== undefined ? normalizeColor(params.color) : undefined
  const explicitContainer = resolveContainer(params.cookieStoreId ?? params.container)

  const parentTab = params.parentId !== undefined ? Tabs.byId[params.parentId] : undefined
  if (params.parentId !== undefined && !parentTab) {
    throw new Error(`Parent tab not found: ${params.parentId}`)
  }

  const panelRef = params.panelId ?? params.panel
  let panel: T.TabsPanel | undefined
  if (panelRef !== undefined) {
    panel = resolveTabsPanel(panelRef)
    if (!panel) throw new Error(`Tabs panel not found: "${panelRef}"`)
  } else if (parentTab) {
    const parentPanel = Sidebar.panelsById[parentTab.panelId]
    if (Utils.isTabsPanel(parentPanel)) panel = parentPanel
  }
  if (!panel) {
    const activePanel = Sidebar.panelsById[Sidebar.activePanelId]
    if (Utils.isTabsPanel(activePanel)) panel = activePanel
  }
  if (!panel) {
    const prevPanel = Sidebar.panelsById[Sidebar.prevTabsPanelId]
    if (Utils.isTabsPanel(prevPanel)) panel = prevPanel
  }
  if (!panel) {
    panel = Sidebar.panels.find(Utils.isTabsPanel)
  }
  if (!panel) throw new Error('No tabs panel available')

  if (parentTab?.folded) Tabs.expTabsBranch(parentTab.id, false)

  const createdTabs: T.AgentTabInfo[] = []
  for (let i = 0; i < urls.length; i++) {
    const rawUrl = urls[i]
    const url = Utils.sanitizeUrl(rawUrl, params.title)
    const parentId = !params.pinned && parentTab ? parentTab.id : D.NOID

    let index: number
    if (params.index !== undefined) {
      index = params.index + i
    } else if (params.pinned) {
      index = Tabs.pinned.length
    } else if (parentTab) {
      index = parentTab.index + (Tabs.getBranchLen(parentTab.id) ?? 0) + 1
    } else {
      index = panel.nextTabIndex > -1 ? panel.nextTabIndex : Tabs.list.length
    }
    index = Math.min(index, Tabs.list.length)

    let cookieStoreId = explicitContainer
    if (!cookieStoreId && parentTab) cookieStoreId = parentTab.cookieStoreId
    if (!cookieStoreId && panel.newTabCtx !== 'none') cookieStoreId = panel.newTabCtx
    if (Windows.incognito && cookieStoreId) cookieStoreId = D.PRIVATE_CONTAINER_ID

    const active = i === 0 ? !!params.active : false
    const pinned = !!params.pinned
    const canDiscard =
      !!params.discarded && !active && !pinned && !!url && !url.startsWith('about:')

    const createProps: browser.tabs.CreateProperties = {
      windowId: Windows.id,
      index,
      url,
      active,
      pinned,
    }
    if (cookieStoreId) createProps.cookieStoreId = cookieStoreId
    if (canDiscard) {
      createProps.discarded = true
      createProps.title = params.title ?? url
    }

    Tabs.setNewTabPosition(index, parentId, panel.id)

    const nativeTab = await browser.tabs.create(createProps)
    const tab = await waitForTabInList(nativeTab.id)

    if (tab) {
      if (normalizedColor) {
        Tabs.setCustomColor([tab.id], normalizedColor)
      }
      const customTitle = params.customTitle ?? (!canDiscard ? params.title : undefined)
      if (customTitle) {
        tab.customTitle = customTitle
        Tabs.renderTitle(tab)
        Tabs.saveTabData(tab.id)
        Tabs.cacheTabsData()
      }
      const serialized = serializeTab(tab)
      if (serialized.url === 'about:blank' && url && url !== 'about:blank') {
        serialized.url = url
      }
      createdTabs.push(serialized)
    } else {
      Logs.warn('AgentApi.createTab: Tab not yet in Tabs.byId:', nativeTab.id)
      createdTabs.push({
        id: nativeTab.id,
        windowId: nativeTab.windowId,
        panelId: panel.id,
        index: nativeTab.index,
        url: nativeTab.url,
        title: nativeTab.title,
        customColor: normalizedColor && normalizedColor !== 'toolbar' ? normalizedColor : undefined,
        active: nativeTab.active,
        pinned: nativeTab.pinned,
        hidden: nativeTab.hidden,
        discarded: !!nativeTab.discarded,
        audible: !!nativeTab.audible,
        muted: !!nativeTab.mutedInfo?.muted,
        cookieStoreId: nativeTab.cookieStoreId,
        parentId,
        lvl: parentTab ? parentTab.lvl + 1 : 0,
        isParent: false,
        folded: false,
        isGroup: Utils.isGroupUrl(nativeTab.url),
        groupId: D.NOID,
        childrenIds: [],
      })
    }
  }

  return isBatch ? createdTabs : createdTabs[0]
}

/**
 * Group tabs under a new group tab without triggering interactive confirmation popups.
 */
export async function groupTabs(
  params: T.AgentGroupTabsParams
): Promise<{ groupTab: T.AgentTabInfo; tabIds: ID[] }> {
  if (!params.tabIds?.length) throw new Error('tabIds is required')
  const existingIds = params.tabIds.filter(id => !!Tabs.byId[id])
  if (!existingIds.length) throw new Error('No matching tabs found')

  const normalizedColor = params.color !== undefined ? normalizeColor(params.color) : undefined

  const groupNativeTab = await Tabs.groupTabs(existingIds, {
    title: params.title,
    active: !!params.active,
  })
  if (!groupNativeTab) throw new Error('Failed to create group tab')

  const groupTab = await waitForTabInList(groupNativeTab.id)
  if (!groupTab) throw new Error(`Group tab ${groupNativeTab.id} did not initialize`)

  const groupDeadline = Date.now() + 500
  while (!groupTab.isGroup && Date.now() < groupDeadline) {
    await Utils.sleep(15)
  }

  if (normalizedColor) {
    Tabs.setCustomColor([groupTab.id], normalizedColor)
  }

  return {
    groupTab: serializeTab(groupTab),
    tabIds: existingIds,
  }
}

/**
 * Flatten tab tree hierarchy for the given tabs.
 */
export function flattenTabs(params: T.AgentFlattenTabsParams): { tabIds: ID[] } {
  if (!params.tabIds?.length) throw new Error('tabIds is required')
  const existingIds = params.tabIds.filter(id => !!Tabs.byId[id])
  if (!existingIds.length) throw new Error('No matching tabs found')

  Tabs.flattenTabs(existingIds)
  return { tabIds: existingIds }
}

/**
 * Move tabs to another panel, parent tab, or index.
 */
export async function moveTabs(
  params: T.AgentMoveTabsParams
): Promise<{ tabIds: ID[]; panelId: ID; parentId: ID }> {
  if (!params.tabIds?.length) throw new Error('tabIds is required')
  const existingIds = params.tabIds.filter(id => !!Tabs.byId[id])
  if (!existingIds.length) throw new Error('No matching tabs found')

  Tabs.sortTabIds(existingIds)
  const firstTab = Tabs.byId[existingIds[0]]
  if (!firstTab) throw new Error('No matching tabs found')

  const parentTab =
    params.parentId !== undefined && params.parentId !== D.NOID
      ? Tabs.byId[params.parentId]
      : undefined
  if (params.parentId !== undefined && params.parentId !== D.NOID && !parentTab) {
    throw new Error(`Parent tab not found: ${params.parentId}`)
  }

  const panelRef = params.panelId ?? params.panel
  let dstPanel: T.TabsPanel | undefined
  if (panelRef !== undefined) {
    dstPanel = resolveTabsPanel(panelRef)
    if (!dstPanel) throw new Error(`Tabs panel not found: "${panelRef}"`)
  } else if (parentTab) {
    const p = Sidebar.panelsById[parentTab.panelId]
    if (Utils.isTabsPanel(p)) dstPanel = p
  } else {
    const p = Sidebar.panelsById[firstTab.panelId]
    if (Utils.isTabsPanel(p)) dstPanel = p
  }
  if (!dstPanel) throw new Error('Target tabs panel not found')

  if (parentTab?.folded) Tabs.expTabsBranch(parentTab.id, false)

  let dstIndex: number
  if (params.index !== undefined) {
    dstIndex = params.index
  } else if (parentTab) {
    dstIndex = parentTab.index + (Tabs.getBranchLen(parentTab.id) ?? 0) + 1
  } else {
    dstIndex = dstPanel.nextTabIndex > -1 ? dstPanel.nextTabIndex : Tabs.list.length
  }

  const items = Tabs.getTabsInfo(existingIds)
  const src: T.SrcPlaceInfo = {
    windowId: Windows.id,
    panelId: firstTab.panelId,
    pinned: firstTab.pinned,
  }
  const dst: T.DstPlaceInfo = {
    windowId: Windows.id,
    panelId: dstPanel.id,
    parentId: parentTab ? parentTab.id : D.NOID,
    index: dstIndex,
    pinned: params.pinned,
  }

  await Tabs.move(items, src, dst)

  return {
    tabIds: existingIds,
    panelId: dstPanel.id,
    parentId: parentTab ? parentTab.id : D.NOID,
  }
}

/**
 * Set or reset custom color on the specified tabs (or active tab when omitted).
 */
export function setTabColor(params: T.AgentSetTabColorParams): {
  tabIds: ID[]
  color: string | null
} {
  const color = normalizeColor(params.color)
  const rawIds = params.tabIds?.length ? [...params.tabIds] : [Tabs.activeId]
  const existingIds = rawIds.filter(id => id !== D.NOID && !!Tabs.byId[id])
  if (!existingIds.length) throw new Error('No matching tabs found')

  Tabs.setCustomColor(existingIds, color)
  return {
    tabIds: existingIds,
    color: color === 'toolbar' ? null : color,
  }
}

/**
 * Set or clear custom title on a tab.
 */
export function setTabTitle(params: T.AgentSetTabTitleParams): T.AgentTabInfo {
  const tab = Tabs.byId[params.tabId]
  if (!tab) throw new Error(`Tab not found: ${params.tabId}`)

  tab.customTitle = params.title
  Tabs.saveCustomTitle(tab.id)

  return serializeTab(tab)
}

/**
 * Activate a tab by ID.
 */
export async function activateTab(params: T.AgentActivateTabParams): Promise<{ tabId: ID }> {
  const tab = Tabs.byId[params.tabId]
  if (!tab) throw new Error(`Tab not found: ${params.tabId}`)

  await browser.tabs.update(params.tabId, { active: true })
  return { tabId: params.tabId }
}

/**
 * Close tabs without triggering confirmation dialogs.
 */
export async function closeTabs(params: T.AgentCloseTabsParams): Promise<{ tabIds: ID[] }> {
  if (!params.tabIds?.length) throw new Error('tabIds is required')
  const existingIds = params.tabIds.filter(id => !!Tabs.byId[id])
  if (!existingIds.length) throw new Error('No matching tabs found')

  await Tabs.removeTabs(existingIds, true)
  return { tabIds: existingIds }
}
