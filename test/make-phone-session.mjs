/**
 * Fabricate a session log that looks like it came from the phone.
 *
 * Usage: node test/make-phone-session.mjs <sessions-root> <id> [bytes]
 *
 * It copies a real desktop log and rewrites the id in its header (recompressing
 * only the first frame), so the rest of the container stays authentic.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { frameOffsets } from '../lib/sessions.js'

const root = process.argv[2]
const id = process.argv[3]
const extra = Number(process.argv[4] ?? 0)

const REAL_ROOT = path.join(os.homedir(), '.dsh', 'sessions')
const projectName = '--D-code-dsh-android-Conversation~0020sync--'
const session = fs
  .readdirSync(path.join(REAL_ROOT, projectName))
  .find((name) => name.startsWith('session-'))
const file = fs
  .readdirSync(path.join(REAL_ROOT, projectName, session))
  .find((name) => name.endsWith('.zstd'))
const original = fs.readFileSync(path.join(REAL_ROOT, projectName, session, file))

const offsets = frameOffsets(original)
const firstFrame = zlib.zstdDecompressSync(original.subarray(offsets[0], offsets[1])).toString('utf8')
const renamed = firstFrame.replace(/"id":"[^"]*"/, `"id":"${id}"`)
const rebuilt = Buffer.concat([zlib.zstdCompressSync(Buffer.from(renamed)), original.subarray(offsets[1])])

const target = path.join(root, '--data-data-com.dsharnessmobile.shell-files-home-work--', id)
fs.mkdirSync(target, { recursive: true })
const buffer = extra > 0 ? Buffer.concat([rebuilt, Buffer.alloc(extra, 0x20)]) : rebuilt
fs.writeFileSync(path.join(target, 'session.v4.jsonl.zstd'), buffer)
console.log(`wrote ${path.join(target, 'session.v4.jsonl.zstd')} (${buffer.length} bytes)`)
