import type { Context } from '@deepseek-ai/cordis'
import {
  defineTool,
  type GenericCallView,
  type GenericResultView,
} from '@deepseek-ai/dsh-tools'
import type { JsonValue } from './json'
import type { Config } from './config'
import { DASHBOARD_META_KIND, type DashboardSnapshot } from './dashboard'
import {
  HomeAssistantClient,
  HomeAssistantWsClient,
  isLovelaceConfigMissing,
  isLovelaceYamlMode,
  type HaState,
} from './ha'
import {
  LovelaceBackups,
  applyLovelaceOps,
  normalizeLovelaceConfig,
  resolveLovelaceBackupDir,
  summarizeLovelace,
  type LovelaceConfig,
  type LovelaceOp,
  type LovelaceSummary,
} from './lovelace'

/** Text content block helper for `output.render` / card content. */
function text(value: string): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: value }]
}

/** Cap rendered text at a sane size so huge attribute maps cannot flood context. */
function truncate(value: string, max = 4000): string {
  return value.length > max ? `${value.slice(0, max)}…[truncated]` : value
}

/**
 * Register the `ha_*` tools. Reads are cheap and safe; the powerful tools
 * (`ha_call_service`, `ha_render_template`) are gated by the plugin's
 * `tools/pre-execute` policy in index.ts. WebSocket-backed tools
 * (`ha_list_areas`, `ha_events`) degrade gracefully when the socket is down.
 */
export function registerTools(
  ctx: Context,
  client: HomeAssistantClient,
  ws: HomeAssistantWsClient,
  config: Config,
): void {
  // Dashboard snapshots live next to the harness data, so a bad edit survives a
  // restart as an undo point.
  const backups = new LovelaceBackups(
    resolveLovelaceBackupDir(config.lovelaceBackupDir),
    config.lovelaceMaxBackups,
  )

  ctx.tools.register(defineTool({
    name: 'ha_health',
    description:
      'Check the connection to Home Assistant and return instance info ' +
      '(location name, version, timezone, unit system) plus WebSocket status. ' +
      'Call this first to verify the plugin is configured.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          reachable: { type: 'boolean' },
          location: { type: 'string' },
          version: { type: 'string' },
          timezone: { type: 'string' },
          websocket: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const v = value as { reachable?: boolean; location?: string; version?: string; timezone?: string; websocket?: string }
        return text(
          v.reachable
            ? `Home Assistant reachable: "${v.location}" (version ${v.version ?? 'unknown'}, timezone ${v.timezone ?? 'unknown'}, websocket ${v.websocket ?? 'n/a'})`
            : 'Home Assistant unreachable',
        )
      },
    },
    async execute() {
      const message = await client.health()
      if (typeof message !== 'string' || !message.includes('API running')) {
        throw new Error(`Unexpected Home Assistant response: ${JSON.stringify(message)}`)
      }
      const configInfo = await client.getConfig()
      return {
        reachable: true,
        location: configInfo.location_name ?? '',
        version: configInfo.version ?? '',
        timezone: configInfo.time_zone ?? '',
        websocket: ws.status,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ha_list_entities',
    description:
      'List Home Assistant entities, optionally filtered by domain (light, switch, sensor, …) ' +
      'and/or a text query on entity id or friendly name. Returns compact summaries to keep context small.',
    parameters: {
      domain: { type: 'string', description: 'Entity domain filter, e.g. "light" or "sensor"' },
      query: { type: 'string', description: 'Text search over entity id and friendly name' },
      limit: { type: 'number', description: 'Maximum entities to return' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          count: { type: 'number' },
          entities: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                entity_id: { type: 'string' },
                state: { type: 'string' },
                friendly_name: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines = (value.entities as { entity_id: string; state: string; friendly_name?: string }[])
          .map(e => `- ${e.entity_id}: ${e.state}${e.friendly_name ? ` (${e.friendly_name})` : ''}`)
        return text(truncate(lines.join('\n') || '(no entities)'))
      },
    },
    async execute(args) {
      const limit = Math.min(Math.max(args.limit ?? 50, 1), 200)
      const states = await client.getStates()
      const query = (args.query ?? '').toLowerCase()
      const filtered = states
        .filter(s => !args.domain || s.entity_id.startsWith(`${args.domain}.`))
        .filter(s => !query ||
          s.entity_id.toLowerCase().includes(query) ||
          String(s.attributes.friendly_name ?? '').toLowerCase().includes(query))
        .sort((a, b) => a.entity_id.localeCompare(b.entity_id))
        .slice(0, limit)
      return {
        count: filtered.length,
        entities: filtered.map(s => ({
          entity_id: s.entity_id,
          state: s.state,
          friendly_name: typeof s.attributes.friendly_name === 'string'
            ? s.attributes.friendly_name
            : '',
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ha_get_state',
    description:
      'Get the full state of one Home Assistant entity, including its attributes ' +
      '(brightness, temperature, battery level, …).',
    parameters: {
      entityId: { type: 'string', required: true, description: 'Entity id, e.g. "light.living_room"' },
    },
    output: {
      // The full raw state object; keep it unconstrained so every attribute
      // HA returns survives round-trip.
      schema: { type: 'json' },
      render: (_args, value) => {
        const s = value as unknown as HaState
        return text(truncate(`${s.entity_id}: ${s.state}\n${JSON.stringify(s.attributes ?? {}, null, 2)}`))
      },
    },
    async execute(args) {
      const s = await client.getState(args.entityId)
      return {
        entity_id: s.entity_id,
        state: s.state,
        attributes: s.attributes,
        last_changed: s.last_changed,
        last_updated: s.last_updated,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ha_history',
    description:
      'Query Home Assistant state history for one entity (or all entities) over a time window. ' +
      'Returns a compact timeline of state changes. Defaults to the last hour.',
    parameters: {
      entityId: { type: 'string', description: 'Entity id filter; omit for all entities' },
      start: { type: 'string', description: 'ISO 8601 start time; defaults to one hour ago' },
      end: { type: 'string', description: 'ISO 8601 end time' },
      maxEvents: { type: 'number', description: 'Maximum timeline entries to return' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          count: { type: 'number' },
          events: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                entity_id: { type: 'string' },
                state: { type: 'string' },
                last_changed: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const events = value.events as { entity_id: string; state: string; last_changed: string }[]
        const lines = events.map(e => `- ${e.last_changed}  ${e.entity_id}: ${e.state}`)
        return text(truncate(lines.join('\n') || '(no history)'))
      },
    },
    async execute(args) {
      const periods = await client.getHistory({
        start: args.start,
        end: args.end,
        entityId: args.entityId,
      })
      const maxEvents = Math.min(Math.max(args.maxEvents ?? config.maxHistoryEvents, 1), 1000)
      const events = periods
        .flat()
        .map(s => ({ entity_id: s.entity_id, state: s.state, last_changed: s.last_changed }))
        .slice(0, maxEvents)
      return { count: events.length, events }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ha_call_service',
    description:
      'Call a Home Assistant service, e.g. light.turn_on, switch.turn_off, climate.set_temperature. ' +
      'Target by entity id(s), by area (areaId — affects everything in that room), or by device (deviceId). ' +
      'Requires human approval (configurable). Use ha_list_entities / ha_list_areas first.',
    parameters: {
      domain: { type: 'string', required: true, description: 'Service domain, e.g. "light"' },
      service: { type: 'string', required: true, description: 'Service name, e.g. "turn_on"' },
      entityId: { type: 'string', description: 'Target a single entity, e.g. "light.living_room"' },
      entityIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Target multiple entities (takes precedence over entityId)',
      },
      areaId: { type: 'string', description: 'Target every device in an area, e.g. "living_room" (see ha_list_areas)' },
      deviceId: { type: 'string', description: 'Target a device, e.g. "a1b2c3…"' },
      data: {
        type: 'object',
        additionalProperties: true,
        description: 'Service data, e.g. {"brightness": 128} or {"temperature": 21}',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          domain: { type: 'string' },
          service: { type: 'string' },
          target: { type: 'string' },
          data: { type: 'json' },
        },
      },
      render: (_args, value) => {
        const target = (value.target as string) || '(whole domain)'
        return text(`Called ${value.domain}.${value.service} on ${target}${value.data ? ` with ${JSON.stringify(value.data)}` : ''}.`)
      },
      // UI cards for the pending and completed call.
    },
    presentCall(args): GenericCallView | undefined {
      const a = args as { domain?: string; service?: string }
      if (!a.domain || !a.service) return undefined
      return { card: 'generic', title: `${a.domain}.${a.service}`, kind: 'execute' }
    },
    presentResult(_args, result): GenericResultView | undefined {
      return {
        card: 'generic',
        content: result.isError
          ? result.content
          : [{ type: 'text', text: '✅ Service call completed' }],
      }
    },
    async execute(args) {
      const entityIds = args.entityIds?.length
        ? args.entityIds
        : (args.entityId ? [args.entityId] : [])
      // HA service bodies accept entity_id | area_id | device_id.
      const target: Record<string, unknown> | undefined = entityIds.length
        ? { entity_id: entityIds }
        : (args.areaId
            ? { area_id: args.areaId }
            : (args.deviceId ? { device_id: args.deviceId } : undefined))
      // Target keys in `data` must never silently override the computed
      // target (e.g. a model passing data.entity_id would retarget the call).
      const TARGET_KEYS = new Set(['entity_id', 'entity_ids', 'area_id', 'device_id'])
      const rawData = args.data ?? undefined
      const data = rawData
        ? Object.fromEntries(Object.entries(rawData).filter(([key]) => !TARGET_KEYS.has(key)))
        : undefined
      const label = entityIds.length
        ? entityIds.join(', ')
        : (args.areaId ? `area:${args.areaId}` : (args.deviceId ? `device:${args.deviceId}` : ''))
      await client.callService(args.domain, args.service, target, data)
      return {
        ok: true,
        domain: args.domain,
        service: args.service,
        target: label,
        data: (data && Object.keys(data).length > 0 ? data : null) as JsonValue,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ha_list_areas',
    description:
      'List Home Assistant areas (rooms) via the WebSocket API. ' +
      'Use the returned area_id with ha_call_service to control everything in a room at once.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          count: { type: 'number' },
          areas: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                area_id: { type: 'string' },
                name: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const areas = value.areas as { area_id: string; name: string }[]
        return text(areas.length
          ? areas.map(a => `- ${a.area_id}: ${a.name}`).join('\n')
          : '(no areas)')
      },
    },
    async execute() {
      const areas = await ws.listAreas()
      return {
        count: areas.length,
        areas: areas.map(a => ({ area_id: a.area_id, name: a.name })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ha_list_devices',
    description:
      'List Home Assistant devices via the WebSocket device registry, optionally ' +
      'filtered by text or by area. Use the returned device id with ha_call_service ' +
      '(deviceId) to control a physical device directly.',
    parameters: {
      query: { type: 'string', description: 'Text search over device name or id' },
      areaId: { type: 'string', description: 'Only devices in this area (see ha_list_areas)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          count: { type: 'number' },
          devices: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                area_id: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const devices = value.devices as { id: string; name: string; area_id?: string }[]
        return text(devices.length
          ? devices.map(d => `- ${d.id}: ${d.name}${d.area_id ? ` (area: ${d.area_id})` : ''}`).join('\n')
          : '(no devices)')
      },
    },
    async execute(args) {
      const query = (args.query ?? '').toLowerCase()
      const devices = (await ws.listDevices())
        .filter(d => !args.areaId || d.area_id === args.areaId)
        .filter(d => !query ||
          d.id.toLowerCase().includes(query) ||
          d.name.toLowerCase().includes(query))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(d => ({
          id: d.id,
          name: d.name,
          ...(d.area_id ? { area_id: d.area_id } : {}),
        }))
      return { count: devices.length, devices }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ha_events',
    description:
      'Return recent real-time state changes buffered from the Home Assistant WebSocket ' +
      '(entity, state, previous state, timestamp). Empty when WebSocket is not connected.',
    parameters: {
      limit: { type: 'number', description: 'Maximum events to return' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          count: { type: 'number' },
          websocket: { type: 'string' },
          events: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                entity_id: { type: 'string' },
                state: { type: 'string' },
                old_state: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                last_changed: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const events = value.events as { entity_id: string; state: string; old_state: string; last_changed: string }[]
        const lines = events.map(e => `- ${e.last_changed}  ${e.entity_id}: ${e.old_state ?? '—'} → ${e.state}`)
        return text(truncate(lines.join('\n') || '(no recent events)'))
      },
    },
    async execute(args) {
      const limit = Math.min(Math.max(args.limit ?? 20, 1), 200)
      const events = ws.events.slice(-limit).map(e => ({
        entity_id: e.entity_id,
        state: e.state,
        old_state: e.old_state,
        last_changed: e.last_changed,
      }))
      return { count: events.length, websocket: ws.status, events }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ha_render_template',
    description:
      'Render a Home Assistant Jinja2 template server-side and return the result. ' +
      'Powerful: can evaluate sensor states, calculations, and comparisons. Requires approval (configurable).',
    parameters: {
      template: { type: 'string', required: true, description: 'Jinja2 template, e.g. "{{ states(\'sensor.temperature\') }}"' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          template: { type: 'string' },
          rendered: { type: 'string' },
        },
      },
      render: (_args, value) => text(truncate(`Rendered: ${value.rendered}`)),
    },
    async execute(args) {
      const rendered = await client.renderTemplate(args.template)
      return { template: args.template, rendered }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ha_list_scenes',
    description:
      'List Home Assistant scenes (one-click moods like "cinema", "goodnight", "away"). ' +
      'Activate one with ha_call_service: domain "scene", service "turn_on", entityId the scene entity id.',
    parameters: {
      query: { type: 'string', description: 'Optional text search over scene id or friendly name' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          count: { type: 'number' },
          scenes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                entity_id: { type: 'string' },
                state: { type: 'string' },
                friendly_name: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const scenes = value.scenes as { entity_id: string; friendly_name: string }[]
        return text(scenes.length
          ? scenes.map(s => `- ${s.entity_id}: ${s.friendly_name || s.entity_id}`).join('\n')
          : '(no scenes)')
      },
    },
    async execute(args) {
      const states = await client.getStates()
      const query = (args.query ?? '').toLowerCase()
      const scenes = states
        .filter(s => s.entity_id.startsWith('scene.'))
        .filter(s => !query ||
          s.entity_id.toLowerCase().includes(query) ||
          String(s.attributes.friendly_name ?? '').toLowerCase().includes(query))
        .sort((a, b) => a.entity_id.localeCompare(b.entity_id))
        .map(s => ({
          entity_id: s.entity_id,
          state: s.state,
          friendly_name: typeof s.attributes.friendly_name === 'string'
            ? s.attributes.friendly_name
            : '',
        }))
      return { count: scenes.length, scenes }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ha_dashboard',
    description:
      'Build a full home dashboard snapshot: every entity (grouped by domain, with ' +
      'friendly names, states and units), all scenes, and recent state changes. ' +
      'The result renders as a home dashboard card in the Web UI.',
    parameters: {},
    output: {
      // The canonical value IS the durable snapshot; it is also projected onto
      // `tool/result` meta (presentationMeta) so the browser dashboard node can
      // render it on live streaming AND on session-log replay.
      schema: { type: 'json' },
      render: (_args, value) => {
        const s = value as unknown as DashboardSnapshot
        const on = s.entities.filter(e => e.state === 'on').length
        return text(
          `Dashboard snapshot: ${s.entities.length} entities (${on} on), ` +
          `${s.scenes.length} scenes, ${s.events.length} recent changes.`,
        )
      },
      presentationMeta: (_args, value) => value as JsonValue,
    },
    presentResult(_args, result): GenericResultView | undefined {
      return {
        card: 'generic',
        content: result.isError
          ? result.content
          : [{ type: 'text', text: '🏠 Home dashboard ready' }],
      }
    },
    async execute() {
      const states = await client.getStates()
      const scenes = states
        .filter(s => s.entity_id.startsWith('scene.'))
        .map(s => ({
          entity_id: s.entity_id,
          friendly_name: typeof s.attributes.friendly_name === 'string'
            ? s.attributes.friendly_name
            : s.entity_id,
        }))
        .sort((a, b) => a.entity_id.localeCompare(b.entity_id))
      const entities: DashboardSnapshot['entities'] = states
        .filter(s => !s.entity_id.startsWith('scene.'))
        .sort((a, b) => a.entity_id.localeCompare(b.entity_id))
        .map(s => ({
          entity_id: s.entity_id,
          state: s.state,
          friendly_name: typeof s.attributes.friendly_name === 'string'
            ? s.attributes.friendly_name
            : s.entity_id,
          ...(typeof s.attributes.unit_of_measurement === 'string'
            ? { unit: s.attributes.unit_of_measurement }
            : {}),
        }))
      const events = ws.events.slice(-8).map(e => ({
        entity_id: e.entity_id,
        state: e.state,
        old_state: e.old_state,
        last_changed: e.last_changed,
      }))
      const snapshot: DashboardSnapshot = {
        kind: DASHBOARD_META_KIND,
        generatedAt: new Date().toISOString(),
        entities,
        scenes,
        events,
      }
      return snapshot
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ha_wait_for_state',
    description:
      'Poll one entity until its state matches (or stops matching) a target, up to a timeout. ' +
      'Real monitoring tasks: wait for the washer to finish, wait until the living room reaches ' +
      'a temperature, watch whether a door stays closed. The call blocks the turn until the ' +
      'condition is met, the timeout elapses, or the caller cancels. Returns matched=false on timeout ' +
      '(with the last observed state) — not an error.',
    parameters: {
      entityId: { type: 'string', required: true, description: 'Entity to watch, e.g. "binary_sensor.washer" or "sensor.temperature"' },
      targetState: { type: 'string', description: 'Wait until state EQUALS this (omit to use notTargetState)' },
      notTargetState: { type: 'string', description: 'Wait until state no longer equals this' },
      timeoutMs: { type: 'number', description: 'Max wait in ms (default 120000, max 600000)' },
      checkIntervalMs: { type: 'number', description: 'Poll interval in ms (default 1000, min 200)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          matched: { type: 'boolean' },
          entity_id: { type: 'string' },
          state: { type: 'string' },
          waitedMs: { type: 'number' },
        },
      },
      render: (_args, value) => text(
        value.matched
          ? `${value.entity_id} reached "${value.state}" after ${value.waitedMs}ms`
          : `${value.entity_id} did not match within ${value.waitedMs}ms (last state: ${value.state})`,
      ),
    },
    async execute(args, exec) {
      const entityId = args.entityId
      const timeoutMs = Math.min(Math.max(args.timeoutMs ?? 120000, 500), 600000)
      const intervalMs = Math.min(Math.max(args.checkIntervalMs ?? 1000, 200), 30000)
      const start = Date.now()
      let last = ''
      while (Date.now() - start < timeoutMs) {
        if (exec.signal.aborted) throw new Error('cancelled')
        const state = await client.getState(entityId)
        last = state.state
        const hit = args.targetState !== undefined
          ? state.state === args.targetState
          : args.notTargetState !== undefined
            ? state.state !== args.notTargetState
            : true
        if (hit) {
          return { matched: true, entity_id: entityId, state: state.state, waitedMs: Date.now() - start }
        }
        await sleep(intervalMs, exec.signal)
      }
      return { matched: false, entity_id: entityId, state: last, waitedMs: Date.now() - start }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ha_notify',
    description:
      'Send a notification through Home Assistant: a persistent notification in the HA UI ' +
      '(default), or any notify service such as a mobile app or speaker. Real business: ' +
      '"tell me on my phone when the task is done" or "announce on the living room speaker". ' +
      'Low-risk and not approval-gated.',
    parameters: {
      message: { type: 'string', required: true, description: 'Notification text' },
      title: { type: 'string', description: 'Optional title (persistent_notification only)' },
      notifyService: {
        type: 'string',
        description: 'Notify service id, e.g. "mobile_app_my_phone" or "persistent_notification" (default)',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          service: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => text(`Notification sent via ${value.service}.`),
    },
    async execute(args) {
      const service = args.notifyService ?? 'persistent_notification'
      if (service === 'persistent_notification') {
        await client.callService('persistent_notification', 'create', undefined, {
          message: args.message,
          ...(args.title ? { title: args.title } : {}),
        })
      } else {
        await client.callService('notify', service, undefined, { message: args.message, ...(args.title ? { title: args.title } : {}) })
      }
      return { ok: true, service, message: args.message }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ha_weather',
    description:
      'Current weather and a structured forecast from the Home Assistant weather entity. ' +
      'Saves the model from parsing raw weather attributes. Example: "what is the weather ' +
      'like tomorrow and should I take an umbrella?".',
    parameters: {
      entityId: { type: 'string', description: 'Weather entity id; defaults to the first weather.* entity' },
      forecastDays: { type: 'number', description: 'Forecast entries to return (default 3, max 7)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          entity_id: { type: 'string' },
          condition: { type: 'string' },
          temperature: { type: 'json' },
          humidity: { type: 'json' },
          forecast: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                datetime: { type: 'string' },
                condition: { type: 'string' },
                temperature: { type: 'json' },
                precipitation_probability: { type: 'json' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value as { condition?: string; temperature?: unknown; forecast?: { datetime: string; condition?: string; temperature?: unknown }[] }
        const lines = (v.forecast ?? []).map(f => `- ${f.datetime}: ${f.condition ?? '?'} ${f.temperature != null ? `${f.temperature}°` : ''}`)
        return text(truncate(`Weather: ${v.condition ?? 'unknown'}${v.temperature != null ? `, ${v.temperature}°` : ''}\n${lines.join('\n')}`))
      },
    },
    async execute(args) {
      const states = await client.getStates()
      const weather = args.entityId
        ? await client.getState(args.entityId)
        : states.find(s => s.entity_id.startsWith('weather.'))
        ?? (() => { throw new Error('dsh-smarthome: no weather entity found in Home Assistant') })()
      const attrs = weather.attributes
      const rawForecast = Array.isArray(attrs.forecast) ? attrs.forecast as Array<Record<string, unknown>> : []
      const days = Math.min(Math.max(args.forecastDays ?? 3, 1), 7)
      return {
        entity_id: weather.entity_id,
        condition: typeof attrs.condition === 'string' ? attrs.condition : weather.state,
        ...(attrs.temperature != null ? { temperature: attrs.temperature as JsonValue } : {}),
        ...(attrs.humidity != null ? { humidity: attrs.humidity as JsonValue } : {}),
        forecast: rawForecast.slice(0, days).map(f => ({
          datetime: String(f.datetime ?? ''),
          ...(f.condition != null ? { condition: String(f.condition) } : {}),
          ...(f.temperature != null ? { temperature: f.temperature as JsonValue } : {}),
          ...(f.precipitation_probability != null ? { precipitation_probability: f.precipitation_probability as JsonValue } : {}),
        })),
      }
    },
  }))

  // -------------------------------------------------------------------------
  // Lovelace dashboards. Home Assistant's dashboard API is WebSocket-only, so
  // these tools ride the same socket as the registries. Stored dashboards lean
  // on HACS card types, so editing is expressed as targeted ops against the
  // stored config rather than a whole-config rewrite: snapshot, apply, save,
  // read back and verify.
  // -------------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'ha_lovelace_list',
    description:
      'List the Home Assistant sidebar dashboards (Lovelace panels) with their mode. ' +
      '"storage" dashboards can be edited with ha_lovelace_apply; "yaml" dashboards are ' +
      'defined in configuration.yaml on the Home Assistant host and cannot be written ' +
      'through the API. Also reports whether the default overview already has a stored config.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const v = value as unknown as {
          dashboards?: { url_path?: string; title?: string; mode?: string }[]
          default?: { note?: string }
        }
        const lines = (v.dashboards ?? []).map(
          d => `- [${d.mode ?? '?'}] ${d.title || '(untitled)'}  url_path=${d.url_path ?? ''}`,
        )
        return text(truncate([...lines, `default overview: ${v.default?.note ?? ''}`].join('\n')))
      },
    },
    async execute() {
      const dashboards = await ws.listLovelaceDashboards()
      const list = dashboards
        .map(d => ({
          // YAML-mode entries carry a filename but no id, so never leak undefined.
          id: typeof d.id === 'string' ? d.id : '',
          url_path: typeof d.url_path === 'string' ? d.url_path : '',
          title: d.title ?? '',
          mode: d.mode ?? 'storage',
          show_in_sidebar: d.show_in_sidebar !== false,
        }))
        .sort((a, b) => a.url_path.localeCompare(b.url_path))

      let mode = 'storage'
      let note: string
      try {
        await ws.getLovelaceConfig()
        note = 'has a stored config and can be edited (pass no urlPath)'
      } catch (error) {
        if (isLovelaceConfigMissing(error)) {
          note = 'auto-generated (no stored config); the first save takes it over (pass no urlPath)'
        } else if (isLovelaceYamlMode(error)) {
          mode = 'yaml'
          note = 'defined in YAML on the Home Assistant host; not writable through the API'
        } else {
          throw error
        }
      }
      return { count: list.length, dashboards: list, default: { urlPath: '', mode, note } }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ha_lovelace_get',
    description:
      'Read one Lovelace dashboard and return an index of its views, sections and cards ' +
      '(index, card type, entity, title), plus a snapshot on disk as an undo point. Omit ' +
      'urlPath for the default overview. Views are addressed by index, path or title; cards ' +
      'by their index inside a view — or inside a section when the view is of type "sections". ' +
      'Prefer the index over includeConfig: stored dashboards ' +
      'are large and depend on dozens of HACS card types.',
    parameters: {
      urlPath: {
        type: 'string',
        description: 'Dashboard url_path from ha_lovelace_list; omit for the default overview',
      },
      includeConfig: {
        type: 'boolean',
        description: 'Also return the raw config JSON (large — only when the index is not enough)',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const v = value as unknown as LovelaceSummary & { backup?: string; exists?: boolean; note?: string }
        const head = [
          `backup: ${v.backup ?? '-'}`,
          ...(v.exists === false ? [`note: ${v.note ?? 'no stored config yet'}`] : []),
        ]
        return text(truncate([...head, describeLovelaceSummary(v)].join('\n')))
      },
    },
    async execute(args) {
      const urlPath = normalizeUrlPath(args.urlPath)
      const { config, missing } = await readLovelace(ws, urlPath)
      const summary = summarizeLovelace(urlPath, config)
      // Hand out an undo point with every read: the model may follow up with a
      // setRaw rewrite, and that has to stay reversible.
      const backup = await backups.save(urlPath, config, 'ha_lovelace_get')
      return {
        ...summary,
        exists: !missing,
        ...(missing ? { note: 'no stored config yet — the first save takes the dashboard over' } : {}),
        backup: backup.id,
        backupCount: (await backups.list(urlPath)).length,
        ...(args.includeConfig ? { config: config as unknown as JsonValue } : {}),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ha_lovelace_apply',
    description:
      'Edit a Lovelace dashboard with structural operations (approval required). Reads the ' +
      'dashboard, snapshots it to disk, applies the ops, saves over WebSocket, then reads back ' +
      'to verify. Ops, applied in order and atomically (one bad op changes nothing): ' +
      '{op:"setTitle",title}; {op:"addView",view,position?}; {op:"updateView",view,patch}; ' +
      '{op:"removeView",view}; {op:"addSection",view,section,position?}; ' +
      '{op:"updateSection",view,section,patch}; {op:"removeSection",view,section}; ' +
      '{op:"addCard",view,section?,card,position?} where card is a full card object such as ' +
      '{type:"entities",title:"Lights",entities:["light.kitchen"]}; ' +
      '{op:"updateCard",view,section?,index,patch}; {op:"replaceCard",view,section?,index,card}; ' +
      '{op:"removeCard",view,section?,index}; {op:"moveCard",view,section?,index,toView?,toSection?,toIndex?}; ' +
      '{op:"setRaw",config}. "view" is a view index, path or title; position is "start", ' +
      '"end" or an index; update patches merge shallowly. Views of type "sections" (the Home ' +
      'Assistant default) keep their cards in sections, so there the card ops require "section": ' +
      '<index> — ha_lovelace_get lists every section. Set dryRun to preview the result ' +
      'without saving (still approval-gated).',
    parameters: {
      urlPath: {
        type: 'string',
        description: 'Dashboard url_path from ha_lovelace_list; omit for the default overview',
      },
      ops: {
        type: 'array',
        description: 'Operations to apply, in order',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            op: { type: 'string', description: 'Operation name, e.g. "addCard"' },
          },
        },
      },
      reason: {
        type: 'string',
        description: 'Short human-readable reason for the change; recorded in the backup',
      },
      dryRun: {
        type: 'boolean',
        description: 'Preview the resulting index without saving anything',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const v = value as unknown as {
          applied?: string[]
          dryRun?: boolean
          backup?: string
          verified?: boolean
          urlPath?: string
          after?: { viewCount: number; cardCount: number; bytes: number }
          views?: LovelaceSummary['views']
        }
        const head = v.dryRun
          ? `Dry run — nothing saved. Would apply: ${(v.applied ?? []).join('; ') || '(no ops)'}`
          : `Saved${v.verified === false ? ' (read-back differs — inspect with ha_lovelace_get)' : ''}: ` +
            `${(v.applied ?? []).join('; ') || '(no ops)'}${v.backup ? ` · backup ${v.backup}` : ''}`
        // The result carries counts under `after`, not as a flat summary.
        const after = v.after ?? { viewCount: 0, cardCount: 0, bytes: 0 }
        return text(
          truncate(
            [
              head,
              describeLovelaceSummary({
                urlPath: v.urlPath ?? '',
                title: '',
                viewCount: after.viewCount,
                cardCount: after.cardCount,
                bytes: after.bytes,
                views: v.views ?? [],
              }),
            ].join('\n'),
          ),
        )
      },
    },
    async execute(args) {
      const urlPath = normalizeUrlPath(args.urlPath)
      const ops = (args.ops ?? []) as LovelaceOp[]
      const { config, missing } = await readLovelace(ws, urlPath)
      const before = summarizeLovelace(urlPath, config)
      const { config: next, applied } = applyLovelaceOps(config, ops)
      const after = summarizeLovelace(urlPath, next)

      if (args.dryRun) {
        return {
          ok: true,
          dryRun: true,
          saved: false,
          urlPath,
          applied,
          before: countsOf(before),
          after: countsOf(after),
          views: after.views,
        }
      }

      const backup = await backups.save(
        urlPath,
        config,
        args.reason ?? `ha_lovelace_apply: ${applied.join('; ') || '(no ops)'}`,
      )
      await ws.saveLovelaceConfig(urlPath || undefined, next)

      // Read back: Home Assistant could have normalized the config, and the
      // model deserves to know whether what it asked for is what is stored.
      const stored = await readLovelace(ws, urlPath)
      const verified = JSON.stringify(stored.config) === JSON.stringify(next)
      return {
        ok: true,
        dryRun: false,
        saved: true,
        urlPath,
        applied,
        verified,
        ...(missing ? { tookOver: true } : {}),
        backup: backup.id,
        ...(verified
          ? {}
          : {
              note:
                'Saved, but the read-back differs from what was sent. Inspect the dashboard, ' +
                `and use ha_lovelace_restore(backup="${backup.id}") to roll back if needed.`,
            }),
        before: countsOf(before),
        after: countsOf(after),
        views: after.views,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ha_lovelace_restore',
    description:
      'Restore a Lovelace dashboard from a snapshot taken by ha_lovelace_get or ' +
      'ha_lovelace_apply (approval required). Pass backup="latest" for the newest snapshot of ' +
      'urlPath, or a backup id from the backup field of an earlier result. The current state is ' +
      'snapshotted first, so a restore is itself undoable.',
    parameters: {
      backup: {
        type: 'string',
        required: true,
        description: 'Backup id from an earlier result, or "latest"',
      },
      urlPath: {
        type: 'string',
        description: 'Dashboard to restore; defaults to the dashboard the snapshot came from',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const v = value as unknown as LovelaceSummary & {
          restoredFrom?: string
          previousBackup?: string
          restoredAt?: string
        }
        const head = `Restored from ${v.restoredFrom ?? '?'} (${v.restoredAt ?? '?'}) · previous state saved as ${v.previousBackup ?? '-'}`
        return text(truncate([head, describeLovelaceSummary(v)].join('\n')))
      },
    },
    async execute(args) {
      const requested = args.backup.trim()
      const hint = args.urlPath === undefined ? undefined : normalizeUrlPath(args.urlPath)
      const id = requested === 'latest' ? await backups.latest(hint) : requested
      const record = await backups.read(id)
      const urlPath = hint ?? record.urlPath
      const current = await readLovelace(ws, urlPath)
      const safety = await backups.save(urlPath, current.config, 'ha_lovelace_restore: pre-restore snapshot')
      await ws.saveLovelaceConfig(urlPath || undefined, record.config)
      const after = summarizeLovelace(urlPath, record.config)
      return {
        ok: true,
        urlPath,
        restoredFrom: record.id,
        restoredAt: record.savedAt,
        previousBackup: safety.id,
        before: countsOf(summarizeLovelace(urlPath, current.config)),
        after: countsOf(after),
        views: after.views,
      }
    },
  }))
}

/** Dashboard url_path: `''` (or omitted) means the default overview. */
function normalizeUrlPath(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new Error('dsh-smarthome: "urlPath" must be a string')
  const trimmed = value.trim().replace(/^\/+/, '')
  if (trimmed.length > 0 && !/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    throw new Error(`dsh-smarthome: "${trimmed}" is not a valid dashboard url_path (see ha_lovelace_list)`)
  }
  return trimmed
}

/**
 * Read a dashboard config. An auto-generated overview reports no stored config
 * at all, which is not an error here: it is an empty config that the first save
 * takes over.
 */
async function readLovelace(
  ws: HomeAssistantWsClient,
  urlPath: string,
): Promise<{ config: LovelaceConfig; missing: boolean }> {
  try {
    const config = await ws.getLovelaceConfig(urlPath || undefined)
    return { config: normalizeLovelaceConfig(config), missing: false }
  } catch (error) {
    if (isLovelaceConfigMissing(error)) return { config: { views: [] }, missing: true }
    throw error
  }
}

function countsOf(summary: LovelaceSummary): {
  viewCount: number
  cardCount: number
  sectionCardCount?: number
  bytes: number
} {
  return {
    viewCount: summary.viewCount,
    cardCount: summary.cardCount,
    ...(summary.sectionCardCount === undefined ? {} : { sectionCardCount: summary.sectionCardCount }),
    bytes: summary.bytes,
  }
}

/** Human-readable index of a dashboard for the tool-result text. */
function describeLovelaceSummary(summary: LovelaceSummary): string {
  const sections = summary.sectionCardCount ?? 0
  const head =
    `${summary.urlPath || '(default overview)'}: ${summary.title || '(untitled)'} — ` +
    `${summary.viewCount} views, ${summary.cardCount}${sections > 0 ? ` + ${sections} in sections` : ''} cards, ` +
    `${summary.bytes} bytes`
  const cardLines = (cards: LovelaceSummary['views'][number]['cards'], indent: string): string[] =>
    cards.map(card => {
      const parts = [`[${card.index}] ${card.type}`]
      if (card.entity) parts.push(card.entity)
      if (card.entities) parts.push(card.entities.join(', '))
      if (card.title) parts.push(`"${card.title}"`)
      if (card.cards !== undefined) parts.push(`(+${card.cards} nested)`)
      return `${indent}${parts.join(' ')}`
    })
  const views = (summary.views ?? []).map(view => {
    const label = view.path ?? view.title ?? `view ${view.index}`
    const viewSections = view.sections ?? []
    const lines = [
      `  view ${view.index} (${label}) — ${view.cardCount} cards` +
        (viewSections.length > 0 ? `, ${viewSections.length} sections (${view.sectionCardCount ?? 0} cards)` : ''),
      ...cardLines(view.cards, '    '),
    ]
    if (view.truncatedCards !== undefined) lines.push(`    … ${view.truncatedCards} more`)
    for (const section of viewSections) {
      lines.push(`    section ${section.index} — ${section.cardCount} cards`)
      lines.push(...cardLines(section.cards, '      '))
      if (section.truncatedCards !== undefined) lines.push(`      … ${section.truncatedCards} more`)
    }
    return lines.join('\n')
  })
  return [head, ...views].join('\n')
}

/** Resolve after `ms`, abortable via the execution signal. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('cancelled'))
    }, { once: true })
  })
}
