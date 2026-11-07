import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";

export function SshSettings() {
  const [path, setPath] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    let live = true;
    void invoke<string>("ssh_private_key_path").then((path) => { if (live) setPath(path); }).catch(() => { if (live) setMessage("Could not read the SSH key setting."); }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, []);
  return <details className="rounded-lg border border-hairline p-3">
    <summary className="cursor-pointer text-sm font-medium">Advanced</summary>
    <form className="mt-3 space-y-2" onSubmit={(event) => {
      event.preventDefault(); setBusy(true); setMessage(null);
      void invoke<string>("ssh_private_key_path", { path: path.trim() }).then(() => setMessage("Saved. Use Enable SSH in a workspace menu to apply it.")).catch(() => setMessage("Use an absolute private key path without SSH expansion characters.")).finally(() => setBusy(false));
    }}>
      <label className="block text-sm" htmlFor="ssh-private-key-path">SSH private key path</label>
      <input id="ssh-private-key-path" className="w-full rounded border border-hairline bg-transparent px-2 py-1 text-sm" value={path} onChange={(e) => setPath(e.target.value)} placeholder="Generate a key per workspace" spellCheck={false} disabled={busy} />
      <p className="text-xs text-muted-foreground">Leave blank to generate a key when you enable SSH. Existing keys and SSH configuration are preserved. Only the public key is registered.</p>
      <Button type="submit" size="sm" disabled={busy}>Save</Button>
      {message && <p role="status" className="text-xs">{message}</p>}
    </form>
  </details>;
}
