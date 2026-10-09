import { describe, expect, it } from 'vitest'

import {
  parseKeyEventBeats,
  validateKeyEventBeats,
  KEY_EVENT_BEAT_MAX_ITEMS,
  KEY_EVENT_BEAT_MIN_ITEMS,
} from '../key-event-beats'

describe('key event beat splitting', () => {
  it('parses the keyEvents envelope, a beats envelope, and a bare array', () => {
    expect(parseKeyEventBeats('{"keyEvents":["甲收到密信","乙发现夹层"]}'))
      .toEqual(['甲收到密信', '乙发现夹层'])
    expect(parseKeyEventBeats('{"beats":["甲收到密信","乙发现夹层"]}'))
      .toEqual(['甲收到密信', '乙发现夹层'])
    expect(parseKeyEventBeats('["甲收到密信","乙发现夹层"]'))
      .toEqual(['甲收到密信', '乙发现夹层'])
  })

  it('accepts a fenced JSON payload and strips the fence', () => {
    expect(parseKeyEventBeats('```json\n{"keyEvents":["甲收到密信","乙发现夹层"]}\n```'))
      .toEqual(['甲收到密信', '乙发现夹层'])
  })

  it('replaces semicolons inside a beat so review does not split one beat into two goals', () => {
    expect(parseKeyEventBeats('{"keyEvents":["甲收到密信；立刻判断屋内有内应","乙出门"]}'))
      .toEqual(['甲收到密信，立刻判断屋内有内应', '乙出门'])
  })

  it('rejects malformed envelopes, empty beats, and non-string beats', () => {
    expect(() => parseKeyEventBeats('不是 JSON')).toThrow(/invalid_envelope/u)
    expect(() => parseKeyEventBeats('{"keyEvents":"一段文字"}')).toThrow(/invalid_envelope/u)
    expect(() => parseKeyEventBeats('{"keyEvents":["有效节拍","  "]}')).toThrow(/invalid_value/u)
    expect(() => parseKeyEventBeats('{"keyEvents":["有效节拍",42]}')).toThrow(/invalid_value/u)
  })

  it('accepts only 2-6 non-empty beats', () => {
    expect(validateKeyEventBeats(['一拍', '二拍']).ok).toBe(true)
    const six = validateKeyEventBeats(['一', '二', '三', '四', '五', '六'])
    expect(six.ok).toBe(true)
    expect(validateKeyEventBeats(['一拍'])).toEqual({ ok: false, reason: 'count' })
    expect(validateKeyEventBeats(['一', '二', '三', '四', '五', '六', '七']))
      .toEqual({ ok: false, reason: 'count' })
    expect(validateKeyEventBeats(['一拍', '   '])).toEqual({ ok: false, reason: 'empty' })
  })

  it('keeps the beat bounds aligned with the blueprint contract range', () => {
    expect(KEY_EVENT_BEAT_MIN_ITEMS).toBe(2)
    expect(KEY_EVENT_BEAT_MAX_ITEMS).toBe(6)
  })
})
