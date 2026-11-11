"""Guard the public-repository CI contract, including negative policy fixtures.

This checks the checked-in workflow, not fork-controlled copies of it. Access
to registered runners still needs the external boundary in CI-RUNNERS.md.
"""
from copy import deepcopy
from pathlib import Path
import re
import unittest

import yaml


WORKFLOW = Path(__file__).resolve().parents[2] / ".github/workflows/ci.yml"
HOSTED = {"ubuntu-latest", "macos-latest", "windows-latest"}
MAIN_RUNNER = "${{ github.ref == 'refs/heads/main' && contains(fromJSON('[\"push\",\"schedule\",\"workflow_dispatch\"]'), github.event_name) && vars.CI_LINUX_RUNNER || 'ubuntu-latest' }}"
CACHE_SCOPE = "${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || (github.ref == 'refs/heads/main' && 'main') || format('run-{0}', github.run_id) }}"


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
    assert '.result == "success"' in jobs["check"]["steps"][0]["run"], "aggregate must reject skipped dependencies"
    for name, job in jobs.items():
        assert "permissions" not in job, "job token escalation"
        assert "secrets" not in job, "job secrets"
        assert "continue-on-error" not in job, "required job failure ignored"
        runner = job["runs-on"]
        if name == "linux-rust":
            assert runner == MAIN_RUNNER, "PRs must ignore the custom runner variable"
        elif runner == "${{ matrix.os }}":
            assert set(job["strategy"]["matrix"]["os"]) <= HOSTED, "custom matrix runner"
        else:
            assert runner in HOSTED, "custom PR runner"
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
                if "/save@" in action:
                    assert inputs["key"] == "${{ steps.cargo-cache.outputs.cache-primary-key }}", "save must use restored scope"
                else:
                    prefix = f"ci-v3-{name}-${{{{ env.CI_CACHE_SCOPE }}}}-"
                    assert inputs["key"].startswith(prefix), "cache key crosses trust scopes"
                    for fallback in inputs.get("restore-keys", "").splitlines():
                        assert fallback.startswith(prefix), "cache fallback crosses trust scopes"
            assert "secrets." not in str(step), "secret expression"
            assert "continue-on-error" not in step, "required step failure ignored"
    rust = jobs["linux-rust"]["steps"]
    assert any(s.get("run") == "cargo test --locked" and "if" not in s for s in rust), "full Linux Rust suite"
    assert any(s.get("run") == "cargo clippy --locked --all-targets -- -D warnings" for s in rust), "Linux Clippy"
    install = next(s for s in rust if s.get("name") == "Install Linux build dependencies")
    assert install["if"] == "runner.environment == 'github-hosted'", "sudo on the private pool"
    assert "ripgrep" in install["run"] and "zsh" in install["run"], "security fixture dependencies"
    native = jobs["macos-native"]
    for steps in [rust, native["steps"]]:
        assert any("command -v rg && command -v zsh" in s.get("run", "") for s in steps), "security fixtures must not skip missing tools"
    assert native["needs"] == "macos-rust-changes", "macOS coverage selection dependency"
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

    def test_unguarded_runner_variable_is_rejected(self):
        self.rejects(lambda w: w["jobs"]["linux-rust"].update({"runs-on": "${{ vars.CI_LINUX_RUNNER || 'ubuntu-latest' }}"}))

    def test_custom_matrix_runner_is_rejected(self):
        self.rejects(lambda w: w["jobs"]["legacy-runtime-probe"]["strategy"]["matrix"].update(os=["self-hosted"]))

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
