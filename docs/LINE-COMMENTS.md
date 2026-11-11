# Shared line comments

PRO-230, pipeline reviewers (PRO-237), and GitHub threads (PRO-234) share
`store::review_comments::{Comment, Anchor, Author, Action, apply}` and the
`review_comments` Tauri command. Do not create a second store or draft formatter.
The frontend types, `ReviewCommentCard`, and `reviewEntry`/`reviewDraft` are in
`src/lib/reviewComments.ts` and `src/components/changes/ReviewComments.tsx`.

For local workspaces, every Rust caller must use `workspace_key(&cwd)`; this is
`local:<canonical absolute cwd>`. The desktop command canonicalizes the same
key. Cloud keys are the GitSource key including its repository identity.
The file is `<store root>/review-comments/<sha256(key)>.json`:

```json
{
  "version": 1,
  "comments": [{
    "id": "uuid-v7", "revision": 1,
    "path": "src/new.ts", "originalPath": "src/old.ts",
    "base": "full Git object ID of the comparison base",
    "side": "before", "startLine": 10, "endLine": 11,
    "lineText": "first quoted line\nsecond quoted line",
    "contextBefore": ["up to three preceding lines"],
    "contextAfter": ["up to three following lines"],
    "textHash": "sha256 of UTF-8 lineText",
    "anchorHash": "sha256 of compact JSON [contextBefore,lineText,contextAfter]",
    "author": {"kind": "agent", "sessionId": "session", "tabId": "tab", "name": "Reviewer"},
    "createdAt": "RFC3339 timestamp",
    "note": "Requested change", "sent": false, "outdated": false
  }]
}
```

`author.kind` is `user` (default), `agent`, or `github`. GitHub authors may include
`login`; agent authors may include `sessionId`, `tabId`, and `name`. Author,
comment and document extension fields survive store writes, so GitHub thread
identity and resolution metadata can be added without losing data. Legacy bare
comment arrays remain readable and migrate on the next mutation.

Create with `Action::Save { anchor: Box<Anchor>, note, expected: None, author }`.
The store supplies ID, hashes and creation time. Line numbers are one-based and
inclusive; quotation and context use LF endings. `base` is required on both
sides. `originalPath` is the rename source. Never use an empty base or HEAD as a
moving symbolic ref. Existing unanchored legacy comments stay in the inventory.

Editing/deleting uses `expected: {id, revision}`. Edits retain anchor, author,
creation time and extension fields, advance revision and clear Sent. Mark Sent
only after the chat send succeeds, with the captured revision. Reconcile takes
path, base, full before/after content (null means absent), and expected revisions.
It skips other bases and stale revisions. Exact quotation matches relocate the
range; exact context disambiguates duplicates. Ambiguous matches stay unplaced,
not Outdated. Only absent text is Outdated; restored text clears that status.
Inline rendering independently resolves against the displayed content, and only
for the saved base/path/rename identity. Never place an unmatched note at its old
line number or at the end of the file.

All mutation/read transactions use the stable store-root `review-comments.lock`.
After successful worktree deletion, `remove_workspace` removes that workspace's
JSON and legacy sidecar. Late writes to a deleted local workspace fail rather
than recreating its notes. The root lock remains for other workspaces.
