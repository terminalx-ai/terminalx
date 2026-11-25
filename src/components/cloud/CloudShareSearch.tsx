import { useEffect, useState } from "react";
import { Search } from "@/icons";
import { Button } from "@/components/ui/button";
import { api, type CloudGroupPage } from "@/lib/api";
import { groupDetail, shareRowKey, type ShareRow } from "@/lib/cloudShareDraft";

type SearchProps = {
  orgId: string;
  organization: string;
  contextRevision: string;
  people: ShareRow[];
  shared: Set<string>;
  disabled: boolean;
  canRequest: () => boolean;
  onSelect: (row: ShareRow) => void;
};

export function CloudShareSearch({ orgId, organization, contextRevision, people, shared, disabled, canRequest, onSelect }: SearchProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const needle = query.trim().toLowerCase();
  const matchingPeople = people.filter((person) =>
    person.name.toLowerCase().includes(needle) || person.detail?.toLowerCase().includes(needle));
  const label = `Add people or groups from ${organization}`;

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label className="flex min-w-0 items-center gap-2 rounded-md border border-hairline px-3 py-2 focus-within:border-ring">
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <input type="search" className="min-w-0 flex-1 bg-transparent text-sm outline-none" aria-label={label}
          placeholder={label} maxLength={120} value={query} disabled={disabled}
          onFocus={() => setOpen(true)} onChange={(event) => { setQuery(event.target.value); setOpen(true); }} />
      </label>
      {open && !disabled && <SearchResults key={query} {...{ query, orgId, organization, contextRevision, shared, canRequest }} people={matchingPeople}
        onSelect={(row) => { onSelect(row); setQuery(""); setOpen(false); }} />}
    </div>
  );
}

function SearchResults({ query, orgId, organization, contextRevision, people, shared, canRequest, onSelect }:
  Omit<SearchProps, "disabled"> & { query: string }) {
  const [page, setPage] = useState<CloudGroupPage>();
  const [failed, setFailed] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let current = true;
    const timer = window.setTimeout(async () => {
      if (!canRequest()) return;
      try {
        const next = await api.cloudWorkspaceGroups(orgId, query, cursor, contextRevision);
        if (current && canRequest()) setPage((previous) => ({
          nextCursor: next.nextCursor,
          groups: cursor && previous
            ? [...previous.groups, ...next.groups.filter(({ id }) => !previous.groups.some((group) => group.id === id))]
            : next.groups,
        }));
      } catch {
        if (current) setFailed(true);
      } finally {
        if (current) setLoading(false);
      }
    }, cursor ? 0 : 160);
    return () => { current = false; window.clearTimeout(timer); };
  }, [orgId, contextRevision, query, cursor, attempt, canRequest]);

  const groups = (page?.groups ?? []).map((group): ShareRow => ({
    subject: { type: "group", id: group.id },
    name: group.name,
    detail: groupDetail(group.memberCount),
    role: "viewer",
    canApprove: false,
  }));
  const matches = [...people, ...groups];
  return (
    <div className="max-h-48 overflow-y-auto rounded-md border border-hairline" role="region" aria-label="People and groups matching the search">
      {matches.length > 0 && <ul className="divide-y divide-hairline">
        {matches.map((row) => {
          const added = shared.has(shareRowKey(row));
          return <li key={shareRowKey(row)}>
            <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-well focus-visible:bg-well disabled:text-muted-foreground" disabled={added} onClick={() => onSelect(row)}>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{row.name}</span>
                {row.detail && <span className="block truncate text-muted-foreground">{row.detail}</span>}
              </span>
              {added && <span>Already added</span>}
            </button>
          </li>;
        })}
      </ul>}
      {loading && <p className="px-3 py-2 text-muted-foreground" role="status">Searching groups…</p>}
      {failed && <div className="flex items-center justify-between gap-2 px-3 py-2" role="alert">
        Could not load groups.
        <Button size="sm" variant="outline" onClick={() => { setFailed(false); setLoading(true); setAttempt((count) => count + 1); }}>Retry search</Button>
      </div>}
      {!loading && !failed && page?.nextCursor && <Button size="sm" variant="ghost" className="m-1" onClick={() => { setLoading(true); setCursor(page.nextCursor); }}>More groups</Button>}
      {!loading && !failed && matches.length === 0 && <p className="px-3 py-2 text-muted-foreground">
        No one matches the search. You can add members and groups of {organization}.
      </p>}
    </div>
  );
}
