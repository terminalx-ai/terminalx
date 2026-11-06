import { describe, expect, it } from "vitest";
import {
  codexFileCitationLabel,
  codexFileCitationName,
  codexFileCitationParts,
  isCodexFileOutput,
  matchCodexFileCitation,
  withoutPartialCodexFileCitation,
} from "./codexCitations";

const OUTPUT = ':codex-file-citation{path="/abs/path/report.xlsx" artifact_kind="workbook" purpose="output"}';

describe("Codex file citations (#776)", () => {
  it("reads a well-formed marker's path, purpose and locators, ignoring unknown keys", () => {
    expect(matchCodexFileCitation(OUTPUT)).toEqual({
      citation: { path: "/abs/path/report.xlsx", artifactKind: "workbook", purpose: "output" },
      end: OUTPUT.length,
    });
    const source = ':codex-file-citation{path="/abs/report.xlsx" sheet="Revenue Model" range="C27" mode="x" future_key="y" object_id=chart1 label=\'Revenue chart\' page_number=3 purpose="source"}';
    expect(matchCodexFileCitation(source)?.citation).toEqual({
      path: "/abs/report.xlsx", sheet: "Revenue Model", range: "C27", objectId: "chart1", label: "Revenue chart", pageNumber: "3", purpose: "source",
    });
  });

  it("keeps a path's spaces, Markdown punctuation, braces, backslashes and non-ASCII characters", () => {
    for (const path of ["/abs/my *draft* _final_ #2 {v}.xlsx", "/Users/zoë/Отчёт.xlsx", "C:\\Users\\me\\report.xlsx"]) {
      expect(matchCodexFileCitation(`:codex-file-citation{path="${path}" purpose="output"}`)?.citation.path).toBe(path);
    }
  });

  it("leaves a malformed marker unmatched", () => {
    for (const text of [
      ':codex-file-citation{purpose="output"}',
      ':codex-file-citation{path=""}',
      ':codex-file-citation{path="/abs/report.xlsx"',
      ':codex-file-citation{path="/abs/report.xlsx}',
      ':codex-file-citation{path="/abs/a.xlsx"\npurpose="output"}',
      ':codex-file-citation{path="/abs/a.xlsx" stray}',
      ':codex-file-citation{path="javascript:alert(1)"}',
      ':codex-file-citation[path="/abs/a.xlsx"]',
      'codex-file-citation{path="/abs/a.xlsx"}',
    ]) expect(matchCodexFileCitation(text), text).toBeNull();
  });

  it("labels a file by its name and locator, and a Drive URL by its kind", () => {
    const label = (attributes: string) => codexFileCitationLabel(matchCodexFileCitation(`:codex-file-citation{${attributes}}`)!.citation);
    expect(label('path="/abs/path/report.xlsx"')).toBe("report.xlsx");
    expect(label('path="/abs/report.xlsx" sheet="Revenue Model" range="C27"')).toBe("report.xlsx · Revenue Model!C27");
    expect(label('path="/abs/report.xlsx" sheet="Revenue Model"')).toBe("report.xlsx · Revenue Model");
    expect(label('path="/abs/review.pdf" page_number="3"')).toBe("review.pdf · p. 3");
    expect(label('path="C:\\Users\\me\\Q3 plan.docx"')).toBe("Q3 plan.docx");
    expect(label('path="https://docs.google.com/spreadsheets/d/1AbC/edit#gid=0"')).toBe("Google Sheets file");
    expect(label('path="https://docs.google.com/document/u/0/d/1AbC/edit"')).toBe("Google Docs file");
    expect(label('path="https://docs.google.com/presentation/d/1AbC/edit"')).toBe("Google Slides file");
    expect(label('path="https://drive.google.com/file/d/1AbC/view"')).toBe("Google Drive file");
    expect(codexFileCitationName("https://example.test/files/Q3%20report.pdf")).toBe("Q3 report.pdf");
    expect(codexFileCitationName("file:///tmp/My%20notes.md")).toBe("My notes.md");
    expect(isCodexFileOutput(matchCodexFileCitation(OUTPUT)!.citation)).toBe(true);
    expect(isCodexFileOutput({ path: "/a", purpose: "source" })).toBe(false);
  });

  it("splits plain text into prose and markers without losing a character", () => {
    const text = `The review of :codex-file-citation{path="/abs/review.pdf" purpose="source"} is due. :codex-file-citation{broken} ${OUTPUT}`;
    const parts = codexFileCitationParts(text);
    expect(parts.map((part) => part.text).join("")).toBe(text);
    expect(parts.filter((part) => part.citation).map((part) => part.citation!.path)).toEqual(["/abs/review.pdf", "/abs/path/report.xlsx"]);
    expect(codexFileCitationParts("no markers")).toEqual([{ text: "no markers" }]);
  });

  it("holds back a marker that is still streaming, and nothing else", () => {
    expect(withoutPartialCodexFileCitation('Here it is.\n\n:codex-file-citation{path="https://docs.google.com/spr')).toBe("Here it is.\n\n");
    expect(withoutPartialCodexFileCitation('See :codex-file-citation{path="/abs/a}b')).toBe("See ");
    expect(withoutPartialCodexFileCitation("Here it is.\n\n:codex-fi")).toBe("Here it is.\n\n");
    expect(withoutPartialCodexFileCitation("Here it is:")).toBe("Here it is:");
    expect(withoutPartialCodexFileCitation(`Done. ${OUTPUT}`)).toBe(`Done. ${OUTPUT}`);
    // Closed or ended by its line, a marker is what it is: a link, or text.
    expect(withoutPartialCodexFileCitation(":codex-file-citation{broken} and more")).toBe(":codex-file-citation{broken} and more");
    expect(withoutPartialCodexFileCitation(':codex-file-citation{path="/a.xlsx"\nNext line')).toBe(':codex-file-citation{path="/a.xlsx"\nNext line');
  });
});
