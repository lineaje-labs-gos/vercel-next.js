export function alpha(input: string) {
  return 'alpha:' + input
}

declare const module: any
if (typeof module !== 'undefined' && module.hot) {
  module.hot.accept()
}
