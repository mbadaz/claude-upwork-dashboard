import { expect, test } from 'claude-code/testing'

import {
  aggregateConnects,
  aggregateLedger,
  barGeometry,
  buildSnapshot,
  categorize,
  feeRate,
  ledgerChunks,
  money,
  num,
  pct,
  periodLabel,
  pieSvg,
  sliceTotal,
  spendSlices,
  ymd,
} from '../hooks/compute'
import type { DashboardSnapshot } from '../types'

// Synthetic figures only — no real account data.
const baseSnap: DashboardSnapshot = {
  periodDays: 30,
  periodFrom: '2026-10-06',
  periodTo: '2026-11-05',
  currency: 'USD',
  billed: 1000,
  earned: 900,
  fees: 100,
  tax: 0,
  byClient: [],
  availableNow: 25,
  pendingBalance: 200,
  pendingCredit: 240,
  connectsBalance: 90,
  connectsSpent: 120,
  connectsByCategory: [],
  connectsPurchasedUsd: 30,
  withdrawalFees: 20,
  withdrawn: 600,
  fetchedAt: 0,
}

// --- num: parse numbers, numeric strings, and Upwork amount objects ---------
test('num parses numbers, strings and amount objects', () => {
  expect(num(42)).toBe(42)
  expect(num('375.00')).toBe(375)
  expect(num('-1.00')).toBe(-1)
  expect(num({ rawValue: '12.34', displayValue: 'x' })).toBe(12.34) // rawValue wins
  expect(num({ displayValue: '56.78' })).toBe(56.78)
  expect(num(null)).toBe(0)
  expect(num(undefined)).toBe(0)
  expect(num({})).toBe(0)
  expect(num('not a number')).toBe(0)
})

// --- money: grouped, 2dp, signed, no Intl -----------------------------------
test('money formats USD with grouping and sign', () => {
  expect(money(0)).toBe('$0.00')
  expect(money(934.5)).toBe('$934.50')
  expect(money(1234.56)).toBe('$1,234.56')
  expect(money(23456.78)).toBe('$23,456.78')
  expect(money(1000000)).toBe('$1,000,000.00')
  expect(money(-5.25)).toBe('-$5.25')
  expect(money(5.2)).toBe('$5.20') // pads decimals
})

test('ymd is UTC yyyy-mm-dd', () => {
  expect(ymd(Date.UTC(2026, 10, 5, 23, 59))).toBe('2026-11-05')
  expect(ymd(Date.UTC(2025, 0, 1))).toBe('2025-01-01')
})

test('periodLabel maps day counts to labels', () => {
  expect(periodLabel(30)).toBe('Last 30 days')
  expect(periodLabel(90)).toBe('Last 90 days')
  expect(periodLabel(365)).toBe('Last 12 months')
  expect(periodLabel(7)).toBe('Last 7 days')
})

test('feeRate is fees/billed as a 1-dp percent, guarded', () => {
  expect(feeRate(150, 1000)).toBe('15.0')
  expect(feeRate(0, 0)).toBe('0.0') // no divide-by-zero
  expect(feeRate(5, 0)).toBe('0.0')
})

// --- categorize: group connects by the reason text --------------------------
test('categorize buckets connects reasons', () => {
  expect(categorize('Sponsored proposal auction clearing charge')).toBe('Proposals')
  expect(categorize('Sponsored proposal auction refund period ended itm')).toBe('Proposals')
  expect(categorize('Ad boosted profile mfs')).toBe('Profile boost')
  expect(categorize('Boosted availability')).toBe('Availability badge')
  expect(categorize('Paid invitation badge')).toBe('Invitation badge')
  expect(categorize('Freelancer Plus plan')).toBe('Membership')
  expect(categorize('')).toBe('Other')
  expect(categorize(null)).toBe('Other')
  expect(categorize('Some novel charge type')).toBe('Some novel charge type')
})

// --- aggregateLedger: real cash costs from the transaction ledger -----------
test('aggregateLedger sums fees, withdrawals and connect purchases only', () => {
  const rows = [
    { accountingSubtype: 'Membership Fee', description: 'Fees for additional Connects (100).', transactionAmount: { rawValue: '15.00' } },
    { accountingSubtype: 'Membership Fee', description: 'Fees for additional Connects (150).', transactionAmount: { rawValue: '22.50' } },
    { accountingSubtype: 'Withdrawal Fee', description: 'Withdrawal Fee', transactionAmount: { rawValue: '-1.00' } },
    { accountingSubtype: 'Withdrawal', description: 'Withdrawal', transactionAmount: { rawValue: '100.00' } },
    { accountingSubtype: 'Service Fee', description: 'Service Fee\nContract ID: 1', transactionAmount: { rawValue: '-5.25' } }, // excluded
    { accountingSubtype: 'Hourly', description: 'Client - 15:00 hrs', transactionAmount: { rawValue: '375.00' } }, // excluded
    { accountingSubtype: 'Membership Fee', description: 'Freelancer Plus membership', transactionAmount: { rawValue: '14.99' } }, // no "connect" -> excluded
  ]
  const led = aggregateLedger(rows)
  expect(led.connectsPurchasedUsd).toBe(37.5)
  expect(led.withdrawalFees).toBe(1)
  expect(led.withdrawn).toBe(100)
})

test('aggregateLedger handles empty / missing input', () => {
  expect(aggregateLedger([])).toEqual({
    withdrawalFees: 0,
    withdrawn: 0,
    connectsPurchasedUsd: 0,
  })
  expect(aggregateLedger(undefined as any).connectsPurchasedUsd).toBe(0)
})

// --- aggregateConnects: net refunds, drop zeros, sort desc ------------------
test('aggregateConnects nets refunds and ranks categories', () => {
  const list = [
    { amount: { rawValue: '-1' }, reason: 'Paid invitation badge' },
    { amount: { rawValue: '-1' }, reason: 'Paid invitation badge' },
    { amount: { rawValue: '-1' }, reason: 'Paid invitation badge' },
    { amount: { rawValue: '-80' }, reason: 'Ad boosted profile mfs' },
    { amount: { rawValue: '-39' }, reason: 'Sponsored proposal auction clearing charge' },
    { amount: { rawValue: '39' }, reason: 'Sponsored proposal auction refund period ended' },
    { amount: { rawValue: '0' }, reason: 'Noise' }, // skipped
  ]
  const { connectsSpent, connectsByCategory } = aggregateConnects(list)
  // gross connects spent = only the negatives: 3*1 + 80 + 39
  expect(connectsSpent).toBe(122)
  // Proposals net to zero (−39 +39) and drops out; sorted by connects desc
  expect(connectsByCategory).toEqual([
    { category: 'Profile boost', connects: 80 },
    { category: 'Invitation badge', connects: 3 },
  ])
})

test('aggregateConnects on empty input', () => {
  expect(aggregateConnects([])).toEqual({
    connectsSpent: 0,
    connectsByCategory: [],
  })
})

// --- ledgerChunks: date-window splitting (the 12-month overflow fix) ---------
test('ledgerChunks covers a year with no gaps or overlaps', () => {
  const from = Date.UTC(2025, 10, 5)
  const to = Date.UTC(2026, 10, 5) // 365 days later
  const chunks = ledgerChunks(from, to)
  expect(chunks).toHaveLength(8)
  expect(chunks[0]?.from).toBe('2025-11-05') // starts at the window start
  expect(chunks[chunks.length - 1]?.to).toBe('2026-11-05') // ends at the window end
  // each chunk starts the day after the previous one ends (no overlap, no gap)
  for (let i = 1; i < chunks.length; i++) {
    const prevEnd = Date.parse(`${chunks[i - 1]?.to}T00:00:00Z`)
    const thisStart = Date.parse(`${chunks[i]?.from}T00:00:00Z`)
    expect((thisStart - prevEnd) / 86_400_000).toBe(1)
  }
})

test('ledgerChunks returns a single chunk for a short window', () => {
  const from = Date.UTC(2026, 9, 6)
  const to = Date.UTC(2026, 10, 5) // 30 days
  const chunks = ledgerChunks(from, to)
  expect(chunks).toHaveLength(1)
  expect(chunks[0]).toEqual({ from: '2026-10-06', to: '2026-11-05' })
})

// --- barGeometry: progress-bar fill -----------------------------------------
test('barGeometry computes percent, fill and head cell', () => {
  expect(barGeometry(0, 4, 18)).toEqual({ pct: 0, filled: 0, head: 0 })
  expect(barGeometry(2, 4, 18)).toEqual({ pct: 50, filled: 9, head: 1 })
  expect(barGeometry(4, 4, 18)).toEqual({ pct: 100, filled: 18, head: 0 })
  expect(barGeometry(1, 0, 18).pct).toBe(0) // guard total=0
})

// --- buildSnapshot: assemble the dashboard from parsed responses ------------
test('buildSnapshot assembles totals, abs fees and client ranking', () => {
  // Synthetic fixtures — not real account data.
  const summary = {
    period: { from: '2026-01-01', to: '2026-12-31' },
    totals: { billed: '12000.00', earned: '11000.00', fee: '-1000.00', tax: '0.00', currency: 'USD' },
    by_client: [
      { client: 'Globex Ltd', earned: '500.00', billed: '600.00', fee: '-100.00' },
      { client: 'Acme Corp', earned: '9000.00', billed: '9000.00', fee: '0.00' },
      { client: 'Initech', earned: '1500.00', billed: '1700.00', fee: '-200.00' },
    ],
  }
  const bal = {
    available_now: { rawValue: '25.00' },
    pending_balance: { rawValue: '200.00' },
    pending_credit: { rawValue: '240.00' },
  }
  const snap = buildSnapshot({
    days: 365,
    from: '2026-01-01',
    to: '2026-12-31',
    now: 1_762_300_000_000,
    summary,
    bal,
    connectsBalance: 90,
    connectsSpent: 120,
    connectsByCategory: [{ category: 'Profile boost', connects: 80 }],
    ledger: { withdrawalFees: 20, withdrawn: 600, connectsPurchasedUsd: 30 },
  })

  expect(snap.billed).toBe(12000)
  expect(snap.earned).toBe(11000)
  expect(snap.fees).toBe(1000) // abs of the negative fee
  expect(snap.currency).toBe('USD')
  expect(snap.availableNow).toBe(25)
  expect(snap.pendingBalance).toBe(200)
  expect(snap.connectsBalance).toBe(90)
  expect(snap.connectsPurchasedUsd).toBe(30)
  expect(snap.periodFrom).toBe('2026-01-01')
  // clients sorted by earned desc
  expect(snap.byClient.map(c => c.client)).toEqual([
    'Acme Corp',
    'Initech',
    'Globex Ltd',
  ])
  expect(snap.byClient[0]?.earned).toBe(9000)
})

// --- spend pie ---------------------------------------------------------------
test('spendSlices keeps positive slices in fixed colour order', () => {
  const slices = spendSlices(baseSnap) // tax is 0 -> dropped
  expect(slices.map(s => s.label)).toEqual([
    'Upwork fees',
    'Withdrawal fees',
    'Connects bought',
  ])
  // colour is tied to the entity, not its size
  expect(slices[0]?.color).toBe('#2a78d6')
  expect(slices[1]?.color).toBe('#eb6834')
  expect(slices[2]?.color).toBe('#1baf7a')
  expect(sliceTotal(slices)).toBe(150)
})

test('spendSlices includes tax when non-zero and drops all-zero', () => {
  expect(spendSlices({ ...baseSnap, tax: 10 }).map(s => s.label)).toContain('Tax withheld')
  expect(
    spendSlices({
      ...baseSnap,
      fees: 0,
      withdrawalFees: 0,
      connectsPurchasedUsd: 0,
      tax: 0,
    }),
  ).toEqual([])
})

test('pct rounds and guards zero total', () => {
  expect(pct(100, 150)).toBe(67)
  expect(pct(5, 0)).toBe(0)
})

test('pieSvg renders one path per slice with percent labels', () => {
  const slices = spendSlices(baseSnap)
  const svg = pieSvg(slices)
  expect(svg.startsWith('<svg')).toBe(true)
  expect(svg).toContain('viewBox="0 0 100 100"')
  // one donut segment per slice
  expect(svg.split('<path').length - 1).toBe(3)
  // fills present for light and swapped under dark mode
  expect(svg).toContain('#2a78d6')
  expect(svg).toContain('prefers-color-scheme:dark')
  expect(svg).toContain('#3987e5')
  // the dominant slice (67%) is labelled
  expect(svg).toContain('>67%<')
})

test('pieSvg handles a single 100% slice as a ring', () => {
  const svg = pieSvg(
    spendSlices({ ...baseSnap, withdrawalFees: 0, connectsPurchasedUsd: 0, tax: 0 }),
  )
  expect(svg).toContain('<circle')
  expect(svg).toContain('>100%<')
})

test('pieSvg is empty when there is no spend', () => {
  expect(
    pieSvg(
      spendSlices({
        ...baseSnap,
        fees: 0,
        withdrawalFees: 0,
        connectsPurchasedUsd: 0,
        tax: 0,
      }),
    ),
  ).toBe('')
})

test('buildSnapshot falls back when responses are empty', () => {
  const snap = buildSnapshot({
    days: 30,
    from: '2026-10-06',
    to: '2026-11-05',
    now: 0,
    summary: {},
    bal: {},
    connectsBalance: 0,
    connectsSpent: 0,
    connectsByCategory: [],
    ledger: { withdrawalFees: 0, withdrawn: 0, connectsPurchasedUsd: 0 },
  })
  expect(snap.billed).toBe(0)
  expect(snap.currency).toBe('USD')
  expect(snap.byClient).toEqual([])
  expect(snap.periodFrom).toBe('2026-10-06') // falls back to the passed window
})
