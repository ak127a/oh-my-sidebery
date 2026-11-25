export interface AgentApiRequest {
  id: string
  method: string
  params?: Record<string, any>
}

export type AgentApiResponse =
  { id: string; ok: true; data: any } | { id: string; ok: false; error: string }

export interface AgentContainerInfo {
  id: string
  name: string
  color: string
  icon: string
}

export interface AgentPanelInfo {
  id: ID
  type: string
  name: string
  color: string
  iconSVG: string
  index: number
  hidden: boolean
  lockedPanel: boolean
  newTabCtx?: string
  tabCount: number
  pinnedTabCount: number
}

export interface AgentTabInfo {
  id: ID
  windowId: ID
  panelId: ID
  index: number
  url: string
  title: string
  customTitle?: string
  customColor?: string
  active: boolean
  pinned: boolean
  hidden: boolean
  discarded: boolean
  audible: boolean
  muted: boolean
  cookieStoreId: string
  parentId: ID
  lvl: number
  isParent: boolean
  folded: boolean
  isGroup: boolean
  groupId: ID
  childrenIds: ID[]
}

export interface AgentGroupInfo {
  id: ID
  title: string
  windowId: ID
  panelId: ID
  parentId: ID
  lvl: number
  folded: boolean
  customColor?: string
  tabIds: ID[]
}

export interface AgentWindowInfo {
  id: ID
  focused: boolean
  incognito: boolean
  activePanelId: ID
  activeTabId: ID
  sidebarConnected: boolean
}

export interface AgentWindowState {
  window: AgentWindowInfo
  panels: AgentPanelInfo[]
  tabs: AgentTabInfo[]
  groups: AgentGroupInfo[]
}

export interface AgentStateSnapshot {
  windows: AgentWindowInfo[]
  containers: AgentContainerInfo[]
  panels: AgentPanelInfo[]
  tabs: AgentTabInfo[]
  groups: AgentGroupInfo[]
}

export interface AgentCreatePanelParams {
  windowId?: ID
  name?: string
  color?: string
  iconSVG?: string
  container?: string
  newTabCtx?: string
  index?: number
  activate?: boolean
}

export interface AgentUpdatePanelParams {
  windowId?: ID
  panelId?: ID
  panel?: ID | string
  name?: string
  color?: string
  iconSVG?: string
}

export interface AgentDeletePanelParams {
  windowId?: ID
  panelId?: ID
  panel?: ID | string
  tabsMode?: 'attach' | 'close' | 'save' | 'leave'
}

export interface AgentSwitchPanelParams {
  windowId?: ID
  panelId?: ID
  panel?: ID | string
}

export interface AgentCreateTabParams {
  windowId?: ID
  panelId?: ID
  panel?: ID | string
  url?: string
  urls?: string[]
  parentId?: ID
  index?: number
  active?: boolean
  pinned?: boolean
  discarded?: boolean
  title?: string
  customTitle?: string
  color?: string
  container?: string
  cookieStoreId?: string
}

export interface AgentGroupTabsParams {
  windowId?: ID
  tabIds: ID[]
  title?: string
  active?: boolean
  color?: string
}

export interface AgentFlattenTabsParams {
  windowId?: ID
  tabIds: ID[]
}

export interface AgentMoveTabsParams {
  windowId?: ID
  tabIds: ID[]
  panelId?: ID
  panel?: ID | string
  parentId?: ID
  index?: number
  pinned?: boolean
}

export interface AgentSetTabColorParams {
  windowId?: ID
  tabIds?: ID[]
  color: string
}

export interface AgentSetTabTitleParams {
  windowId?: ID
  tabId: ID
  title: string
}

export interface AgentActivateTabParams {
  windowId?: ID
  tabId: ID
}

export interface AgentCloseTabsParams {
  windowId?: ID
  tabIds: ID[]
}
