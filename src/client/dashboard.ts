/**
 * Browser-side Conversation Node for the home dashboard.
 *
 * Matches `tool/result` events whose `meta` carries the dashboard snapshot
 * (projected by `ha_dashboard` via `presentationMeta`) and renders a keyed
 * Chat node. Everything rides the KNOWN `tool/result` event type, so the
 * dashboard is durable-safe (no custom session event vocabulary) and
 * replayable from the persisted meta.
 *
 * Harness 0.2.0 moved the client Conversation assembly out of the removed
 * `@deepseek-ai/dsh-client-runtime` package and into
 * `@deepseek-ai/dsh-client-ui-conversation`; the Chat renderer payload
 * registry (`ChatNodeDataMap`) now lives in `@deepseek-ai/dsh-client-ui-chat`.
 * The Definition contract itself is unchanged.
 */
import type {
  ConversationContextReader,
  ConversationLocation,
  ConversationNodeContext,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { DASHBOARD_META_KIND, type DashboardSnapshot } from '../dashboard'

export interface DashboardState {
  readonly snapshot: DashboardSnapshot
  readonly turn: number
  readonly step: number
}

export interface DashboardChatData {
  readonly snapshot: DashboardSnapshot
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    'smarthome-dashboard': DashboardChatData
  }
}

function locationOf(context: ConversationNodeContext): ConversationLocation {
  return context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' }
}

function isDashboardMeta(meta: unknown): meta is DashboardSnapshot {
  return typeof meta === 'object' && meta !== null
    && (meta as { kind?: unknown }).kind === DASHBOARD_META_KIND
}

/**
 * One dashboard call is a single checkpoint event: `ha_dashboard` returns the
 * WHOLE snapshot in `tool/result` meta, so each event carries complete
 * fallback state and no event correlation is needed.
 */
export const dashboardDefinition: ConversationNodeDefinition<DashboardState> = {
  kind: 'smarthome-dashboard',
  target: 'chat',
  match: (event) => {
    if (event.type !== 'tool/result') return null
    if (!isDashboardMeta(event.data.meta)) return null
    // 0.2.0 carries the call identity on the tool-role message itself; 0.1.x
    // nested it in `content[0].toolCallId`. Fall back to the event sequence so
    // older persisted logs still assemble.
    const { toolCallId } = event.data.message as { toolCallId?: string }
    const callId = toolCallId !== undefined && toolCallId !== '' ? toolCallId : String(event.seq)
    return { id: callId, role: 'start' }
  },
  start: (_context, match, _reader: ConversationContextReader) => {
    if (match.event.type !== 'tool/result' || !isDashboardMeta(match.event.data.meta)) {
      throw new Error('smarthome-dashboard requires a tool/result carrying dashboard meta')
    }
    return {
      turn: match.event.data.turn,
      step: match.event.data.step,
      snapshot: match.event.data.meta,
    }
  },
  update: (context) => context.state,
  publication: () => 'immediate',
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    return {
      key: context.key,
      kind: 'smarthome-dashboard',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start?.event.seq ?? context.matches[0]?.event.seq ?? 0,
      location: locationOf(context),
      visibility: 'visible',
      data: { snapshot: context.state.snapshot },
    }
  },
}

// Type-only presence: the slot map declaration lives in the Chat UI package;
// keep it in the program so the slot registration below types.
export type { ChatNodeViewProps }
