import { describe, expect, it } from 'vitest'

import { detectDuplicateParagraphs, mergeDuplicateSpansIntoReview } from '../duplicate-spans'

/** 生成一段超过近似重复门槛（20 归一化字符）的中文长段落，各 seed 内容真正不同 */
function longParagraph(seed: number): string {
  const scenes = [
    '他沿着河堤走了很久，夜里只剩水声，路灯把影子拉得很长，他停下来点了支烟，看对岸的灯一盏一盏灭掉。',
    '会议开到后半段，桌上已经没有人说话，她把文件翻到最后一页，用笔帽敲了敲桌面，等窗外那阵风过去。',
    '巷子深处传来收摊的动静，铁卷门落地的声音一下比一下沉，老板娘把零钱盒锁进柜子，抬头看了一眼天色。',
    '信号灯变绿的时候他才开始移动，脚步不快，身后的引擎声由远及近，他没有回头，只把外套拉链拉到顶。',
    '清点完货物已是深夜，仓库里只剩一盏应急灯，他在签收单末尾签了名，把复写纸的那一联折好塞进内袋。',
    '雨下起来的时候她在便利店门口躲了几分钟，玻璃门内的电视放着重播新闻，她盯着屏幕右下角的日期看了很久。',
    '电话那头沉默了足有十秒，他听得出对方在斟酌措辞，于是把椅子转向窗户，等那句迟来的答复落地。',
    '病历本摊在膝盖上，她逐行核对用药记录，指尖停在某一行，停了很久，然后把那一页折出一个很小的角。',
  ]
  return scenes[(seed - 1) % scenes.length]!
}

describe('detectDuplicateParagraphs', () => {
  it('flags exact duplicated long paragraphs as errors', () => {
    const draft = [
      longParagraph(1),
      '中间隔了一段不同的文字，内容完全无关。',
      longParagraph(1),
    ].join('\n\n')
    const findings = detectDuplicateParagraphs(draft)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      kind: 'exact-paragraph',
      severity: 'error',
      paragraphNumbers: [1, 3],
    })
  })

  it('merges a three-way duplication into one finding listing every occurrence', () => {
    const draft = [
      longParagraph(1),
      longParagraph(1),
      '无关段落。',
      longParagraph(1),
    ].join('\n\n')
    const findings = detectDuplicateParagraphs(draft)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.paragraphNumbers).toEqual([1, 2, 4])
  })

  it('flags near-duplicated paragraphs (continuation overlap) as warnings', () => {
    const overlap = '她推开门，走廊尽头的灯忽明忽暗，水磨石地面映出两个人的影子，'
      + '墙上的公告栏贴着一张泛黄的通知，边角卷起，钉子锈成了暗红色，风从楼道里灌进来。'
    const draft = [
      overlap,
      '完全不同的一段，说的是另一个场景和另一个人的事情，与此处毫无关联。',
      `${overlap}她停下脚步。`,
    ].join('\n\n')
    const findings = detectDuplicateParagraphs(draft)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      kind: 'near-paragraph',
      severity: 'warning',
      paragraphNumbers: [1, 3],
    })
  })

  it('does not convict short functional echoes like repeated date lines', () => {
    const draft = [
      '2004.3.18',
      '2006.8.7',
      '2016.9.12',
      '她合上文件夹，把纸折回两折。',
      '2004.3.18',
      '2006.8.7',
      '2016.9.12',
    ].join('\n\n')
    expect(detectDuplicateParagraphs(draft)).toEqual([])
  })

  it('normalizes punctuation and whitespace before comparing', () => {
    const draft = [
      '他推开门，屋里一片漆黑，只有窗外的路灯照进来一小片光。',
      '他推开门……屋里一片漆黑——只有窗外的路灯，照进来一小片光！',
    ].join('\n\n')
    const findings = detectDuplicateParagraphs(draft)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.kind).toBe('exact-paragraph')
  })

  it('returns no findings for a clean draft', () => {
    const draft = [
      longParagraph(1),
      longParagraph(2),
      longParagraph(3),
    ].join('\n\n')
    expect(detectDuplicateParagraphs(draft)).toEqual([])
  })

  it('caps findings at the report limit', () => {
    const paragraphs: string[] = []
    for (let seed = 1; seed <= 8; seed += 1) {
      paragraphs.push(longParagraph(seed), longParagraph(seed))
    }
    expect(detectDuplicateParagraphs(paragraphs.join('\n\n'))).toHaveLength(6)
  })

  it('does not re-report a near-duplicate of an already convicted exact duplication', () => {
    const original = longParagraph(1)
    const tweaked = `${original.slice(0, -4)}改动结尾几个字。`
    const draft = [
      original,
      longParagraph(2),
      original,
      tweaked,
    ].join('\n\n')
    const findings = detectDuplicateParagraphs(draft)
    // 第 1、3 段逐字重复（error）先定罪；第 4 段只与已定罪段近似，不再报 warning
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      severity: 'error',
      paragraphNumbers: [1, 3],
    })
  })
})

describe('mergeDuplicateSpansIntoReview', () => {
  const findings = detectDuplicateParagraphs([
    longParagraph(1),
    longParagraph(1),
  ].join('\n\n'))

  it('appends localized items and preserves existing review items', () => {
    const review = {
      summary: '原有总结',
      items: [{ category: '剧情连贯性', severity: 'pass', description: '无问题' }],
    }
    const merged = mergeDuplicateSpansIntoReview(review, findings, 'zh-CN')
    expect(merged.items).toHaveLength(2)
    expect(merged.items[1]).toMatchObject({
      category: '确定性重复检测',
      severity: 'error',
    })
    expect(merged.items[0]).toEqual(review.items[0])
  })

  it('uses the en-US category and description for en-US locale', () => {
    const merged = mergeDuplicateSpansIntoReview({ summary: '', items: [] }, findings, 'en-US')
    expect(merged.items[0]).toMatchObject({
      category: 'Deterministic duplicate detection',
      severity: 'error',
    })
  })
})
