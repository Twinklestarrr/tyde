/** JSON 边界不接受有歧义的重复键、非法 UTF-8 或孤立代理项。 */
export function parseStrictJson(bytes: Buffer): unknown {
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(source);
  let index = 0;
  const whitespace = () => {
    while (/\s/.test(source[index] ?? '') && index < source.length) index += 1;
  };
  const string = (): string => {
    const start = index++;
    while (index < source.length) {
      const character = source[index++];
      if (character === '\\') index += 1;
      else if (character === '"') break;
    }
    const text = JSON.parse(source.slice(start, index)) as string;
    if (/[\uD800-\uDFFF]/u.test(text)) throw new Error('INVALID_JSON');
    return text;
  };
  const visit = (depth = 0): void => {
    // 128 KiB 内恶意深嵌套也不得耗尽宿主栈。
    if (depth > 128) throw new Error('INVALID_JSON');
    whitespace();
    if (source[index] === '"') {
      string();
    } else if (source[index] === '{') {
      index += 1;
      whitespace();
      const keys = new Set<string>();
      while (source[index] !== '}') {
        whitespace();
        const key = string();
        if (keys.has(key)) throw new Error('INVALID_JSON');
        keys.add(key);
        whitespace();
        index += 1; // 冒号；JSON.parse 已检查完整语法。
        visit(depth + 1);
        whitespace();
        if (source[index] !== ',') break;
        index += 1;
      }
      index += 1;
    } else if (source[index] === '[') {
      index += 1;
      whitespace();
      while (source[index] !== ']') {
        visit(depth + 1);
        whitespace();
        if (source[index] !== ',') break;
        index += 1;
      }
      index += 1;
    } else {
      while (index < source.length && !/[\s,\]}]/.test(source[index]!)) index += 1;
    }
  };
  visit();
  return value;
}
