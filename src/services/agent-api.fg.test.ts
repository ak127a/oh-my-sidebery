import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PanelType } from 'src/enums'
import { NOID } from 'src/defaults'
import * as Settings from 'src/services/settings'
import * as Sidebar from 'src/services/sidebar.fg'
import * as Tabs from 'src/services/tabs.fg'
import * as AgentApi from 'src/services/agent-api.fg'
import { addMPanel, resetMSidebar } from 'src/defaults/mocks.sidebar.fg'
import { addMTab, addMTTab, resetMTabs, setDefaultMTabPanel } from 'src/defaults/mocks.tabs.fg'

describe('AgentApi foreground service', () => {
  beforeEach(() => {
    Settings.state.tabsTree = true
    Sidebar.setReadyState(true)
  })

  afterEach(() => {
    Settings.resetSettings()
    resetMTabs()
    resetMSidebar()
    Sidebar.reactive.nav = []
    vi.restoreAllMocks()
  })

  test('getWindowState returns panels, tabs, tree hierarchy, and groups', () => {
    const p1 = addMPanel({ type: PanelType.tabs, id: 'p1', name: 'Work', color: 'blue' })
    const p2 = addMPanel({ type: PanelType.tabs, id: 'p2', name: 'Docs', color: 'green' })
    Sidebar.reactive.nav = [...Sidebar.nav]
    Sidebar.recalcPanels()
    Sidebar.setActivePanelId('p1')
    setDefaultMTabPanel('p1')

    const gTab = addMTTab({
      id: 10,
      isGroup: true,
      title: 'Research',
      url: 'moz-extension://x/sidebery/group.html#Research',
    })
    const c1 = addMTTab(0, {
      id: 11,
      title: 'MDN',
      url: 'https://developer.mozilla.org',
      active: true,
      customColor: 'turquoise',
    })
    const c2 = addMTTab(0, 1, {
      id: 12,
      title: 'Nested',
      url: 'https://example.com',
    })
    const p2Tab = addMTab({
      id: 20,
      panelId: 'p2',
      title: 'Guide',
      url: 'https://guide.example',
    })
    if (p1 && 'tabs' in p1) p1.tabs = [gTab, c1, c2]
    if (p2 && 'tabs' in p2) p2.tabs = [p2Tab]

    const state = AgentApi.getWindowState()
    expect(state.window.activePanelId).toBe('p1')
    expect(state.window.activeTabId).toBe(11)
    expect(state.panels).toHaveLength(2)
    expect(state.panels[0]).toMatchObject({ id: 'p1', name: 'Work', color: 'blue', tabCount: 3 })

    expect(state.tabs).toHaveLength(4)
    expect(state.tabs[0]).toMatchObject({
      id: 10,
      isGroup: true,
      groupId: NOID,
      childrenIds: [11],
    })
    expect(state.tabs[1]).toMatchObject({
      id: 11,
      parentId: 10,
      groupId: 10,
      customColor: 'turquoise',
      childrenIds: [12],
    })
    expect(state.tabs[2]).toMatchObject({
      id: 12,
      parentId: 11,
      groupId: 10,
      lvl: 2,
    })
    expect(state.tabs[3]).toMatchObject({ id: 20, panelId: 'p2', groupId: NOID })

    expect(state.groups).toHaveLength(1)
    expect(state.groups[0]).toMatchObject({
      id: 10,
      title: 'Research',
      panelId: 'p1',
      tabIds: [11, 12],
    })
  })

  test('setTabColor updates active or specified tabs and supports reset aliases', () => {
    const t1 = addMTab({ id: 2, active: true })
    const t2 = addMTab({ id: 3 })

    const r1 = AgentApi.setTabColor({ color: 'orange' })
    expect(r1).toEqual({ tabIds: [2], color: 'orange' })
    expect(t1.customColor).toBe('orange')
    expect(t2.customColor).toBeUndefined()

    const r2 = AgentApi.setTabColor({ tabIds: [2, 3], color: 'purple' })
    expect(r2).toEqual({ tabIds: [2, 3], color: 'purple' })
    expect(t1.customColor).toBe('purple')
    expect(t2.customColor).toBe('purple')

    const r3 = AgentApi.setTabColor({ tabIds: [2], color: 'none' })
    expect(r3).toEqual({ tabIds: [2], color: null })
    expect(t1.customColor).toBeUndefined()

    expect(() => AgentApi.setTabColor({ color: 'invalid_color' })).toThrow(/Invalid color/)
  })

  test('createPanel adds a new tabs panel and activates it when requested', async () => {
    addMPanel({ type: PanelType.tabs, id: 'p1', name: 'Main' })
    Sidebar.reactive.nav = [...Sidebar.nav]
    Sidebar.recalcPanels()
    Sidebar.setActivePanelId('p1')
    vi.spyOn(Sidebar, 'saveSidebar').mockResolvedValue()
    vi.spyOn(Tabs, 'load').mockResolvedValue()

    const created = await AgentApi.createPanel({
      name: 'AI Tasks',
      color: 'pink',
      activate: true,
    })

    expect(created.name).toBe('AI Tasks')
    expect(created.color).toBe('pink')
    expect(created.type).toBe('tabs')
    expect(Sidebar.panelsById[created.id]).toBeDefined()
    expect(Sidebar.activePanelId).toBe(created.id)
  })

  test('createTab creates tabs in the requested panel and applies custom color', async () => {
    addMPanel({ type: PanelType.tabs, id: 'p1', name: 'Main' })
    const p2 = addMPanel({ type: PanelType.tabs, id: 'p2', name: 'Research' })
    Sidebar.reactive.nav = [...Sidebar.nav]
    Sidebar.recalcPanels()
    Sidebar.setActivePanelId('p1')
    if (p2 && 'nextTabIndex' in p2) p2.nextTabIndex = 0

    let nextId = 100
    vi.spyOn(browser.tabs, 'create').mockImplementation(async props => {
      const id = nextId++
      const tab = addMTab({
        id,
        panelId: 'p2',
        url: props.url || 'about:newtab',
        title: props.url || 'New Tab',
        active: !!props.active,
        pinned: !!props.pinned,
      })
      return tab
    })

    const created = await AgentApi.createTab({
      panel: 'Research',
      url: 'https://example.org',
      color: 'blue',
      customTitle: 'Example Org',
    })

    expect(Array.isArray(created)).toBe(false)
    if (!Array.isArray(created)) {
      expect(created.id).toBe(100)
      expect(created.panelId).toBe('p2')
      expect(created.customColor).toBe('blue')
      expect(created.customTitle).toBe('Example Org')
    }
  })

  test('createTab batch mode does not double-count panel.nextTabIndex', async () => {
    addMPanel({ type: PanelType.tabs, id: 'p1', name: 'Main' })
    const p2 = addMPanel({ type: PanelType.tabs, id: 'p2', name: 'Batch' })
    Sidebar.reactive.nav = [...Sidebar.nav]
    Sidebar.recalcPanels()
    Sidebar.setActivePanelId('p1')
    if (p2 && 'nextTabIndex' in p2) p2.nextTabIndex = 0

    let nextId = 200
    const createdIndices: number[] = []
    vi.spyOn(browser.tabs, 'create').mockImplementation(async props => {
      createdIndices.push(props.index ?? -1)
      const id = nextId++
      const tab = addMTab({
        id,
        panelId: 'p2',
        url: props.url || 'about:newtab',
        title: props.url || 'New Tab',
      })
      if (p2 && 'nextTabIndex' in p2) p2.nextTabIndex = Tabs.list.length
      return tab
    })

    const created = await AgentApi.createTab({
      panel: 'Batch',
      urls: ['https://a.test', 'https://b.test'],
      color: 'blue',
    })

    expect(createdIndices).toEqual([0, 1])
    expect(Array.isArray(created)).toBe(true)
    if (Array.isArray(created)) {
      expect(created.map(t => t.panelId)).toEqual(['p2', 'p2'])
      expect(created.map(t => t.index)).toEqual([0, 1])
    }
  })

  test('groupTabs creates a group tab and applies color', async () => {
    addMPanel({ type: PanelType.tabs, id: 'p1', name: 'Main' })
    Sidebar.reactive.nav = [...Sidebar.nav]
    Sidebar.recalcPanels()
    Sidebar.setActivePanelId('p1')
    setDefaultMTabPanel('p1')

    addMTab({ id: 5, title: 'Tab A', url: 'https://a.test' })
    addMTab({ id: 6, title: 'Tab B', url: 'https://b.test' })

    vi.spyOn(Tabs, 'groupTabs').mockImplementation(async (tabIds, conf) => {
      const groupTab = addMTab({
        id: 50,
        isGroup: true,
        title: conf?.title ?? 'Group',
        url: `moz-extension://x/sidebery/group.html#${conf?.title ?? 'Group'}`,
      })
      for (const id of tabIds) {
        const t = Tabs.byId[id]
        if (t) {
          t.parentId = groupTab.id
          t.lvl = 1
        }
      }
      groupTab.isParent = true
      return groupTab
    })

    const res = await AgentApi.groupTabs({
      tabIds: [5, 6],
      title: 'My Group',
      color: 'yellow',
    })

    expect(res.groupTab.id).toBe(50)
    expect(res.groupTab.customColor).toBe('yellow')
    expect(res.tabIds).toEqual([5, 6])
  })

  test('moveTabs delegates to Tabs.move with resolved panel and parent', async () => {
    addMPanel({ type: PanelType.tabs, id: 'p1', name: 'Main' })
    const p2 = addMPanel({ type: PanelType.tabs, id: 'p2', name: 'Target' })
    Sidebar.reactive.nav = [...Sidebar.nav]
    Sidebar.recalcPanels()
    if (p2 && 'nextTabIndex' in p2) p2.nextTabIndex = 1

    setDefaultMTabPanel('p1')
    addMTab({ id: 7, panelId: 'p1', title: 'Move me' })
    addMTab({ id: 8, panelId: 'p2', title: 'Parent', lvl: 0 })

    const moveSpy = vi.spyOn(Tabs, 'move').mockResolvedValue()

    const res = await AgentApi.moveTabs({ tabIds: [7], panel: 'Target', parentId: 8 })
    expect(res).toEqual({ tabIds: [7], panelId: 'p2', parentId: 8 })
    expect(moveSpy).toHaveBeenCalledTimes(1)
  })
})
