const TONES_HZ = [880, 660] as const
const TONE_S = 0.12
const ATTACK_S = 0.015
const PEAK_GAIN = 0.15

let context: AudioContext | null = null

/**
 * A short two-tone chime synthesised with Web Audio (no audio file, so the CSP stays as is).
 * The context is created lazily and reused; any audio failure is swallowed.
 */
export function playChime(): void {
  try {
    context ??= new AudioContext()
    const audio = context
    if (audio.state === 'suspended') void audio.resume().catch(() => undefined)
    const start = audio.currentTime + 0.02
    TONES_HZ.forEach((frequency, index) => {
      const begin = start + index * TONE_S
      const end = begin + TONE_S
      const oscillator = audio.createOscillator()
      const gain = audio.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.value = frequency
      // Soft attack and release: no click at either edge.
      gain.gain.setValueAtTime(0, begin)
      gain.gain.linearRampToValueAtTime(PEAK_GAIN, begin + ATTACK_S)
      gain.gain.setValueAtTime(PEAK_GAIN, end - ATTACK_S * 2)
      gain.gain.linearRampToValueAtTime(0, end)
      oscillator.connect(gain).connect(audio.destination)
      oscillator.start(begin)
      oscillator.stop(end + 0.01)
    })
  } catch {
    // Sound is a nicety; the toast and the capsule already carry the reminder.
  }
}
