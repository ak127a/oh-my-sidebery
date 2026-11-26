import { vi } from 'vitest'

vi.mock('src/services/ipc', () => {
  return {
    state: {
      sidebarConnections: new Map(),
      setupPageConnections: new Map(),
      panelConfigConnections: new Map(),
    },
    getConnection: () => undefined,
    isConnected: () => false,
    connectTo: () => {},
    sidebar: () => {},
    sendToSidebar: () => {},
    sidebars: () => {},
    sendToSidebars: () => {},
    setupPage: () => {},
    panelConfigPopup: () => {},
    groupPage: () => {},
    sendToSearchPopup: () => {},
    sendToEditingPopup: () => {},
    bg: () => {},
    sendToBg: () => {},
    sendToPreview: () => {},
    send: () => {},
    request: () => {},
    broadcast: () => {},
    onConnected: () => {},
    onDisconnected: () => {},
    disconnectFrom: () => {},
  }
})
