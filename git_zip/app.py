"""Main GUI for Git-Zip."""

import os
import subprocess
import tkinter as tk
from tkinter import ttk, filedialog, messagebox, simpledialog
from pathlib import Path
from typing import Optional

from .git_manager import GitManager, GitError
from .zipper import create_backup_zip
from .editor import SimpleEditor

try:
    import arabic_reshaper
    from bidi.algorithm import get_display
    ARABIC_AVAILABLE = True
except ImportError:
    ARABIC_AVAILABLE = False


def ar(text: str) -> str:
    """Reshape and bidirectional-display Arabic text when possible."""
    if ARABIC_AVAILABLE:
        try:
            return get_display(arabic_reshaper.reshape(text))
        except Exception:
            pass
    return text


class GitZipApp:
    """Main application window for Git-Zip."""

    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title(ar("Git-Zip | مدير المشاريع السهل"))
        self.root.geometry("1100x700")
        self.root.minsize(900, 600)

        self.repo_path: Path = Path.home()
        self.git: Optional[GitManager] = None

        self.style = ttk.Style()
        self.style.theme_use("clam")
        self.style.configure("TButton", padding=6, font=("Segoe UI", 10))
        self.style.configure("TLabel", font=("Segoe UI", 10))
        self.style.configure("Treeview", font=("Segoe UI", 10), rowheight=24)
        self.style.configure("Treeview.Heading", font=("Segoe UI", 10, "bold"))

        self._build_menu()
        self._build_toolbar()
        self._build_main_panes()
        self._build_status_bar()

        self.refresh_repo()

    def _build_menu(self):
        menubar = tk.Menu(self.root)
        self.root.config(menu=menubar)

        file_menu = tk.Menu(menubar, tearoff=0)
        menubar.add_cascade(label=ar("ملف"), menu=file_menu)
        file_menu.add_command(label=ar("مشروع جديد"), command=self.create_project)
        file_menu.add_command(label=ar("فتح مشروع"), command=self.open_project)
        file_menu.add_command(label=ar("استنساخ من GitHub"), command=self.clone_repo)
        file_menu.add_separator()
        file_menu.add_command(label=ar("خروج"), command=self.root.quit)

        git_menu = tk.Menu(menubar, tearoff=0)
        menubar.add_cascade(label="Git", menu=git_menu)
        git_menu.add_command(label=ar("تهيئة Git"), command=self.init_git)
        git_menu.add_command(label=ar("سحب (Pull)"), command=self.pull)
        git_menu.add_command(label=ar("رفع (Push)"), command=self.push)
        git_menu.add_command(label=ar("تفرع جديد"), command=self.new_branch)
        git_menu.add_command(label=ar("إضافة ريموت"), command=self.add_remote)

        tools_menu = tk.Menu(menubar, tearoff=0)
        menubar.add_cascade(label=ar("أدوات"), menu=tools_menu)
        tools_menu.add_command(label=ar("نسخ احتياطي ZIP"), command=self.backup_zip)
        tools_menu.add_command(label=ar("فتح في Explorer"), command=self.open_explorer)

    def _build_toolbar(self):
        toolbar = ttk.Frame(self.root, padding=5)
        toolbar.pack(fill="x")

        buttons = [
            (ar("مشروع جديد"), self.create_project),
            (ar("فتح مشروع"), self.open_project),
            (ar("استنساخ"), self.clone_repo),
            (ar("تهيئة Git"), self.init_git),
            (ar("سحب"), self.pull),
            (ar("رفع"), self.push),
            (ar("نسخ ZIP"), self.backup_zip),
            (ar("تحديث"), self.refresh_repo),
        ]

        for label, cmd in buttons:
            ttk.Button(toolbar, text=label, command=cmd).pack(side="left", padx=2)

        self.repo_label = ttk.Label(toolbar, text=ar("لم يتم اختيار مشروع"))
        self.repo_label.pack(side="right", padx=5)

    def _build_main_panes(self):
        paned = ttk.PanedWindow(self.root, orient="horizontal")
        paned.pack(fill="both", expand=True, padx=5, pady=5)

        # Left: file tree
        left_frame = ttk.LabelFrame(paned, text=ar("ملفات المشروع"), padding=5)
        paned.add(left_frame, weight=2)

        self.file_tree = ttk.Treeview(left_frame, show="tree")
        self.file_tree.heading("#0", text=ar("الاسم"))
        self.file_tree.column("#0", width=280)
        self.file_tree.pack(fill="both", expand=True, side="left")

        vsb = ttk.Scrollbar(left_frame, orient="vertical", command=self.file_tree.yview)
        vsb.pack(fill="y", side="right")
        self.file_tree.configure(yscrollcommand=vsb.set)

        self.file_tree.bind("<Double-1>", self.on_file_double_click)

        # Right: git status and actions
        right_frame = ttk.Frame(paned)
        paned.add(right_frame, weight=3)

        # Status
        status_frame = ttk.LabelFrame(right_frame, text=ar("حالة Git"), padding=5)
        status_frame.pack(fill="both", expand=True, pady=2)

        self.status_tree = ttk.Treeview(status_frame, columns=("status",), show="tree headings")
        self.status_tree.heading("#0", text=ar("الملف"))
        self.status_tree.heading("status", text=ar("الحالة"))
        self.status_tree.column("#0", width=250)
        self.status_tree.column("status", width=120)
        self.status_tree.pack(fill="both", expand=True, side="left")

        vsb2 = ttk.Scrollbar(status_frame, orient="vertical", command=self.status_tree.yview)
        vsb2.pack(fill="y", side="right")
        self.status_tree.configure(yscrollcommand=vsb2.set)

        self.status_tree.bind("<Double-1>", self.on_status_double_click)

        # Commit area
        commit_frame = ttk.LabelFrame(right_frame, text=ar("تنفيذ تغييرات (Commit)"), padding=5)
        commit_frame.pack(fill="x", pady=5)

        ttk.Label(commit_frame, text=ar("رسالة الكوميت:")).pack(anchor="w")
        self.commit_msg = tk.Text(commit_frame, height=3, wrap="word", font=("Segoe UI", 10))
        self.commit_msg.pack(fill="x", pady=2)

        btn_frame = ttk.Frame(commit_frame)
        btn_frame.pack(fill="x")
        ttk.Button(btn_frame, text=ar("Stage المحدد"), command=self.stage_selected).pack(side="left", padx=2)
        ttk.Button(btn_frame, text=ar("Unstage المحدد"), command=self.unstage_selected).pack(side="left", padx=2)
        ttk.Button(btn_frame, text=ar("Commit"), command=self.commit).pack(side="left", padx=2)

        # Branch / Remote info
        info_frame = ttk.Frame(right_frame)
        info_frame.pack(fill="x", pady=2)

        ttk.Label(info_frame, text=ar("الفرع:")).pack(side="left", padx=2)
        self.branch_var = tk.StringVar(value="-")
        ttk.Label(info_frame, textvariable=self.branch_var).pack(side="left", padx=2)

        ttk.Label(info_frame, text=ar("الريموت:")).pack(side="left", padx=(20, 2))
        self.remote_var = tk.StringVar(value="-")
        ttk.Label(info_frame, textvariable=self.remote_var).pack(side="left", padx=2)

        # Log
        log_frame = ttk.LabelFrame(right_frame, text=ar("السجل"), padding=5)
        log_frame.pack(fill="both", expand=True, pady=2)

        self.log_text = tk.Text(log_frame, height=8, state="disabled", wrap="word", font=("Consolas", 9))
        self.log_text.pack(fill="both", expand=True, side="left")

        log_scroll = ttk.Scrollbar(log_frame, orient="vertical", command=self.log_text.yview)
        log_scroll.pack(fill="y", side="right")
        self.log_text.configure(yscrollcommand=log_scroll.set)

    def _build_status_bar(self):
        self.status_var = tk.StringVar(value=ar("جاهز"))
        status = ttk.Label(self.root, textvariable=self.status_var, relief="sunken", anchor="w", padding=3)
        status.pack(fill="x", side="bottom")

    def log(self, message: str):
        self.log_text.configure(state="normal")
        self.log_text.insert(tk.END, message + "\n")
        self.log_text.see(tk.END)
        self.log_text.configure(state="disabled")

    def set_repo(self, path: str):
        self.repo_path = Path(path).resolve()
        self.repo_label.configure(text=ar(f"المشروع: {self.repo_path.name}"))
        if self.repo_path.joinpath(".git").is_dir():
            self.git = GitManager(str(self.repo_path))
        else:
            self.git = None
        self.refresh_repo()


    def refresh_repo(self):
        self.file_tree.delete(*self.file_tree.get_children())
        self.status_tree.delete(*self.status_tree.get_children())

        if not self.repo_path.exists():
            self.status_var.set(ar("لم يتم اختيار مشروع"))
            return

        self._populate_file_tree("", self.repo_path)

        if self.git and self.git.is_repo():
            try:
                staged, modified, untracked = self.git.status()
                for f in staged:
                    self.status_tree.insert("", "end", iid=f"staged:{f}", text=ar(f), values=(ar("في الـ Staged"),), tags=(f,))
                for f in modified:
                    self.status_tree.insert("", "end", iid=f"mod:{f}", text=ar(f), values=(ar("معدّل"),), tags=(f,))
                for f in untracked:
                    self.status_tree.insert("", "end", iid=f"untracked:{f}", text=ar(f), values=(ar("جديد"),), tags=(f,))

                self.branch_var.set(self.git.current_branch())
                remotes = self.git.remotes()
                self.remote_var.set(", ".join([f"{name} ({url})" for name, url in remotes]) or "-")
                self.status_var.set(ar("تم تحديث الحالة"))
            except GitError as e:
                self.status_var.set(ar(f"خطأ Git: {e}"))
        else:
            self.branch_var.set("-")
            self.remote_var.set("-")
            self.status_var.set(ar("المشروع غير مهيأ لـ Git"))

    def _populate_file_tree(self, parent_iid: str, path: Path):
        try:
            items = sorted(path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except PermissionError:
            return

        for item in items:
            if item.name == ".git":
                continue
            iid = self.file_tree.insert(parent_iid, "end", text=ar(item.name), open=False, tags=(str(item),))
            if item.is_dir():
                self._populate_file_tree(iid, item)

    def on_file_double_click(self, event):
        sel = self.file_tree.selection()
        if not sel:
            return
        full_path = self._iid_to_path(sel[0])
        if full_path and full_path.is_file():
            SimpleEditor(self.root, str(full_path), text_bidir=ar)

    def _iid_to_path(self, iid: str) -> Optional[Path]:
        tags = self.file_tree.item(iid, "tags")
        if tags:
            return Path(tags[0])
        return None

    def on_status_double_click(self, event):
        sel = self.status_tree.selection()
        if not sel:
            return
        tags = self.status_tree.item(sel[0], "tags")
        if not tags:
            return
        file_path = self.repo_path / tags[0]
        if file_path.is_file():
            SimpleEditor(self.root, str(file_path), text_bidir=ar)

    def create_project(self):
        folder = filedialog.askdirectory(title=ar("اختر مكان المشروع الجديد"))
        if not folder:
            return
        name = simpledialog.askstring(ar("اسم المشروع"), ar("أدخل اسم المشروع الجديد:"))
        if not name:
            return
        new_path = Path(folder) / name
        new_path.mkdir(parents=True, exist_ok=True)
        readme = new_path / "README.md"
        if not readme.exists():
            readme.write_text(f"# {name}\n\nمشروع جديد تم إنشاؤه بواسطة Git-Zip.\n", encoding="utf-8")
        self.set_repo(str(new_path))
        self.log(ar(f"تم إنشاء المشروع: {new_path}"))

    def open_project(self):
        folder = filedialog.askdirectory(title=ar("اختر مجلد المشروع"))
        if folder:
            self.set_repo(folder)
            self.log(ar(f"تم فتح المشروع: {folder}"))

    def clone_repo(self):
        url = simpledialog.askstring(ar("رابط المستودع"), ar("أدخل رابط GitHub/GitLab للمستودع:"))
        if not url:
            return
        folder = filedialog.askdirectory(title=ar("اختر مكان الحفظ"))
        if not folder:
            return
        try:
            self.log(ar("جاري الاستنساخ..."))
            gm = GitManager(folder)
            gm.clone(url)
            self.set_repo(str(folder))
            self.log(ar("تم الاستنساخ بنجاح."))
        except GitError as e:
            messagebox.showerror(ar("خطأ"), ar(f"فشل الاستنساخ: {e}"))

    def init_git(self):
        if not self.repo_path.exists():
            messagebox.showwarning(ar("تنبيه"), ar("اختر مشروعاً أولاً."))
            return
        try:
            if not self.git:
                self.git = GitManager(str(self.repo_path))
            self.git.init()
            self.git.set_user("Git-Zip User", "user@gitzip.app")
            self.log(ar("تم تهيئة Git للمشروع."))
            self.refresh_repo()
        except GitError as e:
            messagebox.showerror(ar("خطأ"), ar(f"فشل التهيئة: {e}"))

    def stage_selected(self):
        sel = self.status_tree.selection()
        if not sel:
            return
        tags = self.status_tree.item(sel[0], "tags")
        if not tags or not self.git:
            return
        file_name = tags[0]
        try:
            self.git.stage(file_name)
            self.log(ar(f"تم Stage: {file_name}"))
            self.refresh_repo()
        except GitError as e:
            messagebox.showerror(ar("خطأ"), ar(str(e)))

    def unstage_selected(self):
        sel = self.status_tree.selection()
        if not sel:
            return
        tags = self.status_tree.item(sel[0], "tags")
        if not tags or not self.git:
            return
        file_name = tags[0]
        try:
            self.git.unstage(file_name)
            self.log(ar(f"تم Unstage: {file_name}"))
            self.refresh_repo()
        except GitError as e:
            messagebox.showerror(ar("خطأ"), ar(str(e)))

    def commit(self):
        if not self.git:
            messagebox.showwarning(ar("تنبيه"), ar("المشروع غير مهيأ لـ Git."))
            return
        msg = self.commit_msg.get("1.0", tk.END).strip()
        if not msg:
            messagebox.showwarning(ar("تنبيه"), ar("اكتب رسالة الكوميت أولاً."))
            return
        try:
            self.git.commit(msg)
            self.log(ar(f"تم Commit: {msg}"))
            self.commit_msg.delete("1.0", tk.END)
            self.refresh_repo()
        except GitError as e:
            messagebox.showerror(ar("خطأ"), ar(str(e)))

    def pull(self):
        if not self.git:
            messagebox.showwarning(ar("تنبيه"), ar("المشروع غير مهيأ لـ Git."))
            return
        try:
            self.log(ar("جاري السحب..."))
            self.git.pull()
            self.log(ar("تم السحب بنجاح."))
            self.refresh_repo()
        except GitError as e:
            messagebox.showerror(ar("خطأ"), ar(str(e)))

    def push(self):
        if not self.git:
            messagebox.showwarning(ar("تنبيه"), ar("المشروع غير مهيأ لـ Git."))
            return
        try:
            self.log(ar("جاري الرفع..."))
            self.git.push()
            self.log(ar("تم الرفع بنجاح."))
        except GitError as e:
            messagebox.showerror(ar("خطأ"), ar(str(e)))

    def new_branch(self):
        if not self.git:
            messagebox.showwarning(ar("تنبيه"), ar("المشروع غير مهيأ لـ Git."))
            return
        name = simpledialog.askstring(ar("فرع جديد"), ar("اسم الفرع الجديد:"))
        if not name:
            return
        try:
            self.git.checkout(name, create=True)
            self.log(ar(f"تم إنشاء والتبديل إلى الفرع: {name}"))
            self.refresh_repo()
        except GitError as e:
            messagebox.showerror(ar("خطأ"), ar(str(e)))

    def add_remote(self):
        if not self.git:
            messagebox.showwarning(ar("تنبيه"), ar("المشروع غير مهيأ لـ Git."))
            return
        name = simpledialog.askstring(ar("اسم الريموت"), ar("مثلاً: origin"), initialvalue="origin")
        url = simpledialog.askstring(ar("رابط الريموت"), ar("رابط GitHub/GitLab"))
        if not name or not url:
            return
        try:
            self.git.add_remote(name, url)
            self.log(ar(f"تم إضافة الريموت: {name} -> {url}"))
            self.refresh_repo()
        except GitError as e:
            messagebox.showerror(ar("خطأ"), ar(str(e)))

    def backup_zip(self):
        if not self.repo_path.exists():
            messagebox.showwarning(ar("تنبيه"), ar("اختر مشروعاً أولاً."))
            return
        try:
            zip_path = create_backup_zip(str(self.repo_path))
            self.log(ar(f"تم إنشاء النسخة الاحتياطية: {zip_path}"))
            messagebox.showinfo(ar("تم"), ar(f"تم حفظ النسخة الاحتياطية في:\n{zip_path}"))
        except Exception as e:
            messagebox.showerror(ar("خطأ"), ar(str(e)))

    def open_explorer(self):
        if self.repo_path.exists():
            if os.name == "nt":
                subprocess.run(["explorer", str(self.repo_path)])
            else:
                subprocess.run(["xdg-open", str(self.repo_path)])


def main():
    if not GitManager.check_git_installed():
        messagebox.showwarning(
            ar("تنبيه"),
            ar("Git غير مثبت على جهازك. بعض الميزات ستعمل فقط بعد تثبيت Git.\nرابط التحميل: https://git-scm.com/downloads"),
        )
    root = tk.Tk()
    app = GitZipApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
