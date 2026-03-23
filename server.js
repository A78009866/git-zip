const express = require('express');
const session = require('express-session');
const multer = require('multer');
const AdmZip = require('adm-zip');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory user store (replace with DB in production)
const users = {};

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

// Multer config for ZIP uploads (use /tmp on Vercel)
const uploadDir = process.env.VERCEL ? '/tmp/uploads' : path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
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
  if (req.session && req.session.userId) return next();
  return res.redirect('/login');
}

function requireGitHub(req, res, next) {
  if (req.session && req.session.githubToken) return next();
  return res.redirect('/connect-github');
}

// ─── Pages ───
app.get('/', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'register.html'));
});

app.get('/dashboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

app.get('/upload', requireAuth, requireGitHub, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'upload.html'));
});

app.get('/connect-github', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'connect-github.html'));
});

// ─── Auth API ───
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.json({ success: false, message: 'All fields are required' });
    }
    if (Object.values(users).find(u => u.email === email)) {
      return res.json({ success: false, message: 'Email already registered' });
    }
    if (Object.values(users).find(u => u.username === username)) {
      return res.json({ success: false, message: 'Username already taken' });
    }
    const id = crypto.randomUUID();
    const hash = await bcrypt.hash(password, 10);
    users[id] = { id, username, email, password: hash, githubToken: null, githubUser: null };
    req.session.userId = id;
    req.session.username = username;
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: 'Registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = Object.values(users).find(u => u.email === email);
    if (!user) return res.json({ success: false, message: 'Invalid credentials' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.json({ success: false, message: 'Invalid credentials' });
    req.session.userId = user.id;
    req.session.username = user.username;
    if (user.githubToken) {
      req.session.githubToken = user.githubToken;
      req.session.githubUser = user.githubUser;
    }
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: 'Login failed' });
  }
});

app.get('/api/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

app.get('/api/me', requireAuth, (req, res) => {
  const user = users[req.session.userId];
  res.json({
    username: user ? user.username : req.session.username,
    githubConnected: !!req.session.githubToken,
    githubUser: req.session.githubUser || null
  });
});

// ─── GitHub Integration ───
app.post('/api/connect-github', requireAuth, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.json({ success: false, message: 'Token is required' });

    // Verify token
    const response = await axios.get('https://api.github.com/user', {
      headers: { Authorization: `token ${token}`, 'User-Agent': 'git-zip-app' }
    });

    const githubUser = response.data.login;
    req.session.githubToken = token;
    req.session.githubUser = githubUser;

    // Save to user store
    if (users[req.session.userId]) {
      users[req.session.userId].githubToken = token;
      users[req.session.userId].githubUser = githubUser;
    }

    res.json({ success: true, githubUser });
  } catch (err) {
    res.json({ success: false, message: 'Invalid GitHub token' });
  }
});

app.get('/api/github/repos', requireAuth, requireGitHub, async (req, res) => {
  try {
    const response = await axios.get('https://api.github.com/user/repos?per_page=100&sort=updated', {
      headers: { Authorization: `token ${req.session.githubToken}`, 'User-Agent': 'git-zip-app' }
    });
    const repos = response.data.map(r => ({ name: r.name, full_name: r.full_name, private: r.private, default_branch: r.default_branch }));
    res.json({ success: true, repos });
  } catch (err) {
    res.json({ success: false, message: 'Failed to fetch repos' });
  }
});

// ─── Create new repo ───
app.post('/api/github/create-repo', requireAuth, requireGitHub, async (req, res) => {
  try {
    const { name, description, isPrivate } = req.body;
    if (!name) return res.json({ success: false, message: 'Repository name is required' });

    const response = await axios.post('https://api.github.com/user/repos', {
      name,
      description: description || `Created by git-zip`,
      private: isPrivate || false,
      auto_init: true
    }, {
      headers: { Authorization: `token ${req.session.githubToken}`, 'User-Agent': 'git-zip-app' }
    });

    res.json({
      success: true,
      repo: {
        name: response.data.name,
        full_name: response.data.full_name,
        private: response.data.private,
        default_branch: response.data.default_branch
      }
    });
  } catch (err) {
    const msg = err.response?.data?.message || 'Failed to create repository';
    res.json({ success: false, message: msg });
  }
});

// ─── Upload ZIP & Push to GitHub ───
app.post('/api/upload', requireAuth, requireGitHub, upload.single('zipfile'), async (req, res) => {
  let extractPath = null;
  try {
    if (!req.file) return res.json({ success: false, message: 'No file uploaded' });

    const { repoFullName, branch, commitMessage } = req.body;
    if (!repoFullName) return res.json({ success: false, message: 'Repository is required' });

    const branchName = branch || 'main';
    const message = commitMessage || 'Upload via git-zip';

    // Extract ZIP
    const zip = new AdmZip(req.file.path);
    extractPath = path.join(uploadDir, crypto.randomUUID());
    zip.extractAllTo(extractPath, true);

    // Get all files recursively
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

    // Check if zip has a single root folder
    const topItems = fs.readdirSync(extractPath);
    let rootDir = extractPath;
    if (topItems.length === 1) {
      const singleItem = path.join(extractPath, topItems[0]);
      if (fs.statSync(singleItem).isDirectory()) {
        rootDir = singleItem;
      }
    }
    walkDir(rootDir, rootDir);

    if (allFiles.length === 0) {
      return res.json({ success: false, message: 'ZIP file is empty' });
    }

    const token = req.session.githubToken;
    const headers = { Authorization: `token ${token}`, 'User-Agent': 'git-zip-app' };

    // Get the latest commit SHA on the branch
    let latestCommitSha, treeSha;
    try {
      const refRes = await axios.get(
        `https://api.github.com/repos/${repoFullName}/git/ref/heads/${branchName}`,
        { headers }
      );
      latestCommitSha = refRes.data.object.sha;
      const commitRes = await axios.get(
        `https://api.github.com/repos/${repoFullName}/git/commits/${latestCommitSha}`,
        { headers }
      );
      treeSha = commitRes.data.tree.sha;
    } catch (err) {
      // Branch may not exist, try to create it from default
      try {
        const repoRes = await axios.get(`https://api.github.com/repos/${repoFullName}`, { headers });
        const defaultBranch = repoRes.data.default_branch;
        const defRef = await axios.get(
          `https://api.github.com/repos/${repoFullName}/git/ref/heads/${defaultBranch}`,
          { headers }
        );
        latestCommitSha = defRef.data.object.sha;
        const commitRes = await axios.get(
          `https://api.github.com/repos/${repoFullName}/git/commits/${latestCommitSha}`,
          { headers }
        );
        treeSha = commitRes.data.tree.sha;

        // Create the new branch
        if (branchName !== defaultBranch) {
          await axios.post(`https://api.github.com/repos/${repoFullName}/git/refs`, {
            ref: `refs/heads/${branchName}`,
            sha: latestCommitSha
          }, { headers });
        }
      } catch (e2) {
        return res.json({ success: false, message: 'Could not access repository branch' });
      }
    }

    // Create blobs for each file
    const treeItems = [];
    for (const file of allFiles) {
      const content = fs.readFileSync(file.fullPath);
      const base64Content = content.toString('base64');

      const blobRes = await axios.post(`https://api.github.com/repos/${repoFullName}/git/blobs`, {
        content: base64Content,
        encoding: 'base64'
      }, { headers });

      treeItems.push({
        path: file.path,
        mode: '100644',
        type: 'blob',
        sha: blobRes.data.sha
      });
    }

    // Create tree
    const newTree = await axios.post(`https://api.github.com/repos/${repoFullName}/git/trees`, {
      base_tree: treeSha,
      tree: treeItems
    }, { headers });

    // Create commit
    const newCommit = await axios.post(`https://api.github.com/repos/${repoFullName}/git/commits`, {
      message,
      tree: newTree.data.sha,
      parents: [latestCommitSha]
    }, { headers });

    // Update branch ref
    await axios.patch(`https://api.github.com/repos/${repoFullName}/git/refs/heads/${branchName}`, {
      sha: newCommit.data.sha
    }, { headers });

    // Cleanup
    fs.unlinkSync(req.file.path);
    fs.rmSync(extractPath, { recursive: true, force: true });

    res.json({
      success: true,
      message: `Successfully pushed ${allFiles.length} files to ${repoFullName}`,
      commitSha: newCommit.data.sha,
      filesCount: allFiles.length
    });

  } catch (err) {
    // Cleanup on error
    try {
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      if (extractPath && fs.existsSync(extractPath)) fs.rmSync(extractPath, { recursive: true, force: true });
    } catch (e) {}
    console.error('Upload error:', err.response?.data || err.message);
    res.json({ success: false, message: err.response?.data?.message || 'Failed to push to GitHub' });
  }
});

// ─── Disconnect GitHub ───
app.post('/api/disconnect-github', requireAuth, (req, res) => {
  if (users[req.session.userId]) {
    users[req.session.userId].githubToken = null;
    users[req.session.userId].githubUser = null;
  }
  delete req.session.githubToken;
  delete req.session.githubUser;
  res.json({ success: true });
});

// Start server (skip listen on Vercel)
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`git-zip server running on http://localhost:${PORT}`);
  });
}

// Export for Vercel serverless
module.exports = app;
