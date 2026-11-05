// Pure data transforms for the Upwork dashboard: parsing, aggregation,
// formatting and layout math. No engine access — unit-tested in
// tests/compute.test.ts. The hooks module (register.tsx) does the I/O and
// hands the parsed responses to these functions.

import type {
  ClientRow,
  ConnectsCategory,
  DashboardSnapshot,
} from '../types'

export type Ledger = {
  withdrawalFees: number
  withdrawn: number
  connectsPurchasedUsd: number
  membershipUsd: number
}

// Parse a money-ish value: a number, a numeric string, or an Upwork amount
// object ({ rawValue } / { displayValue }). Non-numeric → 0.
export function num(v: any): number {
  const raw =
    v && typeof v === 'object' ? (v.rawValue ?? v.displayValue ?? 0) : v
  const n = Number(raw)
  return Number.isFinite(n) ? n : 0
}

export function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function hm(ms: number): string {
  const d = new Date(ms)
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

// Format USD with thousands separators and 2 decimals, no Intl dependency.
export function money(n: number): string {
  const neg = n < 0
  const fixed = Math.abs(n).toFixed(2)
  const int = fixed.slice(0, -3)
  const dec = fixed.slice(-2)
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${neg ? '-' : ''}$${grouped}.${dec}`
}

export function periodLabel(days: number): string {
  if (days >= 365) return 'Last 12 months'
  if (days >= 90) return 'Last 90 days'
  return `Last ${days} days`
}

export function feeRate(fees: number, billed: number): string {
  return billed > 0 ? ((fees / billed) * 100).toFixed(1) : '0.0'
}

// Group a connects transaction by what it was spent on, from its `reason` text.
export function categorize(reason: any): string {
  const r = String(reason ?? '').toLowerCase()
  if (r.includes('proposal') || r.includes('auction')) return 'Proposals'
  if (r.includes('boost') && r.includes('profile')) return 'Profile boost'
  if (r.includes('boosted') || r.includes('availability')) return 'Availability badge'
  if (r.includes('invitation') || r.includes('badge')) return 'Invitation badge'
  if (r.includes('membership') || r.includes('plan')) return 'Membership'
  const clean = String(reason ?? '').trim()
  return clean ? clean.slice(0, 22) : 'Other'
}

// Classify ledger rows into real cash costs: Upwork withdrawal fees, amounts
// withdrawn, actual USD spent buying Connects ("Fees for additional Connects
// (100)." = $15.00), and membership/subscription charges ("Subscription Renewal
// Charges" = $19.99, Freelancer Plus). Both connect purchases and subscriptions
// carry the `Membership Fee` subtype, so the "Connects" description is checked
// first. Service fees are excluded (they come from the summary totals instead).
export function aggregateLedger(rows: any[]): Ledger {
  const out: Ledger = {
    withdrawalFees: 0,
    withdrawn: 0,
    connectsPurchasedUsd: 0,
    membershipUsd: 0,
  }
  for (const r of rows ?? []) {
    const amt = num(r?.transactionAmount)
    const desc = String(r?.description ?? '')
    if (r?.accountingSubtype === 'Withdrawal Fee') {
      out.withdrawalFees += Math.abs(amt)
    } else if (r?.accountingSubtype === 'Withdrawal') {
      out.withdrawn += Math.abs(amt)
    } else if (amt > 0 && /connect/i.test(desc)) {
      out.connectsPurchasedUsd += amt
    } else if (r?.accountingSubtype === 'Membership Fee' && amt > 0) {
      out.membershipUsd += amt
    }
  }
  return out
}

// Net connects usage into a per-category breakdown. `list` is the in-window
// transactions (spend is negative, refunds positive); a category whose refunds
// cancel its spend drops out. connectsSpent is the gross connects spent.
export function aggregateConnects(list: any[]): {
  connectsSpent: number
  connectsByCategory: ConnectsCategory[]
} {
  const catMap = new Map<string, number>()
  let connectsSpent = 0
  for (const t of list ?? []) {
    const amt = num(t?.amount)
    if (amt === 0) continue
    const cat = categorize(t?.reason)
    catMap.set(cat, (catMap.get(cat) ?? 0) - amt)
    if (amt < 0) connectsSpent += -amt
  }
  const connectsByCategory = [...catMap.entries()]
    .map(([category, connects]) => ({ category, connects }))
    .filter(c => c.connects > 0)
    .sort((a, b) => b.connects - a.connects)
  return { connectsSpent, connectsByCategory }
}

// Split a [fromMs, toMs] span into non-overlapping day-aligned chunks so each
// transactions request stays under the connector's response-size limit. The
// day gap between chunks avoids double-counting the boundary date.
export function ledgerChunks(
  fromMs: number,
  toMs: number,
  chunkDays = 50,
  dayMs = 86_400_000,
): { from: string; to: string }[] {
  const chunk = chunkDays * dayMs
  const out: { from: string; to: string }[] = []
  for (let start = fromMs; start <= toMs; start += chunk + dayMs) {
    const end = Math.min(start + chunk, toMs)
    out.push({ from: ymd(start), to: ymd(end) })
  }
  return out
}

// Progress-bar geometry: percent, filled cell count, and whether a leading
// "head" cell is drawn (only mid-way, not at 0% or 100%).
export function barGeometry(
  step: number,
  total: number,
  width: number,
): { pct: number; filled: number; head: number } {
  const pct = total > 0 ? Math.round((step / total) * 100) : 0
  const filled = Math.round((pct / 100) * width)
  const head = filled > 0 && filled < width ? 1 : 0
  return { pct, filled, head }
}

// --- SPEND pie chart --------------------------------------------------------
export interface SpendSlice {
  label: string
  value: number
  color: string // light-mode fill
  colorDark: string // dark-mode fill
}

// The USD spend composition, in a FIXED order so each category keeps its colour
// regardless of size (color follows the entity, not its rank). Zero slices drop.
export function spendSlices(snap: DashboardSnapshot): SpendSlice[] {
  const defs: SpendSlice[] = [
    { label: 'Upwork fees', value: snap.fees, color: '#2a78d6', colorDark: '#3987e5' },
    { label: 'Withdrawal fees', value: snap.withdrawalFees, color: '#eb6834', colorDark: '#d95926' },
    { label: 'Connects bought', value: snap.connectsPurchasedUsd, color: '#1baf7a', colorDark: '#199e70' },
    { label: 'Membership', value: snap.membershipUsd, color: '#eda100', colorDark: '#c98500' },
    { label: 'Tax withheld', value: snap.tax, color: '#e87ba4', colorDark: '#d55181' },
  ]
  return defs.filter(s => s.value > 0)
}

export function sliceTotal(slices: SpendSlice[]): number {
  return slices.reduce((a, s) => a + s.value, 0)
}

export function pct(value: number, total: number): number {
  return total > 0 ? Math.round((value / total) * 100) : 0
}

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180
  return [+(cx + r * Math.cos(a)).toFixed(2), +(cy + r * Math.sin(a)).toFixed(2)]
}

// Build a theme-adaptive donut SVG for the spend composition. Direct % labels
// (>=8%), a 2px surface gap between slices, fills swapped under dark mode — the
// secondary encoding the colour validator's light-mode contrast WARN requires.
// Returns '' when there is nothing to chart.
export function pieSvg(slices: SpendSlice[], size = 160): string {
  const total = sliceTotal(slices)
  if (total <= 0 || slices.length === 0) return ''
  const C = 50
  const R = 44
  const r = 26
  const style =
    `.seg{stroke:#fcfcfb;stroke-width:2;stroke-linejoin:round}` +
    `.lbl{fill:#fff;font:600 7px -apple-system,system-ui,sans-serif;text-anchor:middle}` +
    slices.map((s, i) => `.s${i}{fill:${s.color}}`).join('') +
    `@media(prefers-color-scheme:dark){.seg{stroke:#1a1a19}` +
    slices.map((s, i) => `.s${i}{fill:${s.colorDark}}`).join('') +
    `}`

  let body = ''
  if (slices.length === 1) {
    // a full ring can't be one arc — draw concentric circles
    body =
      `<circle class="seg s0" cx="${C}" cy="${C}" r="${R}"/>` +
      `<circle cx="${C}" cy="${C}" r="${r}" fill="#fcfcfb" class="hole"/>` +
      `<text class="lbl" x="${C}" y="${C + 2.5}">100%</text>`
  } else {
    let angle = 0
    for (let i = 0; i < slices.length; i++) {
      const frac = slices[i]!.value / total
      const start = angle
      const end = angle + frac * 360
      angle = end
      const [ox0, oy0] = polar(C, C, R, start)
      const [ox1, oy1] = polar(C, C, R, end)
      const [ix1, iy1] = polar(C, C, r, end)
      const [ix0, iy0] = polar(C, C, r, start)
      const large = end - start > 180 ? 1 : 0
      body +=
        `<path class="seg s${i}" d="M${ox0} ${oy0} A${R} ${R} 0 ${large} 1 ${ox1} ${oy1} ` +
        `L${ix1} ${iy1} A${r} ${r} 0 ${large} 0 ${ix0} ${iy0} Z"/>`
      const p = pct(slices[i]!.value, total)
      if (p >= 8) {
        const [lx, ly] = polar(C, C, (R + r) / 2, (start + end) / 2)
        body += `<text class="lbl" x="${lx}" y="${ly + 2.5}">${p}%</text>`
      }
    }
  }
  // hole fill also follows the surface in dark mode
  const holeDark = `@media(prefers-color-scheme:dark){.hole{fill:#1a1a19}}`
  return (
    `<svg viewBox="0 0 100 100" width="${size}" height="${size}" ` +
    `xmlns="http://www.w3.org/2000/svg"><style>${style}${holeDark}</style>${body}</svg>`
  )
}

// Assemble a DashboardSnapshot from the parsed API responses plus the
// pre-computed connects/ledger aggregates.
export function buildSnapshot(input: {
  days: number
  from: string
  to: string
  now: number
  summary: any
  bal: any
  connectsBalance: number
  connectsSpent: number
  connectsByCategory: ConnectsCategory[]
  ledger: Ledger
}): DashboardSnapshot {
  const totals = input.summary?.totals ?? {}
  const byClient: ClientRow[] = (input.summary?.by_client ?? [])
    .map((c: any) => ({
      client: String(c?.client ?? '—'),
      earned: num(c?.earned),
      billed: num(c?.billed),
      fee: Math.abs(num(c?.fee)),
    }))
    .sort((a: ClientRow, b: ClientRow) => b.earned - a.earned)
  return {
    periodDays: input.days,
    periodFrom: input.summary?.period?.from ?? input.from,
    periodTo: input.summary?.period?.to ?? input.to,
    currency: totals.currency ?? 'USD',
    billed: num(totals.billed),
    earned: num(totals.earned),
    fees: Math.abs(num(totals.fee)),
    tax: Math.abs(num(totals.tax)),
    byClient,
    availableNow: num(input.bal?.available_now),
    pendingBalance: num(input.bal?.pending_balance),
    pendingCredit: num(input.bal?.pending_credit),
    connectsBalance: input.connectsBalance,
    connectsSpent: input.connectsSpent,
    connectsByCategory: input.connectsByCategory,
    connectsPurchasedUsd: input.ledger.connectsPurchasedUsd,
    membershipUsd: input.ledger.membershipUsd,
    withdrawalFees: input.ledger.withdrawalFees,
    withdrawn: input.ledger.withdrawn,
    fetchedAt: input.now,
  }
}
