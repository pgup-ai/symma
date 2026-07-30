// Polls until the probe returns something, for the several e2e tests that wait
// on a real gateway, a real companion, or a file one of them wrote. Deliberately
// not named `.test.ts`, so the runner's glob does not pick it up as a suite.
//
// Probe failures are swallowed and retried: while a gateway is still booting a
// fetch throws, and "timed out waiting for X" names the thing that never
// happened where a bare ECONNREFUSED does not.
export async function waitFor<T>(probe: () => Promise<T | undefined>, what: string): Promise<T> {
  for (let i = 0; i < 100; i += 1) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}
