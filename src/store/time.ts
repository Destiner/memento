// Second-precision ISO 8601 timestamps, matching the §7 front-matter format
// (no milliseconds). Shared by create and update so lifecycle stamps stay
// identical across the store.
export function isoSeconds(now: number): string {
  return new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
