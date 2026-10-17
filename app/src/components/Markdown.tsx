import type { ReactNode } from 'react';

// The chat markdown agents reply in (paragraphs, headings, bullet and numbered lists, **bold**, *italic*, `code`,
// [links](url)), rendered as React elements, never as HTML, so a reply can't inject markup. Hand-rolled because
// a markdown library would push the custom-app bundle past its 1 MB cap; anything it doesn't know shows as text.

export function Markdown({ source }: { source: string }) {
  return <div className="flex flex-col gap-2">{blocks(source)}</div>;
}

function blocks(source: string): ReactNode[] {
  const out: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) out.push(<p key={out.length}>{inline(paragraph.join('\n'))}</p>);
    paragraph = [];
    if (list) {
      const items = list.items.map((item, i) => <li key={i}>{inline(item)}</li>);
      out.push(list.ordered
        ? <ol key={out.length} className="list-decimal pl-5">{items}</ol>
        : <ul key={out.length} className="list-disc pl-5">{items}</ul>);
      list = null;
    }
  };
  for (const line of source.split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (!line.trim()) flush();
    else if (heading) {
      flush();
      out.push(<p key={out.length} className="font-semibold">{inline(heading[2])}</p>);
    } else if (item) {
      const ordered = item[2] !== undefined;
      if (paragraph.length || (list && list.ordered !== ordered)) flush();
      list ??= { ordered, items: [] };
      list.items.push(item[3]);
    } else if (list && /^\s+/.test(line)) list.items[list.items.length - 1] += ` ${line.trim()}`;
    else {
      if (list) flush();
      paragraph.push(line);
    }
  }
  flush();
  return out;
}

const INLINE = /(\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_)/;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push(rest);
      break;
    }
    if (m.index) out.push(rest.slice(0, m.index));
    const key = out.length;
    if (m[2] ?? m[3]) out.push(<strong key={key}>{inline(m[2] ?? m[3])}</strong>);
    else if (m[4]) out.push(<code key={key} className="rounded bg-secondary px-1 text-xs">{m[4]}</code>);
    else if (m[5]) {
      const href = /^(https?:|mailto:)/i.test(m[6]) ? m[6] : undefined;
      out.push(<a key={key} href={href} target="_blank" rel="noreferrer" className="text-brand-primary underline">{inline(m[5])}</a>);
    } else out.push(<em key={key}>{inline(m[7] ?? m[8])}</em>);
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}
