import { runtimeReloadValue } from './shared'

export async function GET() {
  return Response.json({ result: runtimeReloadValue })
}
