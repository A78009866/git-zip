@echo off
REM Build Git-Zip as a single Windows executable
REM Run this on Windows after installing Python and requirements

pip install pyinstaller
pyinstaller --onefile --windowed --name "Git-Zip" --icon=NONE run.py
echo "Executable built in dist/Git-Zip.exe"
pause
