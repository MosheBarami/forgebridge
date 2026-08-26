"""Make the package importable from a checkout without installing it first.

`pip install -e .` is the documented way in, and CI does exactly that. This is
here so that a contributor who cloned the repository and ran `pytest` gets the
tests rather than an ImportError telling them nothing about what to do next.
"""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "src"))
