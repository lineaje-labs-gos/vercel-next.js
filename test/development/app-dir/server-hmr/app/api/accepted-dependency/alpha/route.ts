import { alpha } from '../shared'
import { evaluatedAt } from '../state'

export async function GET() {
  return Response.json({ result: alpha('x'), evaluatedAt })
}
