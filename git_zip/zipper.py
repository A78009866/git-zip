"""Zip backup utilities for Git-Zip."""

import zipfile
from pathlib import Path
from datetime import datetime
from fnmatch import fnmatch
from typing import Optional


def load_gitignore(repo_path: Path) -> list:
    """Read .gitignore patterns if available."""
    gitignore = repo_path / ".gitignore"
    patterns = [".git"]
    if gitignore.exists():
        try:
            with open(gitignore, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#"):
                        patterns.append(line)
        except Exception:
            pass
    return patterns


def should_ignore(rel_path: str, patterns: list) -> bool:
    """Check if a path should be excluded based on patterns."""
    parts = rel_path.replace("\\", "/").split("/")
    for pattern in patterns:
        # Match against the full path or any component
        if fnmatch(rel_path, pattern) or fnmatch(parts[-1], pattern):
            return True
        for part in parts:
            if fnmatch(part, pattern):
                return True
    return False


def create_backup_zip(repo_path: str, output_dir: Optional[str] = None) -> str:
    """Create a zip backup of the project, respecting .gitignore."""
    path = Path(repo_path).resolve()
    if not path.exists():
        raise FileNotFoundError(f"المسار غير موجود: {repo_path}")

    out_dir = Path(output_dir).resolve() if output_dir else path.parent
    out_dir.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    zip_name = f"{path.name}_backup_{timestamp}.zip"
    zip_path = out_dir / zip_name

    patterns = load_gitignore(path)

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for file_path in path.rglob("*"):
            if not file_path.is_file():
                continue
            rel_path = file_path.relative_to(path).as_posix()
            if should_ignore(rel_path, patterns):
                continue
            zf.write(file_path, rel_path)

    return str(zip_path)
