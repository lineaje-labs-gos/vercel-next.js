'use client'

export default function EventRuntimeErrorPage() {
  return (
    <main>
      <button
        id="event-error"
        onClick={() => {
          throw new Error('Test event runtime error')
        }}
      >
        Trigger event error
      </button>
      <p id="event-page-content">Page remains rendered</p>
    </main>
  )
}
