/**
 * trustgraph-scanner.mjs — Stub
 * Periodic TrustGraph violation scanner. Was never fully implemented in v8.
 * Imported by server.js for the 15-minute scan interval.
 */
export async function runScan() {
  // no-op stub — scanner not yet implemented
  return { scanned: 0, violations: [] };
}
