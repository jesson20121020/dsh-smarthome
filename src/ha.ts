/**
 * Minimal, dependency-free Home Assistant REST API client.
 *
 * Only the v1 REST API is used: states, history, service calls, config, and
 * template rendering. Everything is plain JSON over fetch, so the plugin has
 * zero runtime dependencies beyond what the harness already provides.
 */

/** Lossless JSON value (Home Assistant API payloads are plain JSON). */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

export interface HaState {
  entity_id: string
  state: string
  attributes: Record<string, Json>
  last_changed: string
  last_updated: string
  context?: { id?: string; user_id?: string | null; parent_id?: string | null }
}

export interface HaConfig {
  location_name?: string
  version?: string
  time_zone?: string
  unit_system?: { length?: string; mass?: string; temperature?: string; volume?: string }
  [key: string]: unknown
}

export class HomeAssistantError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'HomeAssistantError'
    this.status = status
  }
}

/** True when the error means "this dashboard has no stored config yet". */
export function isLovelaceConfigMissing(err: unknown): boolean {
  return err instanceof HomeAssistantError && /config_not_found/.test(err.message)
}

/** True when the error means "this dashboard lives in YAML, not in storage". */
export function isLovelaceYamlMode(err: unknown): boolean {
  return err instanceof HomeAssistantError && /yaml/i.test(err.message)
}

export interface HistoryOptions {
  /** ISO start time; defaults to one hour ago. */
  start?: string
  /** Optional ISO end time. */
  end?: string
  /** Restrict to one entity. */
  entityId?: string
}

export class HomeAssistantClient {
  readonly baseUrl: string
  readonly token: string
  readonly timeoutMs: number
  private readonly resolveToken?: () => Promise<string>

  constructor(
    baseUrl: string,
    token: string,
    timeoutMs = 15000,
    resolveToken?: () => Promise<string>,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.token = token
    this.timeoutMs = timeoutMs
    this.resolveToken = resolveToken
  }

  /** True when a token source is available; all requests fail loudly when false. */
  get configured(): boolean {
    return this.token.length > 0 || this.resolveToken !== undefined
  }

  /** Resolve the current token (re-resolved per request when a resolver is set). */
  private async tokenFor(): Promise<string> {
    if (this.resolveToken) return (await this.resolveToken()) ?? ''
    return this.token
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    return this.send(path, init, async res => (await res.json()) as T)
  }

  /** Same pipeline as {@link request}, for endpoints that answer with plain text. */
  private requestText(path: string, init: RequestInit = {}): Promise<string> {
    return this.send(path, init, res => res.text())
  }

  private async send<T>(
    path: string,
    init: RequestInit,
    parse: (res: Response) => Promise<T>,
  ): Promise<T> {
    const token = await this.tokenFor()
    if (!token) {
      throw new HomeAssistantError(
        'dsh-smarthome is not configured: no Home Assistant token. ' +
          'Set `token` or `tokenEnv` in the smarthome plugin config, then restart dsh.',
      )
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...init.headers,
        },
        signal: controller.signal,
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        const detail = body ? `: ${body.slice(0, 300)}` : ''
        throw new HomeAssistantError(
          `Home Assistant ${res.status} ${res.statusText}${detail}`,
          res.status,
        )
      }
      return await parse(res)
    } catch (err) {
      if (err instanceof HomeAssistantError) throw err
      if (err instanceof Error && err.name === 'AbortError') {
        throw new HomeAssistantError(
          `Home Assistant request timed out after ${this.timeoutMs}ms: ${path}`,
        )
      }
      throw new HomeAssistantError(
        `Home Assistant request failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * `GET /api/` — Home Assistant answers `{"message":"API running."}` (an object,
   * not a bare string), so unwrap the message before asserting reachability.
   */
  async health(): Promise<string> {
    const body = await this.request<{ message?: unknown } | string>('/api/')
    if (typeof body === 'string') return body
    if (typeof body === 'object' && body !== null && typeof body.message === 'string') {
      return body.message
    }
    return JSON.stringify(body)
  }

  /** `GET /api/config` — instance name, version, timezone, unit system. */
  getConfig(): Promise<HaConfig> {
    return this.request<HaConfig>('/api/config')
  }

  /** `GET /api/states` — every entity state. */
  getStates(): Promise<HaState[]> {
    return this.request<HaState[]>('/api/states')
  }

  /** `GET /api/states/<entity_id>` — one entity state. */
  getState(entityId: string): Promise<HaState> {
    return this.request<HaState>(`/api/states/${encodeURIComponent(entityId)}`)
  }

  /**
   * `POST /api/services/<domain>/<service>`.
   * `target` (entity_id / area_id / device_id) and `data` merge into one body.
   */
  callService(
    domain: string,
    service: string,
    target?: Record<string, unknown>,
    data?: Record<string, unknown>,
  ): Promise<unknown> {
    return this.request(`/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`, {
      method: 'POST',
      body: JSON.stringify({ ...target, ...data }),
    })
  }

  /** `GET /api/history/period/<start>` — one array of state timelines per entity. */
  async getHistory(options: HistoryOptions = {}): Promise<HaState[][]> {
    const start = options.start ?? new Date(Date.now() - 3600_000).toISOString()
    const query = new URLSearchParams()
    if (options.end) query.set('end', options.end)
    if (options.entityId) query.set('filter_entity_id', options.entityId)
    query.set('minimal_response', '')
    const qs = query.toString()
    const path = `/api/history/period/${encodeURIComponent(start)}${qs ? `?${qs}` : ''}`
    const periods = await this.request<HaState[][]>(path)
    // `minimal_response` makes Home Assistant strip `entity_id` (and attributes /
    // last_updated) from every entry but the first. Passing those holes through
    // would put `undefined` in the tool result, which is not lossless JSON, so the
    // harness rejects the whole call — fill the identity back in instead.
    return periods.map(period =>
      (Array.isArray(period) ? period : []).map(state => ({
        ...state,
        entity_id:
          typeof state.entity_id === 'string' && state.entity_id.length > 0
            ? state.entity_id
            : (options.entityId ?? ''),
        state: typeof state.state === 'string' ? state.state : String(state.state ?? ''),
        last_changed: typeof state.last_changed === 'string' ? state.last_changed : '',
        last_updated:
          typeof state.last_updated === 'string' ? state.last_updated : (state.last_changed ?? ''),
        attributes: state.attributes ?? {},
      })),
    )
  }

  /**
   * `POST /api/template` — render a Jinja2 template server-side. Home Assistant
   * answers with the rendered text itself (`text/plain`), never JSON.
   */
  renderTemplate(template: string): Promise<string> {
    return this.requestText('/api/template', {
      method: 'POST',
      body: JSON.stringify({ template }),
    })
  }
}

// ---------------------------------------------------------------------------
// WebSocket API (real-time) — uses Node's built-in global WebSocket (Node ≥ 22),
// so the plugin keeps zero runtime dependencies.
// ---------------------------------------------------------------------------

export interface HaArea {
  area_id: string
  name: string
}

/** One device from the HA device registry (WebSocket `config/device_registry/list`). */
export interface HaDevice {
  id: string
  name: string
  area_id?: string | null
}

/**
 * One sidebar dashboard from the HA Lovelace registry
 * (WebSocket `lovelace/dashboards/list`). `mode` is `storage` (editable through
 * the API) or `yaml` (edited on the Home Assistant host).
 */
export interface HaLovelaceDashboard {
  id: string
  url_path: string
  title?: string | null
  mode?: string
  icon?: string | null
  require_admin?: boolean
  show_in_sidebar?: boolean
  filename?: string | null
}

/** One `state_changed` event, normalized for the model. */
export interface HaStateChange {
  entity_id: string
  state: string
  old_state: string | null
  last_changed: string
}

export type HaWsStatus = 'connected' | 'connecting' | 'disconnected' | 'unavailable'

export interface HaWsOptions {
  /** Master switch; false disables the socket entirely. */
  enabled: boolean
  /** Rolling event buffer size. */
  bufferSize: number
  /** Optional listener for every normalized state change (inject notifications). */
  onEvent?: (change: HaStateChange) => void
}

interface WsMessage {
  id?: number
  type: string
  success?: boolean
  event?: { event_type?: string; data?: Record<string, unknown> }
  result?: unknown
  error?: { code?: string; message?: string }
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Minimal Home Assistant WebSocket client: authenticates, subscribes to
 * `state_changed`, keeps a rolling event buffer, answers pings, and reconnects
 * with backoff. All WS features degrade gracefully when the socket is
 * unavailable (no WebSocket global) or disconnected (real HA not reachable).
 *
 * `start()` opens the socket; `dispose()` closes it and stops reconnecting.
 */
export class HomeAssistantWsClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly options: HaWsOptions
  private readonly resolveToken?: () => Promise<string>
  private socket: WebSocket | null = null
  private readonly pending = new Map<number, PendingRequest>()
  private nextId = 1
  private disposed = false
  private reconnectDelay = 1000
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  status: HaWsStatus = 'disconnected'
  readonly events: HaStateChange[] = []

  constructor(
    baseUrl: string,
    token: string,
    options: HaWsOptions,
    resolveToken?: () => Promise<string>,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.token = token
    this.options = options
    this.resolveToken = resolveToken
  }

  /** Resolve the current token (re-resolved per connection when a resolver is set). */
  private async tokenFor(): Promise<string> {
    if (this.resolveToken) return (await this.resolveToken()) ?? ''
    return this.token
  }

  /** Open the socket (no-op when disabled or unavailable). */
  async start(): Promise<void> {
    if (this.disposed) return
    if (!this.options.enabled) {
      this.status = 'disconnected'
      return
    }
    if (typeof WebSocket === 'undefined') {
      this.status = 'unavailable'
      return
    }
    if (this.socket && this.socket.readyState < 2) return // already open/connecting

    const token = await this.tokenFor()
    const wsUrl = `${this.baseUrl.replace(/^http/, 'ws')}/api/websocket`
    const socket = new WebSocket(wsUrl)
    this.socket = socket
    this.status = 'connecting'

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'auth', access_token: token }))
    })
    socket.addEventListener('message', (event) => {
      this.onMessage(event.data as string, token)
    })
    socket.addEventListener('close', () => {
      if (this.socket === socket) this.socket = null
      if (this.status !== 'unavailable') this.status = 'disconnected'
      // Fail pending requests fast instead of leaving them to their 8s timeout:
      // a dropped connection cannot answer them.
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new HomeAssistantError('Home Assistant WebSocket connection closed'))
      }
      this.pending.clear()
      this.scheduleReconnect()
    })
    socket.addEventListener('error', () => {
      // 'close' follows; nothing to do here.
    })
  }

  private onMessage(raw: string, token: string): void {
    let msg: WsMessage
    try {
      msg = JSON.parse(raw) as WsMessage
    } catch {
      return
    }
    if (msg.type === 'auth_required') {
      this.socket?.send(JSON.stringify({ type: 'auth', access_token: token }))
      return
    }
    if (msg.type === 'auth_ok') {
      this.status = 'connected'
      this.reconnectDelay = 1000
      this.socket?.send(JSON.stringify({
        id: this.nextId++,
        type: 'subscribe_events',
        event_type: 'state_changed',
      }))
      return
    }
    if (msg.type === 'auth_invalid' || msg.type === 'auth_failed') {
      this.status = 'disconnected'
      return
    }
    if (msg.type === 'pong') return
    if (msg.type === 'ping') {
      this.socket?.send(JSON.stringify({ type: 'pong' }))
      return
    }
    if (msg.type === 'event' && msg.event?.event_type === 'state_changed') {
      const data = msg.event.data ?? {}
      const entityId = typeof data.entity_id === 'string' ? data.entity_id : ''
      const newState = data.new_state as { state?: string; last_changed?: string } | null | undefined
      const oldState = data.old_state as { state?: string } | null | undefined
      if (entityId && newState?.state != null) {
        const change: HaStateChange = {
          entity_id: entityId,
          state: newState.state,
          old_state: oldState?.state ?? null,
          last_changed: newState.last_changed ?? new Date().toISOString(),
        }
        this.events.push(change)
        if (this.events.length > this.options.bufferSize) this.events.shift()
        this.options.onEvent?.(change)
      }
      return
    }
    // Request/response correlation (e.g. config/area_registry/list).
    if (typeof msg.id === 'number') {
      const pending = this.pending.get(msg.id)
      if (pending) {
        this.pending.delete(msg.id)
        clearTimeout(pending.timer)
        if (msg.success) pending.resolve(msg.result)
        else {
          // Home Assistant reports failures as `{success:false, error:{code,message}}`;
          // `result` is only there on success. Surface whichever is present.
          const detail = msg.error ?? msg.result
          pending.reject(new HomeAssistantError(`Home Assistant WebSocket error: ${JSON.stringify(detail)}`))
        }
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer || !this.options.enabled) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.disposed) return
      void this.start()
    }, this.reconnectDelay)
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000)
  }

  /** Query the area registry over the socket (HA WebSocket API). */
  listAreas(): Promise<HaArea[]> {
    return this.request<HaArea[]>('config/area_registry/list')
  }

  /**
   * Query the device registry over the socket (HA WebSocket API).
   */
  async listDevices(): Promise<HaDevice[]> {
    const devices = await this.request<Array<{ id: string; name?: string | null; name_by_user?: string | null; area_id?: string | null }>>(
      'config/device_registry/list',
    )
    return devices.map(d => ({
      id: d.id,
      name: d.name_by_user ?? d.name ?? d.id,
      ...(d.area_id ? { area_id: d.area_id } : {}),
    }))
  }

  /** List the sidebar dashboards with their mode (storage vs yaml) over the socket. */
  listLovelaceDashboards(): Promise<HaLovelaceDashboard[]> {
    return this.request<HaLovelaceDashboard[]>('lovelace/dashboards/list')
  }

  /**
   * Read a dashboard's stored configuration (`lovelace/config`). Omit `urlPath`
   * for the default overview. Rejects with `config_not_found` when the dashboard
   * has no stored config (an auto-generated overview) and with a YAML-mode error
   * when it is defined in `configuration.yaml` — Lovelace is WebSocket-only,
   * there is no REST endpoint for it.
   */
  getLovelaceConfig(urlPath?: string): Promise<unknown> {
    return this.request<unknown>(
      'lovelace/config',
      urlPath ? { url_path: urlPath } : undefined,
      15000,
    )
  }

  /** Write a dashboard's configuration (`lovelace/config/save`, storage mode only). */
  saveLovelaceConfig(urlPath: string | undefined, config: unknown): Promise<unknown> {
    return this.request<unknown>(
      'lovelace/config/save',
      { ...(urlPath ? { url_path: urlPath } : {}), config },
      20000,
    )
  }

  /** Send an arbitrary Home Assistant WebSocket command (request/response). */
  command<T>(type: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    return this.request<T>(type, params, timeoutMs)
  }

  private request<T>(type: string, params?: Record<string, unknown>, timeoutMs = 8000): Promise<T> {
    if (this.status === 'unavailable') {
      return Promise.reject(new HomeAssistantError(
        'dsh-smarthome: WebSocket is unavailable in this Node runtime (needs the built-in WebSocket, Node ≥ 22).',
      ))
    }
    if (this.status !== 'connected' || !this.socket || this.socket.readyState !== 1) {
      return Promise.reject(new HomeAssistantError(
        'dsh-smarthome: WebSocket is not connected to Home Assistant (is it running? check ha_health).',
      ))
    }
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new HomeAssistantError(`Home Assistant WebSocket request "${type}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      this.socket?.send(JSON.stringify({ ...params, id, type }))
    })
  }

  /** Close the socket and stop reconnecting. */
  dispose(): void {
    this.disposed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new HomeAssistantError('dsh-smarthome: WebSocket disposed'))
    }
    this.pending.clear()
    if (this.socket) this.socket.close()
    this.socket = null
  }
}
