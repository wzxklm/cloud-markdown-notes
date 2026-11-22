import { useEffect, useState } from "react";
import skill from "../../docs/skills/cloud-notes-cli/SKILL.md?raw";
import mcp from "../../docs/connect-notes-mcp.md?raw";
import { MarkdownPreview } from "./MarkdownPreview";

export function HomeGuides() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const sync = () => setHash(window.location.hash);
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  useEffect(() => {
    if (["#guides", "#cli-guide", "#mcp-guide"].includes(hash)) {
      document.getElementById(hash.slice(1))?.scrollIntoView();
    }
  }, [hash]);

  return (
    <section id="guides" className="home-guides" aria-labelledby="guides-title">
      <h2 id="guides-title">Usage guides</h2>
      <article id="cli-guide">
        <h3><a href="#cli-guide">Use the Notes CLI with AI</a></h3>
        {hash === "#cli-guide" && <>
          <p>Install the CLI with <code>npm install -g cloud-markdown-notes</code> (Node.js 18+).
            Configure it with <code>notes config set-api-url https://notes.bosschat.de</code>.
            For Codex, save <a href="/guides/SKILL.md" download="SKILL.md">the complete SKILL.md</a> in <code>~/.codex/skills/cloud-notes-cli/</code>.</p>
          <MarkdownPreview content={skill.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, "").replace(/^# Cloud Notes CLI\s*/, "")} />
        </>}
      </article>
      <article id="mcp-guide">
        <h3><a href="#mcp-guide">Connect Notes to an MCP client</a></h3>
        {hash === "#mcp-guide" && <MarkdownPreview content={mcp} />}
      </article>
    </section>
  );
}
