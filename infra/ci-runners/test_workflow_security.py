"""Guard the public-repository CI contract, including negative policy fixtures.

This checks the checked-in workflows, not fork-controlled copies of them. Access
to registered runners still needs the external boundary in CI-RUNNERS.md.
"""
from copy import deepcopy
import json
import os
from pathlib import Path
import re
import subprocess
import tomllib
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/ci.yml"
WEBKIT_LINUX = ROOT / ".github/workflows/webkit-linux.yml"
NEXTEST = ROOT / "src-tauri/.config/nextest.toml"
SERVE_TESTS = ROOT / "src-tauri/serve/tests"
HOSTED = {"ubuntu-latest", "macos-latest", "windows-latest"}
MAIN_RUNNER = "${{ github.ref == 'refs/heads/main' && contains(fromJSON('[\"push\",\"schedule\",\"workflow_dispatch\"]'), github.event_name) && vars.CI_LINUX_RUNNER || 'ubuntu-latest' }}"
CACHE_SCOPE = "${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || (github.ref == 'refs/heads/main' && 'main') || format('run-{0}', github.run_id) }}"


# Only these may be skipped, each on one answer of the selector, and `check`
# accepts the skip only when that answer was "false".
SELECTED = {
    "macos-native": "required",
    "machine-compat": "machines",
    "linux-rust": "rust",
    "linux-rust-tests": "rust",
    "headless-serve": "rust",
    "serve-tests": "rust",
    "vitest": "frontend",
    "webkit-layout": "frontend",
    "phone-app": "phone",
}
ANSWERS = ["required", "rust", "frontend", "phone", "machines"]
# Only these may take a macOS runner.
MACOS = {"macos-native", "machine-compat", "webkit-layout"}
# The Linux Rust suite: the library's tests in four parts, then the rest of `cargo test`.
PARTS = ["1", "2", "3", "4", "binaries"]
LIBRARY_PART = 'set -o pipefail\ncargo nextest run --locked --lib --profile ci --partition count:${{ matrix.part }}/4 2>&1 | tee "$RUNNER_TEMP/nextest.log"\n'
VITEST_PARTS = ["1", "2", "3", "4"]
LOCK = "${{ hashFiles('src-tauri/Cargo.lock') }}"
CACHE_MISS = "!endsWith(steps.cargo-cache.outputs.cache-matched-key, hashFiles('src-tauri/Cargo.lock'))"
CLEAN = "cargo clean --locked -p raccoon -p terminalx-serve && rm -rf target/debug/incremental"
# The cache each job restores. serve-tests builds what headless-serve builds: it restores that job's and saves none.
CACHES = {
    "linux-rust": "linux-rust", "linux-rust-tests": "linux-rust-tests", "macos-native": "macos-native",
    "headless-serve": "headless-serve", "serve-tests": "headless-serve", "machine-compat": "machine-compat",
    "machines-e2e": "machines-e2e", "desktop-platforms": "desktop-platforms",
}
RESTORE_ONLY = {"serve-tests"}
# The serve test binaries serve-tests leaves to another job, and the job that runs each.
SERVE_ELSEWHERE = {
    "machine_compat": "machine-compat", "machines_e2e": "machines-e2e", "machine_routes": "machines-e2e",
    "local_issue_start": "headless-serve",
}
STAND_IN = "mkdir -p dist && printf '<!doctype html><title>TerminalX</title>\\n' > dist/index.html"


def cache_key(name, scope, lock=LOCK):
    return f"ci-v5-{name}-{scope}-${{{{ runner.os }}}}-${{{{ runner.arch }}}}-${{{{ steps.toolchain.outputs.rustc }}}}-{lock}"


def load(path):
    return yaml.load(path.read_text(), Loader=yaml.BaseLoader)


def gate_passes(workflow, needs):
    """Run the aggregate's own script against these job results."""
    script = workflow["jobs"]["check"]["steps"][0]["run"]
    done = subprocess.run(["bash", "-c", script], env={**os.environ, "RESULTS": json.dumps(needs)}, capture_output=True)
    return done.returncode == 0


def results(workflow, skipped=(), ended=None, **answers):
    """Every job succeeded and every answer was "true", but for the jobs `skipped` or `ended` otherwise and for `answers`."""
    needs = {name: {"result": "success", "outputs": {}} for name in workflow["jobs"] if name != "check"}
    needs["macos-rust-changes"]["outputs"] = {answer: answers.get(answer, "true") for answer in ANSWERS}
    for name, result in {**{name: "skipped" for name in skipped}, **(ended or {})}.items():
        needs[name]["result"] = result
    return needs


def runs(job):
    return [step.get("run", "") for step in job["steps"]]


def validate_common(workflow):
    """What holds for every workflow a pull request starts."""
    assert workflow.get("permissions") == {"contents": "read"}, "workflow token must be read-only"
    for expression in re.findall(r"\$\{\{.*?\}\}", str(workflow), re.DOTALL):
        assert not re.search(r"\bsecrets\b", expression, re.IGNORECASE), "secret expression anywhere in workflow"
    assert not {"pull_request_target", "workflow_run"} & set(workflow["on"]), "privileged trigger"
    # nextest reads NEXTEST_* (NEXTEST_RETRIES among them) over its file: a workflow sets none, and passes no
    # --retries, so the file's per-test list is the only place a retry comes from. The two names the install step
    # uses for the release and its checksum are that step's alone.
    allowed = {"NEXTEST_VERSION", "NEXTEST_SHA256"}
    assert not any(key.startswith("NEXTEST_") for key in workflow.get("env", {})), "a NEXTEST_ variable for the whole workflow"
    for name, job in workflow["jobs"].items():
        assert not any(key.startswith("NEXTEST_") for key in job.get("env", {})), f"a NEXTEST_ variable for job {name}"
        for step in job["steps"]:
            extra = {key for key in step.get("env", {}) if key.startswith("NEXTEST_")} - (allowed if step.get("name") == "Install cargo-nextest" else set())
            assert not extra, f"a NEXTEST_ variable in {name}: {sorted(extra)}"
            assert not re.search(r"NEXTEST_\w+=|--retries\b|--no-fail-fast\b.*--retries", step.get("run", "")), f"a retry set outside nextest.toml in {name}"
    for name, job in workflow["jobs"].items():
        assert "permissions" not in job, "job token escalation"
        assert "secrets" not in job, "job secrets"
        assert "continue-on-error" not in job, "required job failure ignored"
        for step in job["steps"]:
            action = step.get("uses", "")
            if action:
                assert re.fullmatch(r"[\w.-]+/[\w./-]+@[0-9a-f]{40}", action), "mutable action reference"
            inputs = step.get("with", {})
            if action.startswith("actions/checkout@"):
                assert inputs.get("persist-credentials") == "false", "checkout token persisted"
            if action.startswith("actions/setup-node@"):
                assert "cache" not in inputs, "implicit shared Node cache"
            assert "secrets." not in str(step), "secret expression"
            assert "continue-on-error" not in step, "required step failure ignored"
            if re.search(r"apt-get\b.*\binstall\b", step.get("run", "")):
                # A stalled download is no error to apt without a timeout, so retries alone never fire: every apt-get call has both.
                calls = step["run"].count("apt-get ")
                assert calls and all(step["run"].count(option) == calls for option in ("Acquire::Retries=5", "Acquire::http::Timeout=30", "Acquire::https::Timeout=30")) and "timeout-minutes" in step, "a package install without retries, a stall limit and a time limit"


def validate(workflow):
    validate_common(workflow)
    assert set(workflow["on"]) == {"pull_request", "push", "schedule", "workflow_dispatch"}, "unexpected trigger"
    assert workflow["on"]["pull_request"] == "", "a pull request based on any branch runs CI"
    assert workflow["on"]["push"]["branches"] == ["main"], "push scope"
    assert workflow["env"]["CI_CACHE_SCOPE"] == CACHE_SCOPE, "cache trust scope"
    jobs = workflow["jobs"]
    assert {"check", "frontend", "webkit-layout"} <= jobs.keys(), "required status names"
    assert set(jobs["check"]["needs"]) == jobs.keys() - {"check"}, "aggregate must require every job"
    assert jobs["check"]["if"] == "always()", "aggregate must report failures and cancellations"
    gate = jobs["check"]["steps"][0]["run"]
    assert '$selector.result == "success"' in gate, "a skip is accepted on a failed selector's word"
    accepted = re.search(r"(\{[^{}]*\}) as \$selected", gate)
    assert accepted and json.loads(accepted.group(1)) == SELECTED, "aggregate must reject every other skipped dependency"
    assert '$selector.outputs[$selected[$job]] == "false"' in gate and "$selected[$job] != null" in gate, "a skip is accepted only on the selector's own answer"
    selector = jobs["macos-rust-changes"]
    assert set(selector["outputs"]) == set(ANSWERS), "the selector's answers"
    assert any("macos-rust.py --all" in run and "macos-rust.py --base" in run for run in runs(selector)), "everything runs unless it is a pull request"
    for name, job in jobs.items():
        if name in SELECTED:
            assert job["if"] == f"needs.macos-rust-changes.outputs.{SELECTED[name]} == 'true'", "job selection"
            assert job["needs"] == "macos-rust-changes", "selection dependency"
        elif name != "check":
            assert "if" not in job, "a job the aggregate would see skipped"
        if name in {"macos-native", "machine-compat"}:
            assert job["concurrency"] == {
                "group": f"ci-{name}-${{{{ github.event_name == 'push' && 'main' || github.run_id }}}}",
                "cancel-in-progress": "false",
            }, "main keeps the running macOS job and the newest waiting one; other runs are not grouped"
        else:
            assert "concurrency" not in job, "a job another run could cancel"
        runner = job["runs-on"]
        if name == "linux-rust":
            assert runner == MAIN_RUNNER, "PRs must ignore the custom runner variable"
        elif runner == "${{ matrix.os }}":
            assert set(job["strategy"]["matrix"]["os"]) <= HOSTED - {"macos-latest"}, "custom or unselected macOS matrix runner"
        else:
            assert runner in HOSTED, "custom PR runner"
            assert (runner == "macos-latest") == (name in MACOS), "macOS runner time outside the selected jobs"
        restored = None
        previous = {}
        for step in job["steps"]:
            action = step.get("uses", "")
            inputs = step.get("with", {})
            if action.startswith("actions/cache"):
                assert name in CACHES, "unexpected cache"
                if "/save@" in action:
                    assert restored and name not in RESTORE_ONLY, "save without a restore, or by a job that only restores"
                    assert inputs["key"] == "${{ steps.cargo-cache.outputs.cache-primary-key }}", "save must use restored scope"
                    assert CACHE_MISS in step["if"], "a cache is saved only when none built from this lock file was restored"
                    assert previous.get("run") == CLEAN and previous.get("if") == step["if"] and previous.get("working-directory") == "src-tauri", "a cache must not hold this crate's own output"
                else:
                    assert "/restore@" in action, "a cache action that saves by itself"
                    assert step["id"] == "cargo-cache", "cache step name"
                    assert inputs["key"] == cache_key(CACHES[name], "${{ env.CI_CACHE_SCOPE }}"), "cache writes must stay in the run's own scope, keyed by compiler and lock file"
                    assert inputs.get("restore-keys", "").splitlines() == [cache_key(CACHES[name], "main"), cache_key(CACHES[name], "main", "")], "restore only own scope, then trusted main: the same lock file, else its newest for the same job, platform and compiler"
                    assert any(s.get("id") == "toolchain" and 'echo "rustc=$(rustc --version' in s.get("run", "") for s in job["steps"]), "cache key names the compiler"
                    restored = True
            previous = step
    assert not any(re.search(r"pnpm build(?!:)", run) for job in jobs.values() for run in runs(job)), "`pnpm build` runs tsc again: only `frontend` runs it"
    assert sum("pnpm exec tsc --noEmit" in run for job in jobs.values() for run in runs(job)) == 1, "tsc runs once"
    # frontend is never skipped: the policy and selector tests run whatever changed.
    frontend = jobs["frontend"]
    assert any("python3 -m unittest discover -s infra/ci-runners -p 'test_*.py'" in s.get("run", "") and "if" not in s for s in frontend["steps"]), "the CI policy tests run on every pull request"
    # The icon check calls `pnpm exec expo config`: it and every step before it (the install it needs) run whatever changed.
    icons = next((i for i, s in enumerate(frontend["steps"]) if "python3 scripts/test_icons.py" in s.get("run", "")), None)
    assert icons is not None and all("if" not in s for s in frontend["steps"][: icons + 1]), "the icon check and the install it needs run on every pull request"
    assert any("pnpm install --frozen-lockfile" in s.get("run", "") for s in frontend["steps"][:icons]), "the icon check runs after the packages are installed"
    assert any(s.get("run") == "pnpm exec tsc --noEmit" and s.get("if") == "needs.macos-rust-changes.outputs.frontend == 'true'" for s in frontend["steps"]), "tsc when the frontend changed"
    assert "pnpm --dir mobile test" in runs(jobs["phone-app"]) and "pnpm --dir mobile exec tsc --noEmit" in runs(jobs["phone-app"]), "the phone app's checks"
    rust = jobs["linux-rust"]["steps"]
    assert any(s.get("run") == "cargo clippy --locked --all-targets -- -D warnings" for s in rust), "Linux Clippy"
    # The full Linux Rust suite: every part of the library's tests, then the rest of `cargo test`.
    tests = jobs["linux-rust-tests"]
    assert tests["strategy"]["matrix"] == {"part": PARTS}, "the parts of the Linux Rust suite must stay exact"
    assert tests["strategy"]["fail-fast"] == "false", "every part reports"
    assert any(s.get("run") == LIBRARY_PART and s.get("if") == "matrix.part != 'binaries'" for s in tests["steps"]), "the library's tests, every part"
    others = next((s for s in tests["steps"] if s.get("run", "").startswith("cargo test --locked --bins --test '*'\n")), None)
    assert others and others["if"] == "matrix.part == 'binaries'" and others["run"].split("\n")[:2] == ["cargo test --locked --bins --test '*'", "cargo test --locked --doc"], "the other test binaries and the doc tests"
    assert any(s.get("run") == "cargo test --locked --no-default-features --features local-ui --lib control::issue_tests" and s.get("if") == "matrix.part == 'binaries'" for s in tests["steps"]), "the local owner path without desktop features"
    nextest = next(s for s in tests["steps"] if s.get("name") == "Install cargo-nextest")
    assert re.fullmatch(r"\d+\.\d+\.\d+", nextest["env"]["NEXTEST_VERSION"]) and re.fullmatch(r"[0-9a-f]{64}", nextest["env"]["NEXTEST_SHA256"]), "cargo-nextest by version and checksum"
    lines = nextest["run"].split("\n")
    check = next((i for i, line in enumerate(lines) if line == 'echo "$NEXTEST_SHA256  $RUNNER_TEMP/nextest.tar.gz" | sha256sum --check'), None)
    assert check is not None and all("nextest.tar.gz" not in line or "curl " in line for line in lines[:check]), "the archive is checked before it is opened"
    assert "$NEXTEST_VERSION/" in nextest["run"] and "latest" not in nextest["run"], "a named release, not the newest"
    vitest = jobs["vitest"]
    assert vitest["strategy"]["matrix"] == {"part": VITEST_PARTS}, "every part of the Vitest run"
    assert vitest["strategy"]["fail-fast"] == "false", "every part reports"
    assert any(s.get("run") == "pnpm vitest run --shard=${{ matrix.part }}/4" and "if" not in s for s in vitest["steps"]), "full Vitest run"
    assert any("install -y zsh && command -v zsh" in run for run in runs(vitest)), "the shell Vitest's terminal tests run"
    install = next(s for s in rust if s.get("name") == "Install Linux build dependencies")
    assert install["if"] == "runner.environment == 'github-hosted'", "sudo on the private pool"
    for steps in [rust, tests["steps"]]:
        install = next(s for s in steps if s.get("name") == "Install Linux build dependencies")
        assert "ripgrep" in install["run"] and "zsh" in install["run"], "security fixture dependencies"
        assert any(s.get("run") == STAND_IN for s in steps), "the Rust jobs build against a stand-in for the frontend's output"
    native = jobs["macos-native"]
    for steps in [rust, tests["steps"], native["steps"], jobs["serve-tests"]["steps"]]:
        assert any("command -v rg && command -v zsh" in s.get("run", "") for s in steps), "security fixtures must not skip missing tools"
    assert any(s.get("run") == "cargo test --locked" and s.get("if") == "${{ !cancelled() && steps.build.outcome == 'success' && github.event_name != 'pull_request' }}" for s in native["steps"]), "macOS full suite on main, nightly and manual runs"
    assert any(s.get("run") == "cargo test --locked --lib -- $(python3 ../infra/ci-runners/macos-rust.py --filters)" and s.get("if") == "${{ !cancelled() && steps.build.outcome == 'success' && github.event_name == 'pull_request' }}" for s in native["steps"]), "the Apple-only and system-dependent tests on a selected pull request"
    # Clippy on every run of the job, a pull request's too, ahead of the tests; and a Clippy failure does not stop
    # the build or the suite: they wait only on the last step before Clippy, and nothing continues on error.
    after_helper = "${{ !cancelled() && steps.helper.outcome == 'success' }}"
    names = [s.get("run", "") for s in native["steps"]]
    clippy = [i for i, run in enumerate(names) if run.startswith("cargo clippy")]
    build = names.index("cargo test --locked --lib --no-run")
    assert [names[i] for i in clippy] == ["cargo clippy --locked --test serde_field_naming -- -D warnings", "cargo clippy --locked --all-targets -- -D warnings"] and max(clippy) < build, "both macOS Clippy runs, ahead of the tests"
    assert "if" not in native["steps"][clippy[0]] and native["steps"][clippy[1]].get("if") == after_helper, "macOS Clippy on a pull request too"
    assert native["steps"][build].get("if") == after_helper and native["steps"][build].get("id") == "build", "macOS builds the library's tests whenever it runs, also after a lint"
    assert any(s.get("id") == "helper" and s.get("run") == "node scripts/build-computer-macos.mjs" for s in native["steps"][: clippy[0]]), "the step the build waits on"
    for name, job in jobs.items():
        assert "continue-on-error" not in job and all("continue-on-error" not in s for s in job["steps"]), f"{name} hides a failure"
    for check in ("swift test --package-path native/computer-use-macos", "node scripts/build-computer-macos.mjs"):
        assert any(s.get("run") == check and "if" not in s for s in native["steps"]), "the Swift tests and the helper build whenever macOS runs"
    # Every serve test binary runs somewhere: here, or in the job named for it.
    serve = next(run for run in runs(jobs["serve-tests"]) if "tests/*.rs" in run)
    left_out = re.search(r"^\s*([\w|]+)\) ;;$", serve, re.MULTILINE)
    assert left_out and set(left_out.group(1).split("|")) == set(SERVE_ELSEWHERE), "serve-tests leaves out only the binaries another job runs"
    assert '*) tests+=(--test "$name") ;;' in serve and 'cargo test --locked --bins "${tests[@]}"' in serve, "every other serve test binary"
    for binary, job in SERVE_ELSEWHERE.items():
        assert (SERVE_TESTS / f"{binary}.rs").exists(), f"{binary} is no longer a serve test binary"
        assert any(re.search(rf"\b{binary}\b", run) for run in runs(jobs[job])), f"{binary} is left out of serve-tests and {job} does not run it"
    webkit = jobs["webkit-layout"]
    assert "pnpm test:webkit-layout" in runs(webkit), "the WebKit checks"
    assert any(s.get("with", {}).get("name") == "machine-screens" and s["with"]["if-no-files-found"] == "error" for s in webkit["steps"]), "the machine screens are kept"


def validate_webkit_linux(workflow, required):
    """The Linux WebKit run: the same policy, every check in one part, and no say in what merges."""
    validate_common(workflow)
    assert set(workflow["on"]) == {"pull_request", "workflow_dispatch"}, "unexpected trigger"
    assert workflow["on"]["pull_request"] == "", "it runs for a pull request based on any branch"
    assert not set(workflow["jobs"]) & set(required), "a job that would report under a required status's name"
    for name, job in workflow["jobs"].items():
        assert job["runs-on"] == "ubuntu-latest", "hosted Linux only"
        assert "if" not in job, "every part runs on every pull request"
        assert not any(step.get("uses", "").startswith("actions/cache") for step in job["steps"]), "unexpected cache"
        assert job["strategy"] == {"fail-fast": "false", "matrix": {"part": VITEST_PARTS}}, "every part runs and reports"
        assert "node scripts/webkit/run-all.mjs --shard ${{ matrix.part }}/4" in runs(job), "every WebKit check, in exactly one part"


def validate_nextest(config):
    """The `ci` profile retries and reports; no profile leaves a test out."""
    ci = config["profile"]["ci"]
    assert ci["retries"] == 0, "a failed test fails the run"
    # Retries are for known flaky tests alone: one test by its exact name each, twice at most, and nothing else set.
    for override in ci.get("overrides", []):
        assert set(override) == {"filter", "retries"} and re.fullmatch(r"test\(=[\w:]+\)", override["filter"]) and override["retries"] in (1, 2), f"an override that does more than retry one named test: {override}"
    assert ci["fail-fast"] is False, "every test runs after a failure"
    assert ci.get("junit", {}).get("path") == "junit.xml", "the JUnit report CI keeps"
    assert ci["final-status-level"] == "flaky", "a test that passed on a retry is reported"
    for name, profile in config["profile"].items():
        assert "default-filter" not in profile and (name == "ci" or "overrides" not in profile), f"profile {name} could leave a test out or treat it differently"
    assert "test-groups" not in config, "a group could hide a test that cannot run beside others"


class WorkflowSecurity(unittest.TestCase):
    def setUp(self):
        self.workflow = load(WORKFLOW)

    def test_workflow_meets_public_repository_policy(self):
        validate(self.workflow)

    def rejects(self, mutate):
        changed = deepcopy(self.workflow)
        mutate(changed)
        with self.assertRaises(AssertionError):
            validate(changed)

    def step(self, w, job, **match):
        return next(s for s in w["jobs"][job]["steps"] if all(s.get(key, "").startswith(value) for key, value in match.items()))

    def test_unguarded_runner_variable_is_rejected(self):
        self.rejects(lambda w: w["jobs"]["linux-rust"].update({"runs-on": "${{ vars.CI_LINUX_RUNNER || 'ubuntu-latest' }}"}))

    def test_custom_matrix_runner_is_rejected(self):
        self.rejects(lambda w: w["jobs"]["legacy-runtime-probe"]["strategy"]["matrix"].update(os=["self-hosted"]))

    def test_privileged_trigger_is_rejected(self):
        self.rejects(lambda w: w["on"].update(pull_request_target={}))
        self.rejects(lambda w: w["on"].update(workflow_run={}))

    def test_branch_filter_on_pull_requests_is_rejected(self):
        self.rejects(lambda w: w["on"].update(pull_request={"branches": ["main"]}))

    def test_token_escalation_is_rejected(self):
        self.rejects(lambda w: w["jobs"]["frontend"].update(permissions={"contents": "write"}))

    def test_global_secret_environment_is_rejected(self):
        self.rejects(lambda w: w["env"].update(PRIVATE_TOKEN="${{ secrets['DEPLOY_TOKEN'] }}"))

    def test_mutable_action_is_rejected(self):
        self.rejects(lambda w: w["jobs"]["frontend"]["steps"][0].update(uses="actions/checkout@v4"))

    def test_shared_cache_fallback_is_rejected(self):
        def change(w):
            cache = self.step(w, "linux-rust", id="cargo-cache")
            cache["with"]["restore-keys"] = "ci-v5-linux-rust-"
        self.rejects(change)

    def test_all_cargo_jobs_require_main_fallback_without_shared_writes(self):
        caches = [
            s for job in self.workflow["jobs"].values() for s in job["steps"]
            if s.get("uses", "").startswith("actions/cache")
            and "/save@" not in s["uses"]
        ]
        self.assertEqual(len(caches), len(CACHES))
        for cache in caches:
            self.assertIn("${{ env.CI_CACHE_SCOPE }}", cache["with"]["key"])
            for fallback in cache["with"]["restore-keys"].splitlines():
                self.assertIn("-main-", fallback)
        saves = [name for name, job in self.workflow["jobs"].items() if any("/save@" in s.get("uses", "") for s in job["steps"])]
        self.assertEqual(set(saves), set(CACHES) - RESTORE_ONLY)
        validate(self.workflow)

    def test_missing_main_fallback_is_rejected(self):
        def change(w):
            del self.step(w, "macos-native", id="cargo-cache")["with"]["restore-keys"]
        self.rejects(change)

    def test_other_pr_fallback_is_rejected(self):
        def change(w):
            cache = self.step(w, "linux-rust", id="cargo-cache")
            cache["with"]["restore-keys"] = cache["with"]["restore-keys"].replace("-main-", "-pr-123-")
        self.rejects(change)

    def test_fallback_to_another_job_platform_or_compiler_is_rejected(self):
        for old, new in [("ci-v5-linux-rust-main", "ci-v5-main"), ("-${{ runner.os }}", ""), ("-${{ steps.toolchain.outputs.rustc }}", "")]:
            with self.subTest(dropped=old):
                def change(w):
                    cache = self.step(w, "linux-rust", id="cargo-cache")
                    first, second = cache["with"]["restore-keys"].splitlines()
                    cache["with"]["restore-keys"] = "\n".join([first, second.replace(old, new)])
                self.rejects(change)

    def test_shared_main_primary_key_is_rejected(self):
        def change(w):
            cache = self.step(w, "desktop-platforms", id="cargo-cache")
            cache["with"]["key"] = cache["with"]["key"].replace("${{ env.CI_CACHE_SCOPE }}", "main")
        self.rejects(change)

    def test_saving_to_the_matched_fallback_key_is_rejected(self):
        def change(w):
            self.step(w, "linux-rust", uses="actions/cache/save@")["with"]["key"] = "${{ steps.cargo-cache.outputs.cache-matched-key }}"
        self.rejects(change)

    def test_cache_holding_this_crates_output_is_rejected(self):
        def change(w):
            steps = w["jobs"]["macos-native"]["steps"]
            steps.remove(next(s for s in steps if s.get("run") == CLEAN))
        self.rejects(change)
        self.rejects(lambda w: self.step(w, "headless-serve", run="cargo clean").update({"run": "cargo clean --locked -p terminalx-serve"}))
        self.rejects(lambda w: self.step(w, "linux-rust", run="cargo clean").update({"if": "always()"}))

    def test_cache_saved_by_a_job_that_only_restores_is_rejected(self):
        def change(w):
            w["jobs"]["serve-tests"]["steps"] += deepcopy([s for s in w["jobs"]["headless-serve"]["steps"] if s.get("run") == CLEAN or "/save@" in s.get("uses", "")])
        self.rejects(change)

    def test_narrowed_vitest_run_is_rejected(self):
        self.rejects(lambda w: self.step(w, "vitest", name="vitest").update({"run": "pnpm vitest run src --shard=${{ matrix.part }}/4"}))

    def test_missing_vitest_part_is_rejected(self):
        self.rejects(lambda w: w["jobs"]["vitest"]["strategy"]["matrix"]["part"].pop())

    def test_changed_rust_part_is_rejected(self):
        # A part taken away runs its tests never; a different divisor runs some twice and some never.
        self.rejects(lambda w: w["jobs"]["linux-rust-tests"]["strategy"]["matrix"]["part"].remove("3"))
        self.rejects(lambda w: w["jobs"]["linux-rust-tests"]["strategy"]["matrix"]["part"].remove("binaries"))
        for run in [LIBRARY_PART.replace("/4", "/5"), LIBRARY_PART + " -E 'not test(/slow/)'", LIBRARY_PART.replace(" --profile ci", ""), LIBRARY_PART + " --no-fail-fast --ignore-default-filter -- --skip session::"]:
            with self.subTest(run=run):
                self.rejects(lambda w: self.step(w, "linux-rust-tests", name="The library's tests, this part").update({"run": run}))

    def test_retries_set_outside_the_nextest_file_are_rejected(self):
        self.rejects(lambda w: w.setdefault("env", {}).update(NEXTEST_RETRIES="2"))
        self.rejects(lambda w: w["jobs"]["linux-rust-tests"].setdefault("env", {}).update(NEXTEST_RETRIES="2"))
        self.rejects(lambda w: self.step(w, "linux-rust-tests", name="The library's tests, this part").setdefault("env", {}).update(NEXTEST_PROFILE="default"))
        self.rejects(lambda w: self.step(w, "linux-rust-tests", name="Install cargo-nextest")["env"].update(NEXTEST_RETRIES="2"))
        self.rejects(lambda w: self.step(w, "linux-rust-tests", name="Show the Rust toolchain").update({"run": "echo NEXTEST_RETRIES=2 >> \"$GITHUB_ENV\""}))

    def test_narrowed_rust_part_is_rejected(self):
        self.rejects(lambda w: self.step(w, "linux-rust-tests", name="The library's tests, this part").update({"if": "matrix.part == '1'"}))
        self.rejects(lambda w: self.step(w, "linux-rust-tests", name="cargo test (the other").update({"run": "cargo test --locked --bins"}))
        self.rejects(lambda w: self.step(w, "linux-rust-tests", run="cargo test --locked --no-default-features").update({"if": "false"}))

    def test_unchecked_or_unpinned_nextest_is_rejected(self):
        def install(w):
            return self.step(w, "linux-rust-tests", name="Install cargo-nextest")
        self.rejects(lambda w: install(w).update({"run": install(w)["run"].replace('echo "$NEXTEST_SHA256  $RUNNER_TEMP/nextest.tar.gz" | sha256sum --check\n', "")}))
        self.rejects(lambda w: install(w).update({"run": install(w)["run"].replace("$NEXTEST_VERSION/", "latest/")}))
        self.rejects(lambda w: install(w)["env"].update(NEXTEST_VERSION="latest"))
        self.rejects(lambda w: install(w)["env"].update(NEXTEST_SHA256=""))

        def opened_first(w):
            lines = install(w)["run"].split("\n")
            lines[1], lines[2] = lines[2], lines[1]
            install(w)["run"] = "\n".join(lines)
        self.rejects(opened_first)

    def test_commit_keyed_cache_is_rejected(self):
        # One per commit fills the repository's cache and evicts the ones still in use.
        def change(w):
            self.step(w, "macos-native", id="cargo-cache")["with"]["key"] += "-${{ github.sha }}"
        self.rejects(change)

    def test_cache_saved_over_a_restored_one_is_rejected(self):
        for condition in ["steps.cargo-cache.outputs.cache-hit != 'true'", "always()"]:
            with self.subTest(condition=condition):
                def change(w):
                    for step in w["jobs"]["linux-rust"]["steps"]:
                        if step.get("run") == CLEAN or "/save@" in step.get("uses", ""):
                            step["if"] = condition
                self.rejects(change)

    def test_self_saving_cache_action_is_rejected(self):
        def change(w):
            cache = self.step(w, "headless-serve", id="cargo-cache")
            cache["uses"] = cache["uses"].replace("actions/cache/restore@", "actions/cache@")
        self.rejects(change)

    def test_macos_runner_outside_the_selected_jobs_is_rejected(self):
        self.rejects(lambda w: w["jobs"]["frontend"].update({"runs-on": "macos-latest"}))
        self.rejects(lambda w: w["jobs"]["serve-tests"].update({"runs-on": "macos-latest"}))
        self.rejects(lambda w: w["jobs"]["legacy-runtime-probe"]["strategy"]["matrix"].update(os=["ubuntu-latest", "macos-latest"]))

    def test_unselected_job_condition_is_rejected(self):
        self.rejects(lambda w: w["jobs"]["linux-rust-tests"].update({"if": "github.event_name != 'pull_request'"}))
        self.rejects(lambda w: w["jobs"]["macos-native"].update({"if": "github.event_name != 'pull_request'"}))
        # The right selector, the wrong question; and a job no question may skip.
        self.rejects(lambda w: w["jobs"]["linux-rust"].update({"if": "needs.macos-rust-changes.outputs.frontend == 'true'"}))
        self.rejects(lambda w: w["jobs"]["frontend"].update({"if": "needs.macos-rust-changes.outputs.frontend == 'true'"}))
        self.rejects(lambda w: w["jobs"]["machines-e2e"].update({"if": "needs.macos-rust-changes.outputs.machines == 'true'"}))

    def test_policy_tests_that_could_be_skipped_are_rejected(self):
        for name in ("Verify the CI policy", "Verify portable source icons", "Install npm dependencies"):
            self.rejects(lambda w, name=name: self.step(w, "frontend", name=name).update({"if": "needs.macos-rust-changes.outputs.frontend == 'true'"}))
        # The first run of this shape failed here: the icon check ran before pnpm was there.
        self.rejects(lambda w: w["jobs"]["frontend"]["steps"].insert(1, w["jobs"]["frontend"]["steps"].pop(next(i for i, s in enumerate(w["jobs"]["frontend"]["steps"]) if s.get("name") == "Verify portable source icons"))))

    def test_a_second_tsc_is_rejected(self):
        self.rejects(lambda w: self.step(w, "webkit-layout", name="Build the frontend").update({"run": "pnpm build"}))
        self.rejects(lambda w: self.step(w, "macos-native", name="Build the frontend").update({"run": "pnpm exec tsc --noEmit && pnpm exec vite build"}))
        self.rejects(lambda w: self.step(w, "frontend", name="tsc").update({"if": "false"}))

    def test_missing_phone_checks_are_rejected(self):
        self.rejects(lambda w: w["jobs"]["phone-app"]["steps"].pop())

    def test_cancelling_a_running_main_job_is_rejected(self):
        self.rejects(lambda w: w["jobs"]["macos-native"]["concurrency"].update({"cancel-in-progress": "true"}))

    def test_narrowed_macos_run_is_rejected(self):
        self.rejects(lambda w: self.step(w, "macos-native", run="cargo test --locked --lib -- $(").update({"run": "cargo test --locked --lib -- dictation::"}))
        self.rejects(lambda w: self.step(w, "macos-native", name="cargo test (main").update({"if": "github.event_name == 'schedule'"}))
        self.rejects(lambda w: self.step(w, "macos-native", name="cargo test (main").update({"run": "cargo test --locked --lib"}))
        self.rejects(lambda w: self.step(w, "macos-native", run="cargo test --locked --lib --no-run").update({"if": "github.event_name != 'pull_request'"}))

    def test_macos_clippy_left_off_pull_requests_or_stopping_the_suite_is_rejected(self):
        for name in ("clippy (the library", "clippy"):
            self.rejects(lambda w, name=name: self.step(w, "macos-native", name=name).update({"if": "github.event_name != 'pull_request'"}))
            self.rejects(lambda w, name=name: self.step(w, "macos-native", name=name).update({"continue-on-error": True}))
        # Without its condition the build is skipped after a failed Clippy, and the suite with it.
        self.rejects(lambda w: self.step(w, "macos-native", run="cargo test --locked --lib --no-run").pop("if"))
        self.rejects(lambda w: self.step(w, "macos-native", name="cargo test (main").update({"if": "github.event_name != 'pull_request'"}))
        self.rejects(lambda w: self.step(w, "macos-native", name="clippy (the library").update({"run": "true"}))
        self.rejects(lambda w: self.step(w, "macos-native", name="clippy").update({"if": "false"}))
        self.rejects(lambda w: self.step(w, "macos-native", run="swift test").update({"if": "github.event_name != 'pull_request'"}))

    def test_serve_test_binary_run_by_no_job_is_rejected(self):
        def run(w):
            return next(s for s in w["jobs"]["serve-tests"]["steps"] if "tests/*.rs" in s.get("run", ""))
        self.rejects(lambda w: run(w).update({"run": run(w)["run"].replace("machine_compat|", "machine_compat|local_lifetime|")}))
        self.rejects(lambda w: run(w).update({"run": run(w)["run"].replace('*) tests+=(--test "$name") ;;', "owner_pretool) tests+=(--test owner_pretool) ;;")}))
        # Left out here because headless-serve runs it: not once that step is gone.
        self.rejects(lambda w: w["jobs"]["headless-serve"]["steps"].remove(self.step(w, "headless-serve", name="CLI issue starts")))

    def test_package_install_without_retries_or_a_limit_is_rejected(self):
        self.rejects(lambda w: self.step(w, "vitest", name="Install shells").update({"run": "sudo apt-get update && sudo apt-get install -y zsh && command -v zsh"}))
        self.rejects(lambda w: self.step(w, "linux-rust-tests", name="Install Linux build dependencies").pop("timeout-minutes"))

    def test_missing_vitest_shell_is_rejected(self):
        self.rejects(lambda w: w["jobs"]["vitest"]["steps"].remove(self.step(w, "vitest", name="Install shells")))

    def test_rust_job_without_the_stand_in_is_rejected(self):
        self.rejects(lambda w: w["jobs"]["linux-rust"]["steps"].remove(self.step(w, "linux-rust", name="Stand in")))

    def test_dropped_machine_screens_are_rejected(self):
        self.rejects(lambda w: w["jobs"]["webkit-layout"]["steps"].pop())
        self.rejects(lambda w: self.step(w, "webkit-layout", name="WebKit layout checks").update({"run": "node scripts/webkit/run-all.mjs --shard 1/4"}))

    def test_aggregate_accepts_a_skip_only_on_the_selectors_word(self):
        w = self.workflow
        self.assertTrue(gate_passes(w, results(w)))
        for name, answer in SELECTED.items():
            with self.subTest(job=name):
                self.assertTrue(gate_passes(w, results(w, skipped=[name], **{answer: "false"})))
                # Selected, but it did not run.
                self.assertFalse(gate_passes(w, results(w, skipped=[name])))
                # Another question's "false" is not this job's.
                others = {other: "false" for other in ANSWERS if other != answer}
                self.assertFalse(gate_passes(w, results(w, skipped=[name], **others)))
                # The selector said nothing, or failed.
                self.assertFalse(gate_passes(w, results(w, skipped=[name], **{answer: ""})))
                self.assertFalse(gate_passes(w, results(w, skipped=[name], ended={"macos-rust-changes": "failure"}, **{answer: "false"})))
                # Unselected is skipped, not cancelled or failed.
                for result in ("cancelled", "failure"):
                    self.assertFalse(gate_passes(w, results(w, ended={name: result}, **{answer: "false"})))
        nothing = {answer: "false" for answer in ANSWERS}
        self.assertTrue(gate_passes(w, results(w, skipped=list(SELECTED), **nothing)))
        # No other job may be skipped, whatever the selector said.
        for name in set(w["jobs"]) - {"check", *SELECTED}:
            with self.subTest(job=name):
                self.assertFalse(gate_passes(w, results(w, skipped=[name], **nothing)))
                self.assertFalse(gate_passes(w, results(w, ended={name: "failure"})))

    def test_missing_gate_dependency_is_rejected(self):
        self.rejects(lambda w: w["jobs"]["check"]["needs"].remove("linux-rust"))
        self.rejects(lambda w: w["jobs"]["check"]["needs"].remove("serve-tests"))

    def test_gate_accepting_another_skip_is_rejected(self):
        def change(w):
            gate = w["jobs"]["check"]["steps"][0]
            gate["run"] = gate["run"].replace('"phone-app": "phone"}', '"phone-app": "phone", "frontend": "frontend"}')
        self.rejects(change)

    def test_missing_selector_answer_is_rejected(self):
        self.rejects(lambda w: w["jobs"]["macos-rust-changes"]["outputs"].pop("rust"))

        def change(w):
            select = self.step(w, "macos-rust-changes", id="select")
            select["run"] = select["run"].replace("python3 infra/ci-runners/macos-rust.py --all", "echo 'required=true' >> \"$GITHUB_OUTPUT\"")
        self.rejects(change)

    def test_missing_macos_tool_check_is_rejected(self):
        def change(w):
            show = self.step(w, "macos-native", name="Show the Rust toolchain")
            show["run"] = show["run"].replace(" && command -v rg", "")
        self.rejects(change)

    def test_missing_security_fixture_dependency_is_rejected(self):
        def change(w):
            install = self.step(w, "linux-rust", name="Install Linux build dependencies")
            install["run"] = install["run"].replace(" ripgrep", "")
        self.rejects(change)


class WebKitOnLinux(unittest.TestCase):
    def setUp(self):
        self.workflow = load(WEBKIT_LINUX)
        self.required = load(WORKFLOW)["jobs"]

    def test_workflow_meets_the_same_policy(self):
        validate_webkit_linux(self.workflow, self.required)

    def rejects(self, mutate):
        changed = deepcopy(self.workflow)
        mutate(changed)
        with self.assertRaises(AssertionError):
            validate_webkit_linux(changed, self.required)

    def job(self, w):
        return w["jobs"]["webkit-layout-linux"]

    def test_it_is_no_part_of_the_required_run(self):
        self.assertNotIn("webkit-linux", WORKFLOW.read_text().replace(".github/workflows/webkit-linux.yml", ""))
        self.rejects(lambda w: w["jobs"].update({"webkit-layout": w["jobs"].pop("webkit-layout-linux")}))
        self.rejects(lambda w: w["jobs"].update(check=deepcopy(self.job(w))))

    def test_weaker_policy_is_rejected(self):
        self.rejects(lambda w: w.update(permissions={"contents": "write"}))
        self.rejects(lambda w: w.pop("permissions"))
        self.rejects(lambda w: w["on"].update(pull_request_target={}))
        self.rejects(lambda w: w["on"].update(push={"branches": ["main"]}))
        self.rejects(lambda w: self.job(w)["steps"][0].update(uses="actions/checkout@v4"))
        self.rejects(lambda w: self.job(w)["steps"][0]["with"].update({"persist-credentials": "true"}))
        self.rejects(lambda w: self.job(w).update({"runs-on": "self-hosted"}))
        self.rejects(lambda w: self.job(w).update({"runs-on": "macos-latest"}))
        self.rejects(lambda w: self.job(w).update(env={"TOKEN": "${{ secrets.DEPLOY_TOKEN }}"}))
        self.rejects(lambda w: self.job(w).update({"continue-on-error": "true"}))
        self.rejects(lambda w: self.job(w)["steps"].append({"uses": "actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830", "with": {"path": "dist", "key": "shared"}}))

    def test_branch_filter_is_rejected(self):
        # It must also run for a pull request based on another pull request's branch.
        self.rejects(lambda w: w["on"].update(pull_request={"branches": ["main"]}))

    def test_missing_or_narrowed_part_is_rejected(self):
        self.rejects(lambda w: self.job(w)["strategy"]["matrix"]["part"].pop())
        self.rejects(lambda w: self.job(w).update({"if": "matrix.part != '4'"}))
        self.rejects(lambda w: self.job(w)["steps"][-1].update({"run": "node scripts/webkit/run-all.mjs --shard ${{ matrix.part }}/5"}))
        self.rejects(lambda w: self.job(w)["steps"][-1].update({"run": "node scripts/webkit/run-all.mjs settings-navigation"}))


class NextestProfile(unittest.TestCase):
    def setUp(self):
        self.config = tomllib.loads(NEXTEST.read_text())

    def test_ci_profile_retries_reports_and_leaves_nothing_out(self):
        validate_nextest(self.config)

    def rejects(self, mutate):
        changed = deepcopy(self.config)
        mutate(changed)
        with self.assertRaises(AssertionError):
            validate_nextest(changed)

    def test_every_retried_test_names_its_ticket(self):
        text = NEXTEST.read_text()
        blocks = re.findall(r"^(.*)\n\[\[profile\.ci\.overrides\]\]$", text, re.M)
        self.assertEqual(len(blocks), len(self.config["profile"]["ci"].get("overrides", [])))
        for above in blocks:
            self.assertRegex(above, r"^# (PRO-\d+|#\d+)$", "the line above an override is its ticket")

    def test_wider_retries_are_rejected(self):
        self.rejects(lambda c: c["profile"]["ci"].update({"retries": 2}))
        self.rejects(lambda c: c["profile"]["ci"]["overrides"].append({"filter": "all()", "retries": 2}))
        self.rejects(lambda c: c["profile"]["ci"]["overrides"].append({"filter": "test(/session::/)", "retries": 1}))
        self.rejects(lambda c: c["profile"]["ci"]["overrides"].append({"filter": "test(=a::b)", "retries": 5}))
        self.rejects(lambda c: c["profile"]["ci"]["overrides"].append({"filter": "test(=a::b)", "retries": 1, "slow-timeout": "600s"}))
        self.rejects(lambda c: c["profile"]["default"].update({"overrides": [{"filter": "test(=a::b)", "retries": 1}]}))

    def test_profile_that_hides_a_test_is_rejected(self):
        self.rejects(lambda c: c["profile"]["ci"].update({"default-filter": "not test(/session::/)"}))
        self.rejects(lambda c: c["profile"]["default"].update({"default-filter": "not test(/session::/)"}))
        self.rejects(lambda c: c["profile"]["ci"].update(overrides=[{"filter": "test(/flaky/)", "retries": 10}]))
        self.rejects(lambda c: c.update({"test-groups": {"serial": {"max-threads": 1}}}))

    def test_profile_that_stops_early_or_reports_nothing_is_rejected(self):
        self.rejects(lambda c: c["profile"]["ci"].update({"fail-fast": True}))
        self.rejects(lambda c: c["profile"]["ci"].pop("junit"))
        self.rejects(lambda c: c["profile"]["ci"].update({"final-status-level": "fail"}))


if __name__ == "__main__":
    unittest.main()
