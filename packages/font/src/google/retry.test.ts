import { retry } from './retry'
import * as Log from 'next/dist/build/output/log'

jest.mock('next/dist/build/output/log')

const mockWarn = Log.warn as jest.Mock

describe('next/font/google retry', () => {
  afterEach(() => {
    jest.resetAllMocks()
  })

  it('resolves without warning when the function succeeds first try', async () => {
    const fn = jest.fn().mockResolvedValue('ok')
    await expect(retry(fn, 3)).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(mockWarn).not.toHaveBeenCalled()
  })

  it('retries and logs a numbered warning until it succeeds', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue('ok')
    await expect(retry(fn, 3)).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
    expect(mockWarn.mock.calls.map((call) => call[0])).toEqual([
      'Failed to reach Google Fonts, retrying (1/3)...',
      'Failed to reach Google Fonts, retrying (2/3)...',
    ])
  })

  it('gives up after the retry limit and rejects instead of retrying forever', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('network down'))
    await expect(retry(fn, 3)).rejects.toThrow('network down')
    // Initial attempt + 3 retries.
    expect(fn).toHaveBeenCalledTimes(4)
    expect(mockWarn).toHaveBeenCalledTimes(3)
  })
})
