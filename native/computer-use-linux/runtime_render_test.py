import importlib.util
import sys
import types
import unittest
from pathlib import Path


class FakeStateType:
    PROTECTED = 1
    SELECTED = 2
    FOCUSED = 3
    ACTIVE = 4
    SHOWING = 5


class FakeStateSet:
    def __init__(self, states):
        self.states = set(states)

    def contains(self, state):
        return state in self.states


class FakeSelection:
    def __init__(self, start_offset, end_offset):
        self.start_offset = start_offset
        self.end_offset = end_offset


class FakeText:
    @staticmethod
    def get_character_count(node):
        return len(node.value)

    @staticmethod
    def get_text(node, start, end):
        return node.value[start:end]

    @staticmethod
    def get_text_selections(node):
        return list(node.selections)


def load_runtime():
    gi = types.ModuleType("gi")
    repository = types.ModuleType("gi.repository")
    gi.require_version = lambda *_: None
    repository.Atspi = types.SimpleNamespace(StateType=FakeStateType, Text=FakeText)
    repository.Gdk = types.SimpleNamespace()
    repository.GdkPixbuf = types.SimpleNamespace()
    gi.repository = repository
    sys.modules["gi"] = gi
    sys.modules["gi.repository"] = repository

    path = Path(__file__).with_name("runtime.py")
    spec = importlib.util.spec_from_file_location("terminalx_linux_runtime_test", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


runtime = load_runtime()


class FakeAccessible:
    def __init__(self, role, name="", value="", children=(), counter=None, states=(), selections=(), pid=1234, rect=None, accessible_id=""):
        self.role = role
        self.name = name
        self.value = value
        self.children = list(children)
        self.states = set(states)
        self.selections = list(selections)
        self.pid = pid
        self.rect = rect
        self._accessible_id = accessible_id
        self.parent = None
        self.child_count_calls = 0
        self.child_at_calls = 0
        self.counter = counter or {"child_reads": 0, "state_reads": 0, "child_at_reads": 0}
        for child in self.children:
            child.parent = self
            child.use_counter(self.counter)

    def get_parent(self):
        return self.parent

    def use_counter(self, counter):
        self.counter = counter
        for child in self.children:
            child.use_counter(counter)

    def get_child_count(self):
        self.child_count_calls += 1
        self.counter["child_reads"] += 1
        return len(self.children)

    def get_child_at_index(self, index):
        self.child_at_calls += 1
        self.counter["child_reads"] += 1
        self.counter["child_at_reads"] += 1
        return self.children[index]

    def get_role_name(self):
        return self.role

    def get_name(self):
        return self.name

    def get_accessible_id(self):
        return self._accessible_id

    def get_toolkit_name(self):
        return "fake"

    def get_process_id(self):
        return self.pid

    def get_component_iface(self):
        return self if self.rect is not None else None

    def get_state_set(self):
        self.counter["state_reads"] += 1
        return FakeStateSet(self.states) if self.states else None

    def get_n_actions(self):
        return 0

    def is_text(self):
        return bool(self.value or self.selections)

    def get_text_iface(self):
        return self if (self.value or self.selections) else None

    def get_value_iface(self):
        return None


class FailingChildrenAccessible(FakeAccessible):
    def get_child_count(self):
        raise RuntimeError("defunct node")


def render(root):
    return runtime.render_accessibility_tree(root, None, [0])


class RuntimeRenderTest(unittest.TestCase):
    def test_named_non_generic_node_skips_unused_summary_walk(self):
        root = FakeAccessible("button", "Save", children=[FakeAccessible("text", "unused")])

        records, lines, truncation = render(root)

        self.assertEqual([record["name"] for record in records], ["Save"])
        self.assertEqual(lines, ["0 button Save"])
        self.assertEqual(root.counter["child_reads"], 0)
        self.assertFalse(truncation["truncated"])

    def test_named_generic_node_skips_unused_summary_walk(self):
        root = FakeAccessible("section", "Details", children=[FakeAccessible("text", "body")])

        records, lines, _ = render(root)

        self.assertEqual([record["name"] for record in records], ["Details", "body"])
        self.assertEqual(lines, ["0 section Details", "\t1 text body"])
        self.assertEqual(root.counter["child_reads"], 3)

    def test_unnamed_generic_node_keeps_plain_text_summary(self):
        root = FakeAccessible(
            "section",
            children=[FakeAccessible("text", "Alpha"), FakeAccessible("text", "Beta")],
        )

        records, lines, _ = render(root)

        self.assertEqual(len(records), 1)
        self.assertEqual(lines, ["0 section, Text: Alpha Beta"])
        # Single-pass cached read: root (1 count + 2 child lookups) + 2 leaves (1 count each) = 5.
        self.assertEqual(root.counter["child_reads"], 5)

    def test_row_keeps_its_specific_summary_walk(self):
        root = FakeAccessible(
            "row",
            "Invoice",
            children=[FakeAccessible("text", "Alpha"), FakeAccessible("text", "Beta")],
        )

        records, lines, _ = render(root)

        self.assertEqual([record["name"] for record in records], ["Invoice", "Alpha", "Beta"])
        self.assertEqual(lines, ["0 row Invoice, Text: Alpha Beta", "\t1 text Alpha", "\t2 text Beta"])
        # Single-pass cached read: row children read once and reused during tree rendering.
        self.assertEqual(root.counter["child_reads"], 5)

    def test_nested_generic_containers_do_not_rewalk_depth_four_subtrees(self):
        leaf_button = FakeAccessible("button", "Submit")
        leaf_text = FakeAccessible("text", "Hint")
        inner = FakeAccessible("panel", children=[leaf_button, leaf_text])
        level3 = FakeAccessible("section", children=[inner])
        level2 = FakeAccessible("section", children=[level3])
        level1 = FakeAccessible("section", children=[level2])
        root = FakeAccessible("panel", children=[level1])

        records, lines, _ = render(root)

        self.assertEqual([record["name"] for record in records], ["", "Submit", "Hint"])
        self.assertEqual(lines, ["0 panel", "\t1 button Submit", "\t2 text Hint"])
        for node in (root, level1, level2, level3, inner, leaf_button, leaf_text):
            self.assertLessEqual(node.child_count_calls, 1)

    def test_make_snapshot_captures_focus_and_selection_in_single_pass(self):
        focused_input = FakeAccessible(
            "entry",
            "Search",
            value="hello world",
            states={FakeStateType.FOCUSED},
            selections=[FakeSelection(6, 11)],
        )
        other_button = FakeAccessible("button", "Cancel")
        window = FakeAccessible(
            "frame",
            "Demo Window",
            children=[other_button, focused_input],
            states={FakeStateType.ACTIVE, FakeStateType.SHOWING},
        )
        app = FakeAccessible("application", "DemoApp", children=[window])

        original_find_app = runtime.find_app
        original_choose_window = runtime.choose_window
        try:
            runtime.find_app = lambda query, own_app=None: app
            runtime.choose_window = lambda a, wid, widx: (0, window)
            snapshot = runtime.make_snapshot("DemoApp", include_screenshot=False)
        finally:
            runtime.find_app = original_find_app
            runtime.choose_window = original_choose_window

        self.assertEqual(snapshot["focusedSummary"], "entry Search")
        self.assertEqual(snapshot["selectedText"], "world")
        # Each node in the window is traversed only once (no separate focused_summary/selected_text walks).
        self.assertEqual(window.child_count_calls, 1)
        self.assertEqual(window.child_at_calls, 2)
        self.assertEqual(focused_input.child_count_calls, 1)
        self.assertEqual(other_button.child_count_calls, 0)

    def test_find_by_path_indexes_directly_without_scanning_siblings(self):
        target_leaf = FakeAccessible("button", "Target")
        siblings = [FakeAccessible("panel", f"Item {i}") for i in range(100)]
        siblings[73] = FakeAccessible("panel", "Holder", children=[target_leaf])
        root = FakeAccessible("application", "App", children=siblings)

        found = runtime.find_by_path(root, [73, 0])

        self.assertIs(found, target_leaf)
        # Only 2 direct get_child_at_index calls along path [73, 0], never scanning all 100 siblings.
        self.assertEqual(root.counter["child_at_reads"], 2)
        self.assertIsNone(runtime.find_by_path(root, [-1]))
        self.assertIsNone(runtime.find_by_path(root, [100]))
        self.assertIsNone(runtime.find_by_path(root, ["not-an-int"]))
        self.assertIsNone(runtime.find_by_path(FailingChildrenAccessible("application", "Broken"), [0]))

    def test_empty_generic_wrapper_keeps_elision_path_and_depth(self):
        root = FakeAccessible("section", children=[FakeAccessible("button", "Continue")])

        records, lines, _ = render(root)

        self.assertEqual([record["runtimeId"] for record in records], [[0, 0]])
        self.assertEqual(lines, ["0 button Continue"])

    def test_child_failure_keeps_fail_soft_row_output(self):
        root = FailingChildrenAccessible("row", "Invoice")

        records, lines, truncation = render(root)

        self.assertEqual([record["name"] for record in records], ["Invoice"])
        self.assertEqual(lines, ["0 row Invoice"])
        self.assertFalse(truncation["truncated"])

    def test_node_limit_keeps_exact_prefix_and_truncation(self):
        root = FakeAccessible(
            "document",
            "Results",
            children=[FakeAccessible("text", f"Item {index}") for index in range(runtime.MAX_NODES)],
        )

        records, _, truncation = render(root)

        self.assertEqual(len(records), runtime.MAX_NODES)
        self.assertEqual(records[-1]["name"], f"Item {runtime.MAX_NODES - 2}")
        self.assertTrue(truncation["truncated"])
        self.assertFalse(truncation["maxDepthReached"])

    def test_depth_limit_keeps_exact_prefix_and_flag(self):
        root = FakeAccessible("document", "Depth 65")
        for depth in range(runtime.MAX_DEPTH, -1, -1):
            root = FakeAccessible("document", f"Depth {depth}", children=[root])

        records, _, truncation = render(root)

        self.assertEqual(len(records), runtime.MAX_DEPTH + 1)
        self.assertEqual(records[-1]["name"], f"Depth {runtime.MAX_DEPTH}")
        self.assertTrue(truncation["truncated"])
        self.assertTrue(truncation["maxDepthReached"])


class SecurityHardeningTests(unittest.TestCase):
    def test_s18_own_app_protected_blocks_terminalx_and_owner_pid_across_all_operations(self):
        own_app = {
            "pid": 9999,
            "executablePath": "/opt/TerminalX/terminalx",
            "executableName": "terminalx",
            "appIdentifier": "com.terminalx.dev",
            "releaseBundleId": "com.terminalx.next",
            "appNames": ["TerminalX", "Raccoon"],
            "windowClasses": ["terminalx", "raccoon"],
            "allowOwnWindowsForTests": False,
        }
        tx_win = FakeAccessible("frame", "TerminalX — Workspace", states={FakeStateType.ACTIVE, FakeStateType.SHOWING}, pid=9999)
        tx_app = FakeAccessible("application", "TerminalX", children=[tx_win], pid=9999)
        disguised_win = FakeAccessible("frame", "Confirm Action", states={FakeStateType.ACTIVE, FakeStateType.SHOWING}, pid=9999)
        disguised_app = FakeAccessible("application", "CustomHost", children=[disguised_win], pid=9999)
        editor_win = FakeAccessible("frame", "Notes", states={FakeStateType.ACTIVE, FakeStateType.SHOWING}, pid=5555)
        editor_app = FakeAccessible("application", "Editor", children=[editor_win], pid=5555)

        orig_desktop_apps = runtime.desktop_apps
        try:
            runtime.desktop_apps = lambda: [tx_app, disguised_app, editor_app]
            for tool in ("list_windows", "get_app_state", "click", "type_text", "press_key", "hotkey", "paste_text", "scroll", "drag"):
                for selector in ("TerminalX", "Raccoon", "com.terminalx.next", "pid:9999", "9999", "CustomHost"):
                    with self.assertRaisesRegex(RuntimeError, "own_app_protected"):
                        runtime.run_operation({"tool": tool, "app": selector, "ownApp": own_app, "x": 10, "y": 10, "text": "hi", "key": "Return", "direction": "down", "from_x": 1, "from_y": 1, "to_x": 2, "to_y": 2})

            # Benign app is not blocked by own-app check.
            self.assertIs(runtime.find_app("Editor", own_app=own_app), editor_app)
        finally:
            runtime.desktop_apps = orig_desktop_apps

    def test_s18_release_bundle_remains_protected_even_with_test_escape_hatch(self):
        own_app = {
            "pid": 9999,
            "releaseBundleId": "com.terminalx.next",
            "allowOwnWindowsForTests": True,
        }
        self.assertTrue(runtime.is_own_app_identity(pid=1234, names=["com.terminalx.next"], own_app=own_app))
        self.assertFalse(runtime.is_own_app_identity(pid=9999, names=["DevHost"], own_app=own_app))

    def test_s18_descendant_process_of_terminalx_is_protected(self):
        own_app = {"pid": 7000, "allowOwnWindowsForTests": False}
        orig_ppid = runtime.process_parent_pid
        try:
            parents = {7002: 7001, 7001: 7000, 7000: 1}
            runtime.process_parent_pid = lambda pid: parents.get(pid, 0)
            self.assertTrue(runtime.is_own_app_identity(pid=7002, names=["WebKitWebProcess"], own_app=own_app))
            self.assertFalse(runtime.is_own_app_identity(pid=8000, names=["Firefox"], own_app=own_app))
        finally:
            runtime.process_parent_pid = orig_ppid

    def test_s26_screen_point_rejects_negative_and_out_of_window_bounds(self):
        bounds = runtime.Rect(100.0, 200.0, 300.0, 200.0)
        self.assertEqual(runtime.screen_point(bounds, None, 0, 0), (100.0, 200.0))
        self.assertEqual(runtime.screen_point(bounds, None, 300, 200), (400.0, 400.0))
        for bad_x, bad_y in [(-1, 10), (10, -0.5), (301, 10), (10, 201), (float("nan"), 10), (float("inf"), 10)]:
            with self.assertRaises(RuntimeError):
                runtime.screen_point(bounds, None, bad_x, bad_y)

    def test_s26_verify_pointer_target_enforces_topmost_window_hit_test(self):
        own_app = {"pid": 9999, "allowOwnWindowsForTests": False}
        bounds = runtime.Rect(100.0, 100.0, 400.0, 300.0)
        win = FakeAccessible("frame", "Editor Window", states={FakeStateType.ACTIVE, FakeStateType.SHOWING}, pid=5555)
        app = FakeAccessible("application", "Editor", children=[win], pid=5555)

        orig_hit = runtime.x11_topmost_window_at_point
        orig_desktop = runtime.desktop_apps
        orig_display = runtime.os.environ.get("DISPLAY")
        orig_session = runtime.os.environ.get("XDG_SESSION_TYPE")
        try:
            runtime.desktop_apps = lambda: []
            runtime.os.environ["DISPLAY"] = ":0"
            runtime.os.environ["XDG_SESSION_TYPE"] = "x11"

            # Same PID owns pixel -> allowed
            runtime.x11_topmost_window_at_point = lambda x, y: {"window_id": 1, "pid": 5555, "names": ["Editor"]}
            runtime.verify_pointer_target(app, win, bounds, 150.0, 150.0, own_app=own_app)

            # Occluded by TerminalX -> own_app_protected
            runtime.x11_topmost_window_at_point = lambda x, y: {"window_id": 2, "pid": 9999, "names": ["TerminalX"]}
            with self.assertRaisesRegex(RuntimeError, "own_app_protected"):
                runtime.verify_pointer_target(app, win, bounds, 150.0, 150.0, own_app=own_app)

            # Occluded by password manager -> appBlocked
            runtime.x11_topmost_window_at_point = lambda x, y: {"window_id": 3, "pid": 6666, "names": ["1Password"]}
            with self.assertRaisesRegex(RuntimeError, "appBlocked"):
                runtime.verify_pointer_target(app, win, bounds, 150.0, 150.0, own_app=own_app)

            # Occluded by another unrelated window -> window_not_focused
            runtime.x11_topmost_window_at_point = lambda x, y: {"window_id": 4, "pid": 7777, "names": ["OtherApp"]}
            with self.assertRaisesRegex(RuntimeError, "occluded by another window"):
                runtime.verify_pointer_target(app, win, bounds, 150.0, 150.0, own_app=own_app)

            # Out of window bounds -> invalid_argument
            with self.assertRaisesRegex(RuntimeError, "out of window bounds"):
                runtime.verify_pointer_target(app, win, bounds, 600.0, 150.0, own_app=own_app)
        finally:
            runtime.x11_topmost_window_at_point = orig_hit
            runtime.desktop_apps = orig_desktop
            if orig_display is None:
                runtime.os.environ.pop("DISPLAY", None)
            else:
                runtime.os.environ["DISPLAY"] = orig_display
            if orig_session is None:
                runtime.os.environ.pop("XDG_SESSION_TYPE", None)
            else:
                runtime.os.environ["XDG_SESSION_TYPE"] = orig_session

    def test_s27_selected_text_redacts_secure_node_and_secure_ancestor_and_enforces_text_limit(self):
        # 1. Direct password field with active selection must NEVER leak plaintext
        pw = FakeAccessible(
            "password text",
            "Password",
            value="super-secret-pw",
            states={FakeStateType.FOCUSED, FakeStateType.PROTECTED},
            selections=[FakeSelection(0, 15)],
        )
        self.assertEqual(runtime.selected_text_from_node(pw), "[redacted]")

        # 2. Inner text node inside a secure ancestor container must ALSO redact
        inner_text = FakeAccessible(
            "text",
            "",
            value="my-otp-998877",
            states={FakeStateType.FOCUSED},
            selections=[FakeSelection(0, 13)],
        )
        secure_parent = FakeAccessible("entry", "Verification Code", children=[inner_text])
        window = FakeAccessible("frame", "Login", children=[secure_parent], states={FakeStateType.ACTIVE, FakeStateType.SHOWING})
        self.assertTrue(runtime.is_secure_node(inner_text))
        self.assertEqual(runtime.selected_text(window), "[redacted]")

        records, lines, _, focus_info = runtime.render_accessibility_tree_with_focus(window, None, [0])
        self.assertEqual(focus_info["selectedText"], "[redacted]")
        self.assertNotIn("my-otp-998877", "\n".join(lines))
        self.assertTrue(all("my-otp-998877" not in str(r.get("value", "")) for r in records))

        # 3. Non-secure long selection is capped at TEXT_LIMIT + "..."
        long_value = "a" * (runtime.TEXT_LIMIT + 150)
        normal = FakeAccessible(
            "entry",
            "Notes",
            value=long_value,
            states={FakeStateType.FOCUSED},
            selections=[FakeSelection(0, len(long_value))],
        )
        selected = runtime.selected_text_from_node(normal)
        self.assertEqual(selected, ("a" * runtime.TEXT_LIMIT) + "...")


if __name__ == "__main__":
    unittest.main()
