#!/bin/bash
# Build Git-Zip as a single executable on Linux/macOS

pip install pyinstaller
pyinstaller --onefile --windowed --name "Git-Zip" run.py
echo "Executable built in dist/Git-Zip"
