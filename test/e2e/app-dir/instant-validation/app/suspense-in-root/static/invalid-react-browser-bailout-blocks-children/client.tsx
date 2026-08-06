'use client'

import { use, type ReactNode } from 'react'
import { browser } from 'react-dom'

export function BrowserOnly({ children }: { children: ReactNode }) {
  use(browser())
  return children
}
