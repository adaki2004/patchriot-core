import { useLive } from './useLive';
import type { Order } from './Orders';
import type { Reservation } from './ReviewCodes';

export type HistoryEntry = { kind: 'payment'; record: Order; created: number } | { kind: 'coupon'; record: Reservation; created: number };

/** A shared purchase history without treating coupon coverage as received funds. */
export function useOrderHistory() {
  const orders = useLive<Order[]>('/orders', true, 30_000);
  const coupons = useLive<Reservation[]>('/review-codes', true, 30_000);
  const entries: HistoryEntry[] = [
    ...(orders.data ?? []).map(record => ({ kind: 'payment' as const, record, created: Date.parse(record.created_at) })),
    ...(coupons.data ?? []).map(record => ({ kind: 'coupon' as const, record, created: Date.parse(record.reserved_at) })),
  ];
  entries.sort((a, b) => b.created - a.created || a.record.id.localeCompare(b.record.id));
  return { orders, coupons, entries, ready: orders.data !== null && coupons.data !== null };
}
