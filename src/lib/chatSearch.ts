import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { remarkCodexFileCitations } from "./codexCitations";
import { callTarget, type Transcript, type Turn } from "./transcript";
import { codexFileCitationLabel, codexFileCitationParts } from "@terminalx/portable/codexCitations";

export interface ChatSearchOptions {
  matchCase: boolean;
  includeToolOutput: boolean;
}

export interface SearchSection {
  id: string;
  turnKey: string;
  text: string;
  tool: boolean;
  /** Disclosure names, qualified by turn, to reveal while this result is selected. */
  disclosures: string[];
}

export interface ChatMatch {
  section: SearchSection;
  /** Occurrence within this section, in reading order. */
  occurrence: number;
  from: number;
  to: number;
}

/** Bound allocations for very broad queries in multi-megabyte tool logs, as the file finder does. */
export const MAX_CHAT_MATCHES = 10_000;

export const searchId = (turn: string, part: string) => `chat-find:${encodeURIComponent(turn)}:${encodeURIComponent(part)}`;
// Join materializes normalized text while building the index. Repeated replace
// can leave a chain of string fragments whose first search pays to flatten it.
export const searchText = (text: string) => text.split(/\s+/).join(" ");

const markdown = unified().use(remarkParse).use(remarkGfm).use(remarkCodexFileCitations);
interface TextNode { type: string; value?: string; children?: TextNode[] }

/** Search the words Markdown draws, including code, without counting link destinations or formatting. */
export function markdownSearchText(source: string): string {
  const read = (node: TextNode): string => {
    if (["text", "code", "inlineCode"].includes(node.type)) return node.value ?? "";
    if (node.type === "break") return " ";
    const inline = ["paragraph", "heading", "emphasis", "strong", "delete", "link", "linkReference"].includes(node.type);
    return node.children?.map(read).join(inline ? "" : " ") ?? "";
  };
  return searchText(read(markdown.parse(source)));
}

/** Turn identities are stable while streaming (#727); old turns are parsed only once. */
export function createChatSearchIndex() {
  const cached = new WeakMap<Turn, SearchSection[]>();
  return (transcript: Transcript): SearchSection[] => transcript.turns.flatMap((turn) => {
    const previous = cached.get(turn);
    if (previous) return previous;
    const sections: SearchSection[] = [];
    const add = (part: string, text: string | undefined, tool = false, disclosures: string[] = [], prose = false) => {
      if (!text) return;
      sections.push({ id: searchId(turn.key, part), turnKey: turn.key, text: prose ? markdownSearchText(text) : searchText(text), tool, disclosures: disclosures.map((name) => `${turn.key}/${name}`) });
    };
    if (turn.prompt) add(`message:${turn.prompt.seq}`, turn.prompt.text);
    for (const item of turn.work) {
      switch (item.kind) {
        case "text": add(item.key, item.text, false, [], true); break;
        case "reasoning": add(item.key, item.text, false, ["fold", item.key]); break;
        case "message":
        case "queued": add(`message:${item.seq}`, item.text); break;
        case "error":
          add(item.key, item.text, false, ["fold"]);
          add(`${item.key}:detail`, item.detail, false, ["fold"]);
          break;
        case "tool":
        case "tool_group": {
          const calls = item.kind === "tool" ? [item.call] : item.calls;
          for (const call of calls) {
            const reveal = ["fold", ...(item.kind === "tool_group" ? [`group:${calls[0].callId}`] : []), `call:${call.callId}`];
            if (call.name === "Bash" || call.name === "shell") add(`command:${call.callId}`, callTarget(call) ?? "", true, reveal);
            add(`output:${call.callId}`, call.result?.text, true, reveal);
          }
          break;
        }
      }
    }
    if (turn.completed && turn.completed.status !== "ok" && turn.finalText) {
      add("failure", codexFileCitationParts(turn.finalText).map((part) => part.citation ? codexFileCitationLabel(part.citation) : part.text).join(""));
      add("failure-detail", turn.detail);
    }
    cached.set(turn, sections);
    return sections;
  });
}

/** A literal expression, never a user-supplied regex. Unicode folding keeps source offsets intact. */
export function searchExpression(query: string, matchCase: boolean): RegExp | null {
  if (!query.trim()) return null;
  return new RegExp(searchText(query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), matchCase ? "gu" : "giu");
}

export function searchTranscript(sections: SearchSection[], query: string, options: ChatSearchOptions): ChatMatch[] {
  const expression = searchExpression(query, options.matchCase);
  if (!expression) return [];
  const matches: ChatMatch[] = [];
  for (const section of sections) {
    if (section.tool && !options.includeToolOutput) continue;
    let occurrence = 0;
    for (const match of section.text.matchAll(expression)) {
      matches.push({ section, occurrence: occurrence++, from: match.index, to: match.index + match[0].length });
      if (matches.length === MAX_CHAT_MATCHES) return matches;
    }
  }
  return matches;
}
