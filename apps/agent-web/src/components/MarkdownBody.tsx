// Adapted from agegr/pi-web; see ../../upstream/pi-web/SOURCE.md and LICENSE.
import { memo, useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { splitMarkdownBlocks } from '../lib/markdown-blocks';

const remarkPlugins = [remarkGfm];
const components: Components = {
  a({ href, children }) {
    // Local files, application routes and executable URL schemes are not Agent links.
    const safe = href && /^https?:\/\//i.test(href) ? href : undefined;
    return safe ? (
      <a href={safe} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    );
  },
  img({ alt }) {
    // Model-provided image URLs must not issue an automatic remote request.
    return <span className="markdown-image-label">{alt ? `[图片：${alt}]` : '[图片]'}</span>;
  },
  ol({ node, start, style, ...props }) {
    const items =
      node?.children.filter((child) => child.type === 'element' && child.tagName === 'li').length ??
      0;
    const digits = String(Math.abs((start ?? 1) + Math.max(items, 1) - 1)).length;
    return (
      <ol
        start={start}
        style={{ ...style, ['--ol-marker-digits' as string]: Math.max(digits, 2) }}
        {...props}
      />
    );
  },
  table({ children }) {
    return (
      <div className="markdown-table-frame">
        <div className="markdown-table-wrap">
          <table>{children}</table>
        </div>
      </div>
    );
  },
};

const MarkdownBlock = memo(function MarkdownBlock({ markdown }: { markdown: string }) {
  return (
    <ReactMarkdown skipHtml remarkPlugins={remarkPlugins} components={components}>
      {markdown}
    </ReactMarkdown>
  );
});

/** Completed blocks keep their parse while the trailing streamed block grows. */
export const MarkdownBody = memo(function MarkdownBody({
  children,
  isStreaming = false,
}: {
  children: string;
  isStreaming?: boolean;
}) {
  const blocks = useMemo(
    () => (isStreaming ? splitMarkdownBlocks(children) : [children]),
    [children, isStreaming],
  );
  return (
    <div className="markdown-body">
      {blocks.map((markdown, index) => (
        <MarkdownBlock key={index} markdown={markdown} />
      ))}
    </div>
  );
});
