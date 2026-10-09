/**
 * 定点补丁：LLM 以 {"patches":[{"find","replace"}]} 表达对原文的最小修改，
 * 逐字精确匹配应用。审稿修复与润色定点修复共用同一合同与应用器，
 * 机械保证「只动问题区」：补丁匹配不到原文即跳过，绝不改写别处。
 */

export interface SpotPatch {
  find: string
  replace: string
}

export interface SpotPatchApplyResult {
  text: string
  applied: number
  missed: number
}

export const SPOT_PATCH_LIMITS = Object.freeze({
  minFindLength: 6,
  maxPatches: 16,
})

/** 剥掉 Markdown 代码围栏（如有），供宽容 JSON 解析共用 */
export function stripCodeFences(raw: string): string {
  return raw
    .replace(/^[\s\S]*?```(?:json)?\s*\n?/u, match => (match.includes('```') ? '' : match))
    .replace(/```\s*[\s\S]*$/u, '')
    .trim()
}

/** 宽容解析定点修复补丁 JSON：{"patches":[{"find":"…","replace":"…"}]} */
export function parseSpotPatches(raw: string): SpotPatch[] {
  const candidate = stripCodeFences(raw)
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as { patches?: unknown }
    if (!Array.isArray(parsed.patches)) return []
    const patches: SpotPatch[] = []
    for (const entry of parsed.patches.slice(0, SPOT_PATCH_LIMITS.maxPatches)) {
      if (typeof entry !== 'object' || entry === null) continue
      const record = entry as Record<string, unknown>
      if (typeof record.find !== 'string' || typeof record.replace !== 'string') continue
      if (record.find.length < SPOT_PATCH_LIMITS.minFindLength) continue
      patches.push({ find: record.find, replace: record.replace })
    }
    return patches
  } catch {
    return []
  }
}

/**
 * 逐字精确匹配应用补丁；未命中的补丁直接丢弃并计数，
 * 机械保证「只动问题区」。
 */
export function applySpotPatches(text: string, patches: SpotPatch[]): SpotPatchApplyResult {
  let result = text
  let applied = 0
  let missed = 0
  for (const patch of patches) {
    const index = result.indexOf(patch.find)
    if (index < 0) {
      missed += 1
      continue
    }
    result = result.slice(0, index) + patch.replace + result.slice(index + patch.find.length)
    applied += 1
  }
  return { text: result, applied, missed }
}
