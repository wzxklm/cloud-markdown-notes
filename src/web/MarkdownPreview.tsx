import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownPreview({ content }: { content: string }) {
  return (
    <div className="markdown-preview">
      {content.trim() ? (
        <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
      ) : (
        <p className="muted">No preview</p>
      )}
    </div>
  );
}
