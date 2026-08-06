export const instant = { level: 'experimental-error' }

export default function Page() {
  return (
    <main>
      <p>
        This page is static, but the browser bailout above prevents Instant
        Validation from reaching it.
      </p>
    </main>
  )
}
