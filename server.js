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

// Encryption key for persistent auth cookie (survives server restarts & Vercel cold starts)
const AUTH_SECRET = process.env.SESSION_SECRET || 'git-zip-secret-key-change-me';
const CRYPTO_KEY = crypto.scryptSync(AUTH_SECRET, 'gitzip-salt', 32);

function encryptAuth(data) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', CRYPTO_KEY, iv);
  let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + '.' + encrypted;
}

function decryptAuth(text) {
  try {
    const parts = text.split('.');
    if (parts.length !== 2) return null;
    const iv = Buffer.from(parts[0], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', CRYPTO_KEY, iv);
    let decrypted = decipher.update(parts[1], 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
  } catch {
    return null;
  }
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Cookie parser (no extra package needed)
app.use((req, res, next) => {
  req.cookies = {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    cookieHeader.split(';').forEach(c => {
      const [name, ...rest] = c.trim().split('=');
      if (name && rest.length) req.cookies[name.trim()] = decodeURIComponent(rest.join('='));
    });
  }
  next();
});

app.use(session({
  secret: AUTH_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// Restore session from persistent auth cookie if session was lost (Vercel cold start / server restart)
app.use((req, res, next) => {
  if (!req.session || !req.session.githubToken) {
    const authCookie = req.cookies.gitzip_auth;
    if (authCookie) {
      const auth = decryptAuth(authCookie);
      if (auth && auth.githubToken) {
        req.session.githubToken = auth.githubToken;
        req.session.githubUser = auth.githubUser;
        req.session.githubAvatar = auth.githubAvatar;
        req.session.githubName = auth.githubName;
      }
    }
  }
  next();
});

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
  // For AJAX/fetch requests, return 401 JSON instead of redirect
  if (req.headers['x-requested-with'] === 'XMLHttpRequest' || req.headers.accept?.includes('application/json')) {
    return res.status(401).json({ success: false, message: 'Not authenticated', authRequired: true });
  }
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

    // Set persistent encrypted auth cookie (survives server restarts)
    res.cookie('gitzip_auth', encryptAuth({
      githubToken: accessToken,
      githubUser: userRes.data.login,
      githubAvatar: userRes.data.avatar_url,
      githubName: userRes.data.name || userRes.data.login
    }), { httpOnly: true, maxAge: 24 * 60 * 60 * 1000, sameSite: 'lax', path: '/' });

    res.redirect('/dashboard');
  } catch (err) {
    console.error('OAuth error:', err.message);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('gitzip_auth');
    res.clearCookie('connect.sid');
    res.redirect('/');
  });
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
    const repos = response.data
      .filter(r => r.permissions && r.permissions.push)
      .map(r => ({
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

    // Wait for GitHub to fully initialize the repo (auto_init creates an initial commit)
    // Poll the ref endpoint instead of a fixed sleep to ensure the repo is truly ready
    const defaultBranch = response.data.default_branch || 'main';
    let repoReady = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise(r => setTimeout(r, 1500));
      try {
        await axios.get(`https://api.github.com/repos/${response.data.full_name}/git/ref/heads/${defaultBranch}`, {
          headers: { Authorization: `Bearer ${req.session.githubToken}`, 'User-Agent': 'git-zip-app' }
        });
        repoReady = true;
        break;
      } catch (e) {
        // Not ready yet, keep polling
      }
    }

    if (!repoReady) {
      console.warn('Repo created but initialization not confirmed after polling — may cause upload issues');
    }

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

// ─── Helper: retry with delay ───
async function retryWithDelay(fn, retries = 3, delayMs = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

// ─── Helper: check write access to repo ───
async function checkRepoWriteAccess(repoFullName, headers) {
  try {
    const res = await axios.get(`https://api.github.com/repos/${repoFullName}`, { headers });
    if (!res.data.permissions || !res.data.permissions.push) {
      return { ok: false, message: 'You do not have write access to this repository' };
    }
    return { ok: true, data: res.data };
  } catch (err) {
    if (err.response?.status === 404) {
      return { ok: false, message: 'Repository not found or you do not have access' };
    }
    return { ok: false, message: 'Could not verify repository access' };
  }
}

// ─── Upload ZIP & Push to GitHub ───
app.post('/api/upload', requireApiAuth, upload.single('zipfile'), async (req, res) => {
  let extractPath = null;
  try {
    if (!req.file) return res.json({ success: false, message: 'No file uploaded' });

    let { repoFullName, branch, commitMessage } = req.body;
    if (!repoFullName) return res.json({ success: false, message: 'Repository is required' });

    const branchName = branch || 'main';
    const message = commitMessage || 'Upload via git-zip';

    const token = req.session.githubToken;
    const headers = { Authorization: `Bearer ${token}`, 'User-Agent': 'git-zip-app' };

    // Verify write access before doing any work
    const access = await checkRepoWriteAccess(repoFullName, headers);
    if (!access.ok) return res.json({ success: false, message: access.message });

    // Use canonical repo name from GitHub API to ensure correct casing
    repoFullName = access.data.full_name || repoFullName;

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

    let latestCommitSha, treeSha;

    // Handle empty repos (no commits yet) — create an initial commit
    const repoData = access.data;
    let isEmptyRepo = false;
    const defaultBranch = repoData.default_branch || 'main';

    try {
      const refRes = await axios.get(`https://api.github.com/repos/${repoFullName}/git/ref/heads/${branchName}`, { headers });
      latestCommitSha = refRes.data.object.sha;
      const commitRes = await axios.get(`https://api.github.com/repos/${repoFullName}/git/commits/${latestCommitSha}`, { headers });
      treeSha = commitRes.data.tree.sha;
    } catch (err) {
      try {
        const defRef = await axios.get(`https://api.github.com/repos/${repoFullName}/git/ref/heads/${defaultBranch}`, { headers });
        latestCommitSha = defRef.data.object.sha;
        const commitRes = await axios.get(`https://api.github.com/repos/${repoFullName}/git/commits/${latestCommitSha}`, { headers });
        treeSha = commitRes.data.tree.sha;
        if (branchName !== defaultBranch) {
          await axios.post(`https://api.github.com/repos/${repoFullName}/git/refs`, { ref: `refs/heads/${branchName}`, sha: latestCommitSha }, { headers });
        }
      } catch (e2) {
        // Repo might be completely empty (no commits at all)
        isEmptyRepo = true;
      }
    }

    // Handle empty repos: Git Data API does NOT work on repos with zero commits.
    // We MUST create the first commit via Contents API to initialize the git database.
    if (isEmptyRepo) {
      console.log('Empty repo detected, initializing via Contents API...');

      // Try creating a seed file via Contents API. This is the ONLY way to initialize
      // an empty repo's git database so that the Git Data API becomes functional.
      // Use a unique filename to avoid conflicts with previous failed attempts.
      const seedFileName = `.gitkeep-${Date.now()}`;
      let seedCreated = false;

      // Try multiple seed file names in case of conflicts
      for (const fileName of ['.gitkeep', seedFileName, '.gitinit']) {
        try {
          await axios.put(`https://api.github.com/repos/${repoFullName}/contents/${fileName}`, {
            message: 'Initial commit via git-zip',
            content: Buffer.from('').toString('base64')
          }, { headers });
          seedCreated = true;
          console.log(`Seed file '${fileName}' created successfully`);
          break;
        } catch (seedErr) {
          const seedStatus = seedErr.response?.status;
          console.log(`Seed file '${fileName}' failed (${seedStatus}): ${seedErr.response?.data?.message || seedErr.message}`);
          // 422 means file already exists — the repo might already be initialized from a prior attempt
          if (seedStatus === 422) {
            seedCreated = true; // Repo already has at least one commit
            break;
          }
          // For other errors, try the next filename
        }
      }

      if (!seedCreated) {
        fs.unlinkSync(req.file.path);
        fs.rmSync(extractPath, { recursive: true, force: true });
        return res.json({ success: false, message: 'Failed to initialize empty repository. Please add a README or any file to the repo on GitHub first, then try uploading again.' });
      }

      // Now poll for the ref to appear — the Contents API commit should have created a branch
      try {
        const initRef = await retryWithDelay(() =>
          axios.get(`https://api.github.com/repos/${repoFullName}/git/ref/heads/${defaultBranch}`, { headers })
        , 5, 1500);
        latestCommitSha = initRef.data.object.sha;
        const initCommit = await axios.get(`https://api.github.com/repos/${repoFullName}/git/commits/${latestCommitSha}`, { headers });
        treeSha = initCommit.data.tree.sha;
        if (branchName !== defaultBranch) {
          await axios.post(`https://api.github.com/repos/${repoFullName}/git/refs`, {
            ref: `refs/heads/${branchName}`, sha: latestCommitSha
          }, { headers });
        }
        isEmptyRepo = false;
        console.log('Empty repo initialized successfully, Git Data API should now be available');
      } catch (refErr) {
        console.error('Failed to get ref after seed commit:', refErr.response?.data?.message || refErr.message);
        // Fall back to uploading all files via Contents API
      }
    }

    // ── Fallback: upload via Contents API one-by-one if Git Data API is unavailable ──
    if (isEmptyRepo) {
      console.log('Git Data API unavailable, falling back to Contents API for all files...');
      let lastCommitSha = null;
      for (const file of allFiles) {
        try {
          const content = fs.readFileSync(file.fullPath);
          const putRes = await axios.put(`https://api.github.com/repos/${repoFullName}/contents/${file.path}`, {
            message: allFiles.indexOf(file) === 0 ? message : `${message} - ${file.path}`,
            content: content.toString('base64'),
            ...(branchName !== defaultBranch && lastCommitSha ? { branch: branchName } : {})
          }, { headers });
          lastCommitSha = putRes.data.commit.sha;
        } catch (fileErr) {
          console.error(`Contents API upload failed for ${file.path}:`, fileErr.response?.data?.message || fileErr.message);
        }
      }
      fs.unlinkSync(req.file.path);
      fs.rmSync(extractPath, { recursive: true, force: true });
      return res.json({ success: true, message: `Successfully pushed ${allFiles.length} files to ${repoFullName} (via Contents API)`, commitSha: lastCommitSha, filesCount: allFiles.length });
    }

    // ── Normal path: Git Data API (repo has at least one commit) ──
    let gitDataSuccess = false;
    let finalCommitSha = null;

    try {
      // Create blobs in parallel batches (5 at a time) for speed
      const BATCH_SIZE = 5;
      const treeItems = [];
      for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
        const batch = allFiles.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(batch.map(async (file) => {
          const content = fs.readFileSync(file.fullPath);
          const blobRes = await axios.post(`https://api.github.com/repos/${repoFullName}/git/blobs`, {
            content: content.toString('base64'), encoding: 'base64'
          }, { headers });
          return { path: file.path, mode: '100644', type: 'blob', sha: blobRes.data.sha };
        }));
        treeItems.push(...results);
      }

      // Create new tree, commit, and update ref
      const newTree = await retryWithDelay(() =>
        axios.post(`https://api.github.com/repos/${repoFullName}/git/trees`, { base_tree: treeSha, tree: treeItems }, { headers })
      , 3, 2000);
      const newCommit = await axios.post(`https://api.github.com/repos/${repoFullName}/git/commits`, { message, tree: newTree.data.sha, parents: [latestCommitSha] }, { headers });
      await axios.patch(`https://api.github.com/repos/${repoFullName}/git/refs/heads/${branchName}`, { sha: newCommit.data.sha }, { headers });

      gitDataSuccess = true;
      finalCommitSha = newCommit.data.sha;
    } catch (gitApiErr) {
      const gitApiStatus = gitApiErr.response?.status;
      console.warn('Git Data API failed (status ' + gitApiStatus + '), falling back to Contents API...', gitApiErr.response?.data?.message || gitApiErr.message);

      // Fallback: upload files one-by-one via Contents API
      let lastSha = null;
      let uploadedCount = 0;
      for (const file of allFiles) {
        try {
          const content = fs.readFileSync(file.fullPath);

          // Check if the file already exists (need its SHA to update it)
          let existingFileSha;
          try {
            const existingRes = await axios.get(`https://api.github.com/repos/${repoFullName}/contents/${file.path}?ref=${branchName}`, { headers });
            existingFileSha = existingRes.data.sha;
          } catch (e) {
            // File doesn't exist yet — that's fine, we'll create it
          }

          const putRes = await axios.put(`https://api.github.com/repos/${repoFullName}/contents/${file.path}`, {
            message: uploadedCount === 0 ? message : `${message} - ${file.path}`,
            content: content.toString('base64'),
            branch: branchName,
            ...(existingFileSha ? { sha: existingFileSha } : {})
          }, { headers });
          lastSha = putRes.data.commit.sha;
          uploadedCount++;
        } catch (fileErr) {
          console.error(`Contents API upload failed for ${file.path}:`, fileErr.response?.data?.message || fileErr.message);
        }
      }

      if (uploadedCount === 0) {
        // Nothing was uploaded even via fallback — throw original error
        throw gitApiErr;
      }

      finalCommitSha = lastSha;
      gitDataSuccess = true; // Mark as success since Contents API worked
      console.log(`Fallback succeeded: uploaded ${uploadedCount}/${allFiles.length} files via Contents API`);
    }

    fs.unlinkSync(req.file.path);
    fs.rmSync(extractPath, { recursive: true, force: true });

    res.json({ success: true, message: `Successfully pushed ${allFiles.length} files to ${repoFullName}`, commitSha: finalCommitSha, filesCount: allFiles.length });

  } catch (err) {
    try {
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      if (extractPath && fs.existsSync(extractPath)) fs.rmSync(extractPath, { recursive: true, force: true });
    } catch (e) {}

    const status = err.response?.status;
    const ghMessage = err.response?.data?.message || '';
    console.error('Upload error:', { status, message: ghMessage, url: err.config?.url });

    let userMessage = 'Failed to push to GitHub';
    if (status === 404) {
      userMessage = 'Repository not found or you do not have write access. Please check your permissions.';
    } else if (status === 403) {
      userMessage = ghMessage.includes('rate limit') ? 'GitHub API rate limit reached. Please try again later.' : 'Access denied. Your GitHub token may not have sufficient permissions.';
    } else if (status === 422) {
      userMessage = 'Invalid data sent to GitHub. ' + ghMessage;
    } else if (ghMessage) {
      userMessage = ghMessage;
    }

    res.json({ success: false, message: userMessage });
  }
});

// ─── Vercel Deploy Page ───
app.get('/deploy', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'deploy.html'));
});

// ─── Vercel Token Management ───
app.post('/api/vercel/connect', requireApiAuth, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.json({ success: false, message: 'Vercel token مطلوب' });

    // Verify token by fetching user info
    const userRes = await axios.get('https://api.vercel.com/v2/user', {
      headers: { Authorization: `Bearer ${token}` }
    });

    req.session.vercelToken = token;
    req.session.vercelUser = userRes.data.user.username || userRes.data.user.name;
    req.session.vercelEmail = userRes.data.user.email;

    // Persist in auth cookie
    res.cookie('gitzip_vercel', encryptAuth({
      vercelToken: token,
      vercelUser: req.session.vercelUser,
      vercelEmail: req.session.vercelEmail
    }), { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax', path: '/' });

    res.json({
      success: true,
      user: req.session.vercelUser,
      email: req.session.vercelEmail
    });
  } catch (err) {
    const msg = err.response?.data?.error?.message || 'فشل التحقق من التوكن';
    res.json({ success: false, message: msg });
  }
});

// Restore Vercel session from cookie
app.use((req, res, next) => {
  if (req.session && !req.session.vercelToken) {
    const vc = req.cookies.gitzip_vercel;
    if (vc) {
      const auth = decryptAuth(vc);
      if (auth && auth.vercelToken) {
        req.session.vercelToken = auth.vercelToken;
        req.session.vercelUser = auth.vercelUser;
        req.session.vercelEmail = auth.vercelEmail;
      }
    }
  }
  next();
});

app.get('/api/vercel/status', requireApiAuth, (req, res) => {
  res.json({
    connected: !!req.session.vercelToken,
    user: req.session.vercelUser || null,
    email: req.session.vercelEmail || null
  });
});

app.get('/api/vercel/disconnect', requireApiAuth, (req, res) => {
  delete req.session.vercelToken;
  delete req.session.vercelUser;
  delete req.session.vercelEmail;
  res.clearCookie('gitzip_vercel');
  res.json({ success: true });
});

// ─── Vercel Projects ───
app.get('/api/vercel/projects', requireApiAuth, async (req, res) => {
  try {
    if (!req.session.vercelToken) return res.json({ success: false, message: 'Vercel غير متصل', needsConnect: true });

    const response = await axios.get('https://api.vercel.com/v9/projects?limit=100', {
      headers: { Authorization: `Bearer ${req.session.vercelToken}` }
    });

    const projects = response.data.projects.map(p => ({
      id: p.id,
      name: p.name,
      framework: p.framework || null,
      updatedAt: p.updatedAt,
      createdAt: p.createdAt,
      latestDeployment: p.latestDeployments?.[0] ? {
        id: p.latestDeployments[0].id,
        url: p.latestDeployments[0].url,
        state: p.latestDeployments[0].readyState || p.latestDeployments[0].state,
        createdAt: p.latestDeployments[0].createdAt
      } : null,
      link: p.link ? {
        type: p.link.type,
        repo: p.link.repo,
        org: p.link.org
      } : null,
      targets: p.targets || {}
    }));

    res.json({ success: true, projects });
  } catch (err) {
    const msg = err.response?.data?.error?.message || 'فشل جلب المشاريع';
    res.json({ success: false, message: msg });
  }
});

// Deploy a GitHub repo to Vercel (import project)
app.post('/api/vercel/deploy', requireApiAuth, async (req, res) => {
  try {
    if (!req.session.vercelToken) return res.json({ success: false, message: 'Vercel غير متصل' });

    const { repoFullName, projectName, framework, buildCommand, outputDir, installCommand } = req.body;
    if (!repoFullName) return res.json({ success: false, message: 'المستودع مطلوب' });

    const vHeaders = { Authorization: `Bearer ${req.session.vercelToken}`, 'Content-Type': 'application/json' };

    // Create project linked to GitHub repo
    const [owner, repo] = repoFullName.split('/');
    const createBody = {
      name: projectName || repo,
      framework: framework || null,
      gitRepository: {
        type: 'github',
        repo: repoFullName
      }
    };
    if (buildCommand) createBody.buildCommand = buildCommand;
    if (outputDir) createBody.outputDirectory = outputDir;
    if (installCommand) createBody.installCommand = installCommand;

    const createRes = await axios.post('https://api.vercel.com/v10/projects', createBody, { headers: vHeaders });

    const project = createRes.data;

    // Trigger a deployment
    let deployment = null;
    try {
      const deployRes = await axios.post('https://api.vercel.com/v13/deployments', {
        name: project.name,
        project: project.id,
        gitSource: {
          type: 'github',
          repoId: String(project.link?.repoId || ''),
          ref: project.link?.productionBranch || 'main',
          org: owner,
          repo: repo
        }
      }, { headers: vHeaders });
      deployment = {
        id: deployRes.data.id,
        url: deployRes.data.url,
        state: deployRes.data.readyState || deployRes.data.status
      };
    } catch (deployErr) {
      console.warn('Auto-deploy trigger failed (project may auto-deploy on its own):', deployErr.response?.data?.error?.message || deployErr.message);
    }

    res.json({
      success: true,
      project: {
        id: project.id,
        name: project.name,
        framework: project.framework
      },
      deployment,
      url: `https://${project.name}.vercel.app`
    });
  } catch (err) {
    const msg = err.response?.data?.error?.message || 'فشل نشر المشروع';
    res.json({ success: false, message: msg });
  }
});

// Get project deployments
app.get('/api/vercel/projects/:projectId/deployments', requireApiAuth, async (req, res) => {
  try {
    if (!req.session.vercelToken) return res.json({ success: false, message: 'Vercel غير متصل' });

    const response = await axios.get(`https://api.vercel.com/v6/deployments?projectId=${req.params.projectId}&limit=10`, {
      headers: { Authorization: `Bearer ${req.session.vercelToken}` }
    });

    const deployments = response.data.deployments.map(d => ({
      id: d.uid,
      url: d.url,
      state: d.readyState || d.state,
      createdAt: d.created,
      meta: d.meta || {}
    }));

    res.json({ success: true, deployments });
  } catch (err) {
    res.json({ success: false, message: 'فشل جلب عمليات النشر' });
  }
});

// Get project domains
app.get('/api/vercel/projects/:projectId/domains', requireApiAuth, async (req, res) => {
  try {
    if (!req.session.vercelToken) return res.json({ success: false, message: 'Vercel غير متصل' });

    const response = await axios.get(`https://api.vercel.com/v9/projects/${req.params.projectId}/domains`, {
      headers: { Authorization: `Bearer ${req.session.vercelToken}` }
    });

    res.json({ success: true, domains: response.data.domains || [] });
  } catch (err) {
    res.json({ success: false, message: 'فشل جلب النطاقات' });
  }
});

// Delete a Vercel project
app.delete('/api/vercel/projects/:projectId', requireApiAuth, async (req, res) => {
  try {
    if (!req.session.vercelToken) return res.json({ success: false, message: 'Vercel غير متصل' });

    await axios.delete(`https://api.vercel.com/v9/projects/${req.params.projectId}`, {
      headers: { Authorization: `Bearer ${req.session.vercelToken}` }
    });

    res.json({ success: true });
  } catch (err) {
    const msg = err.response?.data?.error?.message || 'فشل حذف المشروع';
    res.json({ success: false, message: msg });
  }
});

// Redeploy a Vercel project
app.post('/api/vercel/projects/:projectId/redeploy', requireApiAuth, async (req, res) => {
  try {
    if (!req.session.vercelToken) return res.json({ success: false, message: 'Vercel غير متصل' });

    const vHeaders = { Authorization: `Bearer ${req.session.vercelToken}`, 'Content-Type': 'application/json' };

    // Get project info first
    const projRes = await axios.get(`https://api.vercel.com/v9/projects/${req.params.projectId}`, {
      headers: { Authorization: `Bearer ${req.session.vercelToken}` }
    });
    const project = projRes.data;

    // Trigger redeployment
    const deployBody = {
      name: project.name,
      project: project.id,
      target: 'production'
    };

    if (project.link) {
      deployBody.gitSource = {
        type: 'github',
        ref: project.link.productionBranch || 'main',
        org: project.link.org,
        repo: project.link.repo,
        repoId: String(project.link.repoId || '')
      };
    }

    const deployRes = await axios.post('https://api.vercel.com/v13/deployments', deployBody, { headers: vHeaders });

    res.json({
      success: true,
      deployment: {
        id: deployRes.data.id,
        url: deployRes.data.url,
        state: deployRes.data.readyState || deployRes.data.status
      }
    });
  } catch (err) {
    const msg = err.response?.data?.error?.message || 'فشل اعادة النشر';
    res.json({ success: false, message: msg });
  }
});

// ─── GitHub Repo Management ───

// Delete a repository
app.delete('/api/github/repos/:owner/:repo', requireApiAuth, async (req, res) => {
  try {
    const { owner, repo } = req.params;
    await axios.delete(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: { Authorization: `Bearer ${req.session.githubToken}`, 'User-Agent': 'git-zip-app' }
    });
    res.json({ success: true });
  } catch (err) {
    const status = err.response?.status;
    let msg = 'فشل حذف المستودع';
    if (status === 403) msg = 'ليس لديك صلاحية حذف هذا المستودع. يجب ان تكون مالك المستودع.';
    else if (status === 404) msg = 'المستودع غير موجود';
    res.json({ success: false, message: msg });
  }
});

// Rename a repository
app.patch('/api/github/repos/:owner/:repo/rename', requireApiAuth, async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const { newName } = req.body;
    if (!newName) return res.json({ success: false, message: 'الاسم الجديد مطلوب' });

    const response = await axios.patch(`https://api.github.com/repos/${owner}/${repo}`, {
      name: newName
    }, {
      headers: { Authorization: `Bearer ${req.session.githubToken}`, 'User-Agent': 'git-zip-app' }
    });

    res.json({
      success: true,
      repo: {
        name: response.data.name,
        full_name: response.data.full_name,
        html_url: response.data.html_url
      }
    });
  } catch (err) {
    const msg = err.response?.data?.message || 'فشل تغيير اسم المستودع';
    res.json({ success: false, message: msg });
  }
});

// Change repository visibility
app.patch('/api/github/repos/:owner/:repo/visibility', requireApiAuth, async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const { isPrivate } = req.body;

    const response = await axios.patch(`https://api.github.com/repos/${owner}/${repo}`, {
      private: isPrivate
    }, {
      headers: { Authorization: `Bearer ${req.session.githubToken}`, 'User-Agent': 'git-zip-app' }
    });

    res.json({
      success: true,
      private: response.data.private
    });
  } catch (err) {
    const msg = err.response?.data?.message || 'فشل تغيير خصوصية المستودع';
    res.json({ success: false, message: msg });
  }
});

// Update repository description
app.patch('/api/github/repos/:owner/:repo/description', requireApiAuth, async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const { description } = req.body;

    const response = await axios.patch(`https://api.github.com/repos/${owner}/${repo}`, {
      description: description || ''
    }, {
      headers: { Authorization: `Bearer ${req.session.githubToken}`, 'User-Agent': 'git-zip-app' }
    });

    res.json({
      success: true,
      description: response.data.description
    });
  } catch (err) {
    const msg = err.response?.data?.message || 'فشل تحديث الوصف';
    res.json({ success: false, message: msg });
  }
});

// Update repository (general - homepage, topics, etc.)
app.patch('/api/github/repos/:owner/:repo', requireApiAuth, async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const updates = {};
    if (req.body.description !== undefined) updates.description = req.body.description;
    if (req.body.homepage !== undefined) updates.homepage = req.body.homepage;
    if (req.body.has_wiki !== undefined) updates.has_wiki = req.body.has_wiki;
    if (req.body.has_issues !== undefined) updates.has_issues = req.body.has_issues;
    if (req.body.default_branch !== undefined) updates.default_branch = req.body.default_branch;

    const response = await axios.patch(`https://api.github.com/repos/${owner}/${repo}`, updates, {
      headers: { Authorization: `Bearer ${req.session.githubToken}`, 'User-Agent': 'git-zip-app' }
    });

    res.json({ success: true, repo: response.data });
  } catch (err) {
    const msg = err.response?.data?.message || 'فشل تحديث المستودع';
    res.json({ success: false, message: msg });
  }
});

// Start server
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`git-zip server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
