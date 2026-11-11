import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { GitSource } from "@/lib/gitSource";
import type { CommitInfo } from "@/types/session";

export function CommitPicker({ source, active, value, onChange }: { source: GitSource; active: boolean; value: string | null; onChange: (sha: string) => void }) {
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [limit, setLimit] = useState(60);
  const [lookup, setLookup] = useState("");
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    void source.logCommits(null, limit).then((next) => {
      if (!cancelled) { setCommits(next); setError(null); }
    }).catch((error) => { if (!cancelled) setError(source.errorMessage(error)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [source, active, limit, retry]);
  return <div className="space-y-1">
    <label className="flex items-center gap-2">Commit
      <select aria-label="Commit to review" className="min-w-0 flex-1 rounded bg-well p-1" value={value ?? ""} onChange={(event) => onChange(event.target.value)}>
        <option value="" disabled>{loading ? "Loading commits…" : "Choose a commit"}</option>
        {value && !commits.some((commit) => commit.sha === value) && <option value={value}>{value.slice(0, 7)}</option>}
        {commits.map((commit) => <option key={commit.sha} value={commit.sha}>{commit.shortSha} · {commit.subject}</option>)}
      </select>
    </label>
    <details>
      <summary className="cursor-pointer text-muted-foreground">Find by commit ID</summary>
      <form className="mt-1 flex gap-2" onSubmit={(event) => {
        event.preventDefault();
        const sha = lookup.trim().toLowerCase();
        if (!/^[a-f0-9]{7,64}$/.test(sha)) { setLookupError("Enter a commit ID with 7–64 hexadecimal characters."); return; }
        setLookupError(null);
        onChange(sha);
      }}>
        <input aria-label="Commit ID" placeholder="Commit ID" className="min-w-0 flex-1 rounded bg-well p-1 font-mono" value={lookup} onChange={(event) => setLookup(event.target.value)} />
        <Button size="xs" variant="secondary" type="submit">Review commit</Button>
      </form>
      {lookupError && <p role="alert">{lookupError}</p>}
    </details>
    {error && <p role="alert">{error} <Button size="xs" variant="ghost" onClick={() => setRetry((value) => value + 1)}>Retry history</Button></p>}
    {!error && !loading && !commits.length && <p>No commits yet.</p>}
    {commits.length >= limit && <Button size="xs" variant="ghost" disabled={loading} onClick={() => setLimit((value) => value + 60)}>Load older commits</Button>}
  </div>;
}
