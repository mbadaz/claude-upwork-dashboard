import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DashboardSnapshot, DashStatus, Progress } from '../types'
import {
  aggregateConnects,
  aggregateLedger,
  barGeometry,
  buildSnapshot,
  feeRate,
  hm,
  ledgerChunks,
  money,
  num,
  pct,
  periodLabel,
  pieSvg,
  sliceTotal,
  spendSlices,
  ymd,
  type Ledger,
} from './compute'

const PANE = 'upwork-dashboard'
const DEFAULT_DAYS = 30
const REFRESH_MS = 5 * 60_000
// Braille spinner frames and progress-bar glyphs for the loading indicator.
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const BAR_WIDTH = 18
const BAR_FULL = '█'
const BAR_HEAD = '▓'
const BAR_TRACK = '░'

// --- session state (survives reloads via $.state; bump the shape tag when
// DashboardSnapshot's fields change) ---------------------------------------
// Cache one snapshot per period (days), so switching back to an already-loaded
// period is instant and only an unseen period (or ↻ Refresh) triggers a fetch.
const snapshotsAtom = atom(
  { plugin: 'upwork-dashboard', key: 'snapshots' } as const,
  {} as Record<number, DashboardSnapshot>,
  { shape: 'snapshots-1' },
)
const statusAtom = atom(
  { plugin: 'upwork-dashboard', key: 'status' } as const,
  'idle' as DashStatus,
)
const errorAtom = atom(
  { plugin: 'upwork-dashboard', key: 'error' } as const,
  null as string | null,
)
const periodAtom = atom(
  { plugin: 'upwork-dashboard', key: 'periodDays' } as const,
  DEFAULT_DAYS,
)
// Loading progress (phase + 0..total) and an animation frame for the spinner.
const progressAtom = atom(
  { plugin: 'upwork-dashboard', key: 'progress' } as const,
  null as Progress | null,
)
const frameAtom = atom(
  { plugin: 'upwork-dashboard', key: 'frame' } as const,
  0,
)

// --- Upwork connector plumbing ----------------------------------------------
// Read the Upwork connector through the documented $.mcp.call API, which is the
// intended way for a mod to read one of the engine's connected MCP servers for
// its own background data (it reports read-only data; it posts nothing). It
// takes the server name the engine keys the connector under; we derive that
// from the wire tool name (mcp__<server>__upwork__<tool>) at first use and also
// try the documented spellings, caching whichever one answers.
const TOOL_MARKER = '__upwork__'
let mcpServer: string | null = null
let cached: { server: string; tool: (b: string) => string } | null = null
let orgUid: string | null = null

async function discover($: EngineInterface): Promise<string> {
  if (mcpServer) return mcpServer
  const tools = await $.tool.list()
  const probe =
    tools.find(t => t.name.endsWith(`${TOOL_MARKER}list_accounts`)) ??
    tools.find(t => t.name.includes(TOOL_MARKER))
  if (!probe) throw new Error('Upwork connector not available in this session')
  const rest = probe.name.startsWith('mcp__')
    ? probe.name.slice('mcp__'.length)
    : probe.name
  const i = rest.indexOf(TOOL_MARKER)
  mcpServer = i > 0 ? rest.slice(0, i) : rest
  return mcpServer
}

function textOf(res: any): string {
  return (res?.content ?? [])
    .map((b: any) => (typeof b?.text === 'string' ? b.text : ''))
    .join('')
}

async function callUpwork(
  $: EngineInterface,
  base: string,
  args: Record<string, unknown>,
): Promise<any> {
  const hash = await discover($)
  const candidates: { server: string; tool: (b: string) => string }[] = cached
    ? [cached]
    : [
        { server: hash, tool: b => `upwork__${b}` },
        { server: 'claude.ai Upwork', tool: b => `upwork__${b}` },
        { server: 'claude_ai_Upwork', tool: b => `upwork__${b}` },
        { server: 'claude.ai Upwork', tool: b => b },
      ]
  const errs: string[] = []
  // The connector occasionally returns a transient plain-text error (e.g. a
  // rate-limit "Error…" that isn't JSON) when a refresh makes many calls in a
  // row. Retry a few times with backoff before giving up.
  for (let attempt = 0; attempt < 4; attempt++) {
    for (const c of candidates) {
      const toolName = c.tool(base)
      try {
        const res: any = await $.mcp.call(c.server, toolName, args)
        if (res?.isError) {
          errs.push(`[${c.server}|${toolName}] isError: ${textOf(res).slice(0, 80)}`)
          continue
        }
        const text = textOf(res).trim()
        if (!text) {
          errs.push(`[${c.server}|${toolName}] empty response`)
          continue
        }
        const parsed = JSON.parse(text)
        cached = c
        return parsed
      } catch (err: any) {
        errs.push(`[${c.server}|${toolName}] ${String(err?.message ?? err).slice(0, 120)}`)
      }
    }
    // backoff: 0.6s, 1.2s, 1.8s between attempts
    if (attempt < 3) await $.clock.sleep(600 * (attempt + 1)).catch(() => {})
  }
  throw new Error(errs.slice(-4).join('  ;;  '))
}

async function resolveOrg($: EngineInterface): Promise<string> {
  if (orgUid) return orgUid
  const data = await callUpwork($, 'list_accounts', {})
  const first = (data?.accounts ?? [])[0]
  if (!first?.org_uid) throw new Error('no Upwork account found')
  orgUid = String(first.org_uid)
  return orgUid
}

// Fetch the transactions ledger in date chunks (a full year in one call
// overflows the connector's response-size limit and returns a non-JSON error),
// aggregating each chunk; a failed chunk is skipped, not fatal.
async function fetchLedger(
  $: EngineInterface,
  org: string,
  fromMs: number,
  toMs: number,
): Promise<Ledger> {
  const out: Ledger = { withdrawalFees: 0, withdrawn: 0, connectsPurchasedUsd: 0 }
  for (const { from, to } of ledgerChunks(fromMs, toMs)) {
    try {
      const tx = await callUpwork($, 'get_freelancer_financials', {
        action: 'transactions',
        org_uid: org,
        params: { from_date: from, to_date: to, limit: 200 },
      })
      const rows =
        tx?.data?.transactionHistory?.transactionDetail
          ?.transactionHistoryRow ?? []
      const part = aggregateLedger(rows)
      out.withdrawalFees += part.withdrawalFees
      out.withdrawn += part.withdrawn
      out.connectsPurchasedUsd += part.connectsPurchasedUsd
    } catch {
      /* skip this chunk; keep the totals we have */
    }
  }
  return out
}

// --- the one fetch that fills the dashboard --------------------------------
let refreshing = false
let animTimer: { cancel: () => void } | null = null
const PROG_TOTAL = 4

async function refresh($: EngineInterface, days: number): Promise<void> {
  if (refreshing) return // don't stack overlapping refreshes (timer + manual)
  refreshing = true
  const prog = (step: number, label: string) =>
    update($, progressAtom, () => ({ step, total: PROG_TOTAL, label }))
  await update($, statusAtom, () => 'loading')
  await update($, errorAtom, () => null)
  await prog(0, 'Connecting')
  // Animate the spinner smoothly while loading; cancelled in `finally`.
  animTimer?.cancel()
  animTimer = $.clock.every(110, () => {
    void update($, frameAtom, f => (f + 1) % 100_000)
  })
  try {
    const org = await resolveOrg($)
    const now = Date.now()
    const to = ymd(now)
    const from = ymd(now - days * 86_400_000)

    await prog(0, 'Earnings')
    const summary = await callUpwork($, 'get_freelancer_financials', {
      action: 'summary',
      org_uid: org,
      params: { from_date: from, to_date: to },
    })
    await prog(1, 'Balance')
    const bal = await callUpwork($, 'get_freelancer_financials', {
      action: 'available_balance',
      org_uid: org,
    })
    await prog(2, 'Connects')

    // Connects history is paged (25/page); collect the in-window transactions
    // (walking back until we pass the window), best-effort so a paged failure
    // can't sink the dashboard. aggregateConnects() does the netting.
    const fromMs = Date.parse(`${from}T00:00:00Z`)
    let connectsBalance = 0
    const connTransactions: any[] = []
    try {
      let cursor: string | undefined
      let lastCursor: string | undefined
      // cap pages so a long period can't stall the refresh with dozens of calls
      for (let page = 0; page < 6; page++) {
        const conn = await callUpwork($, 'get_freelancer_financials', {
          action: 'connects_balance',
          org_uid: org,
          params: cursor ? { limit: 25, cursor } : { limit: 25 },
        })
        if (page === 0) connectsBalance = num(conn?.balance?.connectsBalance)
        const list = conn?.usage_history?.transactions ?? []
        let reachedOld = false
        for (const t of list) {
          const when = Date.parse(t?.createdDateTime ?? '')
          if (Number.isFinite(when) && when < fromMs) {
            reachedOld = true
            continue
          }
          connTransactions.push(t)
        }
        cursor = conn?.next_cursor
        // stop at the window edge, when the server says no more, or when the
        // cursor stops advancing (guards against a non-paging connector).
        if (reachedOld || !conn?.hasMore || !cursor || cursor === lastCursor) {
          break
        }
        lastCursor = cursor
      }
    } catch {
      /* keep partial connects totals; the rest of the dashboard still renders */
    }
    const { connectsSpent, connectsByCategory } =
      aggregateConnects(connTransactions)

    // The transactions ledger is fetched in ~50-day chunks: a full year in one
    // call (~54 KB) overflows the connector's response limit and comes back as
    // a non-JSON error. Chunking keeps each response small; we aggregate.
    await prog(3, 'Transactions')
    const ledger = await fetchLedger($, org, fromMs, now)
    await prog(4, 'Done')

    const snap = buildSnapshot({
      days,
      from,
      to,
      now,
      summary,
      bal,
      connectsBalance,
      connectsSpent,
      connectsByCategory,
      ledger,
    })

    await update($, snapshotsAtom, prev => ({ ...prev, [days]: snap }))
    await update($, statusAtom, () => 'ready')
  } catch (err: any) {
    await update($, errorAtom, () => String(err?.message ?? err))
    await update($, statusAtom, () => 'error')
  } finally {
    animTimer?.cancel()
    animTimer = null
    await update($, progressAtom, () => null)
    refreshing = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'upwork',
      description: 'Open the Upwork revenue & spend dashboard',
    })
    void $.ui.open({ id: PANE, title: 'Upwork' })

    const days = (await read($, periodAtom)) || DEFAULT_DAYS
    void refresh($, days)
    $.clock.every(REFRESH_MS, async () => {
      void refresh($, (await read($, periodAtom)) || DEFAULT_DAYS)
    })

    return next(e)
  })

  on('command.run', { command: 'upwork' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Upwork', focus: true })
    void refresh($, (await read($, periodAtom)) || DEFAULT_DAYS)

    return { text: 'Upwork dashboard opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const snaps = await read($, snapshotsAtom)
    const status = await read($, statusAtom)
    const error = await read($, errorAtom)
    const period = (await read($, periodAtom)) || DEFAULT_DAYS
    const progress = await read($, progressAtom)
    const frame = await read($, frameAtom)
    const snap = snaps[period] ?? null

    const setPeriod = (days: number) => {
      void (async () => {
        await update($, periodAtom, () => days)
        const cache = await read($, snapshotsAtom)
        if (cache[days]) {
          // already loaded this period — show it instantly, no refetch
          await update($, errorAtom, () => null)
          await update($, statusAtom, () => 'ready')
        } else {
          await refresh($, days)
        }
      })()
    }

    const label = (s: string) => <Text dimColor>{s.padEnd(16)}</Text>

    const metric = (
      name: string,
      value: string,
      color?: string,
      bold?: boolean,
    ) => (
      <Text>
        {label(name)}
        <Text color={color} weight={bold ? 'bold' : undefined}>
          {value}
        </Text>
      </Text>
    )

    const periodButtons = (
      <Box flexDirection="row" gap={1} marginTop={1}>
        <Button
          key="p30"
          label="30d"
          variant={period === 30 ? 'primary' : undefined}
          onPress={() => setPeriod(30)}
        />
        <Button
          key="p90"
          label="90d"
          variant={period === 90 ? 'primary' : undefined}
          onPress={() => setPeriod(90)}
        />
        <Button
          key="p365"
          label="12mo"
          variant={period === 365 ? 'primary' : undefined}
          onPress={() => setPeriod(365)}
        />
        <Button
          key="refresh"
          label="↻ Refresh"
          onPress={() => void refresh($, period)}
        />
      </Box>
    )

    // Elegant progress indicator: animated spinner + labelled phase + a
    // determinate bar that fills as each fetch phase completes.
    const spin = SPINNER[frame % SPINNER.length]
    const { pct: barPct, filled, head } = progress
      ? barGeometry(progress.step, progress.total, BAR_WIDTH)
      : { pct: 0, filled: 0, head: 0 }
    const progressBar = (compact: boolean) => (
      <Box flexDirection="column" marginTop={compact ? 0 : 1}>
        <Text>
          <Text color="claude" weight="bold">
            {spin}{' '}
          </Text>
          <Text weight={compact ? undefined : 'bold'}>
            {progress ? progress.label : 'Loading'}
          </Text>
          <Text dimColor>
            {'  '}
            {progress ? `${progress.step}/${progress.total}` : ''} · {barPct}%
          </Text>
        </Text>
        <Text>
          <Text color="claude">{BAR_FULL.repeat(Math.max(0, filled - head))}</Text>
          {head === 1 && <Text color="claude">{BAR_HEAD}</Text>}
          <Text dimColor>{BAR_TRACK.repeat(BAR_WIDTH - filled)}</Text>
        </Text>
      </Box>
    )

    if (!snap) {
      return (
        <Box flexDirection="column">
          <Text color="claude" weight="bold">
            Upwork
          </Text>
          {status === 'error' ? (
            <>
              <Text color="error">Could not load Upwork data.</Text>
              {error && <Text dimColor>{error}</Text>}
            </>
          ) : (
            progressBar(false)
          )}
          {periodButtons}
        </Box>
      )
    }

    const rate = feeRate(snap.fees, snap.billed)
    const room = Math.max(2, (e.viewport?.rows ?? 24) - 20)
    const clients = snap.byClient.slice(0, room)

    // Spend pie — only on surfaces with an Svg element (not the terminal);
    // there the numeric breakdown above stands in.
    const renderSpendPie = () => {
      if (e.surface === 'terminal') return null
      const slices = spendSlices(snap)
      const svg = pieSvg(slices)
      if (!svg) return null
      const { Svg } = $.ui.resolve(e)
      const spendTotal = sliceTotal(slices)
      return (
        <Box flexDirection="column" marginTop={1}>
          <Svg
            source={svg}
            alt={`Spend composition — ${slices
              .map(s => `${s.label} ${money(s.value)}`)
              .join(', ')}`}
            width={150}
            height={150}
          />
          {slices.map((s, i) => (
            <Text key={`pie${i}`}>
              <Text color={s.color}>● </Text>
              {s.label}
              <Text dimColor>
                {'  '}
                {pct(s.value, spendTotal)}%
              </Text>
            </Text>
          ))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text>
          <Text color="claude" weight="bold">
            Upwork
          </Text>
          <Text dimColor>  {periodLabel(snap.periodDays)}</Text>
        </Text>
        <Text dimColor>
          {snap.periodFrom} → {snap.periodTo} · updated {hm(snap.fetchedAt)}
          {status === 'error' ? ' · refresh failed' : ''}
        </Text>
        {status === 'loading' && progressBar(true)}

        <Box flexDirection="column" marginTop={1}>
          <Text color="success" weight="bold">
            REVENUE
          </Text>
          {metric('Net earned', money(snap.earned), 'success', true)}
          {metric('Gross billed', money(snap.billed))}
          {metric('Fee rate', `${rate}%`)}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text color="warning" weight="bold">
            SPEND
          </Text>
          {metric('Upwork fees', money(snap.fees), 'warning')}
          {snap.tax > 0 && metric('Tax withheld', money(snap.tax), 'warning')}
          {metric('Withdrawal fees', money(snap.withdrawalFees), 'warning')}
          {metric('Connects bought', money(snap.connectsPurchasedUsd), 'warning')}
          {metric('Connects used', `${snap.connectsSpent}`, 'warning')}
          {(snap.connectsByCategory ?? []).map((c, i) => (
            <Text key={`cat${i}`} dimColor>
              {`  · ${c.category}`.padEnd(20)}
              {`${c.connects}`.padStart(4)}
            </Text>
          ))}
          {metric(
            'Total spend',
            money(
              snap.fees + snap.withdrawalFees + snap.connectsPurchasedUsd,
            ),
            'warning',
            true,
          )}
          {renderSpendPie()}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text color="claude" weight="bold">
            BALANCE
          </Text>
          {metric('Available now', money(snap.availableNow), 'success', true)}
          {metric('Pending', money(snap.pendingBalance))}
          {metric('Connects left', `${snap.connectsBalance}`)}
        </Box>

        {clients.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="subtle" weight="bold">
              BY CLIENT
            </Text>
            {clients.map((c, i) => (
              <Text key={`c${i}`}>
                <Text>{c.client.slice(0, 18).padEnd(20)}</Text>
                <Text color="success">{money(c.earned).padStart(11)}</Text>
                <Text dimColor>  billed {money(c.billed)}</Text>
              </Text>
            ))}
          </Box>
        )}

        {periodButtons}
      </Box>
    )
  })
}
