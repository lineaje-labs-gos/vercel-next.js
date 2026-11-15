export async function GET(request: Request) {
  if (new URL(request.url).searchParams.has('load')) {
    const { lazyValue } = await import('./lazy')
    return Response.json({ result: lazyValue })
  }
  return Response.json({ result: 'not loaded' })
}
