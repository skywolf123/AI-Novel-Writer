import { StructuredContractDiagnostic } from './structured-contract-diagnostic'

/**
 * 把单章蓝图的 keyEvents 长段落拆成 2-6 个事件节拍。
 *
 * 这是「只改格式、不改内容」的结构化投影：模型必须以原字符串为唯一输入，
 * 把已有的每个事件原意分配到一个节拍里，不得新增、删除或改写事件。
 * 节拍项数上限与蓝图生成合同一致（BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST），
 * 因此不引入第二套限制。
 */

export const KEY_EVENT_BEAT_MIN_ITEMS = 2
export const KEY_EVENT_BEAT_MAX_ITEMS = 6

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 宽容解析模型返回的节拍数组：接受 {"keyEvents":[...]} / {"beats":[...]} / 裸数组。
 * 节拍项内的分号替换为逗号——审稿按行与分号切分验收目标，节拍内残留分号会把
 * 一拍拆成两条目标。
 */
export function parseKeyEventBeats(raw: string): string[] {
  const trimmed = raw.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed)
  const candidate = fenced ? fenced[1].trim() : trimmed
  if (!candidate || !/^[{[]/u.test(candidate)) {
    throw new StructuredContractDiagnostic('invalid_envelope', '$')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch {
    throw new StructuredContractDiagnostic('invalid_json', '$')
  }
  const list = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed)
      ? parsed.keyEvents ?? parsed.beats
      : undefined
  if (!Array.isArray(list)) throw new StructuredContractDiagnostic('invalid_envelope', 'keyEvents')
  return list.map((item, index) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw new StructuredContractDiagnostic('invalid_value', `keyEvents[${index}]`)
    }
    return item.trim().replace(/[；;]/gu, '，')
  })
}

export interface KeyEventBeatsValidation {
  ok: true
  beats: string[]
}

export interface KeyEventBeatsRejection {
  ok: false
  reason: 'count' | 'empty'
}

/**
 * 机械校验：节拍数必须落在 2-6 之间，且每项非空。
 * 不在这里做语义比对——「是否只改了格式」由提示词约束并由作者肉眼确认。
 */
export function validateKeyEventBeats(beats: readonly string[]): KeyEventBeatsValidation | KeyEventBeatsRejection {
  if (beats.length < KEY_EVENT_BEAT_MIN_ITEMS || beats.length > KEY_EVENT_BEAT_MAX_ITEMS) {
    return { ok: false, reason: 'count' }
  }
  if (beats.some(beat => !beat.trim())) return { ok: false, reason: 'empty' }
  return { ok: true, beats: beats.map(beat => beat.trim()) }
}
