import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DashboardView, apply } from '../src/client/index'
import { dashboardDefinition } from '../src/client/dashboard'
import { DASHBOARD_META_KIND, type DashboardSnapshot } from '../src/dashboard'

/**
 * Browser-half coverage: the card must render real markup for a snapshot, and
 * `apply` must wire the node definition and the chat slot under the 0.2.0
 * service names (`uiConversation` + `slots`).
 */
function snapshot(overrides: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  return {
    kind: DASHBOARD_META_KIND,
    generatedAt: '2026-10-02T07:00:00.000Z',
    entities: [
      { entity_id: 'light.living_room', state: 'on', friendly_name: '客厅吊灯', unit: '' },
      { entity_id: 'sensor.temperature', state: '22.5', friendly_name: '客厅温度', unit: '°C' },
      { entity_id: 'vacuum.roborock', state: 'docked', friendly_name: '扫地机', unit: '' },
    ],
    scenes: [{ entity_id: 'scene.cinema', friendly_name: '影院模式' }],
    events: [
      { entity_id: 'light.bedroom', state: 'on', old_state: 'off', last_changed: '2026-10-02T06:59:00.000Z' },
    ],
    ...overrides,
  }
}

function render(snap: DashboardSnapshot = snapshot()): string {
  return renderToStaticMarkup(createElement(DashboardView, { node: { data: { snapshot: snap } } }))
}

describe('smarthome-dashboard card', () => {
  it('renders the header with the device and online counts', () => {
    const html = render()
    expect(html).toContain('家庭仪表盘')
    expect(html).toContain('3 个设备')
    expect(html).toContain('1 在线')
  })

  it('renders entities grouped by domain with their states and units', () => {
    const html = render()
    expect(html).toContain('💡 灯光')
    expect(html).toContain('客厅吊灯')
    expect(html).toContain('📊 传感器')
    expect(html).toContain('客厅温度')
    expect(html).toContain('22.5 °C')
    expect(html).toContain('🧹 清洁')
    expect(html).toContain('扫地机')
  })

  it('renders the scene strip and the recent-change log', () => {
    const html = render()
    expect(html).toContain('🎬 影院模式')
    expect(html).toContain('🕐 最近变化')
    expect(html).toContain('light.bedroom')
  })

  it('omits the scene strip and the change log when the snapshot has none', () => {
    const html = render(snapshot({ entities: [], scenes: [], events: [] }))
    expect(html).toContain('家庭仪表盘')
    expect(html).toContain('0 个设备')
    expect(html).not.toContain('🎬')
    expect(html).not.toContain('🕐 最近变化')
  })

  it('files domains without a section under the catch-all group', () => {
    const html = render(snapshot({
      entities: [{ entity_id: 'input_boolean.guest', state: 'on', friendly_name: '访客模式', unit: '' }],
    }))
    expect(html).toContain('🏠 其他')
    expect(html).toContain('访客模式')
  })
})

describe('client plugin wiring', () => {
  it('registers the conversation node and the chat card slot when applied', () => {
    const nodeRegistrations: unknown[] = []
    const slotRegistrations: Array<[unknown, unknown]> = []
    const injectedSeats: string[] = []
    const ctx = {
      uiConversation: { events: { register: (definition: unknown) => { nodeRegistrations.push(definition) } } },
      slots: {
        inject: (seat: string, callback: () => void) => { injectedSeats.push(seat); callback() },
        register: (seat: unknown, component: unknown) => { slotRegistrations.push([seat, component]) },
      },
    }

    apply(ctx as never)

    expect(nodeRegistrations).toEqual([dashboardDefinition])
    expect(injectedSeats).toEqual(['conversation.chat.node'])
    expect(slotRegistrations).toEqual([[
      { name: 'conversation.chat.node', key: 'smarthome-dashboard' },
      DashboardView,
    ]])
  })
})
