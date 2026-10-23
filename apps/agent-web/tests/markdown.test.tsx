import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownBody } from '../src/components/MarkdownBody';
import { splitMarkdownBlocks } from '../src/lib/markdown-blocks';
import { getMarkdownListContinuation } from '../src/lib/markdown-list-continuation';

test('Markdown renders tables and code without enabling HTML or automatic remote images', () => {
  const html = renderToStaticMarkup(
    <MarkdownBody>
      {[
        '| 项目 | 状态 |',
        '| --- | --- |',
        '| 连接 | 就绪 |',
        '',
        '```ts',
        'const text = "<script>";',
        '```',
        '',
        '<script>alert(1)</script>',
        '',
        '![图片](https://example.org/tracker.png)',
        '',
        '[本地](file:///etc/passwd) [执行](javascript:alert(1)) [网页](https://example.org)',
      ].join('\n')}
    </MarkdownBody>,
  );
  assert.match(html, /<table>/);
  assert.match(html, /language-ts/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script|<img|file:\/|javascript:/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test('streamed blocks preserve source and keep fences, lists and raw HTML together', () => {
  const document =
    '开头\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n1. 第一项\n\n2. 第二项\n\n结尾';
  for (let end = 0; end <= document.length; end++) {
    assert.equal(splitMarkdownBlocks(document.slice(0, end)).join(''), document.slice(0, end));
  }
  const blocks = splitMarkdownBlocks(document);
  assert.ok(blocks.some((block) => block.includes('const a') && block.includes('const b')));
  assert.ok(blocks.some((block) => block.includes('第一项') && block.includes('第二项')));
  assert.deepEqual(splitMarkdownBlocks('<details>\n\n正文\n\n</details>'), [
    '<details>\n\n正文\n\n</details>',
  ]);
});

test('list editing continues numbered and checkbox lists and exits an empty item', () => {
  assert.deepEqual(getMarkdownListContinuation('1、第一项', 5, 5), {
    start: 5,
    end: 5,
    text: '\n2、',
  });
  assert.deepEqual(getMarkdownListContinuation('- [x] done', 10, 10), {
    start: 10,
    end: 10,
    text: '\n- [ ] ',
  });
  assert.deepEqual(getMarkdownListContinuation('- ', 2, 2), { start: 0, end: 2, text: '' });
  const code = '```\n- text';
  assert.equal(getMarkdownListContinuation(code, code.length, code.length), null);
  assert.equal(getMarkdownListContinuation('- text', 2, 4), null);
});
