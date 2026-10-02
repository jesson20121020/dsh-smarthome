import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LovelaceBackups,
  MAX_CARDS_PER_VIEW,
  applyLovelaceOps,
  normalizeLovelaceConfig,
  resolveLovelaceBackupDir,
  summarizeLovelace,
  type LovelaceConfig,
  type LovelaceOp,
} from '../src/lovelace'

/** A small dashboard shaped like a real stored config. */
function fixture(): LovelaceConfig {
  return {
    title: 'My Home',
    views: [
      {
        title: 'Overview',
        path: 'overview',
        cards: [
          { type: 'entities', title: 'Lights', entities: ['light.a', 'light.b'] },
          { type: 'markdown', content: 'hello' },
        ],
      },
      { title: 'Climate', path: 'climate', cards: [{ type: 'thermostat', entity: 'climate.hall' }] },
    ],
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('applyLovelaceOps', () => {
  it('inserts cards at the start, the end, and an explicit index', () => {
    const base = fixture()
    const start = applyLovelaceOps(base, [
      { op: 'addCard', view: 'overview', card: { type: 'button' }, position: 'start' },
    ])
    expect((start.config.views as { cards: { type: string }[] }[])[0]!.cards[0]!.type).toBe('button')

    const end = applyLovelaceOps(base, [
      { op: 'addCard', view: 0, card: { type: 'button' } },
    ])
    const endCards = (end.config.views as { cards: { type: string }[] }[])[0]!.cards
    expect(endCards[endCards.length - 1]!.type).toBe('button')

    const middle = applyLovelaceOps(base, [
      { op: 'addCard', view: 'overview', card: { type: 'button' }, position: 1 },
    ])
    expect((middle.config.views as { cards: { type: string }[] }[])[0]!.cards[1]!.type).toBe('button')
  })

  it('addresses views by index, path, and title', () => {
    const base = fixture()
    for (const view of [1, 'climate', 'Climate'] as const) {
      const { config, applied } = applyLovelaceOps(base, [
        { op: 'updateView', view, patch: { title: 'Renamed' } },
      ])
      expect((config.views as { title?: string }[])[1]!.title).toBe('Renamed')
      expect(applied[0]).toContain('updateView')
    }
    expect(() => applyLovelaceOps(base, [{ op: 'removeView', view: 'nope' }]))
      .toThrow(/no view matches "nope"/)
  })

  it('merges update patches shallowly and keeps other keys', () => {
    const { config } = applyLovelaceOps(fixture(), [
      { op: 'updateCard', view: 'overview', index: 0, patch: { title: 'New lights' } },
    ])
    const card = (config.views as { cards: Record<string, unknown>[] }[])[0]!.cards[0]!
    expect(card.title).toBe('New lights')
    expect(card.entities).toEqual(['light.a', 'light.b'])
  })

  it('moves a card across views and within one', () => {
    const across = applyLovelaceOps(fixture(), [
      { op: 'moveCard', view: 'overview', index: 0, toView: 'climate' },
    ])
    const views = across.config.views as { cards: { type: string }[] }[]
    expect(views[0]!.cards).toHaveLength(1)
    expect(views[1]!.cards.map(c => c.type)).toEqual(['thermostat', 'entities'])

    const within = applyLovelaceOps(fixture(), [
      { op: 'moveCard', view: 0, index: 0, toIndex: 1 },
    ])
    expect((within.config.views as { cards: { type: string }[] }[])[0]!.cards.map(c => c.type))
      .toEqual(['markdown', 'entities'])
  })

  it('rejects a bad op and leaves the caller config untouched', () => {
    const base = fixture()
    const snapshot = JSON.stringify(base)
    expect(() => applyLovelaceOps(base, [
      { op: 'addCard', view: 'overview', card: { type: 'button' } },
      { op: 'removeCard', view: 'overview', index: 99 },
    ])).toThrow(/existing card index/)
    expect(JSON.stringify(base)).toBe(snapshot)
  })

  it('requires a card type and lists the vocabulary for an unknown op', () => {
    expect(() => applyLovelaceOps(fixture(), [{ op: 'addCard', view: 0, card: { title: 'x' } }]))
      .toThrow(/card\.type/)
    expect(() => applyLovelaceOps(fixture(), [{ op: 'explode' }]))
      .toThrow(/unknown op — allowed: setTitle/)
  })

  it('replaces the whole config with setRaw, keeping later ops working', () => {
    const { config, applied } = applyLovelaceOps(fixture(), [
      { op: 'setRaw', config: { views: [{ title: 'Only', cards: [] }] } },
      { op: 'addCard', view: 0, card: { type: 'button' } },
    ])
    expect(applied[0]).toContain('setRaw')
    const views = config.views as { title: string; cards: unknown[] }[]
    expect(views).toHaveLength(1)
    expect(views[0]!.title).toBe('Only')
    expect(views[0]!.cards).toHaveLength(1)
    expect('title' in config).toBe(false)
  })

  it('rejects a non-object config', () => {
    expect(() => normalizeLovelaceConfig('nope')).toThrow(/not a JSON object/)
    expect(() => applyLovelaceOps({ views: 'nope' } as LovelaceConfig, [{ op: 'setTitle', title: 'x' }]))
      .toThrow(/non-array "views"/)
  })
})

describe('summarizeLovelace', () => {
  it('indexes views and cards without the full payload', () => {
    const summary = summarizeLovelace('my_home', fixture())
    expect(summary.urlPath).toBe('my_home')
    expect(summary.title).toBe('My Home')
    expect(summary.viewCount).toBe(2)
    expect(summary.cardCount).toBe(3)
    expect(summary.bytes).toBeGreaterThan(0)
    expect(summary.views[0]).toMatchObject({ index: 0, path: 'overview', title: 'Overview', cardCount: 2 })
    expect(summary.views[0]!.cards[0]).toEqual({
      index: 0,
      type: 'entities',
      entities: ['light.a', 'light.b'],
      title: 'Lights',
    })
  })

  it('counts nested cards instead of inlining them', () => {
    const summary = summarizeLovelace('my_home', {
      views: [{ title: 'V', cards: [{ type: 'vertical-stack', cards: [{ type: 'button' }, { type: 'button' }] }] }],
    })
    expect(summary.views[0]!.cards[0]).toEqual({ index: 0, type: 'vertical-stack', cards: 2 })
  })

  it('truncates very large views but keeps real card indices', () => {
    const cards = Array.from({ length: MAX_CARDS_PER_VIEW + 5 }, (_, i) => ({ type: 'button', entity: `switch.${i}` }))
    const summary = summarizeLovelace('big', { views: [{ title: 'Big', cards }] })
    expect(summary.views[0]!.cards).toHaveLength(MAX_CARDS_PER_VIEW)
    expect(summary.views[0]!.truncatedCards).toBe(5)
    expect(summary.views[0]!.cardCount).toBe(MAX_CARDS_PER_VIEW + 5)
  })
})

describe('LovelaceBackups', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-lovelace-backups-'))
  })

  it('saves, lists, and reads a snapshot back', async () => {
    const backups = new LovelaceBackups(dir)
    const info = await backups.save('my_home', fixture(), 'test')
    expect(info.id.startsWith('my_home__')).toBe(true)
    expect(info.urlPath).toBe('my_home')

    const list = await backups.list('my_home')
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe(info.id)
    expect(list[0]!.reason).toBe('test')

    const record = await backups.read(info.id)
    expect(record.config).toEqual(fixture())
    expect(await backups.latest('my_home')).toBe(info.id)
  })

  it('never overwrites two snapshots taken in the same millisecond', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-02T03:04:05.678Z'))
    try {
      const backups = new LovelaceBackups(dir)
      const first = await backups.save('dash', { views: [] }, 'one')
      const second = await backups.save('dash', { views: [{ title: 'two' }] }, 'two')
      expect(first.id).not.toBe(second.id)
      expect(await backups.list('dash')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps only the newest snapshots per dashboard', async () => {
    const backups = new LovelaceBackups(dir, 2)
    for (const title of ['one', 'two', 'three']) {
      await backups.save('dash', { title }, title)
      await sleep(5)
    }
    const list = await backups.list('dash')
    expect(list).toHaveLength(2)
    expect(list.map(b => b.reason)).toEqual(['three', 'two'])
    // Another dashboard keeps its own budget.
    await backups.save('other', { title: 'other' }, 'other')
    expect(await backups.list('other')).toHaveLength(1)
  })

  it('scopes "latest" and the list to one dashboard', async () => {
    const backups = new LovelaceBackups(dir)
    await backups.save('a', { title: 'a' }, 'a')
    await sleep(5)
    await backups.save('b', { title: 'b' }, 'b')
    expect((await backups.read(await backups.latest('a'))).urlPath).toBe('a')
    expect(await backups.list('a')).toHaveLength(1)
    expect((await backups.read(await backups.latest())).urlPath).toBe('b')
  })

  it('reports an empty store instead of failing', async () => {
    const backups = new LovelaceBackups(dir)
    expect(await backups.list()).toEqual([])
    await expect(backups.latest()).rejects.toThrow(/no dashboard backup found/)
  })

  it('refuses backup ids that escape the store directory', async () => {
    const backups = new LovelaceBackups(dir)
    await expect(backups.read('../../etc/passwd')).rejects.toThrow(/invalid backup id/)
    await expect(backups.read('a/b')).rejects.toThrow(/invalid backup id/)
    // A file that exists but is not a snapshot is skipped by the listing.
    await writeFile(join(dir, 'broken.json'), 'not json', 'utf8')
    expect(await backups.list()).toEqual([])
    expect(await readdir(dir)).toContain('broken.json')
  })

  it('resolves the default directory under DSH_HOME and honours an override', () => {
    expect(resolveLovelaceBackupDir('/custom/dir')).toBe('/custom/dir')
    const resolved = resolveLovelaceBackupDir('')
    expect(resolved.endsWith(join('dsh-smarthome-backups', 'lovelace'))).toBe(true)
  })
})
