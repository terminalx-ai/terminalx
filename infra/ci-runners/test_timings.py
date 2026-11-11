import unittest
from timings import percentile90, summarize


class Timings(unittest.TestCase):
    def test_nearest_rank(self):
        self.assertEqual(percentile90(list(range(1, 11))), 9)

    def test_queue_time_is_in_total_but_not_job(self):
        run = dict(id=1, html_url="example", head_sha="abc", event="pull_request",
                   run_attempt=1, run_started_at="2026-01-01T00:00:00Z")
        jobs = [dict(name="check", conclusion="success", started_at="2026-01-01T00:10:00Z",
                     completed_at="2026-01-01T00:30:00Z"),
                dict(name="macos-rust", conclusion="skipped", started_at=None, completed_at=None)]
        self.assertEqual(summarize(run, jobs)["minutes"], {"Whole run": 30, "check": 20})

    def test_rerun_rejected(self):
        with self.assertRaises(ValueError):
            summarize({"run_attempt": 2}, [])


if __name__ == "__main__":
    unittest.main()
