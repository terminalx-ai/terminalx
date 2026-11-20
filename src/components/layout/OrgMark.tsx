/** An organization's mark on its row: its initial on the accent colour (02.04). The sidebar and the Settings menu draw it. */
export function OrgMark({ name }: { name: string }) {
  return (
    <span aria-hidden className="grid size-4 shrink-0 place-items-center rounded-[5px] bg-accent text-[10px] font-bold leading-none text-accent-foreground" data-testid="cloud-org-mark">
      {(name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}
