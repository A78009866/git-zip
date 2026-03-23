# git-zip

Upload ZIP files and push them directly to GitHub repositories.

## Features

- GitHub OAuth login (one-click sign in)
- Upload ZIP files and extract contents
- Push to existing GitHub repositories
- Create new repositories and push to them
- Dark theme UI with SVG icons
- Arabic RTL interface

## Setup

### 1. Create a GitHub OAuth App

1. Go to [GitHub Developer Settings](https://github.com/settings/developers)
2. Click "New OAuth App"
3. Fill in:
   - **Application name**: git-zip
   - **Homepage URL**: Your app URL (e.g. `https://your-app.vercel.app`)
   - **Authorization callback URL**: `https://your-app.vercel.app/auth/github/callback`
4. Copy the **Client ID** and **Client Secret**

### 2. Environment Variables

Set these environment variables (in Vercel or `.env` file):

```
GITHUB_CLIENT_ID=your_client_id
GITHUB_CLIENT_SECRET=your_client_secret
BASE_URL=https://your-app.vercel.app
SESSION_SECRET=any_random_string
```

### 3. Run Locally

```bash
npm install
npm start
```

Server runs on `http://localhost:3000`

## Deploy to Vercel

1. Push to GitHub or upload the project
2. Import in Vercel
3. Add environment variables in Vercel project settings
4. Deploy
