# Zeron and TerminalX comparison video

[Play or download the video](comparison.mp4) — **9 minutes 2 seconds**, a narrated, chaptered walkthrough with 1600 × 1000 H.264 video, AAC audio and English captions at 25 fps. Enable English subtitles in a player that supports MP4 subtitle tracks; the [separate SRT](captions.srt) works with players that need a sidecar file.

The video combines actual footage and screenshots from both fresh Lume installations with editorial explanation. TerminalX was tested through the guest's Cua service in the background without host desktop input. Both apps used Codex 0.164.0 without provider credentials. Observed behavior, source-confirmed capabilities and recommendations have distinct labels. Narration uses macOS's synthetic Samantha voice, generated locally.

- [Full transcript](transcript.md)
- [Chapter timings and evidence labels](chapters.json)
- [Comparison report](../README.md)
- [Improvement backlog](../improvements.md)
- [Original screenshot and clip provenance](../evidence.md)

The 23 chapters cover methodology, onboarding, agent installation, launch controls, worktree creation, authentication failures, the real agent terminal, files/editing/diffs, browser navigation, attention, settings, screen-context capture, providers, desktop-process recovery, TerminalX's workflow strengths and prioritized improvements. The final chapter states the coverage limits.

Neither product completed authenticated coding. Cloud/sync, voice, Appshots capture and production updating were not exercised. Different capture geometry and TerminalX's Dev build preclude a controlled density or performance ranking. Runtime/process survival is distinguished from restoration of browser tabs and shell scrollback.

## Rebuild

Requirements: macOS with the Samantha voice and Arial font, Python 3 with Pillow, and FFmpeg/ffprobe with libx264, AAC and mov_text support. No network service or provider account is used by the renderer.

From the repository root:

```sh
python3 docs/research/zeron-comparison/video/render.py \
  --work-dir /tmp/zeron-comparison-render
```

The renderer reads [storyboard.json](storyboard.json), the committed screenshots and four cropped source clips. It regenerates the MP4, SRT, chapter JSON and transcript. Intermediate narration and scene files stay in the work directory. Timings can vary with the installed voice version; captions and chapters are calculated from the newly generated audio.

Both full ten-minute source recordings remain in the local working directory named in the evidence ledger. They are not required to rebuild this edit. The committed excerpts preserve observed action timing; longer narration holds the last frame. Screenshots are cropped and scaled for readability, and title cards are editorial graphics rather than reconstructed application UI. The TerminalX excerpt begins after the operator installed Codex and does not depict an in-app installer.
