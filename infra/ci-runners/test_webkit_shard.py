"""How the Linux WebKit parts are dealt (scripts/webkit/run-all.mjs `shard`, #1514 step 3 piece 4).

`shard` deals the checks to the --shard parts by their measured time on CI's Linux runner
(scripts/webkit/check-times.json), longest first to the part with the least time so far, within its kinds. These run
run-all's own `shard` through Node, for 1 to 8 parts; no WebKit is needed.
"""

import json
import re
import random
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUN_ALL = ROOT / "scripts/webkit/run-all.mjs"
TIMES = ROOT / "scripts/webkit/check-times.json"
COUNTS = range(1, 9)

DEAL = """
const [path, times, counts] = JSON.parse(process.argv[1]);
const r = await import(path);
const weights = r.shardWeights(r.checks, times ?? r.checkTimes());
const deals = {};
for (const count of counts) deals[count] = Array.from({ length: count }, (_, i) => r.shard(r.checks, i + 1, count, times ?? undefined));
console.log(JSON.stringify({ checks: r.checks, macOnly: [...r.macOnly.keys()], alone: [...r.alone.keys()], weights: Object.fromEntries(weights), deals }));
"""


def deal(times=None, counts=COUNTS):
    """run-all's checks, its lists, each check's weight, and the parts for each count, by `times` (None: the file's)."""
    done = subprocess.run(["node", "--input-type=module", "-e", DEAL, json.dumps([RUN_ALL.as_uri(), times, list(counts)])], cwd=ROOT, capture_output=True, text=True)
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout)


def starts_vite(name):
    """As run-all's `startsVite`: the check's script imports Vite or vite-page.mjs."""
    source = (ROOT / "scripts/webkit" / f"{name.split(':')[0]}.mjs").read_text()
    return re.search(r"""(from\s+|import\()\s*["'](vite|\./vite-page\.mjs)["']""", source) is not None


def measured():
    return json.loads(TIMES.read_text())["seconds"]


class WebKitShardTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dealt = deal()

    def assert_each_once(self, dealt):
        for count, parts in dealt["deals"].items():
            with self.subTest(count=count):
                together = [name for part in parts for name in part]
                self.assertEqual(sorted(together), sorted(dealt["checks"]), f"{count} parts: not every check in exactly one part")
                self.assertTrue(all(parts), f"{count} parts: a part with no checks")

    def test_every_check_in_exactly_one_part(self):
        self.assert_each_once(self.dealt)

    def test_the_file_has_its_source_and_every_linux_check(self):
        data = json.loads(TIMES.read_text())
        self.assertIn("45442275413", data["source"], "the file says which runs its numbers came from")
        self.assertIn("--times", data["source"], "the file says how it is rebuilt")
        linux = set(self.dealt["checks"]) - set(self.dealt["macOnly"])
        self.assertEqual(set(data["seconds"]), linux)
        self.assertEqual(set(data["runs"]), linux)

    def test_an_unknown_check_is_dealt_at_the_median(self):
        # Checks the file does not have (yet): new, or renamed. Among them the longest and a split one.
        times = measured()
        unknown = ["orchestration", "agent-dashboard:1", "chat-find"]
        for name in unknown:
            del times[name]
        values = sorted(times.values())
        middle = len(values) // 2
        median = values[middle] if len(values) % 2 else (values[middle - 1] + values[middle]) / 2
        dealt = deal(times)
        self.assert_each_once(dealt)
        for name in unknown:
            self.assertEqual(dealt["weights"][name], round(median * 10), f"{name} not weighed at the median")
        # The checks left out on Linux take no time in a Linux part; the alone ones count their full time.
        for name in self.dealt["macOnly"]:
            self.assertEqual(self.dealt["weights"][name], 0)
        for name in self.dealt["alone"]:
            if name in measured():
                self.assertEqual(self.dealt["weights"][name], round(measured()[name] * 10) * 4)

    def test_the_times_files_order_changes_nothing(self):
        items = list(measured().items())
        for seed in range(3):
            random.Random(seed).shuffle(items)
            with self.subTest(seed=seed):
                self.assertEqual(deal(dict(items))["deals"], self.dealt["deals"])

    def test_measured_times_give_four_even_parts(self):
        weights = self.dealt["weights"]
        sums = [sum(weights[name] for name in part) for part in self.dealt["deals"]["4"]]
        self.assertLessEqual(max(sums), min(sums) * 1.10, f"four parts' predicted times (tenths of check-seconds): {sums}")

    def test_the_kinds_stay_spread(self):
        # The two dealt apart are in different parts; Vite checks differ by at most one between parts.
        apart = ["pr-conversation", "cloud-history"]
        for count, parts in self.dealt["deals"].items():
            if int(count) < 2:
                continue
            with self.subTest(count=count):
                self.assertEqual(len({i for i, part in enumerate(parts) for name in part if name in apart}), 2)
                held = [sum(1 for name in part if starts_vite(name) and name not in apart) for part in parts]
                self.assertLessEqual(max(held) - min(held), 1, f"Vite checks per part: {held}")

    def test_times_rebuilds_the_file_from_logs(self):
        with tempfile.TemporaryDirectory() as folder:
            one, two = Path(folder) / "part-1.log", Path(folder) / "part-2.log"
            one.write_text("2026-11-24T17:00:00.0000000Z ── chat-find (100.0s) ok\n── run-menu (10.0s) ok\n── broken (5.0s) FAILED: 1\n")
            two.write_text("2026-11-25T17:00:00.0000000Z ── chat-find (110.0s) ok\r\n── chat-find (90.0s) ok\n── agent-dashboard:2 (128.4s) ok\n")
            done = subprocess.run(["node", str(RUN_ALL), "--times", str(one), str(two)], cwd=ROOT, capture_output=True, text=True)
            self.assertEqual(done.returncode, 0, done.stderr)
            found = json.loads(done.stdout)
        self.assertEqual(found["seconds"], {"agent-dashboard:2": 128.4, "chat-find": 100.0, "run-menu": 10.0})
        self.assertEqual(found["runs"], {"agent-dashboard:2": 1, "chat-find": 3, "run-menu": 1})
        self.assertIn("part-1.log, part-2.log", found["source"])
        self.assertEqual(list(found["seconds"]), sorted(found["seconds"]), "written in name order")


if __name__ == "__main__":
    unittest.main()
