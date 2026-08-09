"""Git operations wrapper for Git-Zip."""

import os
import subprocess
from pathlib import Path
from typing import List, Optional, Tuple

try:
    import git
    GITPYTHON_AVAILABLE = True
except ImportError:
    GITPYTHON_AVAILABLE = False


class GitError(Exception):
    pass


class GitManager:
    """Manage git operations for a repository."""

    def __init__(self, repo_path: str):
        self.repo_path = Path(repo_path).resolve()
        if not self.repo_path.exists():
            raise GitError(f"المسار غير موجود: {repo_path}")

    def is_repo(self) -> bool:
        """Check if the path is a git repository."""
        return (self.repo_path / ".git").is_dir()

    def init(self) -> None:
        """Initialize a git repository."""
        if self.is_repo():
            raise GitError("المستودع مهيأ بالفعل.")
        if GITPYTHON_AVAILABLE:
            git.Repo.init(str(self.repo_path))
        else:
            self._run(["git", "init"])

    def clone(self, url: str, target_name: Optional[str] = None) -> None:
        """Clone a remote repository."""
        target = self.repo_path / target_name if target_name else self.repo_path
        if GITPYTHON_AVAILABLE:
            git.Repo.clone_from(url, str(target))
        else:
            cmd = ["git", "clone", url]
            if target_name:
                cmd.append(target_name)
            self._run(cmd)

    def status(self) -> Tuple[List[str], List[str], List[str]]:
        """Return (staged, modified, untracked) files."""
        out = self._run(["git", "status", "--porcelain=v1"])
        staged, modified, untracked = [], [], []
        for line in out.splitlines():
            if len(line) < 3:
                continue
            x, y, file = line[0], line[1], line[3:]
            if x != " " and x != "?" and x != "!":
                staged.append(file)
            if y != " " and y != "?" and y != "!":
                modified.append(file)
            if x == "?" and y == "?":
                untracked.append(file)
        return staged, modified, untracked

    def stage(self, file_path: str) -> None:
        if GITPYTHON_AVAILABLE:
            repo = git.Repo(str(self.repo_path))
            repo.git.add(file_path)
        else:
            self._run(["git", "add", file_path])

    def unstage(self, file_path: str) -> None:
        if GITPYTHON_AVAILABLE:
            repo = git.Repo(str(self.repo_path))
            repo.git.reset("HEAD", file_path)
        else:
            self._run(["git", "reset", "HEAD", file_path])

    def commit(self, message: str) -> None:
        if not message.strip():
            raise GitError("رسالة الكوميت فارغة.")
        if GITPYTHON_AVAILABLE:
            repo = git.Repo(str(self.repo_path))
            repo.index.commit(message)
        else:
            self._run(["git", "commit", "-m", message])

    def push(self, remote: str = "origin", branch: str = "") -> None:
        branch_arg = branch if branch else "HEAD"
        if GITPYTHON_AVAILABLE:
            repo = git.Repo(str(self.repo_path))
            repo.git.push(remote, branch_arg)
        else:
            self._run(["git", "push", remote, branch_arg])

    def pull(self, remote: str = "origin", branch: str = "") -> None:
        if GITPYTHON_AVAILABLE:
            repo = git.Repo(str(self.repo_path))
            if branch:
                repo.git.pull(remote, branch)
            else:
                repo.git.pull()
        else:
            cmd = ["git", "pull", remote]
            if branch:
                cmd.append(branch)
            self._run(cmd)

    def branches(self) -> List[str]:
        if GITPYTHON_AVAILABLE:
            repo = git.Repo(str(self.repo_path))
            return [b.name for b in repo.branches]
        else:
            out = self._run(["git", "branch"])
            return [line.strip().strip("*").strip() for line in out.splitlines() if line.strip()]

    def current_branch(self) -> str:
        if GITPYTHON_AVAILABLE:
            repo = git.Repo(str(self.repo_path))
            return repo.active_branch.name
        else:
            out = self._run(["git", "branch", "--show-current"])
            return out.strip()

    def checkout(self, branch: str, create: bool = False) -> None:
        if GITPYTHON_AVAILABLE:
            repo = git.Repo(str(self.repo_path))
            if create:
                new_branch = repo.create_head(branch)
                new_branch.checkout()
            else:
                repo.git.checkout(branch)
        else:
            if create:
                self._run(["git", "checkout", "-b", branch])
            else:
                self._run(["git", "checkout", branch])

    def set_user(self, name: str, email: str) -> None:
        self._run(["git", "config", "user.name", name])
        self._run(["git", "config", "user.email", email])

    def remotes(self) -> List[Tuple[str, str]]:
        if GITPYTHON_AVAILABLE:
            repo = git.Repo(str(self.repo_path))
            return [(r.name, next(iter(r.urls), "")) for r in repo.remotes]
        else:
            out = self._run(["git", "remote", "-v"])
            remotes = {}
            for line in out.splitlines():
                parts = line.split()
                if len(parts) >= 2:
                    remotes[parts[0]] = parts[1]
            return list(remotes.items())

    def add_remote(self, name: str, url: str) -> None:
        self._run(["git", "remote", "add", name, url])

    def _run(self, cmd: List[str]) -> str:
        try:
            result = subprocess.run(
                cmd,
                cwd=str(self.repo_path),
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            return result.stdout
        except subprocess.CalledProcessError as e:
            raise GitError(e.stderr or e.stdout or "خطأ غير معروف") from e

    @staticmethod
    def check_git_installed() -> bool:
        try:
            subprocess.run(["git", "--version"], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            return True
        except FileNotFoundError:
            return False
