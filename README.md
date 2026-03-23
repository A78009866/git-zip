# git-zip

Upload ZIP files and push them directly to GitHub repositories.

## Features

- User registration & login
- GitHub integration via Personal Access Token
- Upload ZIP files and extract contents
- Push to existing GitHub repositories
- Create new repositories and push to them
- Dark theme UI
- Arabic RTL interface

## Setup

```bash
npm install
npm start
```

Server runs on `http://localhost:3000`

## Environment Variables (optional)

- `PORT` - Server port (default: 3000)
- `SESSION_SECRET` - Session secret key

## Usage

1. Register an account
2. Connect your GitHub account with a Personal Access Token
3. Upload a ZIP file and choose a repository
4. Files are pushed to GitHub automatically
