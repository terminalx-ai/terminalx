"""Guard the public-repository CI contract, including negative policy fixtures.

This checks the checked-in workflow, not fork-controlled copies of it. Every
Linux job runs on Instabox, pull requests included (CI-RUNNERS.md "Threat
model"): what keeps a pull request's code harmless there is that the job holds
no secret and a read-only token, which is what most of this file checks.
"""
from copy import deepcopy
import json
import os
from pathlib import Path
import re
import subprocess
import unittest

import yaml


WORKFLOW = Path(__file__).resolve().parents[2] / ".github/workflows/ci.yml"
# Every Linux job's runner: Instabox, a fresh machine for each job. macOS stays GitHub-hosted.
LINUX = "instabox-medium"
MACOS = "macos-latest"
# A matrix may also name the Windows leg desktop-platforms keeps its steps for.
MATRIX = {LINUX, "windows-latest"}
CACHE_SCOPE = "${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || (github.ref == 'refs/heads/main' && 'main') || format('run-{0}', github.run_id) }}"


# Only these may take a macOS runner or be skipped, and only on the selector's word.
SELECTED = {
    "macos-native": "needs.macos-rust-changes.outputs.required == 'true'",
    "machine-compat": "needs.macos-rust-changes.outputs.machines == 'true'",
}
# The Linux Rust suite in parts. A filter matches the names containing it, so
# these are exact: the first's names, the other session:: and remote:: names,
# and every name containing neither.
PARTS = [
    {"part": "prompts", "tests": "session::watch_tests::prompts"},
    {"part": "session-remote", "tests": "session:: remote:: --skip session::watch_tests::prompts"},
    {"part": "rest", "tests": "--skip session:: --skip remote::"},
]
VITEST_PARTS = ["1", "2", "3", "4"]
CACHE_MISS = "steps.cargo-cache.outputs.cache-matched-key == ''"
# A cache job's name, where it is not the job's own.
CACHES = {"linux-rust", "linux-rust-tests", "macos-native", "headless-serve", "machine-compat", "machines-e2e", "desktop-platforms"}


def cache_key(name, scope):
    return (
        f"ci-v4-{name}-{scope}-${{{{ runner.os }}}}-${{{{ runner.arch }}}}-"
        "${{ hashFiles('src-tauri/Cargo.lock') }}-${{ steps.toolchain.outputs.rustc }}"
    )


def gate_passes(workflow, needs):
    """Run the aggregate's own script against these job results."""
    script = workflow["jobs"]["check"]["steps"][0]["run"]
    done = subprocess.run(["bash", "-c", script], env={**os.environ, "RESULTS": json.dumps(needs)}, capture_output=True)
    return done.returncode == 0


def results(workflow, required="true", machines="true", **changed):
    needs = {name: {"result": "success", "outputs": {}} for name in workflow["jobs"] if name != "check"}
    needs["macos-rust-changes"]["outputs"] = {"required": required, "machines": machines}
    for name, result in changed.items():
        needs[name.replace("_", "-")]["result"] = result
    return needs


def validate(workflow):
    assert workflow["permissions"] == {"contents": "read"}, "workflow token must be read-only"
    for expression in re.findall(r"\$\{\{.*?\}\}", str(workflow), re.DOTALL):
        assert not re.search(r"\bsecrets\b", expression, re.IGNORECASE), "secret expression anywhere in workflow"
    assert set(workflow["on"]) == {"pull_request", "push", "schedule", "workflow_dispatch"}, "unexpected trigger"
    assert workflow["on"]["push"]["branches"] == ["main"], "push scope"
    assert workflow["env"]["CI_CACHE_SCOPE"] == CACHE_SCOPE, "cache trust scope"
    jobs = workflow["jobs"]
    assert {"check", "frontend", "webkit-layout"} <= jobs.keys(), "required status names"
    assert set(jobs["check"]["needs"]) == jobs.keys() - {"check"}, "aggregate must require every job"
    assert jobs["check"]["if"] == "always()", "aggregate must report failures and cancellations"
    gate = jobs["check"]["steps"][0]["run"]
    assert '$selector.result == "success"' in gate, "a skip is accepted on a failed selector's word"
    assert set(re.findall(r'\$job == "([\w-]+)"', gate)) == set(SELECTED), "aggregate must reject every other skipped dependency"
    for name, job in jobs.items():
        assert "permissions" not in job, "job token escalation"
        assert "secrets" not in job, "job secrets"
        assert "continue-on-error" not in job, "required job failure ignored"
        if name in SELECTED:
            assert job["if"] == SELECTED[name], "macOS job selection"
            assert job["needs"] == "macos-rust-changes", "macOS coverage selection dependency"
            assert job["concurrency"] == {
                "group": f"ci-{name}-${{{{ github.event_name == 'push' && 'main' || github.run_id }}}}",
                "cancel-in-progress": "false",
            }, "main keeps the running macOS job and the newest waiting one; other runs are not grouped"
        elif name != "check":
            assert "if" not in job, "a job the aggregate would see skipped"
            assert "concurrency" not in job, "a job another run could cancel"
        # A literal label, or a matrix of literal labels: never a variable or an expression that picks one.
        runner = job["runs-on"]
        if runner == "${{ matrix.os }}":
            assert set(job["strategy"]["matrix"]["os"]) <= MATRIX, "a matrix runner that is neither Instabox nor the Windows leg"
        elif name in SELECTED or name == "webkit-layout":
            assert runner == MACOS, "the macOS jobs run on GitHub's macOS runner"
        else:
            assert runner == LINUX, "a Linux job off Instabox, or macOS runner time outside the selected jobs and the WebKit checks"
        restored = None
        for step in job["steps"]:
            action = step.get("uses", "")
            if action:
                assert re.fullmatch(r"[\w.-]+/[\w./-]+@[0-9a-f]{40}", action), "mutable action reference"
            inputs = step.get("with", {})
            if action.startswith("actions/checkout@"):
                assert inputs.get("persist-credentials") == "false", "checkout token persisted"
            if action.startswith("actions/setup-node@"):
                assert "cache" not in inputs, "implicit shared Node cache"
            if action.startswith("actions/cache"):
                assert name in CACHES, "unexpected cache"
                if "/save@" in action:
                    assert restored, "save without a restore"
                    assert inputs["key"] == "${{ steps.cargo-cache.outputs.cache-primary-key }}", "save must use restored scope"
                    assert CACHE_MISS in step["if"], "a cache is saved only when none was restored"
                else:
                    assert "/restore@" in action, "a cache action that saves by itself"
                    assert step["id"] == "cargo-cache", "cache step name"
                    assert inputs["key"] == cache_key(name, "${{ env.CI_CACHE_SCOPE }}"), "cache writes must stay in the run's own scope, keyed by lock file and compiler"
                    assert inputs.get("restore-keys", "").splitlines() == [cache_key(name, "main")], "restore only own scope, then trusted main with matching job/platform/lock/compiler"
                    assert any(s.get("id") == "toolchain" and 'echo "rustc=$(rustc --version' in s.get("run", "") for s in job["steps"]), "cache key names the compiler"
                    restored = True
            assert "secrets." not in str(step), "secret expression"
            assert "continue-on-error" not in step, "required step failure ignored"
    rust = jobs["linux-rust"]["steps"]
    assert any(s.get("run") == "cargo clippy --locked --all-targets -- -D warnings" for s in rust), "Linux Clippy"
    # The full Linux Rust suite: every part of the library's tests, then the rest of `cargo test`.
    tests = jobs["linux-rust-tests"]
    assert tests["strategy"]["matrix"] == {"include": PARTS}, "the parts of the Linux Rust suite must stay exact"
    assert tests["strategy"]["fail-fast"] == "false", "every part reports"
    assert any(s.get("run") == "cargo test --locked --lib -- ${{ matrix.tests }}" and "if" not in s for s in tests["steps"]), "the library's tests, every part"
    others = next(s for s in tests["steps"] if s.get("if") == "matrix.part == 'rest'" and "run" in s)
    assert others["run"].split("\n")[:2] == ["cargo test --locked --bins --test '*'", "cargo test --locked --doc"], "the other test binaries and the doc tests"
    # desktop-platforms skips its script tests on Linux because this job runs them all.
    vitest = jobs["vitest"]
    assert vitest["strategy"]["matrix"] == {"part": VITEST_PARTS}, "every part of the Vitest run"
    assert vitest["strategy"]["fail-fast"] == "false", "every part reports"
    assert any(s.get("run") == "pnpm vitest run --shard=${{ matrix.part }}/4" and "if" not in s for s in vitest["steps"]), "full Vitest run"
    for steps in [rust, tests["steps"]]:
        install = next(s for s in steps if s.get("name") == "Install Linux build dependencies")
        assert "if" not in install, "the build dependencies are installed on every run"
        assert "ripgrep" in install["run"] and "zsh" in install["run"], "security fixture dependencies"
    native = jobs["macos-native"]
    for steps in [rust, tests["steps"], native["steps"]]:
        assert any("command -v rg && command -v zsh" in s.get("run", "") for s in steps), "security fixtures must not skip missing tools"
    assert any(s.get("run") == "cargo test --locked" and s.get("if") == "needs.macos-rust-changes.outputs.required == 'true'" for s in native["steps"]), "macOS full suite"


class WorkflowSecurity(unittest.TestCase):
    def setUp(self):
        self.workflow = yaml.load(WORKFLOW.read_text(), Loader=yaml.BaseLoader)

    def test_workflow_meets_public_repository_policy(self):
        validate(self.workflow)

    def rejects(self, mutate):
        changed = deepcopy(self.workflow)
        mutate(changed)
        with self.assertRaises(AssertionError):
            validate(changed)

    def test_runner_chosen_by_a_variable_is_rejected(self):
        self.rejects(lambda w: w["jobs"]["linux-rust"].update({"runs-on": "${{ vars.CI_LINUX_RUNNER || 'instabox-medium' }}"}))

    def test_custom_matrix_runner_is_rejected(self):
        self.rejects(lambda w: w["jobs"]["legacy-runtime-probe"]["strategy"]["matrix"].update(os=["self-hosted"]))

    def test_linux_job_off_instabox_is_rejected(self):
        # GitHub's Ubuntu runner, another label of the same provider, a bare self-hosted one.
        for runner in ["ubuntu-latest", "instabox-large", "self-hosted"]:
            with self.subTest(runner=runner):
                self.rejects(lambda w: w["jobs"]["linux-rust-tests"].update({"runs-on": runner}))
        self.rejects(lambda w: w["jobs"]["desktop-platforms"]["strategy"]["matrix"].update(os=["ubuntu-latest"]))

    def test_macos_job_off_githubs_runner_is_rejected(self):
        self.rejects(lambda w: w["jobs"]["webkit-layout"].update({"runs-on": "instabox-medium"}))
        self.rejects(lambda w: w["jobs"]["macos-native"].update({"runs-on": "self-hosted"}))

    def test_conditional_build_dependencies_are_rejected(self):
        def change(w):
            install = next(s for s in w["jobs"]["linux-rust"]["steps"] if s.get("name") == "Install Linux build dependencies")
            install["if"] = "runner.environment == 'github-hosted'"
        self.rejects(change)

    def test_privileged_trigger_is_rejected(self):
        self.rejects(lambda w: w["on"].update(pull_request_target={}))

    def test_token_escalation_is_rejected(self):
        self.rejects(lambda w: w["jobs"]["frontend"].update(permissions={"contents": "write"}))

    def test_global_secret_environment_is_rejected(self):
        self.rejects(lambda w: w["env"].update(PRIVATE_TOKEN="${{ secrets['DEPLOY_TOKEN'] }}"))

    def test_mutable_action_is_rejected(self):
        self.rejects(lambda w: w["jobs"]["frontend"]["steps"][0].update(uses="actions/checkout@v4"))

    def test_shared_cache_fallback_is_rejected(self):
        def change(w):
            cache = next(s for s in w["jobs"]["linux-rust"]["steps"] if s.get("id") == "cargo-cache")
            cache["with"]["restore-keys"] = "ci-v3-linux-rust-"
        self.rejects(change)

    def test_all_cargo_jobs_require_main_fallback_without_shared_writes(self):
        caches = [
            s for job in self.workflow["jobs"].values() for s in job["steps"]
            if s.get("uses", "").startswith("actions/cache")
            and "/save@" not in s["uses"]
        ]
        self.assertEqual(len(caches), 7)
        for cache in caches:
            self.assertIn("${{ env.CI_CACHE_SCOPE }}", cache["with"]["key"])
            self.assertIn("-main-", cache["with"]["restore-keys"].splitlines()[0])
        validate(self.workflow)

    def test_missing_main_fallback_is_rejected(self):
        def change(w):
            cache = next(s for s in w["jobs"]["macos-native"]["steps"] if s.get("id") == "cargo-cache")
            del cache["with"]["restore-keys"]
        self.rejects(change)

    def test_other_pr_fallback_is_rejected(self):
        def change(w):
            cache = next(s for s in w["jobs"]["linux-rust"]["steps"] if s.get("id") == "cargo-cache")
            cache["with"]["restore-keys"] = cache["with"]["restore-keys"].replace("-main-", "-pr-123-")
        self.rejects(change)

    def test_shared_main_primary_key_is_rejected(self):
        def change(w):
            cache = next(s for s in w["jobs"]["desktop-platforms"]["steps"] if s.get("id") == "cargo-cache")
            cache["with"]["key"] = cache["with"]["key"].replace("${{ env.CI_CACHE_SCOPE }}", "main")
        self.rejects(change)

    def test_saving_to_the_matched_fallback_key_is_rejected(self):
        def change(w):
            cache = next(s for s in w["jobs"]["linux-rust"]["steps"] if s.get("uses", "").startswith("actions/cache/save@"))
            cache["with"]["key"] = "${{ steps.cargo-cache.outputs.cache-matched-key }}"
        self.rejects(change)

    def test_narrowed_vitest_run_is_rejected(self):
        def change(w):
            vitest = next(s for s in w["jobs"]["vitest"]["steps"] if s.get("name") == "vitest")
            vitest["run"] = "pnpm vitest run src --shard=${{ matrix.part }}/4"
        self.rejects(change)

    def test_missing_vitest_part_is_rejected(self):
        self.rejects(lambda w: w["jobs"]["vitest"]["strategy"]["matrix"]["part"].pop())

    def test_changed_rust_part_is_rejected(self):
        # Dropping one skip would run those tests twice; dropping a filter would run them never.
        for index, tests in [(1, "session:: --skip session::watch_tests::prompts"), (2, "--skip session:: --skip remote:: --skip pty::")]:
            with self.subTest(tests=tests):
                self.rejects(lambda w: w["jobs"]["linux-rust-tests"]["strategy"]["matrix"]["include"][index].update(tests=tests))

    def test_narrowed_rust_part_is_rejected(self):
        def change(w):
            run = next(s for s in w["jobs"]["linux-rust-tests"]["steps"] if "matrix.tests" in s.get("run", ""))
            run["if"] = "matrix.part != 'prompts'"
        self.rejects(change)

    def test_commit_keyed_cache_is_rejected(self):
        # One per commit fills the repository's cache and evicts the ones still in use.
        def change(w):
            cache = next(s for s in w["jobs"]["macos-native"]["steps"] if s.get("id") == "cargo-cache")
            cache["with"]["key"] += "-${{ github.sha }}"
        self.rejects(change)

    def test_cache_saved_over_a_restored_one_is_rejected(self):
        def change(w):
            cache = next(s for s in w["jobs"]["linux-rust"]["steps"] if s.get("uses", "").startswith("actions/cache/save@"))
            cache["if"] = "steps.cargo-cache.outputs.cache-hit != 'true'"
        self.rejects(change)

    def test_self_saving_cache_action_is_rejected(self):
        def change(w):
            cache = next(s for s in w["jobs"]["headless-serve"]["steps"] if s.get("id") == "cargo-cache")
            cache["uses"] = cache["uses"].replace("actions/cache/restore@", "actions/cache@")
        self.rejects(change)

    def test_macos_runner_outside_the_selected_jobs_is_rejected(self):
        self.rejects(lambda w: w["jobs"]["frontend"].update({"runs-on": "macos-latest"}))
        self.rejects(lambda w: w["jobs"]["legacy-runtime-probe"]["strategy"]["matrix"].update(os=["instabox-medium", "macos-latest"]))

    def test_unselected_job_condition_is_rejected(self):
        self.rejects(lambda w: w["jobs"]["linux-rust-tests"].update({"if": "github.event_name != 'pull_request'"}))
        self.rejects(lambda w: w["jobs"]["macos-native"].update({"if": "github.event_name != 'pull_request'"}))

    def test_cancelling_a_running_main_job_is_rejected(self):
        self.rejects(lambda w: w["jobs"]["macos-native"]["concurrency"].update({"cancel-in-progress": "true"}))

    def test_aggregate_accepts_a_skip_only_on_the_selectors_word(self):
        w = self.workflow
        self.assertTrue(gate_passes(w, results(w)))
        self.assertTrue(gate_passes(w, results(w, required="false", macos_native="skipped")))
        self.assertTrue(gate_passes(w, results(w, machines="false", machine_compat="skipped")))
        self.assertTrue(gate_passes(w, results(w, required="false", machines="false", macos_native="skipped", machine_compat="skipped")))
        # Selected, but it did not run.
        self.assertFalse(gate_passes(w, results(w, macos_native="skipped")))
        self.assertFalse(gate_passes(w, results(w, required="false", machine_compat="skipped")))
        # The selector said nothing, or failed.
        self.assertFalse(gate_passes(w, results(w, required="", macos_native="skipped")))
        self.assertFalse(gate_passes(w, results(w, required="false", macos_native="skipped", macos_rust_changes="failure")))
        # Unselected is skipped, not cancelled or failed.
        self.assertFalse(gate_passes(w, results(w, required="false", macos_native="cancelled")))
        self.assertFalse(gate_passes(w, results(w, required="false", macos_native="failure")))
        # No other job may be skipped, whatever the selector said.
        for name in set(w["jobs"]) - {"check", *SELECTED}:
            with self.subTest(job=name):
                self.assertFalse(gate_passes(w, results(w, required="false", machines="false", **{name.replace("-", "_"): "skipped"})))
                self.assertFalse(gate_passes(w, results(w, **{name.replace("-", "_"): "failure"})))

    def test_missing_gate_dependency_is_rejected(self):
        self.rejects(lambda w: w["jobs"]["check"]["needs"].remove("linux-rust"))

    def test_missing_macos_tool_check_is_rejected(self):
        def change(w):
            show = next(s for s in w["jobs"]["macos-native"]["steps"] if s.get("name") == "Show the Rust toolchain")
            show["run"] = show["run"].replace(" && command -v rg", "")
        self.rejects(change)

    def test_missing_security_fixture_dependency_is_rejected(self):
        def change(w):
            install = next(s for s in w["jobs"]["linux-rust"]["steps"] if s.get("name") == "Install Linux build dependencies")
            install["run"] = install["run"].replace(" ripgrep", "")
        self.rejects(change)


if __name__ == "__main__":
    unittest.main()
