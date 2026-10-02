/**
 * Lovelace dashboard editing.
 *
 * Home Assistant's dashboard API is WebSocket-only (there is no REST endpoint),
 * and a stored dashboard config is a deeply nested, card-type-specific tree that
 * typically leans on dozens of HACS resources. Letting a model rewrite the whole
 * thing would be destructive, so every edit is expressed as a small, targeted
 * operation against the stored config: snapshot first, apply ops atomically,
 * save, then read back and verify.
 *
 * This module is intentionally free of I/O beyond the backup directory, so the
 * operation language can be unit-tested directly.
 */

import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** A dashboard configuration object, exactly as Home Assistant stores it. */
export type LovelaceConfig = Record<string, unknown>

/** Views are addressed by index, by `path`, or by `title`. */
export type ViewSelector = number | string

/** One structural edit; see {@link applyLovelaceOps} for the vocabulary. */
export interface LovelaceOp {
  op?: string
  [key: string]: unknown
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error(`${label}: expected a JSON object`)
  return value
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label}: expected a non-empty string`)
  }
  return value
}

/** Normalize an untrusted value into a dashboard config object. */
export function normalizeLovelaceConfig(value: unknown): LovelaceConfig {
  if (!isPlainObject(value)) throw new Error('dsh-smarthome: the dashboard config is not a JSON object')
  return value
}

/** Views array of a dashboard config, created on demand. */
function viewsOf(config: LovelaceConfig): Record<string, unknown>[] {
  const views = config.views
  if (views === undefined) {
    const created: Record<string, unknown>[] = []
    config.views = created
    return created
  }
  if (!Array.isArray(views)) {
    throw new Error('this dashboard has a non-array "views" — fix it in Home Assistant first')
  }
  return views as Record<string, unknown>[]
}

function cardsOf(view: Record<string, unknown>, label: string): Record<string, unknown>[] {
  const cards = view.cards
  if (cards === undefined) {
    const created: Record<string, unknown>[] = []
    view.cards = created
    return created
  }
  if (!Array.isArray(cards)) throw new Error(`${label}: the target view has a non-array "cards"`)
  return cards as Record<string, unknown>[]
}

function describeView(view: Record<string, unknown>): string {
  if (typeof view.path === 'string' && view.path.length > 0) return view.path
  if (typeof view.title === 'string' && view.title.length > 0) return view.title
  return 'view'
}

function resolveViewIndex(config: LovelaceConfig, selector: unknown, label: string): number {
  const views = viewsOf(config)
  if (typeof selector === 'number') {
    if (!Number.isInteger(selector) || selector < 0 || selector >= views.length) {
      throw new Error(`${label}: view index ${selector} is out of range (0..${views.length - 1})`)
    }
    return selector
  }
  if (typeof selector === 'string' && selector.length > 0) {
    const byPath = views.findIndex(v => v.path === selector)
    if (byPath >= 0) return byPath
    const byTitle = views.findIndex(v => v.title === selector)
    if (byTitle >= 0) return byTitle
    throw new Error(
      `${label}: no view matches "${selector}" — use the index, path or title reported by ha_lovelace_get`,
    )
  }
  throw new Error(`${label}: "view" is required (a view index, path, or title)`)
}

function resolvePosition(position: unknown, length: number, label: string): number {
  if (position === undefined || position === 'end') return length
  if (position === 'start') return 0
  if (typeof position === 'number' && Number.isInteger(position)) {
    if (position < 0 || position > length) {
      throw new Error(`${label}: position ${position} is out of range (0..${length})`)
    }
    return position
  }
  throw new Error(`${label}: position must be "start", "end" or an integer in 0..${length}`)
}

function requireCard(value: unknown, label: string): Record<string, unknown> {
  const card = requireObject(value, `${label}: "card"`)
  requireString(card.type, `${label}: card.type`)
  return card
}

function resolveCardIndex(cards: readonly unknown[], index: unknown, label: string): number {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= cards.length) {
    throw new Error(`${label}: "index" must be an existing card index in 0..${cards.length - 1}`)
  }
  return index
}

/**
 * Apply a list of operations to a dashboard config.
 *
 * The operations run against a structural clone, so a failing op never leaves a
 * half-edited config behind. Vocabulary:
 *
 * - `{op:'setTitle', title}` — dashboard title
 * - `{op:'addView', view, position?}` / `{op:'updateView', view, patch}` /
 *   `{op:'removeView', view}`
 * - `{op:'addCard', view, card, position?}` / `{op:'updateCard', view, index, patch}` /
 *   `{op:'replaceCard', view, index, card}` / `{op:'removeCard', view, index}`
 * - `{op:'moveCard', view, index, toView?, toIndex?}`
 * - `moveCard`'s `toIndex` counts in the destination view *after* the card is
 *   removed, so moving the last card of a two-card view is `toIndex: 1`.
 * - `{op:'setRaw', config}` — replace the whole config (still backed up)
 *
 * `updateView` / `updateCard` merge their patch shallowly; `cards` is only ever
 * touched by the explicit card ops.
 */
export function applyLovelaceOps(
  config: LovelaceConfig,
  ops: readonly LovelaceOp[],
): { config: LovelaceConfig; applied: string[] } {
  if (!Array.isArray(ops)) throw new Error('"ops" must be an array of operations')
  const next = structuredClone(config)
  if (next.views !== undefined && !Array.isArray(next.views)) {
    throw new Error('this dashboard has a non-array "views" — fix it in Home Assistant first')
  }
  const applied: string[] = []

  ops.forEach((rawOp, position) => {
    const op = rawOp as LovelaceOp
    const label = `ops[${position}] (${typeof op.op === 'string' ? op.op : 'missing op'})`
    switch (op.op) {
      case 'setTitle': {
        const title = requireString(op.title, `${label}: "title"`)
        next.title = title
        applied.push(`setTitle "${title}"`)
        return
      }
      case 'addView': {
        const views = viewsOf(next)
        const view = requireObject(op.view, `${label}: "view"`)
        const at = resolvePosition(op.position, views.length, label)
        views.splice(at, 0, view)
        applied.push(`addView at ${at} (${describeView(view)})`)
        return
      }
      case 'updateView': {
        const views = viewsOf(next)
        const at = resolveViewIndex(next, op.view, label)
        const patch = requireObject(op.patch, `${label}: "patch"`)
        const current = views[at] ?? {}
        views[at] = { ...current, ...patch }
        applied.push(`updateView ${describeView(views[at] ?? {})} (${Object.keys(patch).join(', ')})`)
        return
      }
      case 'removeView': {
        const views = viewsOf(next)
        const at = resolveViewIndex(next, op.view, label)
        const [removed] = views.splice(at, 1)
        applied.push(`removeView ${at} (${describeView(removed ?? {})})`)
        return
      }
      case 'addCard': {
        const views = viewsOf(next)
        const at = resolveViewIndex(next, op.view, label)
        const view = views[at] ?? {}
        const cards = cardsOf(view, label)
        const card = requireCard(op.card, label)
        const insertAt = resolvePosition(op.position, cards.length, label)
        cards.splice(insertAt, 0, card)
        applied.push(`addCard ${describeView(view)}[${insertAt}] (${String(card.type)})`)
        return
      }
      case 'updateCard': {
        const cards = cardsOf(viewsOf(next)[resolveViewIndex(next, op.view, label)] ?? {}, label)
        const at = resolveCardIndex(cards, op.index, label)
        const patch = requireObject(op.patch, `${label}: "patch"`)
        cards[at] = { ...(cards[at] ?? {}), ...patch }
        applied.push(`updateCard [${at}] (${Object.keys(patch).join(', ')})`)
        return
      }
      case 'replaceCard': {
        const cards = cardsOf(viewsOf(next)[resolveViewIndex(next, op.view, label)] ?? {}, label)
        const at = resolveCardIndex(cards, op.index, label)
        cards[at] = requireCard(op.card, label)
        applied.push(`replaceCard [${at}]`)
        return
      }
      case 'removeCard': {
        const cards = cardsOf(viewsOf(next)[resolveViewIndex(next, op.view, label)] ?? {}, label)
        const at = resolveCardIndex(cards, op.index, label)
        cards.splice(at, 1)
        applied.push(`removeCard [${at}]`)
        return
      }
      case 'moveCard': {
        const views = viewsOf(next)
        const fromViewIndex = resolveViewIndex(next, op.view, label)
        const fromView = views[fromViewIndex] ?? {}
        const cards = cardsOf(fromView, label)
        const at = resolveCardIndex(cards, op.index, label)
        const toViewIndex = op.toView === undefined
          ? fromViewIndex
          : resolveViewIndex(next, op.toView, label)
        const toView = views[toViewIndex] ?? {}
        const targetCards = toView === fromView ? cards : cardsOf(toView, label)
        const [card] = cards.splice(at, 1)
        if (card === undefined) throw new Error(`${label}: card ${at} disappeared mid-move`)
        const to = resolvePosition(op.toIndex, targetCards.length, label)
        targetCards.splice(to, 0, card)
        applied.push(`moveCard ${describeView(fromView)}[${at}] → ${describeView(toView)}[${to}]`)
        return
      }
      case 'setRaw': {
        const replacement = normalizeLovelaceConfig(op.config)
        for (const key of Object.keys(next)) delete next[key]
        Object.assign(next, structuredClone(replacement))
        applied.push('setRaw (whole config replaced)')
        return
      }
      default:
        throw new Error(
          `${label}: unknown op — allowed: setTitle, addView, updateView, removeView, ` +
            'addCard, updateCard, replaceCard, removeCard, moveCard, setRaw',
        )
    }
  })

  return { config: next, applied }
}

// ---------------------------------------------------------------------------
// Compact summaries — a stored dashboard can be hundreds of kilobytes, so the
// model gets an index of views and cards instead of the whole tree.
// ---------------------------------------------------------------------------

export type LovelaceCardSummary = {
  index: number
  type: string
  entity?: string
  entities?: string[]
  title?: string
  /** Number of nested cards (only the count is exposed). */
  cards?: number
}

export type LovelaceViewSummary = {
  index: number
  title?: string
  path?: string
  type?: string
  cardCount: number
  cards: LovelaceCardSummary[]
  /** Cards beyond {@link MAX_CARDS_PER_VIEW} that are not listed. */
  truncatedCards?: number
}

export type LovelaceSummary = {
  urlPath: string
  title: string
  viewCount: number
  cardCount: number
  bytes: number
  views: LovelaceViewSummary[]
}

/** Cards listed per view before the summary is truncated. */
export const MAX_CARDS_PER_VIEW = 60

function summarizeCard(raw: unknown, index: number): LovelaceCardSummary {
  const card = isPlainObject(raw) ? raw : {}
  const nested = Array.isArray(card.cards) ? card.cards.length : 0
  const entity = typeof card.entity === 'string' && card.entity.length > 0 ? card.entity : undefined
  const entities = Array.isArray(card.entities)
    ? card.entities.filter((entry): entry is string => typeof entry === 'string').slice(0, 8)
    : undefined
  const title = typeof card.title === 'string'
    ? card.title
    : typeof card.name === 'string'
      ? card.name
      : typeof card.heading === 'string'
        ? card.heading
        : undefined
  return {
    index,
    type: typeof card.type === 'string' ? card.type : '?',
    ...(entity ? { entity } : {}),
    ...(entities && entities.length > 0 ? { entities } : {}),
    ...(title ? { title } : {}),
    ...(nested > 0 ? { cards: nested } : {}),
  }
}

/** Index a dashboard config into views and addressable top-level cards. */
export function summarizeLovelace(urlPath: string, config: LovelaceConfig): LovelaceSummary {
  const views = Array.isArray(config.views) ? config.views : []
  const summaries: LovelaceViewSummary[] = views.map((rawView, index) => {
    const view = isPlainObject(rawView) ? rawView : {}
    const cards = Array.isArray(view.cards) ? view.cards : []
    const listed = cards.slice(0, MAX_CARDS_PER_VIEW).map((card, cardIndex) => summarizeCard(card, cardIndex))
    return {
      index,
      ...(typeof view.title === 'string' ? { title: view.title } : {}),
      ...(typeof view.path === 'string' ? { path: view.path } : {}),
      ...(typeof view.type === 'string' ? { type: view.type } : {}),
      cardCount: cards.length,
      cards: listed,
      ...(cards.length > listed.length ? { truncatedCards: cards.length - listed.length } : {}),
    }
  })
  return {
    urlPath,
    title: typeof config.title === 'string' ? config.title : '',
    viewCount: summaries.length,
    cardCount: summaries.reduce((total, view) => total + view.cardCount, 0),
    bytes: Buffer.byteLength(JSON.stringify(config)),
    views: summaries,
  }
}

// ---------------------------------------------------------------------------
// Backups — every read hands out an undo point, every write takes one first.
// ---------------------------------------------------------------------------

export interface LovelaceBackupInfo {
  id: string
  urlPath: string
  savedAt: string
  reason: string
  bytes: number
}

const BACKUP_ID_PATTERN = /^[A-Za-z0-9._-]+$/

/** Filename prefix for one dashboard; the default overview has no url_path. */
function backupPrefix(urlPath: string): string {
  return urlPath === '' ? 'default' : urlPath.replace(/[^A-Za-z0-9._-]/g, '_')
}

/** Backup directory: `${DSH_HOME}/dsh-smarthome-backups/lovelace`, else `~/.dsh/...`. */
export function resolveLovelaceBackupDir(configured: string): string {
  if (configured.length > 0) return configured
  const home = process.env.DSH_HOME
  const base = home && home.length > 0 ? home : join(homedir(), '.dsh')
  return join(base, 'dsh-smarthome-backups', 'lovelace')
}

/** Newest-first store of dashboard snapshots on disk. */
export class LovelaceBackups {
  readonly dir: string
  private readonly keep: number

  constructor(dir: string, keep = 20) {
    this.dir = dir
    this.keep = Math.max(1, Math.floor(keep) || 1)
  }

  private pathFor(id: string): string {
    if (!BACKUP_ID_PATTERN.test(id) || id.includes('..')) {
      throw new Error(`dsh-smarthome: invalid backup id "${id}"`)
    }
    return join(this.dir, `${id}.json`)
  }

  /** Snapshot a dashboard before it is changed; returns the backup handle. */
  async save(urlPath: string, config: LovelaceConfig, reason: string): Promise<LovelaceBackupInfo> {
    const savedAt = new Date().toISOString()
    const prefix = backupPrefix(urlPath)
    const stamp = `${prefix}__${savedAt.replace(/[:.]/g, '-')}`
    // Two saves inside the same millisecond must not overwrite each other.
    let id = stamp
    for (let attempt = 1; await this.exists(this.pathFor(id)); attempt += 1) {
      id = `${stamp}-${attempt}`
    }
    const body = JSON.stringify({ urlPath, savedAt, reason, config }, null, 2)
    await mkdir(this.dir, { recursive: true })
    await writeFile(this.pathFor(id), `${body}\n`, 'utf8')
    await this.prune(prefix)
    return { id, urlPath, savedAt, reason, bytes: Buffer.byteLength(body) }
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  }

  /** Id of the newest backup for one dashboard, or the newest overall. */
  async latest(urlPath?: string): Promise<string> {
    const newest = (await this.list(urlPath))[0]
    if (!newest) {
      const scope = urlPath === undefined ? '' : ` for "${urlPath || 'default'}"`
      throw new Error(`dsh-smarthome: no dashboard backup found${scope} in ${this.dir}`)
    }
    return newest.id
  }

  async list(urlPath?: string): Promise<LovelaceBackupInfo[]> {
    let entries: string[]
    try {
      entries = await readdir(this.dir)
    } catch {
      return []
    }
    const wanted = urlPath === undefined ? undefined : `${backupPrefix(urlPath)}__`
    const infos: LovelaceBackupInfo[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      if (wanted !== undefined && !entry.startsWith(wanted)) continue
      const info = await this.describe(entry.slice(0, -'.json'.length)).catch(() => undefined)
      if (info) infos.push(info)
    }
    return infos.sort((a, b) => b.savedAt.localeCompare(a.savedAt))
  }

  private async describe(id: string): Promise<LovelaceBackupInfo> {
    const raw = await readFile(this.pathFor(id), 'utf8')
    const record = JSON.parse(raw) as { urlPath?: unknown; savedAt?: unknown; reason?: unknown }
    return {
      id,
      urlPath: typeof record.urlPath === 'string' ? record.urlPath : '',
      savedAt: typeof record.savedAt === 'string' ? record.savedAt : '',
      reason: typeof record.reason === 'string' ? record.reason : '',
      bytes: Buffer.byteLength(raw),
    }
  }

  /** Read one backup including the stored config, ready to restore. */
  async read(id: string): Promise<LovelaceBackupInfo & { config: LovelaceConfig }> {
    const raw = await readFile(this.pathFor(id), 'utf8')
    const record = JSON.parse(raw) as {
      urlPath?: unknown
      savedAt?: unknown
      reason?: unknown
      config?: unknown
    }
    return {
      id,
      urlPath: typeof record.urlPath === 'string' ? record.urlPath : '',
      savedAt: typeof record.savedAt === 'string' ? record.savedAt : '',
      reason: typeof record.reason === 'string' ? record.reason : '',
      bytes: Buffer.byteLength(raw),
      config: normalizeLovelaceConfig(record.config),
    }
  }

  /** Keep only the newest {@link keep} snapshots of one dashboard. */
  private async prune(prefix: string): Promise<void> {
    const wanted = `${prefix}__`
    const entries = await readdir(this.dir).catch(() => [] as string[])
    const ids = entries
      .filter(entry => entry.endsWith('.json') && entry.startsWith(wanted))
      .map(entry => entry.slice(0, -'.json'.length))
    if (ids.length <= this.keep) return
    // Ids embed an ISO timestamp, so a lexicographic sort is chronological.
    ids.sort()
    for (const id of ids.slice(0, ids.length - this.keep)) {
      await rm(this.pathFor(id), { force: true })
    }
  }
}
