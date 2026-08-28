export type SkipDeployment = (reason: string, defineTests: () => void) => void

declare global {
  var skipDeployment: SkipDeployment
}

export function createSkipDeployment({
  isDeployment,
  skipTest,
}: {
  isDeployment: () => boolean
  skipTest: (name: string) => void
}): SkipDeployment {
  return function skipDeployment(reason, defineTests) {
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new Error('skipDeployment requires a reason')
    }

    if (isDeployment()) {
      skipTest(
        `did not run part of this test suite in deployment mode: ${reason.trim()}`
      )
      return
    }

    defineTests()
  }
}
