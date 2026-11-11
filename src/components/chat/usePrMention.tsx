import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { errorMessage, gh } from "@/lib/api";
import { tokenAtCaret } from "@/lib/pickers";
import { usePrSearch } from "@/lib/usePrSearch";
import { PickerMenu, type PickerItem } from "./PickerMenu";

/** PR context is fetched before replacing the token; late answers never overwrite a newer draft. */
export function usePrMention(
  cwd: string | null,
  draft: string,
  caret: number,
  onChange: (text: string) => void,
  field: RefObject<HTMLTextAreaElement | null>,
  onCaret: (caret: number) => void,
  { inline = false }: { inline?: boolean } = {},
) {
  const token = tokenAtCaret(draft, caret);
  const key = cwd && token?.kind === "pr" ? JSON.stringify([cwd, token.start, token.query]) : null;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [selection, setSelection] = useState({ key: "", row: 0 });
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [attaching, setAttaching] = useState(false);
  const pending = useRef(false);
  const operation = useRef(0);
  useEffect(() => {
    setDismissed(null);
  }, [key]);
  useEffect(() => {
    // An attachment belongs to the draft and project that selected it.
    operation.current++;
    pending.current = false;
    setAttaching(false);
  }, [draft, cwd]);
  useEffect(
    () => () => {
      operation.current++;
    },
    [],
  );
  const current = useRef({ draft, cwd });
  current.current = { draft, cwd };
  const open = key !== null && key !== dismissed;
  const result = usePrSearch(open ? cwd : null, token?.kind === "pr" ? token.query : null);
  const items = result.items.map((pr) => ({ id: String(pr.number), label: `#${pr.number} ${pr.title}`, detail: `${pr.author} · ${pr.state.toLowerCase()}` }));
  const highlighted = selection.key === key ? Math.min(selection.row, Math.max(items.length - 1, 0)) : 0;
  const highlight = (row: number) => setSelection({ key: key ?? "", row });
  const pick = async (item: PickerItem) => {
    if (!cwd || !token || !key || pending.current) return;
    const request = ++operation.current;
    pending.current = true;
    setAttaching(true);
    setFailure(null);
    try {
      const path = await gh.attach(cwd, Number(item.id));
      if (operation.current !== request || current.current.draft !== draft || current.current.cwd !== cwd) return;
      const replacement = `@${/\s/.test(path) ? JSON.stringify(path) : path} `;
      const next = draft.slice(0, token.start) + replacement + draft.slice(caret);
      onChange(next);
      const pos = token.start + replacement.length;
      onCaret(pos);
      requestAnimationFrame(() => {
        field.current?.focus({ preventScroll: true });
        field.current?.setSelectionRange(pos, pos);
      });
    } catch (error) {
      if (operation.current === request) setFailure({ key, message: errorMessage(error) });
    } finally {
      if (operation.current === request) {
        pending.current = false;
        setAttaching(false);
      }
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || event.nativeEvent.isComposing) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      operation.current++;
      pending.current = false;
      setAttaching(false);
      setDismissed(key);
      return true;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (items.length) highlight((highlighted + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
      return true;
    }
    const item = attaching ? undefined : items[highlighted];
    if (item && (event.key === "Enter" || event.key === "Tab") && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      void pick(item);
      return true;
    }
    return false;
  };
  return {
    open,
    attaching: attaching && open,
    onKeyDown,
    menu: open ? (
      <PickerMenu
        inline={inline}
        items={attaching ? [] : items}
        highlighted={highlighted}
        onHover={highlight}
        onPick={(item) => void pick(item)}
        title="Pull requests"
        empty={attaching ? "Attaching pull request…" : result.loading ? "Searching pull requests…" : "No matching pull requests"}
        note={failure?.key === key ? failure.message : result.error}
      />
    ) : null,
  };
}
