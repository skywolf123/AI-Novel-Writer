import { describe, expect, it } from 'vitest'
import { diffLineChars, hunkChurn, pairHunkLines, type LinePair } from '../ThreeWayMerge'

describe('pairHunkLines', () => {
  it('相同行配对为 same 对', () => {
    expect(pairHunkLines(['a', 'b'], ['a', 'b'])).toEqual([
      { o: 'a', m: 'a' },
      { o: 'b', m: 'b' },
    ])
  })

  it('单行改写 zip 为同一修改对（供字符级 diff）', () => {
    expect(pairHunkLines(['他说了一句话'], ['他说了一句不一样的话'])).toEqual([
      { o: '他说了一句话', m: '他说了一句不一样的话' },
    ])
  })

  it('纯插入产出单边新增行', () => {
    expect(pairHunkLines(['a'], ['a', 'new'])).toEqual([
      { o: 'a', m: 'a' },
      { m: 'new' },
    ])
  })

  it('纯删除产出单边删除行', () => {
    expect(pairHunkLines(['a', 'gone'], ['a'])).toEqual([
      { o: 'a', m: 'a' },
      { o: 'gone' },
    ])
  })

  it('相邻删除块+插入块按顺序 zip 为修改对', () => {
    expect(pairHunkLines(['x', 'd1', 'd2', 'y'], ['x', 'a1', 'a2', 'y'])).toEqual([
      { o: 'x', m: 'x' },
      { o: 'd1', m: 'a1' },
      { o: 'd2', m: 'a2' },
      { o: 'y', m: 'y' },
    ])
  })

  it('空输入产出空数组', () => {
    expect(pairHunkLines([], [])).toEqual([])
  })

  it('一删多增时删除行与首个新增行配对,余下保持单边', () => {
    expect(pairHunkLines(['a'], ['b', 'c'])).toEqual([
      { o: 'a', m: 'b' },
      { m: 'c' },
    ])
  })
})

describe('diffLineChars', () => {
  it('相同文本产出 same spans', () => {
    const { left, right } = diffLineChars('红色的苹果', '红色的苹果')
    expect(left).toEqual([{ type: 'same', text: '红色的苹果' }])
    expect(right).toEqual([{ type: 'same', text: '红色的苹果' }])
  })

  it('中间插入词时右栏产出 add span、左栏无 del', () => {
    const { left, right } = diffLineChars('他说', '他说了一句')
    const adds = right.filter(s => s.type === 'add')
    expect(adds.map(s => s.text).join('')).toContain('了一句')
    expect(right.some(s => s.type === 'del')).toBe(false)
    expect(left.some(s => s.type === 'del')).toBe(false)
  })

  it('改写词产出 del 与 add spans', () => {
    const { left, right } = diffLineChars('红色的苹果', '青色的苹果')
    expect(left.filter(s => s.type === 'del').map(s => s.text).join('')).toContain('红')
    expect(right.filter(s => s.type === 'add').map(s => s.text).join('')).toContain('青')
    // 未改动的尾部两侧都是 same
    expect(left.some(s => s.type === 'same' && s.text.includes('色的苹果'))).toBe(true)
    expect(right.some(s => s.type === 'same' && s.text.includes('色的苹果'))).toBe(true)
  })
})

describe('hunkChurn', () => {
  it('统计改写/删除/新增行(改写行两侧各计一次)', () => {
    const pairs: LinePair[] = [
      { o: 'same', m: 'same' },
      { o: 'old', m: 'new' }, // 改写:del+1, add+1
      { o: 'gone' }, // 纯删除:del+1
      { m: 'fresh' }, // 纯新增:add+1
    ]
    expect(hunkChurn(pairs)).toEqual({ del: 2, add: 2 })
  })

  it('未变行不计入', () => {
    expect(hunkChurn([{ o: 'a', m: 'a' }])).toEqual({ del: 0, add: 0 })
  })
})
