import { createSkipDeployment } from '../../lib/skip-deployment'

describe('skipDeployment', () => {
  it('is installed as a Jest global', () => {
    expect(globalThis.skipDeployment).toBe(skipDeployment)
  })

  it('defines the test block outside deployment mode', () => {
    const skipTest = jest.fn()
    const defineTests = jest.fn()
    const skipDeployment = createSkipDeployment({
      isDeployment: () => false,
      skipTest,
    })

    skipDeployment('requires a local process', defineTests)

    expect(defineTests).toHaveBeenCalledTimes(1)
    expect(skipTest).not.toHaveBeenCalled()
  })

  it('replaces the test block with a skipped test in deployment mode', () => {
    const skipTest = jest.fn()
    const defineTests = jest.fn()
    const skipDeployment = createSkipDeployment({
      isDeployment: () => true,
      skipTest,
    })

    skipDeployment('requires a local process', defineTests)

    expect(defineTests).not.toHaveBeenCalled()
    expect(skipTest).toHaveBeenCalledWith(
      'did not run part of this test suite in deployment mode: requires a local process'
    )
  })

  it.each(['', '   '])('rejects an empty reason', (reason) => {
    const skipDeployment = createSkipDeployment({
      isDeployment: () => false,
      skipTest: jest.fn(),
    })

    expect(() => skipDeployment(reason, () => {})).toThrow(
      'skipDeployment requires a reason'
    )
  })
})
