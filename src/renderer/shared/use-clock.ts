import { useEffect, useState } from 'react'

/** Current time, refreshed once per minute on the minute: no work while idle. */
export function useClock(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const schedule = () => {
      const msToNextMinute = 60_000 - (Date.now() % 60_000)
      timer = setTimeout(() => {
        setNow(new Date())
        schedule()
      }, msToNextMinute + 50)
    }
    schedule()
    return () => clearTimeout(timer)
  }, [])
  return now
}
