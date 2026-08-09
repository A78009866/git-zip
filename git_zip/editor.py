"""Simple file editor for Git-Zip."""

import tkinter as tk
from tkinter import ttk, messagebox
from pathlib import Path


class SimpleEditor:
    """A basic file editor window."""

    def __init__(self, parent, file_path: str, text_bidir=None):
        self.file_path = Path(file_path)
        self.text_bidir = text_bidir or (lambda x: x)
        self.window = tk.Toplevel(parent)
        self.window.title(self.text_bidir(f"تحرير: {self.file_path.name}"))
        self.window.geometry("800x600")
        self.window.transient(parent)

        self.text = tk.Text(self.window, wrap="word", undo=True, font=("Consolas", 11))
        self.text.pack(fill="both", expand=True, padx=5, pady=5)

        btn_frame = ttk.Frame(self.window)
        btn_frame.pack(fill="x", padx=5, pady=5)

        ttk.Button(btn_frame, text=self.text_bidir("حفظ"), command=self.save).pack(side="right", padx=2)
        ttk.Button(btn_frame, text=self.text_bidir("إغلاق"), command=self.window.destroy).pack(side="right", padx=2)

        self.load()

    def load(self):
        try:
            with open(self.file_path, "r", encoding="utf-8") as f:
                content = f.read()
            self.text.delete("1.0", tk.END)
            self.text.insert("1.0", content)
        except Exception as e:
            messagebox.showerror("خطأ", f"تعذر فتح الملف:\n{e}")

    def save(self):
        try:
            with open(self.file_path, "w", encoding="utf-8") as f:
                f.write(self.text.get("1.0", tk.END))
            messagebox.showinfo("تم", "تم حفظ الملف.")
        except Exception as e:
            messagebox.showerror("خطأ", f"تعذر حفظ الملف:\n{e}")
