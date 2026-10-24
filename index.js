/**
 * Host half of `dsh-mobile-sync`.
 *
 * Two jobs, kept apart on purpose:
 *
 * 1. Run the LAN listener the phone talks to (`lib/controller.js`). It is a
 *    separate `http.Server` on its own port — never the DSH web server, which
 *    refuses unspecified bind addresses and has no server-wide authentication.
 * 2. Publish a tiny control API to the browser half over `ctx.connection.fetch`,
 *    so the sidebar panel can show the pairing QR, the command to paste, and the
 *    sync log without a second network path.
 *
 * No configuration schema is declared: everything the plugin needs to remember
 * lives in `$DSH_HOME/dsh-mobile-sync/state.json`, which survives the profile
 * patch layer being rebuilt (a repair, a reinstall, or a write that equals the
 * inherited default all drop plugin rows from that layer).
 *
 * @module index.js
 */
import os from 'node:os'
import path from 'node:path'

import { createController } from './lib/controller.js'

/** Route prefix this plugin claims on the authenticated connection fetch channel. */
const API = '/api/dsh-mobile-sync'

/** Resolve `$DSH_HOME`, matching the runtime's own default. */
function homeDir() {
  if (process.env.DSH_HOME && process.env.DSH_HOME.length > 0) return process.env.DSH_HOME
  return path.join(os.homedir(), '.dsh')
}

/** Plugin name, shown by the loader. */
export const name = 'dsh-mobile-sync'

/**
 * Mount the listener and the control API.
 * @param ctx - plugin context.
 */
export function apply(ctx) {
  const logger = ctx.logger ?? console
  const home = homeDir()
  const sessionsRoot = path.join(home, 'sessions')

  let controller
  try {
    controller = createController({ home, sessionsRoot, logger, deviceName: os.hostname() })
  } catch (error) {
    if (typeof logger.error === 'function') logger.error(`[mobile-sync] controller failed: ${String(error?.message ?? error)}`)
    return
  }

  // The listener is independent of every other service, so it starts now and is
  // torn down with the plugin context.
  ctx.effect(() => {
    controller.start().catch((error) => {
      if (typeof logger.warn === 'function') logger.warn(`[mobile-sync] start failed: ${String(error?.message ?? error)}`)
    })
    return () => {
      controller.stop().catch(() => {})
    }
  }, 'mobile-sync: lan listener')

  ctx.inject(['connection'], (scope) => {
    const connection = scope.connection
    if (connection === undefined || typeof connection.fetch?.register !== 'function') {
      if (typeof logger.warn === 'function') logger.warn('[mobile-sync] connection.fetch unavailable; panel API not registered')
      return
    }

    /** Read a JSON request body, or `{}` when there is none. */
    const readJson = async (request) => {
      try {
        const text = await request.text()
        return text.length === 0 ? {} : JSON.parse(text)
      } catch (_error) {
        return {}
      }
    }

    /** Answer with JSON. */
    const json = (value, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      })

    scope.effect(
      () =>
        connection.fetch.register({
          path: `${API}/status`,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: () => json(controller.status()),
        }),
      'mobile-sync: status route',
    )

    scope.effect(
      () =>
        connection.fetch.register({
          path: `${API}/action`,
          methods: ['POST'],
          requestBody: 'buffered',
          async fetch(request) {
            const body = await readJson(request)
            // Every edit lives in the controller, so the panel API and the LAN
            // page cannot disagree about what an action means.
            try {
              const result = await controller.act(body)
              return json(result.body, result.status)
            } catch (error) {
              return json({ error: String(error?.message ?? error) }, 500)
            }
          },
        }),
      'mobile-sync: action route',
    )
  })

  if (typeof logger.info === 'function') {
    logger.info(`[mobile-sync] session store: ${sessionsRoot}`)
  }
}
