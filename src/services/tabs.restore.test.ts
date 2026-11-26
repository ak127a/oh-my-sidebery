import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { InstanceType, PanelType } from 'src/enums'
import { CONTAINER_ID, NOID } from 'src/defaults'
import * as Info from 'src/services/info'
import * as IPC from 'src/services/ipc'
import * as Settings from 'src/services/settings'
import * as Windows from 'src/services/windows.fg'
import * as Sidebar from 'src/services/sidebar.fg'
import * as Tabs from 'src/services/tabs.fg'
import * as Links from 'src/services/links'
import * as Containers from 'src/services/containers'
import { addMPanel, resetMSidebar } from 'src/defaults/mocks.sidebar.fg'
import { resetMTabs } from 'src/defaults/mocks.tabs.fg'
import type { NativeTab, TabCache, TabSessionData } from 'src/types'

function makeNativeTab(overrides: Partial<NativeTab> & { id: ID; url: string }): NativeTab {
  return {
    windowId: 1,
    index: 0,
    title: overrides.url,
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

describe('Tabs restart & snapshot restore', () => {
  beforeEach(async () => {
    Info.setInstanceType(InstanceType.sidebar)
    Settings.resetSettings()
    Settings.state.tabsTree = true
    Containers.reactive.byId = {}
    resetMTabs()
    resetMSidebar()
    Sidebar.reactive.nav = []
    await browser.storage.local.set({ tabsDataCache: undefined })
  })

  afterEach(() => {
    Tabs.unload()
    resetMTabs()
    resetMSidebar()
    Sidebar.reactive.nav = []
    Links.rmAllTabs()
    Settings.resetSettings()
    Info.setInstanceType(InstanceType.unknown)
    vi.restoreAllMocks()
  })

  test('restores panels, trees, folded state, custom titles, and custom colors from tabsDataCache after restart', async () => {
    const p1 = addMPanel({ type: PanelType.tabs, id: 'p1', name: 'Main' })
    const p2 = addMPanel({ type: PanelType.tabs, id: 'p2', name: 'Research' })
    if (!p1 || !p2) throw new Error('Expected panels')
    Sidebar.reactive.nav = [...Sidebar.nav]
    Sidebar.recalcPanels()
    Sidebar.setActivePanelId('p1')
    Sidebar.setReadyState(true)

    vi.spyOn(browser.sessions, 'getWindowValue').mockResolvedValue('win-uniq-1')
    vi.spyOn(browser.windows, 'getCurrent').mockResolvedValue({
      id: 1,
      type: 'normal',
      focused: true,
      incognito: false,
      alwaysOnTop: false,
    })
    await Windows.load()

    const cached: TabCache[][] = [
      [
        { id: 10, url: 'https://pin.example', pin: true, uniqWinId: 'win-uniq-1', panelId: 'p1' },
        { id: 11, url: 'https://parent.example', panelId: 'p1', folded: true, customColor: 'blue' },
        {
          id: 12,
          url: 'https://child.example',
          panelId: 'p1',
          parentId: 11,
          customTitle: 'Child Custom',
        },
        { id: 13, url: 'https://work.example', panelId: 'p2', customColor: 'red' },
      ],
    ]
    await browser.storage.local.set({ tabsDataCache: cached })

    // Simulated new Firefox session with completely new native tab IDs
    const nativeTabs: NativeTab[] = [
      makeNativeTab({ id: 200, index: 0, url: 'https://pin.example', pinned: true }),
      makeNativeTab({ id: 201, index: 1, url: 'https://parent.example', active: true }),
      makeNativeTab({ id: 202, index: 2, url: 'https://child.example', discarded: true }),
      makeNativeTab({ id: 203, index: 3, url: 'https://work.example', discarded: true }),
    ]

    vi.spyOn(browser.tabs, 'query').mockResolvedValue(nativeTabs)
    const setTabValSpy = vi.spyOn(browser.sessions, 'setTabValue').mockResolvedValue()
    vi.spyOn(IPC, 'bg').mockResolvedValue(false as any)

    await Tabs.load()

    expect(Tabs.list).toHaveLength(4)
    expect(Tabs.byId[200]).toMatchObject({ pinned: true, panelId: 'p1' })
    expect(Tabs.byId[201]).toMatchObject({
      panelId: 'p1',
      folded: true,
      isParent: true,
      customColor: 'blue',
    })
    expect(Tabs.byId[202]).toMatchObject({
      panelId: 'p1',
      parentId: 201,
      lvl: 1,
      invisible: true,
      customTitle: 'Child Custom',
    })
    expect(Tabs.byId[203]).toMatchObject({ panelId: 'p2', customColor: 'red' })

    expect(p1.type === PanelType.tabs && p1.tabs.map(t => t.id)).toEqual([201, 202])
    expect(p2.type === PanelType.tabs && p2.tabs.map(t => t.id)).toEqual([203])

    // Session values were re-saved under the new tab IDs
    expect(setTabValSpy).toHaveBeenCalledWith(
      202,
      'data',
      expect.objectContaining({
        id: 202,
        panelId: 'p1',
        parentId: 201,
        customTitle: 'Child Custom',
      })
    )
  })

  test('falls back to browser.sessions.getTabValue for 1-tab windows and cache mismatches after restart', async () => {
    addMPanel({ type: PanelType.tabs, id: 'p1', name: 'Main' })
    const p2 = addMPanel({ type: PanelType.tabs, id: 'p2', name: 'Side' })
    if (!p2) throw new Error('Expected panel p2')
    Sidebar.reactive.nav = [...Sidebar.nav]
    Sidebar.recalcPanels()
    Sidebar.setActivePanelId('p1')
    Sidebar.setReadyState(true)

    vi.spyOn(browser.sessions, 'getWindowValue').mockResolvedValue('win-uniq-2')
    vi.spyOn(browser.windows, 'getCurrent').mockResolvedValue({
      id: 1,
      type: 'normal',
      focused: true,
      incognito: false,
      alwaysOnTop: false,
    })
    await Windows.load()

    // 1-tab window skips findCachedData and uses browser.sessions.getTabValue
    await browser.storage.local.set({
      tabsDataCache: [[{ id: 1, url: 'https://other.example', panelId: 'p1' }]],
    })
    vi.spyOn(browser.tabs, 'query').mockResolvedValue([
      makeNativeTab({ id: 301, index: 0, url: 'https://solo.example', active: true }),
    ])
    vi.spyOn(browser.sessions, 'getTabValue').mockResolvedValue({
      id: 10,
      panelId: 'p2',
      parentId: NOID,
      folded: false,
      customColor: 'green',
      customTitle: 'Solo',
    } satisfies TabSessionData)
    vi.spyOn(browser.sessions, 'setTabValue').mockResolvedValue()
    vi.spyOn(IPC, 'bg').mockResolvedValue(false as any)

    await Tabs.load()

    expect(Tabs.byId[301]).toMatchObject({
      panelId: 'p2',
      customColor: 'green',
      customTitle: 'Solo',
    })
    expect(p2.type === PanelType.tabs && p2.tabs.map(t => t.id)).toEqual([301])

    // Multi-tab window where cache does not match falls back to sessions and remaps parentId
    Tabs.unload()
    const nativeMulti: NativeTab[] = [
      makeNativeTab({ id: 401, index: 0, url: 'https://a.example', active: true }),
      makeNativeTab({ id: 402, index: 1, url: 'https://b.example', discarded: true }),
    ]
    vi.spyOn(browser.tabs, 'query').mockResolvedValue(nativeMulti)
    vi.spyOn(browser.sessions, 'getTabValue').mockImplementation(async tabId => {
      if (tabId === 401) {
        return { id: 81, panelId: 'p2', parentId: NOID, folded: true, customColor: 'yellow' }
      }
      if (tabId === 402) {
        return { id: 82, panelId: 'p2', parentId: 81, folded: false, customTitle: 'Child B' }
      }
      return undefined
    })

    await Tabs.load()

    expect(Tabs.byId[401]).toMatchObject({
      panelId: 'p2',
      folded: true,
      isParent: true,
      customColor: 'yellow',
    })
    expect(Tabs.byId[402]).toMatchObject({
      panelId: 'p2',
      parentId: 401,
      lvl: 1,
      invisible: true,
      customTitle: 'Child B',
    })
  })

  test('Tabs.open preserves and persists customTitle, customColor, and folded regardless of onTabCreated timing', async () => {
    const p1 = addMPanel({ type: PanelType.tabs, id: 'p1', name: 'Main' })
    if (!p1) throw new Error('Expected panel p1')
    Sidebar.reactive.nav = [...Sidebar.nav]
    Sidebar.recalcPanels()
    Sidebar.setActivePanelId('p1')
    Sidebar.setReadyState(true)

    vi.spyOn(browser.sessions, 'getWindowValue').mockResolvedValue('win-uniq-3')
    vi.spyOn(browser.windows, 'getCurrent').mockResolvedValue({
      id: 1,
      type: 'normal',
      focused: true,
      incognito: false,
      alwaysOnTop: false,
    })
    await Windows.load()
    vi.spyOn(browser.tabs, 'query').mockResolvedValue([])
    vi.spyOn(IPC, 'bg').mockResolvedValue(false as any)
    const createdListeners: Array<(t: NativeTab) => void> = []
    vi.spyOn(browser.tabs.onCreated, 'addListener').mockImplementation(fn => {
      createdListeners.push(fn)
    })

    await Tabs.load()
    expect(createdListeners.length).toBeGreaterThan(0)

    // Case A: onTabCreated runs AFTER browser.tabs.create resolves
    let nextId = 500
    const createdNativeTabs: NativeTab[] = []
    vi.spyOn(browser.tabs, 'create').mockImplementation(async props => {
      const t = makeNativeTab({
        id: nextId++,
        index: props.index ?? 0,
        url: props.url ?? 'about:newtab',
        title: props.title ?? 'New Tab',
        active: !!props.active,
      })
      createdNativeTabs.push(t)
      return t
    })
    const setTabValSpy = vi.spyOn(browser.sessions, 'setTabValue').mockResolvedValue()

    const ok = await Tabs.open(
      [
        {
          id: 1,
          url: 'https://delayed.example',
          title: 'Delayed',
          customTitle: 'Delayed Custom',
          customColor: 'pink',
          folded: true,
        },
      ],
      { panelId: p1.id, index: 0 }
    )
    expect(ok).toBe(true)

    expect(Tabs.newTabsPosition[0]).toMatchObject({
      panel: p1.id,
      customTitle: 'Delayed Custom',
      customColor: 'pink',
      folded: true,
    })

    // Fire the captured onTabCreated handler after browser.tabs.create resolved
    await createdListeners[0](createdNativeTabs[0])
    expect(Tabs.byId[500]).toMatchObject({
      panelId: p1.id,
      customTitle: 'Delayed Custom',
      customColor: 'pink',
      folded: true,
    })
    expect(Tabs.byId[500]?.reactive.customColor).toBe('pink')
    expect(Tabs.byId[500]?.reactive.folded).toBe(true)

    // Case B: onTabCreated populates Tabs.byId BEFORE browser.tabs.create resolves
    Tabs.unload()
    await Tabs.load()
    vi.spyOn(browser.tabs, 'create').mockImplementation(async props => {
      const t = makeNativeTab({
        id: 601,
        index: props.index ?? 0,
        url: props.url ?? 'about:newtab',
        title: props.title ?? 'New Tab',
      })
      const sideberyTab = Tabs.mutateNativeTabToSideberyTab(t)
      sideberyTab.panelId = p1.id
      Tabs.byId[sideberyTab.id] = sideberyTab
      Tabs.list.push(sideberyTab)
      return t
    })

    await Tabs.open(
      [
        {
          id: 2,
          url: 'https://immediate.example',
          title: 'Immediate',
          customTitle: 'Immediate Custom',
          customColor: 'orange',
          folded: true,
        },
      ],
      { panelId: p1.id, index: 0 }
    )

    expect(Tabs.byId[601]).toMatchObject({
      customTitle: 'Immediate Custom',
      customColor: 'orange',
      folded: true,
    })
    expect(Tabs.byId[601]?.reactive.customColor).toBe('orange')
    expect(Tabs.byId[601]?.reactive.folded).toBe(true)
    expect(setTabValSpy).toHaveBeenCalledWith(
      601,
      'data',
      expect.objectContaining({
        id: 601,
        customTitle: 'Immediate Custom',
        customColor: 'orange',
        folded: true,
      })
    )
  })
})
