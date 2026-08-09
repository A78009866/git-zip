#!/usr/bin/env python3
"""Entry point for Git-Zip."""

import sys
from pathlib import Path

# Allow running from source without installation
sys.path.insert(0, str(Path(__file__).parent))

from git_zip.app import main

if __name__ == "__main__":
    main()
