"""TerminalX startup for browser-use's macOS stdio MCP process (PRO-116)."""

import sys


def _background_stdio_helper():
    # Child Python commands (including the shared browser-harness daemon) also
    # inherit PYTHONPATH. Only the MCP process should change its app policy.
    if sys.platform != "darwin" or "--cli-mcp" not in sys.argv:
        return
    try:
        from Foundation import NSBundle

        # Do this before loading AppKit: NSScreen's first query otherwise
        # registers Homebrew's Python.app as a regular Dock application.
        NSBundle.mainBundle().infoDictionary()["LSBackgroundOnly"] = True
    except ImportError:
        # Without PyObjC, browser-use cannot take its AppKit screen-probe path.
        return


def _user_sitecustomize():
    # Adding our startup directory must not replace an existing sitecustomize.
    # Find it on the remaining import path and execute it under its usual name.
    import importlib.machinery
    import importlib.util
    import os

    own_dir = os.path.realpath(os.path.dirname(__file__))
    search = [p for p in sys.path if os.path.realpath(p) != own_dir]
    spec = importlib.machinery.PathFinder.find_spec("sitecustomize", search)
    if spec is not None and spec.loader is not None:
        module = importlib.util.module_from_spec(spec)
        sys.modules["sitecustomize"] = module
        spec.loader.exec_module(module)


_background_stdio_helper()
_user_sitecustomize()
