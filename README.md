# Git-Zip | مدير المشاريع السهل

Git-Zip is a beginner-friendly desktop application for managing Git projects and creating zip backups without using the command line.

Git-Zip هو تطبيق سطح مكتب سهل للمبتدئين لإدارة مشاريع Git وإنشاء نسخ احتياطية ZIP بدون استخدام سطر الأوامر.

## Features | الميزات

- Create, open, and clone Git projects
- Browse project files with a simple tree view
- Edit files with a built-in text editor
- Stage, unstage, and commit changes with one click
- Pull and push to GitHub / GitLab
- Create branches and add remotes
- Create zip backups respecting `.gitignore`
- Arabic-friendly interface

- إنشاء وفتح واستنساخ مشاريع Git
- تصفح ملفات المشروع بواجهة شجرة بسيطة
- تحرير الملفات بمحرر نصوص مدمج
- Stage وUnstage وCommit بنقرة واحدة
- سحب (Pull) ورفع (Push) إلى GitHub / GitLab
- إنشاء فروع وإضافة remotes
- إنشاء نسخ احتياطية ZIP مع احترام `.gitignore`
- واجهة عربية سهلة

## Requirements | المتطلبات

- Windows 10/11, Linux, or macOS
- Python 3.8 or newer
- Git installed on your system: https://git-scm.com/downloads

## Installation | التثبيت

1. Download or clone this repository.
2. Open a terminal inside the project folder.
3. Install dependencies:

```bash
pip install -r requirements.txt
```

## Run | التشغيل

```bash
python run.py
```

## Build EXE for Windows | بناء ملف تنفيذي للويندوز

```bash
pip install pyinstaller
pyinstaller --onefile --windowed --name Git-Zip run.py
```

The `dist/Git-Zip.exe` file can be shared with anyone.

## How to use | كيفية الاستخدام

1. **Create project**: creates a new folder with a README file.
2. **Open project**: opens an existing folder.
3. **Initialize Git**: enables Git for the current project.
4. **Edit files**: double-click any file in the left tree.
5. **Stage files**: select a changed file on the right and click **Stage**.
6. **Commit**: write a message and click **Commit**.
7. **Push**: after adding a remote URL, click **Push** to upload to GitHub.
8. **Backup ZIP**: creates a zip file of your project (ignores `.git`).

## Notes | ملاحظات

- For private repositories, configure Git credentials on your system once.
- Arabic display may need `arabic-reshaper` and `python-bidi` installed (included in `requirements.txt`).

## License | الترخيص

MIT
