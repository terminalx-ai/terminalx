import type { KeyboardEvent } from "react";

/** Arrow movement changes focus; only Enter/Space on a destination opens it. */
export function navigateTree(event: KeyboardEvent<HTMLElement>) {
  const target = event.target as HTMLElement;
  if (target.closest("input, textarea, [role=menu]")) return;
  const tree = event.currentTarget;
  const row = target.closest<HTMLElement>('[role="treeitem"]');
  if (!row || !tree.contains(row)) return;
  const rows = [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')].filter((item) => !item.closest("[hidden]"));
  const index = rows.indexOf(row);
  const focus = (item?: HTMLElement) => {
    if (!item) return;
    const destination = item.querySelector<HTMLElement>(':scope > [data-tree-row] button:not([data-tree-toggle])') ?? item;
    destination.focus();
    destination.scrollIntoView?.({ block: "nearest" });
  };
  const toggle = () => row.querySelector<HTMLButtonElement>(":scope > [data-tree-row] [data-tree-toggle]")?.click();
  switch (event.key) {
    case "ArrowDown": focus(rows[Math.min(index + 1, rows.length - 1)]); break;
    case "ArrowUp": focus(rows[Math.max(0, index - 1)]); break;
    case "Home": focus(rows[0]); break;
    case "End": focus(rows[rows.length - 1]); break;
    case "ArrowRight":
      if (row.getAttribute("aria-expanded") === "false") toggle();
      else if (row.contains(rows[index + 1])) focus(rows[index + 1]);
      break;
    case "ArrowLeft":
      if (row.getAttribute("aria-expanded") === "true") toggle();
      else focus(row.parentElement?.closest<HTMLElement>('[role="treeitem"]') ?? undefined);
      break;
    default: return;
  }
  event.preventDefault();
  event.stopPropagation();
}
