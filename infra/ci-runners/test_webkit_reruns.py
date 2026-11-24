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
const [path, outcomes, times] = JSON.parse(process.argv[1]);
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
for (const name of Object.keys(outcomes)) first.push(await run(name));
let results, error = null;
try {
  results = await runAll.rerunFailed(first, run, times ?? runAll.reruns);
} catch (caught) {
  error = caught.message;
}
console.log("RESULT " + JSON.stringify({ calls, error, results, summary: results ? runAll.stepSummary(results, "2/4") : null }));
"""


def scenario(outcomes, times=None, path=RUN_ALL):
    """Run `rerunFailed` over first runs of `outcomes` ({name: [ok, ok again, ...]}). Returns (result, log)."""
    done = subprocess.run(["node", "--input-type=module", "-e", SCENARIO, json.dumps([path.as_uri(), outcomes, times])], cwd=ROOT, capture_output=True, text=True)
    assert done.returncode == 0, done.stderr
    line = next(line for line in done.stdout.splitlines() if line.startswith("RESULT "))
    return json.loads(line.removeprefix("RESULT ")), done.stdout


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

    def test_pass_is_not_rerun(self):
        result, log = scenario({"a": [True], "b": [True]})
        self.assertEqual(result["calls"], ["a", "b"])
        self.assertEqual(result["summary"], "")
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
