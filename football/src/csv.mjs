/** 极简 CSV：无引号转义需求的数值型数据集专用（字段内不含逗号）。 */
export function parseCsv(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) return [];
  const header = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row = {};
    header.forEach((key, index) => {
      row[key] = cells[index] ?? '';
    });
    return row;
  });
}

export function toCsv(header, rows) {
  const out = [header.join(',')];
  for (const row of rows) {
    out.push(
      header
        .map((key) => {
          const value = row[key] ?? '';
          const text = String(value);
          if (text.includes(',') || text.includes('\n')) {
            throw new RangeError(`toCsv: 字段 ${key} 含逗号/换行（${text}）`);
          }
          return text;
        })
        .join(','),
    );
  }
  return `${out.join('\n')}\n`;
}
