const express = require('express');
const session = require('express-session');
const multer = require('multer');
const AdmZip = require('adm-zip');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// GitHub OAuth Config
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'git-zip-secret-key-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// Multer config
const uploadDir = process.env.VERCEL ? '/tmp/uploads' : path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/zip' || file.mimetype === 'application/x-zip-compressed' || file.originalname.endsWith('.zip')) {
      cb(null, true);
    } else {
      cb(new Error('Only ZIP files are allowed'));
    }
  }
});

// Auth middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.githubToken) return next();
  return res.redirect('/');
}

// API auth middleware - returns 401 JSON instead of redirect
function requireApiAuth(req, res, next) {
  if (req.session && req.session.githubToken) return next();
  return res.status(401).json({ success: false, message: 'Not authenticated', authRequired: true });
}

// ─── Pages ───
app.get('/', (req, res) => {
  if (req.session && req.session.githubToken) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

app.get('/dashboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

app.get('/upload', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'upload.html'));
});

// ─── GitHub OAuth ───
app.get('/auth/github', (req, res) => {
  const state = crypto.randomUUID();
  req.session.oauthState = state;
  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: `${BASE_URL}/auth/github/callback`,
    scope: 'repo user',
    state
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

app.get('/auth/github/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || state !== req.session.oauthState) {
      return res.redirect('/?error=auth_failed');
    }
    delete req.session.oauthState;

    const tokenRes = await axios.post('https://github.com/login/oauth/access_token', {
      client_id: GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${BASE_URL}/auth/github/callback`
    }, { headers: { Accept: 'application/json' } });

    const accessToken = tokenRes.data.access_token;
    if (!accessToken) return res.redirect('/?error=token_failed');

    const userRes = await axios.get('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'git-zip-app' }
    });

    req.session.githubToken = accessToken;
    req.session.githubUser = userRes.data.login;
    req.session.githubAvatar = userRes.data.avatar_url;
    req.session.githubName = userRes.data.name || userRes.data.login;

    res.redirect('/dashboard');
  } catch (err) {
    console.error('OAuth error:', err.message);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/api/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

app.get('/api/me', requireApiAuth, (req, res) => {
  res.json({
    username: req.session.githubUser,
    name: req.session.githubName,
    avatar: req.session.githubAvatar
  });
});

// ─── GitHub Repos ───
app.get('/api/github/repos', requireApiAuth, async (req, res) => {
  try {
    const response = await axios.get('https://api.github.com/user/repos?per_page=100&sort=updated', {
      headers: { Authorization: `Bearer ${req.session.githubToken}`, 'User-Agent': 'git-zip-app' }
    });
    const repos = response.data.map(r => ({
      name: r.name,
      full_name: r.full_name,
      private: r.private,
      default_branch: r.default_branch,
      description: r.description || '',
      language: r.language || '',
      updated_at: r.updated_at,
      stargazers_count: r.stargazers_count,
      html_url: r.html_url
    }));
    res.json({ success: true, repos });
  } catch (err) {
    res.json({ success: false, message: 'Failed to fetch repos' });
  }
});

app.post('/api/github/create-repo', requireApiAuth, async (req, res) => {
  try {
    const { name, description, isPrivate } = req.body;
    if (!name) return res.json({ success: false, message: 'Repository name is required' });

    const response = await axios.post('https://api.github.com/user/repos', {
      name,
      description: description || 'Created by git-zip',
      private: isPrivate || false,
      auto_init: true
    }, {
      headers: { Authorization: `Bearer ${req.session.githubToken}`, 'User-Agent': 'git-zip-app' }
    });

    res.json({
      success: true,
      repo: {
        name: response.data.name,
        full_name: response.data.full_name,
        private: response.data.private,
        default_branch: response.data.default_branch,
        description: response.data.description || '',
        language: response.data.language || '',
        updated_at: response.data.updated_at,
        stargazers_count: response.data.stargazers_count,
        html_url: response.data.html_url
      }
    });
  } catch (err) {
    const msg = err.response?.data?.message || 'Failed to create repository';
    res.json({ success: false, message: msg });
  }
});

// ─── Upload ZIP & Push to GitHub ───
app.post('/api/upload', requireApiAuth, upload.single('zipfile'), async (req, res) => {
  let extractPath = null;
  try {
    if (!req.file) return res.json({ success: false, message: 'No file uploaded' });

    const { repoFullName, branch, commitMessage } = req.body;
    if (!repoFullName) return res.json({ success: false, message: 'Repository is required' });

    const branchName = branch || 'main';
    const message = commitMessage || 'Upload via git-zip';

    const zip = new AdmZip(req.file.path);
    extractPath = path.join(uploadDir, crypto.randomUUID());
    zip.extractAllTo(extractPath, true);

    const allFiles = [];
    function walkDir(dir, baseDir) {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          walkDir(fullPath, baseDir);
        } else {
          const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
          allFiles.push({ path: relativePath, fullPath });
        }
      }
    }

    const topItems = fs.readdirSync(extractPath);
    let rootDir = extractPath;
    if (topItems.length === 1) {
      const singleItem = path.join(extractPath, topItems[0]);
      if (fs.statSync(singleItem).isDirectory()) rootDir = singleItem;
    }
    walkDir(rootDir, rootDir);

    if (allFiles.length === 0) return res.json({ success: false, message: 'ZIP file is empty' });

    const token = req.session.githubToken;
    const headers = { Authorization: `Bearer ${token}`, 'User-Agent': 'git-zip-app' };

    let latestCommitSha, treeSha;
    try {
      const refRes = await axios.get(`https://api.github.com/repos/${repoFullName}/git/ref/heads/${branchName}`, { headers });
      latestCommitSha = refRes.data.object.sha;
      const commitRes = await axios.get(`https://api.github.com/repos/${repoFullName}/git/commits/${latestCommitSha}`, { headers });
      treeSha = commitRes.data.tree.sha;
    } catch (err) {
      try {
        const repoRes = await axios.get(`https://api.github.com/repos/${repoFullName}`, { headers });
        const defaultBranch = repoRes.data.default_branch;
        const defRef = await axios.get(`https://api.github.com/repos/${repoFullName}/git/ref/heads/${defaultBranch}`, { headers });
        latestCommitSha = defRef.data.object.sha;
        const commitRes = await axios.get(`https://api.github.com/repos/${repoFullName}/git/commits/${latestCommitSha}`, { headers });
        treeSha = commitRes.data.tree.sha;
        if (branchName !== defaultBranch) {
          await axios.post(`https://api.github.com/repos/${repoFullName}/git/refs`, { ref: `refs/heads/${branchName}`, sha: latestCommitSha }, { headers });
        }
      } catch (e2) {
        return res.json({ success: false, message: 'Could not access repository branch' });
      }
    }

    const treeItems = [];
    for (const file of allFiles) {
      const content = fs.readFileSync(file.fullPath);
      const blobRes = await axios.post(`https://api.github.com/repos/${repoFullName}/git/blobs`, {
        content: content.toString('base64'), encoding: 'base64'
      }, { headers });
      treeItems.push({ path: file.path, mode: '100644', type: 'blob', sha: blobRes.data.sha });
    }

    const newTree = await axios.post(`https://api.github.com/repos/${repoFullName}/git/trees`, { base_tree: treeSha, tree: treeItems }, { headers });
    const newCommit = await axios.post(`https://api.github.com/repos/${repoFullName}/git/commits`, { message, tree: newTree.data.sha, parents: [latestCommitSha] }, { headers });
    await axios.patch(`https://api.github.com/repos/${repoFullName}/git/refs/heads/${branchName}`, { sha: newCommit.data.sha }, { headers });

    fs.unlinkSync(req.file.path);
    fs.rmSync(extractPath, { recursive: true, force: true });

    res.json({ success: true, message: `Successfully pushed ${allFiles.length} files to ${repoFullName}`, commitSha: newCommit.data.sha, filesCount: allFiles.length });

  } catch (err) {
    try {
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      if (extractPath && fs.existsSync(extractPath)) fs.rmSync(extractPath, { recursive: true, force: true });
    } catch (e) {}
    console.error('Upload error:', err.response?.data || err.message);
    res.json({ success: false, message: err.response?.data?.message || 'Failed to push to GitHub' });
  }
});

// Start server
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`git-zip server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
