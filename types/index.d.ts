export interface ClientRow {
  client: string
  earned: number
  billed: number
  fee: number
}

export interface ConnectsCategory {
  category: string
  connects: number
}

export interface DashboardSnapshot {
  periodDays: number
  periodFrom: string
  periodTo: string
  currency: string
  billed: number
  earned: number
  fees: number
  tax: number
  byClient: ClientRow[]
  availableNow: number
  pendingBalance: number
  pendingCredit: number
  connectsBalance: number
  connectsSpent: number
  connectsByCategory: ConnectsCategory[]
  connectsPurchasedUsd: number
  withdrawalFees: number
  withdrawn: number
  fetchedAt: number
}

export type DashStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface Progress {
  step: number
  total: number
  label: string
}

declare module 'claude-code' {
  interface PluginState {
    'upwork-dashboard': {
      // Per-period cache, keyed by period length in days (30/90/365).
      // Change the shape tag in register.tsx if these fields change.
      snapshots: Shaped<Record<number, DashboardSnapshot>>
      status: DashStatus
      error: string | null
      periodDays: number
      progress: Progress | null
      frame: number
    }
  }
}
