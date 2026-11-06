import { useState } from "react";
import { Cloud } from "@/icons";
import { setComputerColor, useAccount } from "@/lib/account";
import { COMPUTER_COLORS, computerColor } from "@/lib/computerColor";
import { errorMessage } from "@/lib/api";

export function ComputerColorPicker({ organizationId, name }: { organizationId: string; name: string }) {
  const { status } = useAccount();
  const saved = status.organizations?.find((org) => org.id === organizationId)?.computerColor ?? "blue";
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selected = pending ?? saved;
  return <section className="space-y-3 rounded-lg border border-hairline p-4" aria-label="Computer color">
    <p className="text-sm font-medium">Choose a color for your cloud computer</p>
    <div className="flex gap-3" role="group" aria-label="Colors">
      {COMPUTER_COLORS.map((color) => <button key={color.id} type="button" aria-label={color.label} aria-pressed={selected === color.id} disabled={pending !== null}
        className="size-8 rounded-full border-2 border-transparent outline-offset-4 aria-pressed:border-foreground focus-visible:outline-2 disabled:cursor-wait"
        style={{ backgroundColor: color.value }} onClick={() => {
          setPending(color.id); setError(null);
          void setComputerColor(organizationId, color.id).catch((failure) => setError(errorMessage(failure))).finally(() => setPending(null));
        }} />)}
    </div>
    <div className="flex items-center gap-2 rounded-md bg-well p-3 text-sm" data-testid="computer-color-preview"><Cloud style={{ color: computerColor(selected) }} /> {name}</div>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </section>;
}
