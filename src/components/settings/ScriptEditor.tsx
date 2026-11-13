import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Shell words coloured like the design's script blocks: the command, builtins, strings, variables and comments. */
const BUILTINS = new Set(["set", "export", "cd", "if", "then", "else", "elif", "fi", "for", "do", "done", "while", "case", "esac", "in", "exit", "return", "local", "source", "function", "trap", "unset"]);

type Token = { text: string; kind: "command" | "builtin" | "string" | "variable" | "comment" | "plain" };

export function shellTokens(line: string): Token[] {
  const tokens: Token[] = [];
  const push = (text: string, kind: Token["kind"]) => { if (text) tokens.push({ text, kind }); };
  let commandPending = true;
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) { push(line.slice(i), "comment"); break; }
    if (c === "'" || c === '"') {
      let end = i + 1;
      while (end < line.length && line[end] !== c) end += line[end] === "\\" && c === '"' ? 2 : 1;
      push(line.slice(i, Math.min(end + 1, line.length)), "string");
      i = end + 1;
      commandPending = false;
      continue;
    }
    if (c === "$") {
      const match = /^\$(\{[^}]*\}?|[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])?/.exec(line.slice(i))!;
      push(match[0], "variable");
      i += match[0].length;
      commandPending = false;
      continue;
    }
    if (/\s/.test(c)) {
      const match = /^\s+/.exec(line.slice(i))!;
      push(match[0], "plain");
      i += match[0].length;
      continue;
    }
    if (";|&()".includes(c)) { push(c, "plain"); i++; commandPending = true; continue; }
    const match = /^[^\s'"$;|&()]+/.exec(line.slice(i))!;
    const word = match[0];
    const assignment = commandPending && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
    push(word, commandPending && !assignment && !word.startsWith("#!") ? (BUILTINS.has(word) ? "builtin" : "command") : "plain");
    if (!assignment && !BUILTINS.has(word)) commandPending = false;
    else if (BUILTINS.has(word) && !["then", "do", "else", "elif", "if", "while", "!"].includes(word)) commandPending = false;
    i += word.length;
  }
  return tokens;
}

const COLOURS: Record<Token["kind"], string> = {
  command: "text-warning",
  builtin: "text-thinking",
  string: "text-add",
  variable: "text-add",
  comment: "text-faint italic",
  plain: "",
};

function highlight(line: string): ReactNode {
  return shellTokens(line).map((token, index) => token.kind === "plain" ? <Fragment key={index}>{token.text}</Fragment> : <span key={index} className={COLOURS[token.kind]}>{token.text}</span>);
}

/**
 * A script field: a real textarea laid over a coloured copy with line numbers. Both columns wrap the same way, so a
 * long line keeps its number beside it. Read-only fields stay selectable and focusable.
 */
export function ScriptEditor({ label, value, onChange, readOnly, disabled, placeholder }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  disabled?: boolean;
  placeholder?: string;
}) {
  const lines = value.split("\n");
  const text = "whitespace-pre-wrap break-all font-mono text-xs leading-5";
  return (
    <div className="relative py-2.5">
      {/* Each row carries its number, so a wrapped line keeps it; the textarea covers only the code column. */}
      <div aria-hidden className="pointer-events-none">
        {lines.map((line, index) => (
          <div key={index} className="flex" data-script-line={index + 1}>
            <span className="w-10 shrink-0 select-none pr-3 text-right font-mono text-xs leading-5 text-faint tabular-nums">{index + 1}</span>
            <span className={cn(text, "min-w-0 flex-1 pr-3")}>{line ? highlight(line) : "\u200b"}</span>
          </div>
        ))}
      </div>
      {!value && placeholder && <div aria-hidden className={cn(text, "pointer-events-none absolute left-10 right-3 top-2.5 text-faint")}>{placeholder}</div>}
      <textarea
        aria-label={label}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        readOnly={readOnly}
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn(text, "absolute bottom-2.5 left-10 right-0 top-2.5 resize-none overflow-hidden bg-transparent pr-3 text-transparent caret-foreground outline-none selection:bg-(--selection) disabled:cursor-not-allowed")}
      />
    </div>
  );
}
