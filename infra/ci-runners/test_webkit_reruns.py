"""The WebKit parts' one rerun (scripts/webkit/run-all.mjs, #1514 item 21).

On a Linux part a check that failed runs once more, by itself, after the part's other checks. The part passes only
if each such check then passes; one that passed only alone stays visible in the log and the job summary. These run
run-all's own `rerunFailed` through Node with a stand-in for running a check, so no WebKit is needed.
"""

import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUN_ALL = ROOT / "scripts/webkit/run-all.mjs"

SCENARIO = """
const [path, outcomes, times, alone] = JSON.parse(process.argv[1]);
const runAll = await import(path);
const calls = [];
// Each check's outcomes in order: true passes, false fails. A check run more often than it has outcomes fails the run.
const run = async (name) => {
  calls.push(name);
  const ok = outcomes[name][calls.filter((call) => call === name).length - 1];
  if (ok === undefined) throw new Error(`${name} ran more times than it has outcomes`);
  return { name, ms: 1000, ok, report: `\\n── ${name} (1.0s) ${ok ? "ok" : "FAILED: 1"}\\n${ok ? "" : `AssertionError: ${name} broke`}` };
};
const first = [];
// As run-all marks the checks of its `alone` list, which ran by themselves the first time too.
for (const name of Object.keys(outcomes)) first.push({ ...await run(name), ...(alone.includes(name) ? { alone: true } : {}) });
let results, error = null;
try {
  results = await runAll.rerunFailed(first, run, times ?? runAll.reruns);
} catch (caught) {
  error = caught.message;
}
console.log("RESULT " + JSON.stringify({ calls, error, results, summary: results ? runAll.stepSummary(results, "2/4") : null, annotations: results ? runAll.annotations(results, "2/4") : null }));
"""


def scenario(outcomes, times=None, path=RUN_ALL, alone=()):
    """Run `rerunFailed` over first runs of `outcomes` ({name: [ok, ok again, ...]}), the names in `alone` as checks
    that ran by themselves. Returns (result, log)."""
    done = subprocess.run(["node", "--input-type=module", "-e", SCENARIO, json.dumps([path.as_uri(), outcomes, times, list(alone)])], cwd=ROOT, capture_output=True, text=True)
    assert done.returncode == 0, done.stderr
    line = next(line for line in done.stdout.splitlines() if line.startswith("RESULT "))
    return json.loads(line.removeprefix("RESULT ")), done.stdout


def node(script):
    """What a module script prints, as JSON."""
    done = subprocess.run(["node", "--input-type=module", "-e", script], cwd=ROOT, capture_output=True, text=True)
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout)


def reruns_here(platform, only=None):
    script = f"const {{ rerunsHere }} = await import({json.dumps(RUN_ALL.as_uri())}); console.log(rerunsHere({json.dumps({'platform': platform, 'only': only})}));"
    done = subprocess.run(["node", "--input-type=module", "-e", script], cwd=ROOT, capture_output=True, text=True)
    assert done.returncode == 0, done.stderr
    return int(done.stdout.strip())


def validate_one_rerun(path=RUN_ALL):
    """The policy: a check that keeps failing runs exactly twice (once, and once alone) and fails; a second rerun is refused."""
    result, _ = scenario({"stuck": [False, False, False], "fine": [True]}, path=path)
    assert result["error"] is None, f"run-all refuses its own number of reruns: {result['error']}"
    assert result["calls"].count("stuck") == 2, f"a failing check ran {result['calls'].count('stuck')} times, not twice"
    assert result["calls"].count("fine") == 1, "a check that passed ran again"
    assert not next(r for r in result["results"] if r["name"] == "stuck")["ok"], "a check that failed twice passed"
    refused, _ = scenario({"stuck": [False, False, False]}, times=2, path=path)
    assert refused["error"] is not None and refused["calls"].count("stuck") == 1, "run-all allows a second rerun"


class WebKitRerunTest(unittest.TestCase):
    def test_fail_then_pass_is_green_and_listed(self):
        result, log = scenario({"flaky": [False, True], "fine": [True]})
        self.assertEqual(result["calls"], ["flaky", "fine", "flaky"])
        self.assertTrue(all(r["ok"] for r in result["results"]), "the part is green")
        flaky = next(r for r in result["results"] if r["name"] == "flaky")
        self.assertTrue(flaky["passedAlone"])
        self.assertFalse(flaky["first"]["ok"])
        # The log says so with the first failure's output, and the summary lists it under its own heading with that output.
        self.assertIn("flaky FAILED under load, passed alone", log)
        self.assertRegex(log, r"FAILED under load, passed alone; its first run:\n── flaky \(1\.0s\) FAILED: 1\nAssertionError: flaky broke")
        self.assertIn("### WebKit checks, part 2/4: FAILED under load, passed alone", result["summary"])
        self.assertIn("<code>flaky</code>", result["summary"])
        self.assertIn("AssertionError: flaky broke", result["summary"])
        self.assertNotIn("fine", result["summary"])
        # One warning annotation, for the check and its part, seen without opening the job.
        self.assertEqual(result["annotations"], ["::warning title=WebKit check passed only when run again%3A flaky%2C part 2/4::flaky FAILED under load, passed alone in part 2/4. The part passed; the check is still to be fixed (its first output is in the log and the job summary)."])

    def test_an_alone_check_is_not_said_to_have_failed_under_load(self):
        # A check on run-all's `alone` list ran by itself both times: it failed, then passed when run again.
        result, log = scenario({"timed": [False, True], "flaky": [False, True]}, alone=["timed"])
        self.assertTrue(all(r["ok"] for r in result["results"]))
        self.assertIn("── timed failed, passed when run again; its first run:", log)
        self.assertNotIn("timed FAILED under load", log)
        self.assertIn("── flaky FAILED under load, passed alone; its first run:", log)
        # In the same list, each with its own words.
        self.assertEqual(result["summary"].count("### "), 1)
        self.assertIn("<code>timed</code>: failed, passed when run again", result["summary"])
        self.assertIn("<code>flaky</code>: FAILED under load, passed alone", result["summary"])
        self.assertEqual(len(result["annotations"]), 2)
        self.assertIn("::timed failed, passed when run again in part 2/4.", result["annotations"][0])

    def test_fail_fail_is_red(self):
        result, log = scenario({"broken": [False, False], "fine": [True]})
        broken = next(r for r in result["results"] if r["name"] == "broken")
        self.assertFalse(broken["ok"])
        self.assertFalse(broken.get("passedAlone", False))
        self.assertFalse(broken["first"]["ok"], "the first failure is kept for the log")
        self.assertNotIn("passed alone", log)
        self.assertIn("### WebKit checks, part 2/4: failed", result["summary"])
        self.assertIn("<code>broken</code>, and again alone", result["summary"])
        self.assertNotIn("FAILED under load", result["summary"])
        self.assertEqual(result["annotations"], [], "a check that failed fails its part; it needs no warning")

    def test_pass_is_not_rerun(self):
        result, log = scenario({"a": [True], "b": [True]})
        self.assertEqual(result["calls"], ["a", "b"])
        self.assertEqual(result["summary"], "")
        self.assertEqual(result["annotations"], [])
        self.assertNotIn("again, alone", log)

    def test_at_most_one_rerun(self):
        validate_one_rerun()
        # Several failed checks: each runs again once, one after another, in the order they ended.
        result, _ = scenario({"x": [False, True], "y": [False, False], "z": [True]})
        self.assertEqual(result["calls"], ["x", "y", "z", "x", "y"])
        self.assertEqual([r["ok"] for r in result["results"]], [True, False, True])

    def test_no_rerun_where_none_is_made(self):
        result, _ = scenario({"broken": [False]}, times=0)
        self.assertEqual(result["calls"], ["broken"])
        self.assertFalse(result["results"][0]["ok"])

    def test_only_linux_parts_rerun(self):
        self.assertEqual(reruns_here("linux"), 1)
        self.assertEqual(reruns_here("darwin"), 0)
        # webkit-mac-only runs `--only mac-only`: unchanged, wherever it runs.
        self.assertEqual(reruns_here("linux", "mac-only"), 0)
        self.assertEqual(reruns_here("darwin", "mac-only"), 0)

    def test_annotation_titles_are_read_back(self):
        uri = json.dumps(RUN_ALL.as_uri())
        found = node(f"""const r = await import({uri});
            console.log(JSON.stringify([r.annotationCheck(r.annotationTitle("agent-dashboard:2", "1/4")), r.annotationCheck(r.annotationTitle("chat-links")),
              r.annotationCheck("Node.js 20 is deprecated"), r.annotationCheck(""), r.annotationCheck(null)]));""")
        self.assertEqual(found, [{"name": "agent-dashboard:2", "part": "1/4"}, {"name": "chat-links", "part": None}, None, None, None])
        odd_part = json.dumps("50%,\n:")
        # A message with what GitHub's commands read as their own is escaped, so it stays one annotation.
        lines = node(f"""const r = await import({uri});
            console.log(JSON.stringify(r.annotations([{{ name: "x", ok: true, passedAlone: true, first: {{ ok: false }} }}], {odd_part})));""")
        self.assertEqual(len(lines), 1)
        self.assertNotIn("\n", lines[0])
        self.assertIn("title=WebKit check passed only when run again%3A x%2C part 50%25%2C%0A%3A::", lines[0])

    def test_the_tally_counts_runs_per_check(self):
        tally = json.dumps((ROOT / "scripts/webkit/rerun-tally.mjs").as_uri())
        uri = json.dumps(RUN_ALL.as_uri())
        found = node(f"""const {{ tally }} = await import({tally});
            const {{ annotationTitle }} = await import({uri});
            const warn = (name, part) => ({{ title: annotationTitle(name, part), level: "warning" }});
            const job = (id, name, attempt, annotations) => ({{ id, name, attempt, annotations }});
            const run = (id, jobs) => ({{ id, url: `u${{id}}`, branch: "b", sha: "s", jobs }});
            console.log(JSON.stringify(tally([
              run(1, [job(11, "webkit-layout-linux (2)", 1, [warn("flaky", "2/4"), {{ title: "", level: "warning" }}]), job(12, "webkit-layout-linux (3)", 1, [warn("timed", "3/4")])]),
              // The same check twice in one run (a part rerun by hand) counts that run once; a failure-level one, or another job's, not at all.
              run(2, [job(21, "webkit-layout-linux (2)", 1, [warn("flaky", "2/4")]), job(22, "webkit-layout-linux (2)", 2, [warn("flaky", "2/4")]), job(23, "webkit-mac-only", 1, [warn("other", null)]), job(24, "webkit-layout-linux (1)", 1, [{{ title: annotationTitle("broken", "1/4"), level: "failure" }}])]),
              run(3, [job(31, "webkit-layout-linux (4)", 1, [])]),
            ])));""")
        self.assertEqual(found, [
            {"name": "flaky", "runs": [{"id": 1, "url": "u1", "branch": "b", "sha": "s", "parts": ["2/4"]}, {"id": 2, "url": "u2", "branch": "b", "sha": "s", "parts": ["2/4", "2/4 (attempt 2)"]}]},
            {"name": "timed", "runs": [{"id": 1, "url": "u1", "branch": "b", "sha": "s", "parts": ["3/4"]}]},
        ])

    def test_more_than_one_rerun_is_rejected(self):
        source = RUN_ALL.read_text()
        self.assertRegex(source, r"\nexport const reruns = 1;\n")
        loosened = [
            # The number raised: run-all then refuses it, or allows a third run.
            source.replace("export const reruns = 1;", "export const reruns = 2;", 1),
            # The guard dropped and the number raised: a failing check runs three times.
            re.sub(r"  if \(times !== 0 && times !== reruns\) throw [^\n]*\n", "", source.replace("export const reruns = 1;", "export const reruns = 2;", 1), count=1)
            .replace("    const again = await run(first.name);\n", "    let again = await run(first.name);\n    for (let n = 1; n < times && !again.ok; n++) again = await run(first.name);\n", 1),
            # A retry loop around the one rerun.
            source.replace("    const again = await run(first.name);\n", "    let again = await run(first.name);\n    if (!again.ok) again = await run(first.name);\n", 1),
        ]
        for changed in loosened:
            with self.subTest(changed=changed.count("await run(first.name)")):
                self.assertNotEqual(changed, source, "the edit applies")
                with tempfile.TemporaryDirectory() as folder:
                    copy = Path(folder) / "run-all.mjs"
                    copy.write_text(changed)
                    with self.assertRaises(AssertionError):
                        validate_one_rerun(copy)


if __name__ == "__main__":
    unittest.main()
