/**
 * 修稿产物的段落空行规整（纯确定性，不动任何可见字符）。
 *
 * 模型整章修订删掉段落时，被删段落两侧的空行会残留为连续多个空行；
 * 补丁删除句子的 replace 也会留下同样的空档。修稿合同要求「段落之间
 * 恰好一个空行」，这里机械折叠：两个及以上连续空行收为一个，统一换行
 * 符为 \n，并去掉首尾空行。
 */
export function normalizeParagraphSpacing(text: string): string {
  return text
    .replace(/\r\n?/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .replace(/^(?:[^\S\n]*\n)+/u, '')
    .replace(/(?:\n[^\S\n]*)+$/u, '')
}
