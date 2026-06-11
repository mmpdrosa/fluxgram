/**
 * Gaussian "human-looking" delay around avgSecs (stdev avg/5), clamped to
 * [0.1, 2*avg]. Used for humanized delays while keeping deterministic tests possible.
 */
export function humanDelay(
  avgSecs: number,
  rng: () => number = Math.random,
  opts?: { lo?: number; hi?: number; stdev?: number },
): number {
  const lo = opts?.lo ?? 0.1;
  const hi = opts?.hi ?? avgSecs * 2;
  const stdev = opts?.stdev ?? avgSecs / 5;
  const u1 = Math.max(rng(), Number.EPSILON);
  const u2 = rng();
  const gauss = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.min(hi, Math.max(lo, avgSecs + gauss * stdev));
}
