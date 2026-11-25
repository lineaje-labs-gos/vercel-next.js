import type { Span } from '@opentelemetry/api'
import type { LocalSpanDelivery } from './local-span-recorder'
import { normalizeTraceAttributes } from './span-attributes'
import { startRequestInsight } from './request-insights'
import {
  captureLocalSpanRecorder,
  isLocalSpanSinkActive,
  isRequestInsightsEnabled,
  type SpanStoreRecord,
} from './span-store'

export type RequestIdentity = ReturnType<typeof getCurrentRequestIdentity>
type ActivityInsight = {
  identity: RequestIdentity
  rootSpanId: string | undefined
  started: boolean
}
const activityInsights = new WeakMap<Span, ActivityInsight>()

function applyRequestIdentity(
  record: SpanStoreRecord,
  identity: RequestIdentity
) {
  record.requestId = identity.requestId
  record.parentRequestId = identity.parentRequestId
  record.requestInsightKind = identity.requestInsightKind
  record.requestInsightSource = identity.requestInsightSource
  record.requestInsightProxyStatus = identity.requestInsightProxyStatus
  record.htmlRequestId = identity.htmlRequestId
  record.route ??= identity.route
  record.url ??= identity.url
}

export function captureRequestSpanRecorder(
  identity: RequestIdentity = getCurrentRequestIdentity()
): LocalSpanDelivery {
  const deliver = captureLocalSpanRecorder()
  return (recording, end) => {
    const span = recording.toSpanStoreRecord(end)
    applyRequestIdentity(span, identity)
    deliver([span])
  }
}

export function captureInsightSpanRecorder(
  span: Span,
  parent: Span | undefined,
  name: string,
  type: string
): LocalSpanDelivery {
  const identity = getCurrentRequestIdentity()
  let insight = parent?.isRecording() ? activityInsights.get(parent) : undefined
  if (identity.requestId) {
    insight = { identity, rootSpanId: undefined, started: true }
  } else if (!insight) {
    const requestId = span.spanContext().spanId
    insight = {
      identity: {
        requestId,
        requestInsightKind: 'background',
        requestInsightSource: 'background',
        htmlRequestId: requestId,
        route: name,
      },
      rootSpanId: span.spanContext().spanId,
      started: false,
    }
  }
  activityInsights.set(span, insight)
  const scoped = isLocalSpanSinkActive()
  const deliver = captureLocalSpanRecorder()
  return (recording, end) => {
    if (!scoped && !insight.started && isRequestInsightsEnabled()) {
      startRequestInsight({
        requestId: insight.identity.requestId,
        kind: 'background',
        source: 'background',
        route: insight.identity.route,
      })
      insight.started = true
    }
    const record = recording.toSpanStoreRecord(
      end,
      normalizeTraceAttributes(recording.attributes)
    )
    applyRequestIdentity(record, insight.identity)
    record.requestInsightRoot = record.spanId === insight.rootSpanId
    record.attributes = {
      ...record.attributes,
      'next.span_category': 'nextjs',
      'next.span_type': type,
      'next.span_name': name,
    }
    deliver([record])
  }
}

export function getCurrentRequestIdentity(): Pick<
  SpanStoreRecord,
  | 'requestId'
  | 'parentRequestId'
  | 'requestInsightKind'
  | 'requestInsightSource'
  | 'requestInsightProxyStatus'
  | 'htmlRequestId'
  | 'route'
  | 'url'
> {
  // Required lazily: these modules create AsyncLocalStorage on load, which
  // throws before node-environment installs it (e.g. during CLI startup spans).
  try {
    const { getRequestInsightsIdentity } =
      require('./request-insights-identity') as typeof import('./request-insights-identity')
    const { workAsyncStorage } =
      require('../../app-render/work-async-storage.external') as typeof import('../../app-render/work-async-storage.external')
    const { workUnitAsyncStorage } =
      require('../../app-render/work-unit-async-storage.external') as typeof import('../../app-render/work-unit-async-storage.external')
    const workStore = workAsyncStorage.getStore()
    const workUnitStore = workUnitAsyncStorage.getStore()
    const requestInsightsIdentity = getRequestInsightsIdentity()
    const url =
      workUnitStore && 'url' in workUnitStore ? workUnitStore.url : undefined
    return {
      requestId: requestInsightsIdentity?.requestId ?? workStore?.requestId,
      parentRequestId: requestInsightsIdentity?.parentRequestId,
      requestInsightKind: requestInsightsIdentity?.kind,
      requestInsightSource: requestInsightsIdentity?.source,
      requestInsightProxyStatus: requestInsightsIdentity?.proxyStatus,
      htmlRequestId:
        requestInsightsIdentity?.htmlRequestId ?? workStore?.htmlRequestId,
      url: url ? `${url.pathname}${url.search}` : requestInsightsIdentity?.url,
    }
  } catch {
    return {}
  }
}
