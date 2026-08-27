"""What this package says about itself, checked against what it is.

Packaging metadata is the part of a project nobody reads until it is wrong, and
the ways it goes wrong here are all silent. A version that drifts between
`pyproject.toml` and `__init__.py` produces a wheel whose contents disagree with
its name. A `requires-python` floor that disagrees with the classifiers means a
wheel is chosen by one statement while a reader believes the other. And a README
that says `pip install forgebridge` sends a reader to somebody else's package —
this repository has already caught that exact defect twice in other documents,
which is why it is a test rather than a convention.

Whether anything in this repository is published is `M49`'s decision. Until it
makes one, "not published" is a claim this file holds the package to: the
`Private :: Do Not Upload` classifier is what makes an accidental upload fail
rather than succeed, and it is checked here rather than trusted to stay put. A
release that means to publish this package has to take the marker off on purpose,
which is the point of putting it there.

── Why this reads the manifest as text ──────────────────────────────────────

`tomllib` is standard library from 3.11, and this package supports 3.10 — which
is the version CI pins, precisely so that a wheel claiming 3.10 is tested on 3.10.
Importing `tomllib` here would make this file fail on the oldest interpreter the
package claims, and guarding it with a `skipif` would be worse: a skipped test is
indistinguishable from a passing one in a log. So each fact is extracted by an
anchored pattern, and every extraction asserts it found something before it
decides anything — a reader that quietly matched nothing would pass by having
nothing to disagree with.
"""

from __future__ import annotations

import pathlib
import re

import pytest

import forgebridge

ROOT = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = (ROOT / "pyproject.toml").read_text(encoding="utf-8")


def declared(key: str) -> str:
    """One `key = "value"` from the manifest, or a failure naming the key."""
    match = re.search(rf'^{re.escape(key)}\s*=\s*"([^"]+)"', MANIFEST, re.MULTILINE)
    assert match is not None, f'pyproject.toml declares no {key} = "…"'
    return match.group(1)


def classifiers() -> list[str]:
    block = re.search(r"^classifiers\s*=\s*\[(.*?)^\]", MANIFEST, re.MULTILINE | re.DOTALL)
    assert block is not None, "pyproject.toml declares no classifiers"
    found = re.findall(r'"([^"]+)"', block.group(1))
    assert found, "the classifiers block is empty"
    return found


def test_the_declared_version_and_the_importable_one_agree() -> None:
    assert forgebridge.__version__ == declared("version")


def test_the_package_declares_itself_unpublished() -> None:
    """The classifier that makes an accidental upload fail rather than succeed.

    `Private :: Do Not Upload` is rejected by PyPI, so it is a mechanism and not
    a comment: it is what stops this package reaching an index before `M49`
    decides how everything in this repository is released together.
    """
    assert "Private :: Do Not Upload" in classifiers()


def test_no_document_in_this_package_offers_an_install_that_would_404() -> None:
    """`pip install forgebridge` installs somebody else's package or nothing.

    `pip install -e <path>` is the honest instruction while nothing is published,
    and it is the one CI actually runs.
    """
    for document in sorted(ROOT.glob("*.md")):
        for number, line in enumerate(document.read_text(encoding="utf-8").splitlines(), 1):
            # A *command*, not a sentence about one. The README says in prose
            # that `pip install forgebridge` does not work, and a check that
            # could not tell those apart would make the honest sentence
            # unwritable.
            command = line.lstrip().removeprefix("$ ").removeprefix("python -m ")
            if command.startswith("pip install") and "forgebridge" in command:
                assert "-e" in command, f"{document.name}:{number} offers `{command.strip()}`"


def test_every_supported_python_is_one_the_metadata_claims() -> None:
    """The classifiers and `requires-python` are two statements of the same fact.

    A wheel is chosen by one and a reader believes the other, so a floor of 3.10
    with a lowest classifier of 3.11 would install on an interpreter the project
    says it does not support — or refuse one it says it does.
    """
    floor = declared("requires-python")
    assert floor.startswith(">=3."), f'requires-python is "{floor}", which this test cannot read'
    minor_floor = int(floor.removeprefix(">=3.").split(".")[0])
    claimed = sorted(
        int(classifier.rsplit(".", 1)[1])
        for classifier in classifiers()
        if classifier.startswith("Programming Language :: Python :: 3.")
    )
    assert claimed, "no interpreter version is claimed in the classifiers"
    assert claimed[0] == minor_floor, (
        f"requires-python says 3.{minor_floor}, the lowest classifier says 3.{claimed[0]}"
    )


def test_the_wheel_carries_the_typing_marker() -> None:
    """`py.typed` is what makes the annotations visible to a type checker in a
    consuming project. Without it every generated model is `Any` on the far side
    of the install, which is most of what this package is for."""
    assert (ROOT / "src" / "forgebridge" / "py.typed").is_file()
    assert 'packages = ["src/forgebridge"]' in MANIFEST


@pytest.mark.parametrize(
    "name",
    sorted(
        path.stem
        for path in (ROOT / "src" / "forgebridge").glob("*.py")
        if path.stem != "__init__"
    ),
)
def test_every_module_in_the_package_is_importable(name: str) -> None:
    """A module that ships and cannot be imported is a wheel with a hole in it,
    and nothing else here would notice one that no test happens to import."""
    __import__(f"forgebridge.{name}")


def test_everything_named_in_all_actually_exists() -> None:
    for name in forgebridge.__all__:
        assert hasattr(forgebridge, name), f"__all__ names {name}, which is not defined"
