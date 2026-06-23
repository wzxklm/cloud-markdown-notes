import { useMemo, type ReactNode } from "react";

export function MarkdownPreview({ content }: { content: string }) {
  const blocks = useMemo(() => renderMarkdown(content), [content]);
  return <div className="markdown-preview">{blocks}</div>;
}

function renderMarkdown(content: string) {
  const blocks: ReactNode[] = [];
  const lines = content.split(/\r?\n/);
  let paragraph: string[] = [];
  let unorderedList: { content: string; checked?: boolean }[] = [];
  let orderedList: string[] = [];
  let quote: string[] = [];
  let code: string[] | null = null;

  function flushQuote() {
    if (quote.length > 0) {
      blocks.push(
        <blockquote key={`quote-${blocks.length}`}>
          <p>{renderInline(quote.join(" "))}</p>
        </blockquote>
      );
      quote = [];
    }
  }

  function flushParagraph() {
    if (paragraph.length > 0) {
      blocks.push(<p key={`p-${blocks.length}`}>{renderInline(paragraph.join(" "))}</p>);
      paragraph = [];
    }
  }

  function flushLists() {
    if (unorderedList.length > 0) {
      blocks.push(
        <ul key={`ul-${blocks.length}`}>
          {unorderedList.map((item, index) => (
            <li
              key={`${item.content}-${index}`}
              className={item.checked === undefined ? undefined : "task-item"}
            >
              {item.checked !== undefined && (
                <input type="checkbox" checked={item.checked} readOnly disabled />
              )}
              <span>{renderInline(item.content)}</span>
            </li>
          ))}
        </ul>
      );
      unorderedList = [];
    }

    if (orderedList.length > 0) {
      blocks.push(
        <ol key={`ol-${blocks.length}`}>
          {orderedList.map((item, index) => (
            <li key={`${item}-${index}`}>{renderInline(item)}</li>
          ))}
        </ol>
      );
      orderedList = [];
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("```")) {
      flushQuote();
      flushParagraph();
      flushLists();
      if (code) {
        blocks.push(<pre key={`code-${blocks.length}`}>{code.join("\n")}</pre>);
        code = null;
      } else {
        code = [];
      }
      continue;
    }

    if (code) {
      code.push(line);
      continue;
    }

    if (isTableStart(lines, index)) {
      flushQuote();
      flushParagraph();
      flushLists();
      const table = readTable(lines, index);
      blocks.push(
        <table key={`table-${blocks.length}`}>
          <thead>
            <tr>
              {table.headers.map((cell, cellIndex) => (
                <th key={`${cell}-${cellIndex}`}>{renderInline(cell)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, rowIndex) => (
              <tr key={`row-${rowIndex}`}>
                {table.headers.map((_header, cellIndex) => (
                  <td key={`${rowIndex}-${cellIndex}`}>{renderInline(row[cellIndex] ?? "")}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
      index = table.nextIndex - 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flushQuote();
      flushParagraph();
      flushLists();
      const level = Math.min(heading[1].length, 3);
      const Tag = `h${level}` as "h1" | "h2" | "h3";
      blocks.push(<Tag key={`h-${blocks.length}`}>{renderInline(heading[2])}</Tag>);
      continue;
    }

    const quoteLine = /^>\s?(.*)$/.exec(line);
    if (quoteLine) {
      flushParagraph();
      flushLists();
      quote.push(quoteLine[1]);
      continue;
    }

    const taskItem = /^[-*]\s+\[([ xX])\]\s+(.+)$/.exec(line);
    if (taskItem) {
      flushQuote();
      flushParagraph();
      if (orderedList.length > 0) {
        flushLists();
      }
      unorderedList.push({
        checked: taskItem[1].toLowerCase() === "x",
        content: taskItem[2]
      });
      continue;
    }

    const listItem = /^[-*]\s+(.+)$/.exec(line);
    if (listItem) {
      flushQuote();
      flushParagraph();
      if (orderedList.length > 0) {
        flushLists();
      }
      unorderedList.push({ content: listItem[1] });
      continue;
    }

    const orderedItem = /^\d+\.\s+(.+)$/.exec(line);
    if (orderedItem) {
      flushQuote();
      flushParagraph();
      if (unorderedList.length > 0) {
        flushLists();
      }
      orderedList.push(orderedItem[1]);
      continue;
    }

    if (!line.trim()) {
      flushQuote();
      flushParagraph();
      flushLists();
      continue;
    }

    flushQuote();
    flushLists();
    paragraph.push(line.trim());
  }

  flushQuote();
  flushParagraph();
  flushLists();
  if (code) {
    blocks.push(<pre key={`code-${blocks.length}`}>{code.join("\n")}</pre>);
  }

  return blocks.length > 0 ? blocks : <p className="muted">No preview</p>;
}

function isTableStart(lines: string[], index: number): boolean {
  const header = lines[index];
  const separator = lines[index + 1];
  return (
    !!header?.includes("|") &&
    !!separator?.includes("|") &&
    /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(separator)
  );
}

function readTable(
  lines: string[],
  startIndex: number
): {
  headers: string[];
  rows: string[][];
  nextIndex: number;
} {
  const headers = splitTableRow(lines[startIndex]);
  const rows: string[][] = [];
  let index = startIndex + 2;
  while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
    rows.push(splitTableRow(lines[index]));
    index += 1;
  }

  return { headers, rows, nextIndex: index };
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const tokenPattern = /(!?\[[^\]]+\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let lastIndex = 0;

  for (const match of text.matchAll(tokenPattern)) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const token = match[0];
    const key = `${token}-${match.index}`;
    const image = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(token);
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
    if (image) {
      nodes.push(<img key={key} src={image[2]} alt={image[1]} />);
    } else if (link) {
      nodes.push(
        <a key={key} href={link[2]} target="_blank" rel="noreferrer">
          {link[1]}
        </a>
      );
    } else if (token.startsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}
