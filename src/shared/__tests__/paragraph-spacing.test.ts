import { describe, expect, it } from 'vitest'

import { normalizeParagraphSpacing } from '../paragraph-spacing'

describe('paragraph spacing normalization', () => {
  it('collapses two or more blank lines into exactly one', () => {
    expect(normalizeParagraphSpacing('第一段。\n\n\n\n第二段。')).toBe('第一段。\n\n第二段。')
    expect(normalizeParagraphSpacing('第一段。\n\n第二段。')).toBe('第一段。\n\n第二段。')
  })

  it('removes leading and trailing blank lines left by deletions', () => {
    expect(normalizeParagraphSpacing('\n\n\n第一段。\n第二段。\n\n\n')).toBe('第一段。\n第二段。')
  })

  it('unifies CRLF line endings', () => {
    expect(normalizeParagraphSpacing('第一段。\r\n\r\n\r\n第二段。')).toBe('第一段。\n\n第二段。')
  })

  it('never touches visible characters', () => {
    const text = '他把“南山”划掉。\n“钥匙两把。”\n\n她看了那四个字两秒。'
    expect(normalizeParagraphSpacing(text)).toBe(text)
  })
})
