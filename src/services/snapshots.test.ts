import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { InstanceType, PanelType, SnapStoreMode } from 'src/enums'
import { CONTAINER_ID, DEFAULT_CONTAINER_ID, GROUP_URL, NOID } from 'src/defaults'
import * as Info from 'src/services/info'
import * as IPC from 'src/services/ipc'
import * as Utils from 'src/utils'
import * as Settings from 'src/services/settings'
import * as Windows from 'src/services/windows.bg'
import * as TabsBg from 'src/services/tabs.bg'
import * as Containers from 'src/services/containers.bg'
import * as SnapshotsBg from 'src/services/snapshots.bg'
import * as SnapshotsFg from 'src/services/snapshots.fg'
import * as SidebarConf from 'src/services/sidebar-config'
import type { BgTab, BgWindow, Container, NormalizedSnapshot, Stored } from 'src/types'

function makeBgTab(overrides: Partial<BgTab> & { id: ID; url: string; title: string }): BgTab {
  return {
    windowId: 1,
    index: 0,
    active: false,
    pinned: false,
    highlighted: false,
    hidden: false,
    incognito: false,
    isInReaderMode: false,
    lastAccessed: 0,
    cookieStoreId: CONTAINER_ID,
    ...overrides,
  }
}

function clearTabsBgState() {
  for (const k of Object.keys(TabsBg.byId)) delete TabsBg.byId[k]
  for (const k of Object.keys(TabsBg.cacheByWin)) delete TabsBg.cacheByWin[k]
}

describe('Snapshots service', () => {
  beforeEach(async () => {
    Info.setInstanceType(InstanceType.bg)
    Settings.resetSettings()
    Windows.byId.clear()
    clearTabsBgState()
    Containers.reactive.byId = {}
    await browser.storage.local.set({
      sidebar: undefined,
      containers: undefined,
      snapshots: undefined,
    })
  })

  afterEach(() => {
    Settings.resetSettings()
    Windows.byId.clear()
    clearTabsBgState()
    Containers.reactive.byId = {}
    Info.setInstanceType(InstanceType.unknown)
    vi.restoreAllMocks()
  })

  test('full round-trip preserves panels, pinned tabs, trees, folded state, containers, custom colors/titles, and internal URLs', async () => {
    const sidebar = SidebarConf.createDefaultSidebarConfig()
    const tabsPanelId = sidebar.nav.find(id => sidebar.panels[id]?.type === PanelType.tabs) as ID
    const secondPanel = SidebarConf.createTabsPanelConfig({ id: 'p_work', name: 'Work' })
    sidebar.nav.push(secondPanel.id)
    sidebar.panels[secondPanel.id] = secondPanel

    const containerId = 'firefox-container-1'
    const containers: Record<string, Container> = {
      [containerId]: {
        id: containerId,
        cookieStoreId: containerId,
        name: 'Work',
        color: 'blue',
        colorCode: '#37adff',
        icon: 'briefcase',
        proxified: false,
        proxy: null,
        reopenRulesActive: false,
        reopenRules: [],
        userAgentActive: false,
        userAgent: '',
      },
    }
    Containers.reactive.byId = structuredClone(containers)

    const oldOrigin = 'moz-extension://11111111-1111-1111-1111-111111111111'
    const rawTabs: BgTab[] = [
      makeBgTab({ id: 10, index: 0, url: 'https://pin.example', title: 'Pinned', pinned: true }),
      makeBgTab({
        id: 11,
        index: 1,
        url: `${oldOrigin}/sidebery/group.html#Research`,
        title: 'Research',
        customColor: 'green',
      }),
      makeBgTab({
        id: 12,
        index: 2,
        url: 'https://mdn.example',
        title: 'MDN',
        cookieStoreId: containerId,
        customTitle: 'MDN Docs',
        customColor: 'turquoise',
      }),
      makeBgTab({
        id: 13,
        index: 3,
        url: 'https://nested.example',
        title: 'Nested',
      }),
      makeBgTab({
        id: 14,
        index: 4,
        url: `${oldOrigin}/sidebery/url.html#about:config`,
        title: 'about:config',
        customColor: 'yellow',
      }),
    ]

    const bgWin: BgWindow = {
      id: 1,
      type: 'normal',
      focused: true,
      alwaysOnTop: false,
      incognito: false,
      tabs: rawTabs,
      activeTabId: 11,
      activePanelId: tabsPanelId,
    }
    Windows.byId.set(1, bgWin)
    for (const t of rawTabs) TabsBg.byId[t.id] = t

    await browser.storage.local.set({ sidebar, containers, snapshots: [] })

    vi.spyOn(IPC, 'getConnection').mockReturnValue({ id: 1, type: InstanceType.sidebar } as any)
    vi.spyOn(IPC, 'sidebar').mockResolvedValue([
      { id: 10, pid: tabsPanelId },
      { id: 11, pid: tabsPanelId, cc: 'green', f: 1 },
      { id: 12, pid: tabsPanelId, tid: 11, ct: 'MDN Docs', cc: 'turquoise' },
      { id: 13, pid: tabsPanelId, tid: 12 },
      { id: 14, pid: secondPanel.id, cc: 'yellow' },
    ])

    const created = await SnapshotsBg.createSnapshot()
    expect(created).toBeDefined()

    const stored = await browser.storage.local.get<Stored>('snapshots')
    expect(stored.snapshots).toHaveLength(1)
    if (!stored.snapshots) throw new Error('Expected snapshots')
    const normalized = SnapshotsFg.getNormalizedSnapshot(stored.snapshots, 0)
    expect(normalized).toBeDefined()
    if (!normalized) throw new Error('Expected normalized snapshot')

    // Simulate restoring into a fresh add-on instance where the Work panel & container are missing
    const freshSidebar = SidebarConf.createDefaultSidebarConfig()
    await browser.storage.local.set({ sidebar: freshSidebar })
    Containers.reactive.byId = {}

    let nextWinId = 50
    let nextTabId = 500
    const createdTabCalls: browser.tabs.CreateProperties[] = []
    const sessionWrites: Record<ID, any> = {}
    const openerUpdates: Array<{ tabId: ID; openerTabId?: ID }> = []

    vi.spyOn(browser.contextualIdentities, 'create').mockResolvedValue({
      cookieStoreId: 'firefox-container-99',
      name: 'Work',
      color: 'blue',
      icon: 'briefcase',
      colorCode: '#37adff',
    } as Container)
    vi.spyOn(browser.windows, 'create').mockImplementation(async () => {
      const winId = nextWinId++
      const initTab = { id: nextTabId++, windowId: winId, index: 0, url: 'about:blank' } as any
      Windows.byId.set(winId, {
        id: winId,
        type: 'normal',
        focused: true,
        alwaysOnTop: false,
        incognito: false,
        tabs: [initTab],
        activeTabId: initTab.id,
        activePanelId: NOID,
      })
      return { id: winId, tabs: [initTab], incognito: false, alwaysOnTop: false, focused: true }
    })
    vi.spyOn(browser.tabs, 'create').mockImplementation(async props => {
      createdTabCalls.push(props)
      return {
        id: nextTabId++,
        windowId: props.windowId ?? 1,
        index: props.index ?? 0,
        url: props.url ?? 'about:blank',
        cookieStoreId: props.cookieStoreId ?? DEFAULT_CONTAINER_ID,
      } as browser.tabs.Tab
    })
    vi.spyOn(browser.tabs, 'update').mockImplementation((async (
      tabId: ID,
      props: browser.tabs.UpdateProperties
    ) => {
      openerUpdates.push({ tabId, openerTabId: props.openerTabId })
      return {} as browser.tabs.Tab
    }) as typeof browser.tabs.update)
    vi.spyOn(browser.tabs, 'remove').mockResolvedValue()
    vi.spyOn(browser.sessions, 'setTabValue').mockImplementation(async (tabId, key, val) => {
      if (key === 'data') sessionWrites[tabId] = val
    })

    await SnapshotsBg.openWindows(structuredClone(normalized))

    // Missing panel was recreated in sidebar config
    const updatedStored = await browser.storage.local.get<Stored>('sidebar')
    expect(updatedStored.sidebar?.panels[secondPanel.id]).toBeDefined()

    // Tabs created in order with rebased internal URLs and mapped container ID
    expect(createdTabCalls).toHaveLength(5)
    expect(createdTabCalls[0]).toMatchObject({ pinned: true, url: 'https://pin.example' })
    expect(createdTabCalls[1].url).toBe(`${GROUP_URL}#Research`)
    expect(createdTabCalls[2]).toMatchObject({
      url: 'https://mdn.example',
      cookieStoreId: 'firefox-container-99',
    })
    expect(createdTabCalls[4].url).toBe(
      Utils.createPlaceholderUrl({ url: 'about:config', title: 'about:config' })
    )

    // Session data preserves panelId, parentId, folded, customTitle, customColor
    const written = Object.values(sessionWrites)
    expect(written).toHaveLength(5)
    const groupSession = written.find(s => s.customColor === 'green')
    const mdnSession = written.find(s => s.customTitle === 'MDN Docs')
    const nestedSession = written.find(s => s.parentId === mdnSession?.id)
    const workSession = written.find(s => s.panelId === secondPanel.id)

    expect(groupSession).toMatchObject({ folded: true, customColor: 'green', panelId: tabsPanelId })
    expect(mdnSession).toMatchObject({
      parentId: groupSession.id,
      customTitle: 'MDN Docs',
      customColor: 'turquoise',
      panelId: tabsPanelId,
    })
    expect(nestedSession).toMatchObject({ parentId: mdnSession.id, panelId: tabsPanelId })
    expect(workSession).toMatchObject({ customColor: 'yellow', panelId: secondPanel.id })
    expect(openerUpdates).toEqual(
      expect.arrayContaining([
        { tabId: mdnSession.id, openerTabId: groupSession.id },
        { tabId: nestedSession.id, openerTabId: mdnSession.id },
      ])
    )
  })

  test('unfolding a branch clears folded state on subsequent snapshot', async () => {
    const sidebar = SidebarConf.createDefaultSidebarConfig()
    const tabsPanelId = sidebar.nav.find(id => sidebar.panels[id]?.type === PanelType.tabs) as ID
    await browser.storage.local.set({ sidebar, containers: {}, snapshots: [] })

    const parent = makeBgTab({ id: 1, index: 0, url: 'https://a.test', title: 'A' })
    const child = makeBgTab({ id: 2, index: 1, url: 'https://b.test', title: 'B' })
    Windows.byId.set(1, {
      id: 1,
      type: 'normal',
      focused: true,
      alwaysOnTop: false,
      incognito: false,
      tabs: [parent, child],
      activeTabId: 1,
      activePanelId: tabsPanelId,
    })
    Object.assign(TabsBg.byId, { 1: parent, 2: child })

    vi.spyOn(IPC, 'getConnection').mockReturnValue({ id: 1, type: InstanceType.sidebar } as any)
    const ipcSpy = vi
      .spyOn(IPC, 'sidebar')
      .mockResolvedValueOnce([
        { id: 1, pid: tabsPanelId, f: 1 },
        { id: 2, pid: tabsPanelId, tid: 1 },
      ])
      .mockResolvedValueOnce([
        { id: 1, pid: tabsPanelId },
        { id: 2, pid: tabsPanelId, tid: 1 },
      ])

    await SnapshotsBg.createSnapshot()
    await SnapshotsBg.createSnapshot()
    expect(ipcSpy).toHaveBeenCalledTimes(2)

    const stored = await browser.storage.local.get<Stored>('snapshots')
    expect(stored.snapshots).toHaveLength(2)
    if (!stored.snapshots) throw new Error('Expected snapshots')

    const snap1 = SnapshotsFg.getNormalizedSnapshot(stored.snapshots, 0)
    const snap2 = SnapshotsFg.getNormalizedSnapshot(stored.snapshots, 1)
    if (!snap1 || !snap2) throw new Error('Expected normalized snapshots')
    expect(snap1.tabs[0][0][0].folded).toBe(true)
    expect(snap2.tabs[0][0][0].folded).toBeUndefined()
  })

  test('disconnected sidebar falls back to cacheByWin and then browser.sessions.getTabValue', async () => {
    const sidebar = SidebarConf.createDefaultSidebarConfig()
    const tabsPanelId = sidebar.nav.find(id => sidebar.panels[id]?.type === PanelType.tabs) as ID
    await browser.storage.local.set({ sidebar, containers: {}, snapshots: [] })

    // 1. Fallback to cacheByWin when sidebar is disconnected
    const t1 = makeBgTab({ id: 21, index: 0, url: 'https://one.test', title: 'One' })
    const t2 = makeBgTab({ id: 22, index: 1, url: 'https://two.test', title: 'Two' })
    Windows.byId.set(1, {
      id: 1,
      type: 'normal',
      focused: true,
      alwaysOnTop: false,
      incognito: false,
      tabs: [t1, t2],
      activeTabId: 21,
      activePanelId: tabsPanelId,
    })
    Object.assign(TabsBg.byId, { 21: t1, 22: t2 })
    TabsBg.cacheByWin[1] = [
      { id: 21, url: 'https://one.test', panelId: tabsPanelId, folded: true, customColor: 'red' },
      {
        id: 22,
        url: 'https://two.test',
        panelId: tabsPanelId,
        parentId: 21,
        customTitle: 'Two Custom',
      },
    ]

    vi.spyOn(IPC, 'getConnection').mockReturnValue(undefined)

    await SnapshotsBg.createSnapshot()
    let stored = await browser.storage.local.get<Stored>('snapshots')
    if (!stored.snapshots) throw new Error('Expected snapshots')
    const fromCache = SnapshotsFg.getNormalizedSnapshot(stored.snapshots, 0)
    if (!fromCache) throw new Error('Expected normalized snapshot from cache')
    expect(fromCache.tabs[0][0][0]).toMatchObject({
      panelId: tabsPanelId,
      folded: true,
      customColor: 'red',
    })
    expect(fromCache.tabs[0][0][1]).toMatchObject({
      panelId: tabsPanelId,
      lvl: 1,
      customTitle: 'Two Custom',
    })

    // 2. Fallback to browser.sessions.getTabValue (remapping previous-session parentId) when cache is absent
    delete TabsBg.cacheByWin[1]
    t1.folded = false
    t1.customColor = undefined
    t2.customTitle = undefined
    await browser.storage.local.set({ snapshots: [] })

    vi.spyOn(browser.sessions, 'getTabValue').mockImplementation(async tabId => {
      if (tabId === 21) {
        return {
          id: 901,
          panelId: tabsPanelId,
          parentId: NOID,
          folded: true,
          customColor: 'purple',
        }
      }
      if (tabId === 22) {
        return {
          id: 902,
          panelId: tabsPanelId,
          parentId: 901,
          folded: false,
          customTitle: 'Restored Title',
        }
      }
      return undefined
    })

    await SnapshotsBg.createSnapshot()
    stored = await browser.storage.local.get<Stored>('snapshots')
    if (!stored.snapshots) throw new Error('Expected snapshots')
    const fromSession = SnapshotsFg.getNormalizedSnapshot(stored.snapshots, 0)
    if (!fromSession) throw new Error('Expected normalized snapshot from session')
    expect(fromSession.tabs[0][0][0]).toMatchObject({
      panelId: tabsPanelId,
      folded: true,
      customColor: 'purple',
    })
    expect(fromSession.tabs[0][0][1]).toMatchObject({
      panelId: tabsPanelId,
      lvl: 1,
      customTitle: 'Restored Title',
    })
  })

  test('Windows.createWithTabs awaits sessions.setTabValue before unlocking window tabs', async () => {
    let resolveSetTabValue!: () => void
    const setTabValuePromise = new Promise<void>(resolve => {
      resolveSetTabValue = resolve
    })

    vi.spyOn(browser.windows, 'create').mockResolvedValue({
      id: 77,
      tabs: [{ id: 700, windowId: 77, index: 0, url: 'about:blank' } as browser.tabs.Tab],
      incognito: false,
      alwaysOnTop: false,
      focused: true,
    })
    vi.spyOn(browser.tabs, 'create').mockResolvedValue({
      id: 701,
      windowId: 77,
      index: 0,
      url: 'https://solo.example',
      cookieStoreId: DEFAULT_CONTAINER_ID,
    } as browser.tabs.Tab)
    vi.spyOn(browser.tabs, 'remove').mockResolvedValue()
    vi.spyOn(browser.sessions, 'setTabValue').mockReturnValue(setTabValuePromise)

    let finished = false
    const creating = Windows.createWithTabs([
      {
        id: 0,
        url: 'https://solo.example',
        title: 'Solo',
        panelId: 'p1',
        customColor: 'orange',
        active: true,
      },
    ]).then(res => {
      finished = true
      return res
    })

    // Flush microtasks up to setTabValue wait
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(finished).toBe(false)
    expect(Windows.isWindowTabsLocked(77)).toBe(true)

    resolveSetTabValue()
    const ok = await creating
    expect(ok).toBe(true)
    expect(finished).toBe(true)

    const lockResult = Windows.isWindowTabsLocked(77)
    expect(typeof lockResult).toBe('object')
  })

  test('foldBranchInViewer does not mutate underlying snapshot folded state', () => {
    const sidebar = SidebarConf.createDefaultSidebarConfig()
    const tabsPanelId = sidebar.nav.find(id => sidebar.panels[id]?.type === PanelType.tabs) as ID

    const rawSnapshot: NormalizedSnapshot = {
      id: 'snap-1',
      time: Date.now(),
      containers: {},
      sidebar,
      tabs: [
        [
          [
            { url: 'https://parent.test', title: 'Parent', panelId: tabsPanelId, folded: true },
            { url: 'https://child.test', title: 'Child', panelId: tabsPanelId, lvl: 1 },
          ],
        ],
      ],
    }

    const parsed = SnapshotsFg.parseSnapshot([rawSnapshot], 0, 0)
    if (!parsed) throw new Error('Expected parsed snapshot')
    const viewerTabs = parsed.windows[0].panels[0].tabs
    expect(viewerTabs[0].folded).toBe(true)
    expect(viewerTabs[1].invisible).toBe(true)

    // Expand in viewer UI
    SnapshotsFg.foldBranchInViewer(0, viewerTabs)
    expect(viewerTabs[0].folded).toBe(false)
    expect(viewerTabs[1].invisible).toBe(false)

    // Underlying snapshot data remains folded: true
    const exported = SnapshotsFg.snapshotStateToNormalizedSnapshot(parsed)
    expect(exported.tabs[0][0][0].folded).toBe(true)
  })

  test('openWindows preserves non-contiguous panel chunks and avoids cross-panel parenting', async () => {
    const sidebar = SidebarConf.createDefaultSidebarConfig()
    const p1 = sidebar.nav.find(id => sidebar.panels[id]?.type === PanelType.tabs) as ID
    const p2Conf = SidebarConf.createTabsPanelConfig({ id: 'p2', name: 'P2' })
    sidebar.nav.push(p2Conf.id)
    sidebar.panels[p2Conf.id] = p2Conf
    await browser.storage.local.set({ sidebar })

    const snapshot: NormalizedSnapshot = {
      id: 'snap-2',
      time: Date.now(),
      containers: {},
      sidebar,
      tabs: [
        [
          [{ url: 'https://p1-a.test', title: 'P1 A', panelId: p1, lvl: 0 }],
          [{ url: 'https://p2-a.test', title: 'P2 A', panelId: p2Conf.id, lvl: 1 }],
          [{ url: 'https://p1-b.test', title: 'P1 B', panelId: p1, lvl: 0 }],
        ],
      ],
    }

    const createWithTabsSpy = vi.spyOn(Windows, 'createWithTabs').mockResolvedValue(true)
    await SnapshotsBg.openWindows(snapshot)

    expect(createWithTabsSpy).toHaveBeenCalledTimes(1)
    const items = createWithTabsSpy.mock.calls[0][0]
    expect(items).toHaveLength(3)
    expect(items.map(i => i.url)).toEqual([
      'https://p1-a.test',
      'https://p1-b.test',
      'https://p2-a.test',
    ])
    // P2 tab has lvl: 1 with no lvl: 0 parent in P2 — must NOT parent to P1's tab
    expect(items[2].parentId).toBe(NOID)
  })

  test('minimizeSnapshot compresses unchanged fields and getNormalizedSnapshot restores them', () => {
    const sidebar = SidebarConf.createDefaultSidebarConfig()
    const p1 = sidebar.nav.find(id => sidebar.panels[id]?.type === PanelType.tabs) as ID

    const base: NormalizedSnapshot = {
      id: 's1',
      time: 1000,
      containers: {},
      sidebar,
      tabs: [[[{ url: 'https://a.test', title: 'A', panelId: p1, customColor: 'blue' }]]],
    }
    const next: NormalizedSnapshot = {
      id: 's2',
      time: 2000,
      containers: {},
      sidebar: structuredClone(sidebar),
      tabs: [[[{ url: 'https://a.test', title: 'A', panelId: p1, customColor: 'blue' }]]],
    }

    SnapshotsFg.minimizeSnapshot([base], next)
    expect(next.containers).toBe(SnapStoreMode.Unchanged)
    expect(next.sidebar).toBe(SnapStoreMode.Unchanged)
    expect(next.tabs[0][0][0]).toBe(SnapStoreMode.Unchanged)

    const restored = SnapshotsFg.getNormalizedSnapshot([base, next], 1)
    expect(restored).toBeDefined()
    if (!restored) throw new Error('Expected restored snapshot')
    expect(restored.sidebar).toEqual(sidebar)
    expect(restored.tabs[0][0][0]).toEqual({
      url: 'https://a.test',
      title: 'A',
      panelId: p1,
      customColor: 'blue',
    })
  })
})
