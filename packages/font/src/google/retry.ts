// @ts-expect-error File exists
import asyncRetry from 'next/dist/compiled/async-retry'
import * as Log from 'next/dist/build/output/log'

export async function retry<T>(
  fn: asyncRetry.RetryFunction<T>,
  retries: number
) {
  return await asyncRetry(fn, {
    retries,
    onRetry(_e: unknown, attempt: unknown) {
      Log.warn(
        `Failed to fetch from Google Fonts, retrying (${attempt}/${retries})...`
      )
    },
    minTimeout: 100,
  })
}
