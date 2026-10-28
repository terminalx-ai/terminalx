# Pinned terminal dependency patch

`@xterm__addon-webgl@0.19.0.patch` fixes the reproduced last-owner warm-up
cancellation defect in @xterm/addon-webgl 0.19.0 (package commit
f447274f430fd22513f6adbf9862d19524471c04).

TextureAtlas owns one IdleTaskQueue and clears it before disposing its canvases.
The existing shared-atlas cache still chooses when the last owner releases the
atlas; nonlast-owner release does not cancel warm-up. The queue is reused after
clearTexture/warmUp cycles so disposal owns all pending warm-up callbacks, not
only the most recently created queue. Live glyph generation is unchanged.

The patch includes TypeScript source AND both published runtime entries:
package.json `main` is lib/addon-webgl.js, `module` is lib/addon-webgl.mjs.
Source-only edits would not fix the shipped app. The minified runtime edits are
literal counterparts of the source change, not a runtime monkeypatch. Removed
sourceMappingURL directives prevent the unchanged upstream maps from providing
incorrect generated positions; original map files remain in the package but
are not advertised by these patched entries. A rebuilt matching source map is
not supplied. License notices remain intact.

pnpm-workspace.yaml selects this exact version; pnpm-lock.yaml binds the patch
SHA256 and patched importer/snapshot. patch-manifest.json pins original and
expected installed bytes. A private frozen offline install and all three output
hashes were verified on 2026-10-27. Verify BOTH runtime hashes before interpreting
the unchanged real-addon focused regression:

    pnpm vitest run src/lib/terminalWebgl.real.test.ts -t 'atlas held-idle lifecycle' --reporter=verbose --maxWorkers=1 --no-file-parallelism

Do not convert cancellation failures to expected failures or bypass inconclusive
reachability guards. The original six-case run produced4 pass/2 failures with
93 raster calls after disposal in each failing case. The patched six-case run
passed all six selected cases (seven unrelated cases excluded by the filter).
Full project checks remain outstanding. No native memory reduction or acceptance
follows from this patch.
