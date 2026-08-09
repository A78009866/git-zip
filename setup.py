from setuptools import setup, find_packages

setup(
    name="git-zip",
    version="1.0.0",
    description="Beginner-friendly Git GUI with zip backup support",
    long_description=open("README.md", encoding="utf-8").read(),
    long_description_content_type="text/markdown",
    author="Git-Zip Team",
    packages=find_packages(),
    install_requires=[
        "GitPython>=3.1.40",
        "arabic-reshaper>=3.0.0",
        "python-bidi>=0.4.2",
    ],
    python_requires=">=3.8",
    entry_points={
        "console_scripts": [
            "git-zip=git_zip.app:main",
        ],
    },
)
