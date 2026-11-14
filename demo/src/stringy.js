/**
 * 演示用字符串小工具。
 * 给 Bot 团队练手：让 /dispatch 对它提需求、修 bug、加测试。
 */

/** 转成 URL 友好的 slug：小写、空格/下划线转连字符、去掉其他非字母数字字符；keepChinese 为 true 时保留中文字符 */
export function slugify(input, keepChinese = false) {
  const strip = keepChinese ? /[^a-z0-9-\p{Script=Han}]/gu : /[^a-z0-9-]/g;
  return String(input)
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(strip, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** 超长截断并加省略号；不超过 limit 时原样返回。limit 不大于省略号长度时按 limit 硬截断 */
export function truncate(input, limit = 20, ellipsis = '...') {
  const text = String(input);
  if (text.length <= limit) return text;
  if (limit <= ellipsis.length) return text.slice(0, Math.max(0, limit));
  return text.slice(0, Math.max(0, limit - ellipsis.length)) + ellipsis;
}
