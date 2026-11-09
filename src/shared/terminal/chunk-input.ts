import { TERMINAL_INPUT_MAX } from '../ipc/contract'

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff

/**
 * Splits terminal input into pieces the IPC contract accepts, so a large paste is sent
 * in order instead of being rejected. A surrogate pair is never cut in half.
 */
export function chunkInput(data: string, max: number = TERMINAL_INPUT_MAX): string[] {
  const chunks: string[] = []
  let start = 0
  while (start < data.length) {
    let end = Math.min(start + max, data.length)
    if (end < data.length && isHighSurrogate(data.charCodeAt(end - 1)) && end - 1 > start) end -= 1
    chunks.push(data.slice(start, end))
    start = end
  }
  return chunks
}
