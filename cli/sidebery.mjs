#!/usr/bin/env node
import fs from 'node:fs'
import http from 'node:http'
import { DEFAULT_PORT, getSocketPath, getStateFilePath } from './protocol.mjs'
import { installHost, uninstallHost } from './install-host.mjs'

const HELP_TEXT = `Sidebery AI Agent CLI

Usage:
  sidebery-cli <command> [options]

Inspection:
  ping | status                         Check bridge and Sidebery connection
  state [--window <id>] [--tree]        Get full snapshot (windows, containers, panels, tabs, groups)
  windows                               List browser windows and sidebar connection status
  panels [--window <id>]                List panels in a window
  tabs [filters] [--tree]               List tabs (--window, --panel, --group, --color, --active, --query)
  groups [--window <id>] [--panel <id>] List tab groups and member tab IDs

Panels:
  panel create <name> [--color <c>] [--icon <svg>] [--container <id|name>] [--index <n>] [--activate] [--window <id>]
  panel update <id|name> [--name <n>] [--color <c>] [--icon <svg>] [--window <id>]
  panel delete <id|name> [--tabs-mode attach|close|save|leave] [--window <id>]
  panel switch <id|name> [--window <id>]

Tabs & Groups:
  tab create [url...] [--panel <id|name>] [--parent <tabId>] [--index <n>] [--active] [--pinned] [--discarded] [--title <t>] [--color <c>] [--container <id|name>] [--window <id>]
  tab group <tabIds...> [--title <t>] [--active] [--color <c>] [--window <id>]
  tab flatten <tabIds...> [--window <id>]
  tab move <tabIds...> [--panel <id|name>] [--parent <tabId>] [--index <n>] [--pinned] [--window <id>]
  tab color <color> [tabIds...] [--window <id>]
  tab title <tabId> <title> [--window <id>]
  tab activate <tabId>
  tab close <tabIds...> [--window <id>]

Other:
  rpc <method> [jsonParams]             Call any Sidebery Agent API RPC method directly
  install | install-host                Install sidebery-cli, native host, and AI skill
  uninstall | uninstall-host            Remove sidebery-cli, native host, and AI skill

Global flags:
  --pretty                              Force pretty-printed JSON output
  --compact                             Force compact single-line JSON output
  -h, --help                            Show this help
`

const BOOLEAN_FLAGS = new Set([
  'activate',
  'active',
  'pinned',
  'discarded',
  'tree',
  'pretty',
  'compact',
  'help',
])

function parseArgs(argv) {
  const positionals = []
  const flags = {}

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') {
      flags.help = true
      continue
    }
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=')
      if (eqIdx !== -1) {
        const k = arg.slice(2, eqIdx)
        flags[k] = arg.slice(eqIdx + 1)
      } else {
        const k = arg.slice(2)
        if (BOOLEAN_FLAGS.has(k)) {
          flags[k] = true
        } else {
          const next = argv[i + 1]
          if (next === undefined || next.startsWith('--')) {
            flags[k] = true
          } else {
            flags[k] = next
            i++
          }
        }
      }
      continue
    }
    positionals.push(arg)
  }

  return { positionals, flags }
}

function parseIntArg(val, label) {
  const n = Number(val)
  if (!Number.isInteger(n)) throw new Error(`Invalid ${label}: "${val}"`)
  return n
}

function resolveTarget() {
  const envUrl = process.env.SIDEBERY_API_URL
  if (envUrl) {
    const parsed = new URL(envUrl)
    return {
      host: parsed.hostname,
      port: Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)),
      basePath: parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, ''),
    }
  }

  const statePath = getStateFilePath()
  if (fs.existsSync(statePath)) {
    try {
      const info = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      if (info.socket && fs.existsSync(info.socket)) {
        return { socketPath: info.socket, basePath: '' }
      }
      if (info.port) {
        return { host: info.host || '127.0.0.1', port: Number(info.port), basePath: '' }
      }
    } catch {
      // Fall through to defaults
    }
  }

  const defaultSocket = getSocketPath()
  if (process.platform !== 'win32' && fs.existsSync(defaultSocket)) {
    return { socketPath: defaultSocket, basePath: '' }
  }

  const port = process.env.SIDEBERY_API_PORT ? Number(process.env.SIDEBERY_API_PORT) : DEFAULT_PORT
  return { host: '127.0.0.1', port, basePath: '' }
}

function requestApi(method, apiPath, body) {
  const target = resolveTarget()
  const payload = body !== undefined ? JSON.stringify(body) : undefined

  const reqOpts = {
    method,
    path: `${target.basePath}${apiPath}`,
    headers: {
      Accept: 'application/json',
    },
  }
  if (target.socketPath) {
    reqOpts.socketPath = target.socketPath
  } else {
    reqOpts.hostname = target.host
    reqOpts.port = target.port
  }
  if (payload !== undefined) {
    reqOpts.headers['Content-Type'] = 'application/json; charset=utf-8'
    reqOpts.headers['Content-Length'] = Buffer.byteLength(payload, 'utf8')
  }

  return new Promise((resolve, reject) => {
    const req = http.request(reqOpts, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let parsed
        try {
          parsed = JSON.parse(raw)
        } catch {
          return reject(new Error(`Invalid JSON response (${res.statusCode}): ${raw}`))
        }
        if (res.statusCode >= 400 || !parsed.ok) {
          return reject(new Error(parsed.error || `HTTP ${res.statusCode}`))
        }
        resolve(parsed.data)
      })
    })

    req.on('error', err => {
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT') {
        reject(
          new Error(
            `Cannot connect to Sidebery API (${err.code}). Make sure Firefox with Sidebery is running and run "sidebery-cli install-host" if you have not installed the native host yet.`
          )
        )
      } else {
        reject(err)
      }
    })

    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

function formatTabsTree(tabs, panels = []) {
  const panelById = new Map(panels.map(p => [String(p.id), p]))
  const lines = []
  let currentPanelKey = null

  for (const tab of tabs) {
    const panelKey = String(tab.panelId)
    if (panelKey !== currentPanelKey) {
      currentPanelKey = panelKey
      const panel = panelById.get(panelKey)
      const panelTitle = panel ? `${panel.name} (${panel.id}, color=${panel.color})` : `Panel ${panelKey}`
      if (lines.length > 0) lines.push('')
      lines.push(`[PANEL] ${panelTitle}`)
    }

    const indent = '  '.repeat((tab.lvl || 0) + 1)
    const flags = []
    if (tab.active) flags.push('*')
    if (tab.pinned) flags.push('pin')
    if (tab.isGroup) flags.push('group')
    if (tab.folded) flags.push('folded')
    if (tab.discarded) flags.push('unloaded')
    if (tab.customColor) flags.push(`color=${tab.customColor}`)
    const badge = flags.length ? `[${flags.join(' ')}] ` : ''
    const title = tab.customTitle || tab.title || '(untitled)'
    lines.push(`${indent}#${tab.id} ${badge}${title} — ${tab.url}`)
  }

  return lines.join('\n')
}

function printOutput(data, flags) {
  if (flags.pretty) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n')
  } else if (flags.compact) {
    process.stdout.write(JSON.stringify(data) + '\n')
  } else if (process.stdout.isTTY) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n')
  } else {
    process.stdout.write(JSON.stringify(data) + '\n')
  }
}

function buildQueryString(params) {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== false) qs.set(k, String(v))
  }
  const str = qs.toString()
  return str ? `?${str}` : ''
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2))
  if (flags.help || positionals.length === 0) {
    process.stdout.write(HELP_TEXT)
    return
  }

  const [cmd, sub, ...rest] = positionals

  if (cmd === 'install' || cmd === 'install-host') {
    printOutput({ action: 'install', ...installHost() }, flags)
    return
  }
  if (cmd === 'uninstall' || cmd === 'uninstall-host') {
    printOutput({ action: 'uninstall', ...uninstallHost() }, flags)
    return
  }

  if (cmd === 'ping' || cmd === 'status') {
    const data = await requestApi('GET', '/api/health')
    printOutput(data, flags)
    return
  }

  if (cmd === 'windows') {
    const data = await requestApi('GET', '/api/windows')
    printOutput(data, flags)
    return
  }

  if (cmd === 'state') {
    const qs = buildQueryString({ windowId: flags.window })
    const data = await requestApi('GET', `/api/state${qs}`)
    if (flags.tree) {
      process.stdout.write(formatTabsTree(data.tabs || [], data.panels || []) + '\n')
    } else {
      printOutput(data, flags)
    }
    return
  }

  if (cmd === 'panels') {
    const qs = buildQueryString({ windowId: flags.window })
    const data = await requestApi('GET', `/api/panels${qs}`)
    printOutput(data, flags)
    return
  }

  if (cmd === 'groups') {
    const qs = buildQueryString({ windowId: flags.window, panel: flags.panel })
    const data = await requestApi('GET', `/api/groups${qs}`)
    printOutput(data, flags)
    return
  }

  if (cmd === 'tabs') {
    const qs = buildQueryString({
      windowId: flags.window,
      panel: flags.panel,
      groupId: flags.group,
      color: flags.color,
      active: flags.active ? 'true' : undefined,
      query: flags.query,
    })
    if (flags.tree) {
      const stateQs = buildQueryString({ windowId: flags.window })
      const [tabsRes, panelsRes] = await Promise.all([
        requestApi('GET', `/api/tabs${qs}`),
        requestApi('GET', `/api/panels${stateQs}`),
      ])
      process.stdout.write(formatTabsTree(tabsRes.tabs || [], panelsRes.panels || []) + '\n')
    } else {
      const data = await requestApi('GET', `/api/tabs${qs}`)
      printOutput(data, flags)
    }
    return
  }

  if (cmd === 'panel') {
    const windowId = flags.window !== undefined ? parseIntArg(flags.window, 'window') : undefined
    if (sub === 'create') {
      const name = rest.join(' ').trim()
      if (!name) throw new Error('Usage: sidebery-cli panel create <name> [options]')
      const body = { windowId, name }
      if (flags.color !== undefined) body.color = flags.color
      if (flags.icon !== undefined) body.iconSVG = flags.icon
      if (flags.container !== undefined) body.container = flags.container
      if (flags.index !== undefined) body.index = parseIntArg(flags.index, 'index')
      if (flags.activate) body.activate = true
      printOutput(await requestApi('POST', '/api/panels', body), flags)
      return
    }
    if (sub === 'update') {
      const panelRef = rest[0]
      if (!panelRef) throw new Error('Usage: sidebery-cli panel update <id|name> [options]')
      const body = { windowId }
      if (flags.name !== undefined) body.name = flags.name
      if (flags.color !== undefined) body.color = flags.color
      if (flags.icon !== undefined) body.iconSVG = flags.icon
      printOutput(
        await requestApi('PATCH', `/api/panels/${encodeURIComponent(panelRef)}`, body),
        flags
      )
      return
    }
    if (sub === 'delete') {
      const panelRef = rest[0]
      if (!panelRef) throw new Error('Usage: sidebery-cli panel delete <id|name> [options]')
      const body = { windowId }
      if (flags['tabs-mode'] !== undefined) body.tabsMode = flags['tabs-mode']
      printOutput(
        await requestApi('DELETE', `/api/panels/${encodeURIComponent(panelRef)}`, body),
        flags
      )
      return
    }
    if (sub === 'switch') {
      const panelRef = rest[0]
      if (!panelRef) throw new Error('Usage: sidebery-cli panel switch <id|name> [--window <id>]')
      printOutput(
        await requestApi('POST', `/api/panels/${encodeURIComponent(panelRef)}/activate`, {
          windowId,
        }),
        flags
      )
      return
    }
    throw new Error(`Unknown panel subcommand: "${sub || ''}"`)
  }

  if (cmd === 'tab') {
    const windowId = flags.window !== undefined ? parseIntArg(flags.window, 'window') : undefined
    if (sub === 'create') {
      const body = { windowId }
      if (rest.length === 1) body.url = rest[0]
      else if (rest.length > 1) body.urls = rest
      if (flags.panel !== undefined) body.panel = flags.panel
      if (flags.parent !== undefined) body.parentId = parseIntArg(flags.parent, 'parent')
      if (flags.index !== undefined) body.index = parseIntArg(flags.index, 'index')
      if (flags.active) body.active = true
      if (flags.pinned) body.pinned = true
      if (flags.discarded) body.discarded = true
      if (flags.title !== undefined) body.title = flags.title
      if (flags.color !== undefined) body.color = flags.color
      if (flags.container !== undefined) body.container = flags.container
      printOutput(await requestApi('POST', '/api/tabs', body), flags)
      return
    }
    if (sub === 'group') {
      if (rest.length === 0) throw new Error('Usage: sidebery-cli tab group <tabIds...> [options]')
      const tabIds = rest.map(id => parseIntArg(id, 'tabId'))
      const body = { windowId, tabIds }
      if (flags.title !== undefined) body.title = flags.title
      if (flags.active) body.active = true
      if (flags.color !== undefined) body.color = flags.color
      printOutput(await requestApi('POST', '/api/tabs/group', body), flags)
      return
    }
    if (sub === 'flatten') {
      if (rest.length === 0) throw new Error('Usage: sidebery-cli tab flatten <tabIds...>')
      const tabIds = rest.map(id => parseIntArg(id, 'tabId'))
      printOutput(await requestApi('POST', '/api/tabs/flatten', { windowId, tabIds }), flags)
      return
    }
    if (sub === 'move') {
      if (rest.length === 0) throw new Error('Usage: sidebery-cli tab move <tabIds...> [options]')
      const tabIds = rest.map(id => parseIntArg(id, 'tabId'))
      const body = { windowId, tabIds }
      if (flags.panel !== undefined) body.panel = flags.panel
      if (flags.parent !== undefined) body.parentId = parseIntArg(flags.parent, 'parent')
      if (flags.index !== undefined) body.index = parseIntArg(flags.index, 'index')
      if (flags.pinned) body.pinned = true
      printOutput(await requestApi('POST', '/api/tabs/move', body), flags)
      return
    }
    if (sub === 'color') {
      const color = rest[0]
      if (!color) throw new Error('Usage: sidebery-cli tab color <color> [tabIds...]')
      const tabIds = rest.slice(1).map(id => parseIntArg(id, 'tabId'))
      const body = { windowId, color }
      if (tabIds.length > 0) body.tabIds = tabIds
      printOutput(await requestApi('POST', '/api/tabs/color', body), flags)
      return
    }
    if (sub === 'title') {
      if (rest.length < 2) throw new Error('Usage: sidebery-cli tab title <tabId> <title>')
      const tabId = parseIntArg(rest[0], 'tabId')
      const title = rest.slice(1).join(' ')
      printOutput(
        await requestApi('POST', '/api/tabs/title', { windowId, tabId, title }),
        flags
      )
      return
    }
    if (sub === 'activate') {
      if (!rest[0]) throw new Error('Usage: sidebery-cli tab activate <tabId>')
      const tabId = parseIntArg(rest[0], 'tabId')
      printOutput(
        await requestApi('POST', `/api/tabs/${encodeURIComponent(tabId)}/activate`, { windowId }),
        flags
      )
      return
    }
    if (sub === 'close') {
      if (rest.length === 0) throw new Error('Usage: sidebery-cli tab close <tabIds...>')
      const tabIds = rest.map(id => parseIntArg(id, 'tabId'))
      printOutput(await requestApi('POST', '/api/tabs/close', { windowId, tabIds }), flags)
      return
    }
    throw new Error(`Unknown tab subcommand: "${sub || ''}"`)
  }

  if (cmd === 'rpc') {
    if (!sub) throw new Error('Usage: sidebery-cli rpc <method> [jsonParams]')
    let params = {}
    if (rest[0]) {
      params = JSON.parse(rest[0])
    }
    printOutput(await requestApi('POST', '/api/rpc', { method: sub, params }), flags)
    return
  }

  throw new Error(`Unknown command: "${cmd}". Run "sidebery-cli --help" for usage.`)
}

main().catch(err => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
