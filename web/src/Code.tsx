import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { memo, useMemo, useState } from "react";
import { copyText } from "./api";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("java", java);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("python", python);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

const EXT: Record<string, string> = {
  py: "python", java: "java", sh: "bash", bash: "bash", json: "json", md: "markdown", xml: "xml", html: "xml",
  yaml: "yaml", yml: "yaml", ini: "ini", cfg: "ini", toml: "ini", c: "cpp", cc: "cpp", cpp: "cpp", h: "cpp",
  hpp: "cpp", geo: "cpp", inp: "ini", m: "cpp",
};

export function langFromPath(path?: string): string | undefined {
  if (!path) return undefined;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXT[ext];
}

export const Code = memo(function Code({ code, lang, maxLines, className = "", wrap = false }:
  { code: string; lang?: string; maxLines?: number; className?: string; wrap?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const lines = code.split("\n");
  const limited = !!maxLines && !expanded && lines.length > maxLines;
  const shown = limited ? lines.slice(0, maxLines).join("\n") : code;
  const html = useMemo(() => {
    if (shown.length > 200_000) return null;
    try {
      if (lang && hljs.getLanguage(lang)) return hljs.highlight(shown, { language: lang, ignoreIllegals: true }).value;
    } catch { /* fall through */ }
    return null;
  }, [shown, lang]);
  return (
    <div className={`code ${className}`}>
      <button className="code-copy" title="複製"
              onClick={async () => { if (await copyText(code)) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }}>{copied ? "已複製 ✓" : "複製"}</button>
      {html !== null
        ? <pre className={wrap ? "wrap" : ""}><code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /></pre>
        : <pre className={wrap ? "wrap" : ""}><code>{shown}</code></pre>}
      {limited && <button className="code-more" onClick={() => setExpanded(true)}>顯示全部 {lines.length} 行</button>}
    </div>
  );
});

export function Terminal({ command, output, exitCode, maxLines = 14, commandMaxLines = 0 }:
  { command?: string; output?: string; exitCode?: number | string | null; maxLines?: number; commandMaxLines?: number }) {
  const [expanded, setExpanded] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const cmdLines = (command ?? "").split("\n");
  const cmdCut = !!commandMaxLines && !cmdOpen && cmdLines.length > commandMaxLines;
  const cmdShown = cmdCut ? cmdLines.slice(0, commandMaxLines).join("\n") : command;
  const lines = (output ?? "").split("\n");
  const cut = !expanded && lines.length > maxLines;
  const shown = cut ? lines.slice(-maxLines).join("\n") : output ?? "";
  const ok = exitCode === undefined || exitCode === null || String(exitCode) === "0";
  return (
    <div className="term">
      {command !== undefined && <pre className="term-cmd"><span className="term-prompt">$</span> {cmdShown}</pre>}
      {cmdCut && <button className="term-more" onClick={() => setCmdOpen(true)}>… 指令共 {cmdLines.length} 行，點此展開</button>}
      {output !== undefined && (
        <>
          {cut && <button className="term-more" onClick={() => setExpanded(true)}>… 顯示前面 {lines.length - maxLines} 行</button>}
          <pre className="term-out">{shown || "（沒有輸出）"}</pre>
        </>
      )}
      {exitCode !== undefined && exitCode !== null && (
        <div className={`term-exit ${ok ? "ok" : "bad"}`}>exit {String(exitCode)}</div>
      )}
    </div>
  );
}
