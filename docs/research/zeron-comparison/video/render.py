#!/usr/bin/env python3
"""Render the evidence video with FFmpeg and macOS's local Samantha voice.

Run from any directory. Inputs are the committed storyboard, screenshots and
cropped source clips. No account, network call, or app UI automation is used.
"""

import argparse
import json
import pathlib
import subprocess
import textwrap

from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent
FONT = "/System/Library/Fonts/Supplemental/Arial.ttf"


def run(args):
    subprocess.run(args, check=True)


def probe(path):
    return json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path),
    ], text=True))


def stamp(seconds):
    millis = round(seconds * 1000)
    hours, millis = divmod(millis, 3_600_000)
    minutes, millis = divmod(millis, 60_000)
    secs, millis = divmod(millis, 1000)
    return f"{hours:02}:{minutes:02}:{secs:02},{millis:03}"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work-dir", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, default=ROOT / "comparison-interim.mp4")
    args = parser.parse_args()
    work = args.work_dir.resolve()
    work.mkdir(parents=True, exist_ok=True)
    if any(c in str(work) for c in "':\\\n"):
        parser.error("Use a work directory without quotes, colons, backslashes or newlines.")
    scenes = json.loads((ROOT / "storyboard.json").read_text())
    subtitles, chapters, transcript, segments = [], [], [], []
    timeline = 0.0
    for index, scene in enumerate(scenes, 1):
        directory = work / f"scene-{index:02}"
        directory.mkdir(exist_ok=True)
        chunks, cursor = [], 0.0
        for part, sentence in enumerate(scene["narration"], 1):
            sentence_file = directory / f"sentence-{part}.txt"
            sentence_file.write_text(sentence)
            audio = directory / f"sentence-{part}.aiff"
            run(["say", "-v", "Samantha", "-r", "165", "-f", str(sentence_file), "-o", str(audio)])
            duration = float(probe(audio)["format"]["duration"])
            subtitles.append((timeline + cursor, timeline + cursor + duration, sentence))
            cursor += duration
            chunks.append(audio)
        audio_list = directory / "audio.txt"
        audio_list.write_text("".join(f"file '{p}'\n" for p in chunks))
        joined = directory / "narration.wav"
        run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0",
             "-i", str(audio_list), "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", str(joined)])
        duration = float(probe(joined)["format"]["duration"]) + 1.2
        # Round every scene to an exact 25 fps frame so concatenation and captions agree.
        duration = (int(duration * 25) + 1) / 25
        canvas = Image.new("RGB", (1600, 1000), "#0d1625")
        drawing = ImageDraw.Draw(canvas)
        drawing.rectangle((40, 135, 1560, 137), fill="#7f8bf4")
        drawing.rectangle((1140, 174, 1142, 890), fill="#26374d")

        def text(name, value, x, y, size, color="0xe7edf5", spacing=8):
            drawing.multiline_text((x, y), value, font=ImageFont.truetype(FONT, size),
                                   fill=color.replace("0x", "#"), spacing=spacing)

        text("title", scene["title"], 40, 34, 39)
        text("tag", scene["tag"], 42, 96, 17, "0x9faafc")
        text("notes", "\n\n".join(textwrap.fill(n, 25) for n in scene["notes"]),
             1160, 233, 28, "0xd8dfeb", 12)
        text("footer", "Zeron 0.2.125  |  TerminalX 0.2.19 Dev  |  Synthetic narration", 42, 954, 18, "0x9ca9bc")
        text("page", f"{index:02} / {len(scenes):02}", 1460, 954, 18, "0x9ca9bc")
        background = directory / "background.png"
        cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-threads", "2",
               "-loop", "1", "-framerate", "25", "-i", str(background)]
        if scene.get("image") or scene.get("clip"):
            media = (ROOT / scene.get("image", scene.get("clip"))).resolve()
            if not media.is_file():
                raise FileNotFoundError(media)
            if "image" in scene:
                cmd += ["-loop", "1", "-framerate", "25", "-i", str(media)]
            else:
                cmd += ["-i", str(media)]
            cmd += ["-i", str(joined)]
            crop = ""
            if scene.get("crop"):
                x, y, width, height = scene["crop"]
                crop = f"crop={width}:{height}:{x}:{y},"
            graph = (f"[0:v]null[bg];[1:v]{crop}scale=1080:750:force_original_aspect_ratio=decrease,"
                     f"setsar=1,fps=25,tpad=stop_mode=clone:stop_duration={duration}[media];"
                     "[bg][media]overlay=x=40:y=174+(750-h)/2:shortest=1[v]")
            audio_index = 2
        else:
            for row, line in enumerate(scene["card"]):
                text(f"card-{row}", line, 62, 310 + row * 135, 44,
                     "0xffffff" if row == 0 else "0xb9c4d7")
            cmd += ["-i", str(joined)]
            graph = "[0:v]null[v]"
            audio_index = 1
        canvas.save(background)
        graph += f";[{audio_index}:a]apad,atrim=0:{duration},loudnorm=I=-16:TP=-1.5:LRA=11[a]"
        segment = directory / "segment.mp4"
        cmd += ["-filter_complex_threads", "2", "-filter_complex", graph, "-map", "[v]", "-map", "[a]",
                "-t", str(duration), "-c:v", "libx264", "-preset", "fast", "-crf", "25", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-movflags", "+faststart", str(segment)]
        run(cmd)
        segments.append(segment)
        chapters.append({"start": timeline, "end": timeline + duration, "title": scene["title"], "evidence": scene["tag"]})
        transcript.append(f"## {stamp(timeline).split(',')[0]} — {scene['title']}\n\n{scene['tag']}\n\n" +
                          " ".join(scene["narration"]) + "\n")
        timeline += duration
        print(f"Rendered {index}/{len(scenes)}: {scene['title']}", flush=True)
    captions = ROOT / "captions.srt"
    captions.write_text("\n".join(f"{i}\n{stamp(start)} --> {stamp(end)}\n{textwrap.fill(line, 84)}\n"
                                  for i, (start, end, line) in enumerate(subtitles, 1)))
    (ROOT / "chapters.json").write_text(json.dumps(chapters, indent=2, ensure_ascii=False) + "\n")
    (ROOT / "transcript.md").write_text("# Interim comparison video transcript\n\n" + "\n".join(transcript))
    metadata = work / "metadata.txt"
    metadata.write_text(";FFMETADATA1\ntitle=Zeron and TerminalX - interim evidence review\n" + "".join(
        f"[CHAPTER]\nTIMEBASE=1/1000\nSTART={round(c['start'] * 1000)}\nEND={round(c['end'] * 1000)}\ntitle={c['title']}\n"
        for c in chapters))
    segment_list = work / "segments.txt"
    segment_list.write_text("".join(f"file '{p}'\n" for p in segments))
    run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0",
         "-i", str(segment_list), "-i", str(captions), "-i", str(metadata), "-map", "0:v", "-map", "0:a",
         "-map", "1:0", "-map_metadata", "2", "-map_chapters", "2", "-c", "copy", "-c:s", "mov_text",
         "-metadata:s:s:0", "language=eng", "-movflags", "+faststart", str(args.output)])
    info = probe(args.output)
    video = next(s for s in info["streams"] if s["codec_type"] == "video")
    assert (video["width"], video["height"], video["codec_name"]) == (1600, 1000, "h264")
    assert any(s["codec_type"] == "audio" for s in info["streams"])
    assert any(s["codec_type"] == "subtitle" for s in info["streams"])
    assert abs(float(info["format"]["duration"]) - timeline) < 1.0
    print(f"Verified streams and duration: {args.output} ({timeline:.2f} seconds)")


if __name__ == "__main__":
    main()
