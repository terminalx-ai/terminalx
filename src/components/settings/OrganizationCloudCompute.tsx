import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export const CLOUD_COMPUTE_TABS = [
  { id: "providers", label: "Providers" },
  { id: "limits", label: "Limits" },
] as const;
export type CloudComputeTab = (typeof CLOUD_COMPUTE_TABS)[number]["id"];

/**
 * An organization's Cloud compute page (PRO-391): its providers and limits
 * as tabs of one section, as the design draws them. Its environment and
 * agent logins have pages of their own in the Settings menu (PRO-464).
 *
 * Every tab stays mounted while hidden, so an unsaved template or limit
 * survives a switch. A settings link or search result opens the tab that
 * holds the row it names: Settings marks that row (data-setting-highlight),
 * which shows its tab before Settings scrolls and focuses the row.
 */
export function OrganizationCloudCompute({ organizationName, panels, initialTab = "providers" }: {
  organizationName: string;
  panels: Record<CloudComputeTab, ReactNode>;
  initialTab?: CloudComputeTab;
}) {
  const [tab, setTab] = useState<CloudComputeTab>(initialTab);
  const root = useRef<HTMLDivElement>(null);
  const tabs = useRef<Partial<Record<CloudComputeTab, HTMLButtonElement | null>>>({});

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const follow = (target: Element) => {
      const panel = target.closest<HTMLElement>("[data-cloud-compute-panel]");
      if (!panel || !element.contains(panel)) return;
      const id = panel.dataset.cloudComputePanel as CloudComputeTab;
      setTab(id);

    };
    const marked = element.querySelector("[data-setting-highlight]");
    if (marked) follow(marked);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.target instanceof Element && record.target.getAttribute("data-setting-highlight") === "on") follow(record.target);
      }
    });
    observer.observe(element, { subtree: true, attributes: true, attributeFilter: ["data-setting-highlight"] });
    return () => observer.disconnect();
  }, []);

  const move = (offset: number) => {
    const index = CLOUD_COMPUTE_TABS.findIndex((candidate) => candidate.id === tab);
    const next = CLOUD_COMPUTE_TABS[(index + offset + CLOUD_COMPUTE_TABS.length) % CLOUD_COMPUTE_TABS.length].id;
    setTab(next);
    tabs.current[next]?.focus();
  };

  return (
    <section ref={root} className="flex flex-col gap-4" aria-label="Cloud compute" data-testid="organization-cloud-compute">
      {/* The page is titled Cloud compute; this says what it holds. */}
      <p className="text-xs text-muted-foreground">Where {organizationName}'s cloud workspaces run, and how many can run.</p>
      <div
        role="tablist"
        aria-label="Cloud compute"
        className="-mt-1 flex min-w-0 items-center overflow-x-auto border-b border-hairline"
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") move(1);
          else if (event.key === "ArrowLeft") move(-1);
          else return;
          event.preventDefault();
        }}
      >
        {CLOUD_COMPUTE_TABS.map((candidate) => {
          const selected = candidate.id === tab;
          return (
            <button
              key={candidate.id}
              ref={(button) => {
                tabs.current[candidate.id] = button;
              }}
              type="button"
              role="tab"
              id={`cloud-compute-tab-${candidate.id}`}
              aria-selected={selected}
              aria-controls={`cloud-compute-panel-${candidate.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setTab(candidate.id)}
              className={cn(
                "mr-5 flex h-9 shrink-0 items-center whitespace-nowrap border-b-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                selected ? "border-accent font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {candidate.label}
            </button>
          );
        })}
      </div>
      {CLOUD_COMPUTE_TABS.map((candidate) => (
        <div
          key={candidate.id}
          role="tabpanel"
          id={`cloud-compute-panel-${candidate.id}`}
          aria-labelledby={`cloud-compute-tab-${candidate.id}`}
          data-cloud-compute-panel={candidate.id}
          hidden={candidate.id !== tab}
          className={candidate.id === tab ? "flex flex-col gap-4" : "hidden"}
        >
          {panels[candidate.id]}
        </div>
      ))}
    </section>
  );
}
