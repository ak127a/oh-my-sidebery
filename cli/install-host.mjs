#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ALLOWED_EXTENSIONS, HOST_NAME } from './protocol.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(__dirname, '..')

const CLI_FILES = ['protocol.mjs', 'host.mjs', 'sidebery.mjs', 'install-host.mjs']
const WIN_REGISTRY_KEY = `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}`

function getInstallDir({ homeDir, platform, localAppDataDir }) {
  if (platform === 'win32') {
    const base = localAppDataDir || path.join(homeDir, 'AppData', 'Local')
    return path.join(base, 'sidebery-api')
  }
  return path.join(homeDir, '.local', 'share', 'sidebery-api')
}

function getManifestDirs({ homeDir, platform, installDir }) {
  if (platform === 'win32') {
    return [installDir]
  }
  if (platform === 'darwin') {
    return [path.join(homeDir, 'Library', 'Application Support', 'Mozilla', 'NativeMessagingHosts')]
  }
  return [
    path.join(homeDir, '.mozilla', 'native-messaging-hosts'),
    path.join(homeDir, '.config', 'mozilla', 'native-messaging-hosts'),
  ]
}

function getWrapperPath({ platform, installDir }) {
  return path.join(installDir, platform === 'win32' ? 'sidebery-host.cmd' : 'sidebery-host.sh')
}

function getCliBinPath({ homeDir, platform, appDataDir }) {
  if (platform === 'win32') {
    const npmGlobalDir = appDataDir ? path.join(appDataDir, 'npm') : ''
    if (npmGlobalDir && fs.existsSync(npmGlobalDir)) {
      return path.join(npmGlobalDir, 'sidebery-cli.cmd')
    }
    return path.join(homeDir, '.local', 'bin', 'sidebery-cli.cmd')
  }
  return path.join(homeDir, '.local', 'bin', 'sidebery-cli')
}

function getSkillTargetPaths(homeDir) {
  const targets = [path.join(homeDir, '.agents', 'skills', 'sidebery', 'SKILL.md')]
  const optionalAgentBases = [
    path.join(homeDir, '.claude'),
    path.join(homeDir, '.codex'),
    path.join(homeDir, '.gemini', 'config'),
    path.join(homeDir, '.cursor'),
  ]
  for (const base of optionalAgentBases) {
    if (fs.existsSync(base)) {
      targets.push(path.join(base, 'skills', 'sidebery', 'SKILL.md'))
    }
  }
  return targets
}

function writeExecutableScript(filePath, content, platform) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, platform === 'win32' ? undefined : { mode: 0o755 })
  if (platform !== 'win32') {
    fs.chmodSync(filePath, 0o755)
  }
}

function findSkillSource() {
  const candidates = [
    path.join(PACKAGE_ROOT, 'skills', 'sidebery', 'SKILL.md'),
    path.join(__dirname, '..', 'skills', 'sidebery', 'SKILL.md'),
  ]
  return candidates.find(p => fs.existsSync(p))
}

export function installHost(options = {}) {
  const homeDir = options.homeDir ?? os.homedir()
  const platform = options.platform ?? process.platform
  const appDataDir = options.appDataDir ?? process.env.APPDATA ?? path.join(homeDir, 'AppData', 'Roaming')
  const localAppDataDir =
    options.localAppDataDir ?? process.env.LOCALAPPDATA ?? path.join(homeDir, 'AppData', 'Local')
  const skipRegistry = options.skipRegistry ?? false

  const installDir = getInstallDir({ homeDir, platform, localAppDataDir })
  const installedCliDir = path.join(installDir, 'cli')
  fs.mkdirSync(installedCliDir, { recursive: true })

  // Copy CLI scripts to a stable self-contained install directory
  for (const file of CLI_FILES) {
    const src = path.resolve(__dirname, file)
    const dst = path.resolve(installedCliDir, file)
    if (fs.existsSync(src) && src !== dst) {
      fs.copyFileSync(src, dst)
    }
  }

  const hostEntryPath = path.join(installedCliDir, 'host.mjs')
  const cliEntryPath = path.join(installedCliDir, 'sidebery.mjs')

  // Write native messaging host wrapper
  const wrapperPath = getWrapperPath({ platform, installDir })
  const wrapperContent =
    platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${hostEntryPath}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${hostEntryPath}" "$@"\n`
  writeExecutableScript(wrapperPath, wrapperContent, platform)

  // Write global sidebery-cli launcher
  const cliPath = getCliBinPath({ homeDir, platform, appDataDir })
  const cliContent =
    platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${cliEntryPath}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${cliEntryPath}" "$@"\n`
  writeExecutableScript(cliPath, cliContent, platform)

  // Write Firefox native messaging host manifest(s)
  const manifest = {
    name: HOST_NAME,
    description: 'Sidebery AI Agent API Native Messaging Host',
    path: wrapperPath,
    type: 'stdio',
    allowed_extensions: ALLOWED_EXTENSIONS,
  }

  const installedManifests = []
  for (const dir of getManifestDirs({ homeDir, platform, installDir })) {
    fs.mkdirSync(dir, { recursive: true })
    const manifestPath = path.join(dir, `${HOST_NAME}.json`)
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    installedManifests.push(manifestPath)
  }

  // Register Windows HKCU native messaging key
  let windowsRegistryKey = null
  if (platform === 'win32' && !skipRegistry && installedManifests[0]) {
    execFileSync(
      'reg',
      ['add', WIN_REGISTRY_KEY, '/ve', '/t', 'REG_SZ', '/d', installedManifests[0], '/f'],
      { stdio: 'pipe' }
    )
    windowsRegistryKey = WIN_REGISTRY_KEY
  }

  // Copy bundled AI skill into ~/.agents/skills and detected agent skill dirs
  const installedSkills = []
  const skillSrc = findSkillSource()
  if (skillSrc) {
    const installedSkillCopy = path.join(installDir, 'skills', 'sidebery', 'SKILL.md')
    fs.mkdirSync(path.dirname(installedSkillCopy), { recursive: true })
    if (path.resolve(skillSrc) !== path.resolve(installedSkillCopy)) {
      fs.copyFileSync(skillSrc, installedSkillCopy)
    }

    for (const target of getSkillTargetPaths(homeDir)) {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(skillSrc, target)
      installedSkills.push(target)
    }
  }

  const binDir = path.dirname(cliPath)
  const pathEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  const inPath = pathEntries.some(p => path.resolve(p) === path.resolve(binDir))

  return {
    platform,
    installDir,
    wrapperPath,
    cliPath,
    inPath,
    pathHint: inPath ? undefined : `Add "${binDir}" to your PATH to run "sidebery-cli" globally.`,
    installedManifests,
    windowsRegistryKey,
    installedSkills,
  }
}

export function uninstallHost(options = {}) {
  const homeDir = options.homeDir ?? os.homedir()
  const platform = options.platform ?? process.platform
  const appDataDir = options.appDataDir ?? process.env.APPDATA ?? path.join(homeDir, 'AppData', 'Roaming')
  const localAppDataDir =
    options.localAppDataDir ?? process.env.LOCALAPPDATA ?? path.join(homeDir, 'AppData', 'Local')
  const skipRegistry = options.skipRegistry ?? false

  const installDir = getInstallDir({ homeDir, platform, localAppDataDir })
  const removed = []

  const cliCandidates = new Set([
    getCliBinPath({ homeDir, platform, appDataDir }),
    path.join(homeDir, '.local', 'bin', platform === 'win32' ? 'sidebery-cli.cmd' : 'sidebery-cli'),
  ])
  for (const cliPath of cliCandidates) {
    if (fs.existsSync(cliPath)) {
      fs.unlinkSync(cliPath)
      removed.push(cliPath)
    }
  }

  for (const dir of getManifestDirs({ homeDir, platform, installDir })) {
    const manifestPath = path.join(dir, `${HOST_NAME}.json`)
    if (fs.existsSync(manifestPath)) {
      fs.unlinkSync(manifestPath)
      removed.push(manifestPath)
    }
  }

  if (platform === 'win32' && !skipRegistry) {
    try {
      execFileSync('reg', ['delete', WIN_REGISTRY_KEY, '/f'], { stdio: 'pipe' })
      removed.push(WIN_REGISTRY_KEY)
    } catch {
      // Registry key may not exist
    }
  }

  const skillDirs = [
    path.join(homeDir, '.agents', 'skills', 'sidebery'),
    path.join(homeDir, '.claude', 'skills', 'sidebery'),
    path.join(homeDir, '.codex', 'skills', 'sidebery'),
    path.join(homeDir, '.gemini', 'config', 'skills', 'sidebery'),
    path.join(homeDir, '.cursor', 'skills', 'sidebery'),
  ]
  for (const skillDir of skillDirs) {
    if (fs.existsSync(skillDir)) {
      fs.rmSync(skillDir, { recursive: true, force: true })
      removed.push(skillDir)
    }
  }

  if (fs.existsSync(installDir)) {
    fs.rmSync(installDir, { recursive: true, force: true })
    removed.push(installDir)
  }

  return { removed }
}

function isMainModule() {
  if (!process.argv[1]) return false
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href
  } catch {
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  }
}

if (isMainModule()) {
  const isUninstall = process.argv.includes('--uninstall')
  if (isUninstall) {
    const result = uninstallHost()
    process.stdout.write(JSON.stringify({ ok: true, action: 'uninstall', ...result }, null, 2) + '\n')
  } else {
    const result = installHost()
    process.stdout.write(JSON.stringify({ ok: true, action: 'install', ...result }, null, 2) + '\n')
  }
}
