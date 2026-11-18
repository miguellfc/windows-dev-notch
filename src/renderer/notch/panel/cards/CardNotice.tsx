/** What a card says instead of its content: not set up, signed out, offline, loading or empty. */
export function CardNotice({ text }: { text: string }) {
  return (
    <div className="mt-2 flex min-h-0 flex-1 items-center justify-center overflow-hidden px-1 text-center">
      <p className="min-w-0 text-small text-graphite">{text}</p>
    </div>
  )
}
