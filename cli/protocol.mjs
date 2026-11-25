import os from 'node:os'
import path from 'node:path'

export const HOST_NAME = 'sidebery_api'
export const EXTENSION_ID = '{3c078156-979c-498b-8990-85f7987dd929}'
export const DEFAULT_PORT = 47321

export function getRuntimeDir() {
  return process.env.SIDEBERY_API_DIR || process.env.XDG_RUNTIME_DIR || os.tmpdir()
}

export function getSocketPath() {
  return path.join(getRuntimeDir(), 'sidebery-api.sock')
}

export function getStateFilePath() {
  return path.join(getRuntimeDir(), 'sidebery-api.json')
}

export function encodeNativeMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32LE(payload.length, 0)
  return Buffer.concat([header, payload])
}

export function createNativeMessageReader(stream, onMessage, onError) {
  let buffer = Buffer.alloc(0)

  const onData = chunk => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    buffer = buffer.length === 0 ? buf : Buffer.concat([buffer, buf])

    while (buffer.length >= 4) {
      const msgLen = buffer.readUInt32LE(0)
      if (msgLen > 64 * 1024 * 1024) {
        const err = new Error(`Native message too large: ${msgLen} bytes`)
        buffer = Buffer.alloc(0)
        if (onError) onError(err)
        return
      }
      if (buffer.length < 4 + msgLen) break

      const payload = buffer.subarray(4, 4 + msgLen).toString('utf8')
      buffer = buffer.subarray(4 + msgLen)

      try {
        const parsed = JSON.parse(payload)
        onMessage(parsed)
      } catch (err) {
        if (onError) onError(err)
      }
    }
  }

  stream.on('data', onData)
  return () => {
    stream.off('data', onData)
  }
}
