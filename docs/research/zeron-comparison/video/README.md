# Interim comparison video

[Play or download the video](comparison-interim.mp4) — 5 minutes 50 seconds, 1600 × 1000, H.264/AAC, 25 fps. Enable English captions in a player that supports MP4 subtitle tracks; the [separate SRT](captions.srt) works with players that need a sidecar file.

This is an **interim evidence review**. It combines actual Zeron VM footage and screenshots with editorial explanation. TerminalX sections describe its verified fresh installation and source-confirmed features; they do not depict a completed TerminalX UI walkthrough. The last chapter explains the remaining work. Narration uses macOS's synthetic Samantha voice, generated locally.

- [Full transcript](transcript.md)
- [Chapter timings and evidence labels](chapters.json)
- [Comparison report](../README.md)
- [Improvement backlog](../improvements.md)
- [Original screenshot and clip provenance](../evidence.md)

The video moves through onboarding, agent installation, launch controls, worktrees and the signed-out failure, diffs, browser, Appshots setup, provider breadth, TerminalX's installation and strengths, and the proposed improvements. Successful inference, cloud/sync, voice and Appshots capture were not tested.

## Rebuild

Requirements: macOS with the Samantha voice and Arial font, Python 3 with Pillow, and FFmpeg/ffprobe with libx264, AAC and mov_text support. No network service or provider account is used by the renderer.

From the repository root:

```sh
python3 docs/research/zeron-comparison/video/render.py \
  --work-dir /tmp/zeron-comparison-render
```

The renderer reads [storyboard.json](storyboard.json), the committed screenshots and the three cropped clips. It regenerates the MP4, SRT, chapter JSON and transcript. Its intermediate narration and scene files stay in the work directory. Timings can vary with the installed voice version; captions and chapters are calculated from the newly generated audio.

The full ten-minute source recording remains in the local working directory named in the evidence ledger. It is not required to rebuild this edit. The committed excerpts preserve observed action timing; longer narration holds the last frame. Screenshots are cropped and scaled for readability, and title cards are editorial graphics rather than reconstructed application UI.
