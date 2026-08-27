"""The examples, checked against the API they claim to use.

A README example that does not work is the defect this repository has already
caught twice in other forms, and an example directory is where it hides best:
nothing imports it, nothing installs it, and it reads as documentation right up
until somebody runs it.

── What this proves, and what it does not ───────────────────────────────────

It proves that every `client.<method>(…)` the examples call is a real method on
`ForgeBridgeClient`, that every name they import from `forgebridge` is really
exported, that each file parses, and that the approval split the walk-through is
built around is a property of the files rather than of their prose.

It does **not** prove they run end to end: each is a script that talks to a live
daemon and exits the process. `tests/conformance_driver.py`, driven by
`packages/conformance/test/python-sdk.test.ts`, is what exercises these same
calls against a real daemon; this file is what stops the examples from drifting
away from the API those calls belong to.
"""

from __future__ import annotations

import ast
import pathlib

import pytest

import forgebridge
from forgebridge import ForgeBridgeClient

ROOT = pathlib.Path(__file__).resolve().parent.parent
EXAMPLES = ROOT.parent.parent / "examples" / "python"

#: The examples are a repository artefact, not a wheel one — the sdist ships
#: `src`, `tests` and `README.md`, and nothing under `examples/`. So when this
#: file is running anywhere but a checkout there is genuinely nothing for it to
#: check, and asserting the directory exists would fail for the wrong reason.
#: Inside a checkout it is not skipped and not forgiving: an empty directory is a
#: failure, because that is the shape of a walk-through somebody deleted.
IN_CHECKOUT = (ROOT.parent.parent / "docs" / "MILESTONES.md").is_file()

pytestmark = pytest.mark.skipif(
    not IN_CHECKOUT,
    reason="examples/ belongs to the repository, not the distribution; run these from a checkout",
)

SCRIPTS = sorted(EXAMPLES.glob("*.py")) if IN_CHECKOUT else []


def test_there_are_examples_to_check() -> None:
    """Fail closed.

    A glob that matched nothing would make every test below pass by having
    nothing to disagree with, which is the shape of a gate that silently stopped
    running.
    """
    assert SCRIPTS, f"no example scripts under {EXAMPLES}"


@pytest.mark.parametrize("script", SCRIPTS, ids=lambda path: path.name)
def test_an_example_parses(script: pathlib.Path) -> None:
    ast.parse(script.read_text(encoding="utf-8"), filename=str(script))


@pytest.mark.parametrize("script", SCRIPTS, ids=lambda path: path.name)
def test_an_example_calls_only_real_client_methods(script: pathlib.Path) -> None:
    tree = ast.parse(script.read_text(encoding="utf-8"), filename=str(script))
    called = {
        node.func.attr
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "client"
    }
    assert called, f"{script.name} builds a client and never calls it"
    for method in sorted(called):
        assert callable(getattr(ForgeBridgeClient, method, None)), (
            f"{script.name} calls client.{method}(), which is not a method on ForgeBridgeClient"
        )


@pytest.mark.parametrize("script", SCRIPTS, ids=lambda path: path.name)
def test_an_example_imports_only_real_exports(script: pathlib.Path) -> None:
    tree = ast.parse(script.read_text(encoding="utf-8"), filename=str(script))
    for node in ast.walk(tree):
        if not isinstance(node, ast.ImportFrom) or node.module is None:
            continue
        if node.module == "forgebridge":
            module = forgebridge
        elif node.module.startswith("forgebridge."):
            module = __import__(node.module, fromlist=["*"])
        else:
            continue
        for alias in node.names:
            assert hasattr(module, alias.name), (
                f"{script.name} imports {alias.name} from {node.module}, which does not export it"
            )


def test_no_example_both_proposes_and_approves() -> None:
    """ADR-012 as a property of the files.

    An example with a `--yes` flag on the propose step would teach the opposite
    of what the system does, and it would read as a convenience rather than as a
    hole.
    """
    for script in SCRIPTS:
        text = script.read_text(encoding="utf-8")
        proposes = "propose_changeset(" in text or "start_run(" in text
        approves = "approve_changeset(" in text
        assert not (proposes and approves), f"{script.name} both proposes and approves"


def test_the_approval_example_echoes_a_digest_it_was_given() -> None:
    """Reading the diff again there and echoing whatever it said would approve
    the script's idea of the set rather than the operations a person read."""
    approve = (EXAMPLES / "approve.py").read_text(encoding="utf-8")
    assert "get_diff(" not in approve
    assert "contentDigest" in approve


def test_the_example_readme_points_at_files_that_exist() -> None:
    readme = (EXAMPLES / "README.md").read_text(encoding="utf-8")
    names = {
        line.split("examples/python/")[1].split()[0]
        for line in readme.splitlines()
        if "examples/python/" in line and ".py" in line
    }
    assert names
    for name in names:
        assert (EXAMPLES / name).exists(), f"the README tells the reader to run {name}"


def test_no_example_offers_an_install_command_that_would_404() -> None:
    """`pip install forgebridge` installs somebody else's package or nothing at
    all. Publishing this one is `M49`; until then it is installed from a
    checkout, which is `pip install -e`."""
    for path in [*SCRIPTS, EXAMPLES / "README.md"]:
        for line in path.read_text(encoding="utf-8").splitlines():
            # A command, not a sentence about one — see the same check in
            # `test_packaging.py`, which explains why the distinction matters.
            command = line.lstrip().removeprefix("$ ")
            if command.startswith("pip install") and "forgebridge" in command:
                assert "-e" in command, f"{path.name} offers `{command.strip()}`, which would 404"
