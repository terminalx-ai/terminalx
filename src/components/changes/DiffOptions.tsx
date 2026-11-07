import { useDiffOptions } from "@/lib/diffOptions";
import { setPrefs } from "@/lib/prefs";
import { Button } from "@/components/ui/button";

/** Global defaults shared by turn, workspace and commit comparisons. */
export function DiffOptions() {
  const { mode, hideWhitespace, defaultWrap } = useDiffOptions();
  return <div aria-label="Diff options" role="group" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-hairline px-3 py-2 text-xs">
    <label className="flex items-center gap-1"><input type="checkbox" checked={hideWhitespace} onChange={(e) => setPrefs({ diffHideWhitespace: e.target.checked })} />Hide whitespace changes</label>
    <label className="flex items-center gap-1"><input type="checkbox" checked={defaultWrap} onChange={(e) => setPrefs({ diffWrap: e.target.checked })} />Wrap lines by default</label>
    <div className="ml-auto flex gap-1">
      <Button size="xs" variant={mode === "unified" ? "secondary" : "ghost"} aria-pressed={mode === "unified"} onClick={() => setPrefs({ diffMode: "unified" })}>Unified</Button>
      <Button size="xs" variant={mode === "split" ? "secondary" : "ghost"} aria-pressed={mode === "split"} onClick={() => setPrefs({ diffMode: "split" })}>Split</Button>
    </div>
  </div>;
}
