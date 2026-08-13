const express = require('express');
const session = require('express-session');
const multer = require('multer');
const extractZip = require('extract-zip');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Allow large payloads for GitHub API and zip downloads
axios.defaults.maxBodyLength = Infinity;
axios.defaults.maxContentLength = Infinity;

const MAX_UPLOAD_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB
const MAX_GITHUB_FILE_SIZE = 100 * 1024 * 1024; // 100 MB per file

// Trust Vercel's reverse proxy so req.ip returns the real client IP
app.set('trust proxy', 1);

// ─── Security Headers ───
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'", "https://api.github.com", "https://api.vercel.com"],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
        }
    },
    crossOriginEmbedderPolicy: false,
}));

// ─── Rate Limiting ───
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: ipKeyGenerator,
});

const uploadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 20,
    message: { error: 'Too many upload requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: ipKeyGenerator,
});

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Too many auth attempts, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: ipKeyGenerator,
});

app.use('/api/', generalLimiter);

// Telegram notification settings
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ─── HTML Sanitization for Telegram messages ───
function escapeHtml(str) {
    if (!str) return 'غير معروف';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

// ─── Parse User-Agent for detailed device info ───
function parseUserAgent(ua) {
    if (!ua) return { browser: 'غير معروف', os: 'غير معروف', device: 'غير معروف' };
    let browser = 'غير معروف';
    let os = 'غير معروف';
    let device = 'Desktop';

    if (/Edg\//i.test(ua)) browser = 'Microsoft Edge ' + (ua.match(/Edg\/([\d.]+)/)?.[1] || '');
    else if (/OPR\//i.test(ua) || /Opera/i.test(ua)) browser = 'Opera ' + (ua.match(/OPR\/([\d.]+)/)?.[1] || '');
    else if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) browser = 'Google Chrome ' + (ua.match(/Chrome\/([\d.]+)/)?.[1] || '');
    else if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) browser = 'Safari ' + (ua.match(/Version\/([\d.]+)/)?.[1] || '');
    else if (/Firefox\//i.test(ua)) browser = 'Firefox ' + (ua.match(/Firefox\/([\d.]+)/)?.[1] || '');
    else if (/MSIE|Trident/i.test(ua)) browser = 'Internet Explorer';

    if (/Windows NT 10/i.test(ua)) os = 'Windows 10/11';
    else if (/Windows NT/i.test(ua)) os = 'Windows';
    else if (/Mac OS X/i.test(ua)) os = 'macOS ' + (ua.match(/Mac OS X ([\d_]+)/)?.[1]?.replace(/_/g, '.') || '');
    else if (/Android/i.test(ua)) os = 'Android ' + (ua.match(/Android ([\d.]+)/)?.[1] || '');
    else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS ' + (ua.match(/OS ([\d_]+)/)?.[1]?.replace(/_/g, '.') || '');
    else if (/Linux/i.test(ua)) os = 'Linux';
    else if (/CrOS/i.test(ua)) os = 'Chrome OS';

    if (/Mobile|Android|iPhone|iPod/i.test(ua)) device = 'Mobile';
    else if (/iPad|Tablet/i.test(ua)) device = 'Tablet';

    return { browser: browser.trim(), os: os.trim(), device: device.trim() };
}

// دالة إرسال إشعار Telegram
async function sendTelegramNotification(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.log('⚠️ Telegram not configured, skipping notification');
        return;
    }
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML'
        });
    } catch (err) {
        console.error('❌ Telegram notification error:', err.message);
    }
}

// GitHub OAuth Config
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Vercel OAuth Config (Integration)
const VERCEL_CLIENT_ID = process.env.VERCEL_CLIENT_ID || '';
const VERCEL_CLIENT_SECRET = process.env.VERCEL_CLIENT_SECRET || '';
const VERCEL_INTEGRATION_SLUG = process.env.VERCEL_INTEGRATION_SLUG || '';

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
app.use(express.json({ limit: '1gb' }));
app.use(express.urlencoded({ extended: true, limit: '1gb' }));
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

// Custom session store to avoid the MemoryStore production warning.
// On Vercel serverless, instances are short-lived so in-memory storage is acceptable.
class ServerlessStore extends session.Store {
  constructor() {
    super();
    this.sessions = Object.create(null);
  }
  get(sid, cb) { cb(null, this.sessions[sid] ? JSON.parse(this.sessions[sid]) : null); }
  set(sid, sess, cb) { this.sessions[sid] = JSON.stringify(sess); cb(null); }
  destroy(sid, cb) { delete this.sessions[sid]; cb(null); }
  touch(sid, sess, cb) { this.sessions[sid] = JSON.stringify(sess); cb(null); }
}

app.use(session({
  store: new ServerlessStore(),
  secret: AUTH_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
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

// Workspace directory for beginner-friendly edit-before-push flow
const workspaceDir = process.env.VERCEL ? '/tmp/workspaces' : path.join(__dirname, 'workspaces');
if (!fs.existsSync(workspaceDir)) fs.mkdirSync(workspaceDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: MAX_UPLOAD_SIZE },
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

app.get('/workspace', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'workspace.html'));
});

// ─── GitHub OAuth ───
app.get('/auth/github', authLimiter, (req, res) => {
  const state = crypto.randomUUID();
  req.session.oauthState = state;
  // Also store state in a cookie so it survives Vercel cold starts
  res.cookie('gitzip_oauth_state', state, {
    httpOnly: true, maxAge: 10 * 60 * 1000, sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production', path: '/'
  });
  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: `${BASE_URL}/auth/github/callback`,
    scope: 'repo delete_repo user',
    state
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

app.get('/auth/github/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    // Check state from session first, then fall back to cookie (Vercel cold start)
    const savedState = req.session.oauthState || req.cookies.gitzip_oauth_state;
    if (!code || state !== savedState) {
      return res.redirect('/?error=auth_failed');
    }
    delete req.session.oauthState;
    res.clearCookie('gitzip_oauth_state');

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

    // إرسال إشعار Telegram مفصل عند تسجيل الدخول عبر GitHub
    const loginIp = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.connection?.remoteAddress || 'غير معروف';
    const loginTime = new Date().toLocaleString('ar-EG', { timeZone: 'Asia/Riyadh' });
    const loginUserAgent = req.headers['user-agent'] || 'Unknown';
    const loginDevice = parseUserAgent(loginUserAgent);
    const loginReferer = req.headers['referer'] || req.headers['referrer'] || 'مباشر';
    const loginLang = (req.headers['accept-language'] || 'غير معروف').split(',')[0];
    sendTelegramNotification(
      `🟢 <b>مستخدم جديد - git-zip</b>\n\n` +
      `👤 <b>الاسم:</b> ${escapeHtml(userRes.data.name || userRes.data.login)}\n` +
      `🐙 <b>GitHub:</b> @${escapeHtml(userRes.data.login)}\n` +
      `📧 <b>الإيميل:</b> ${escapeHtml(userRes.data.email || 'غير متاح')}\n` +
      `📍 <b>الموقع:</b> ${escapeHtml(userRes.data.location || 'غير متاح')}\n` +
      `🏢 <b>الشركة:</b> ${escapeHtml(userRes.data.company || 'غير متاح')}\n` +
      `📊 <b>المستودعات العامة:</b> ${userRes.data.public_repos || 0}\n` +
      `👥 <b>المتابعون:</b> ${userRes.data.followers || 0}\n` +
      `🌐 <b>IP:</b> ${escapeHtml(loginIp)}\n` +
      `💻 <b>نظام التشغيل:</b> ${escapeHtml(loginDevice.os)}\n` +
      `🔍 <b>المتصفح:</b> ${escapeHtml(loginDevice.browser)}\n` +
      `📲 <b>نوع الجهاز:</b> ${escapeHtml(loginDevice.device)}\n` +
      `🌍 <b>اللغة:</b> ${escapeHtml(loginLang)}\n` +
      `🔗 <b>مصدر الزيارة:</b> ${escapeHtml(loginReferer)}\n` +
      `🕐 <b>الوقت:</b> ${loginTime}\n` +
      `📋 <b>User-Agent:</b> <code>${escapeHtml(loginUserAgent.substring(0, 200))}</code>`
    );

    // Set persistent encrypted auth cookie (survives server restarts)
    res.cookie('gitzip_auth', encryptAuth({
      githubToken: accessToken,
      githubUser: userRes.data.login,
      githubAvatar: userRes.data.avatar_url,
      githubName: userRes.data.name || userRes.data.login
    }), { httpOnly: true, maxAge: 24 * 60 * 60 * 1000, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' });

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
    const headers = { Authorization: `Bearer ${req.session.githubToken}`, 'User-Agent': 'git-zip-app' };
    let allRepos = [];
    let page = 1;
    const perPage = 100;

    // Paginate through all repos
    while (true) {
      const response = await axios.get(`https://api.github.com/user/repos?per_page=${perPage}&sort=updated&page=${page}`, { headers });
      const pageRepos = response.data;
      if (!pageRepos || pageRepos.length === 0) break;
      allRepos = allRepos.concat(pageRepos);
      if (pageRepos.length < perPage) break;
      page++;
      if (page > 10) break; // Safety limit: max 1000 repos
    }

    const repos = allRepos
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
app.post('/api/upload', requireApiAuth, uploadLimiter, upload.single('zipfile'), async (req, res) => {
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

    extractPath = path.join(uploadDir, crypto.randomUUID());
    fs.mkdirSync(extractPath, { recursive: true });
    await extractZip(req.file.path, { dir: extractPath });

    const allFiles = [];
    function walkDir(dir, baseDir) {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        // Skip git metadata and macOS helper folders
        if (item === '.git' || item === '__MACOSX') continue;
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);

        // ─── Path Traversal Protection ───
        const resolvedFull = path.resolve(fullPath);
        const resolvedBase = path.resolve(baseDir);
        if (!resolvedFull.startsWith(resolvedBase + path.sep) && resolvedFull !== resolvedBase) {
          console.warn(`⚠️ Path traversal attempt blocked: ${fullPath}`);
          continue;
        }

        if (stat.isDirectory()) {
          walkDir(fullPath, baseDir);
        } else {
          const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
          // Block paths that try to escape via ..
          if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
            console.warn(`⚠️ Suspicious relative path blocked: ${relativePath}`);
            continue;
          }
          allFiles.push({ path: relativePath, fullPath, size: stat.size });
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

    // GitHub rejects individual blobs larger than 100MB.
    const skippedFiles = allFiles.filter(f => f.size > MAX_GITHUB_FILE_SIZE).map(f => f.path);
    const filesToUpload = allFiles.filter(f => f.size <= MAX_GITHUB_FILE_SIZE);

    if (filesToUpload.length === 0) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      try { fs.rmSync(extractPath, { recursive: true, force: true }); } catch (e) {}
      return res.json({ success: false, message: `ZIP contains no files under ${MAX_GITHUB_FILE_SIZE / 1024 / 1024}MB. Skipped: ${skippedFiles.join(', ')}` });
    }

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
      for (const [index, file] of filesToUpload.entries()) {
        try {
          const content = fs.readFileSync(file.fullPath);
          const putRes = await axios.put(`https://api.github.com/repos/${repoFullName}/contents/${file.path}`, {
            message: index === 0 ? message : `${message} - ${file.path}`,
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
      const warn = skippedFiles.length ? ` (skipped ${skippedFiles.length} file(s) over 100MB)` : '';
      return res.json({ success: true, message: `Successfully pushed ${filesToUpload.length} files to ${repoFullName} (via Contents API)${warn}`, commitSha: lastCommitSha, filesCount: filesToUpload.length, skipped: skippedFiles });
    }

    // ── Normal path: Git Data API (repo has at least one commit) ──
    let gitDataSuccess = false;
    let finalCommitSha = null;

    try {
      // Create blobs sequentially to keep memory usage low for large files
      const treeItems = [];
      for (const file of filesToUpload) {
        const content = fs.readFileSync(file.fullPath);
        const blobRes = await axios.post(`https://api.github.com/repos/${repoFullName}/git/blobs`, {
          content: content.toString('base64'), encoding: 'base64'
        }, { headers });
        treeItems.push({ path: file.path, mode: '100644', type: 'blob', sha: blobRes.data.sha });
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
      for (const file of filesToUpload) {
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
      console.log(`Fallback succeeded: uploaded ${uploadedCount}/${filesToUpload.length} files via Contents API`);
    }

    fs.unlinkSync(req.file.path);
    fs.rmSync(extractPath, { recursive: true, force: true });

    // إرسال إشعار Telegram مفصل عند رفع ملفات
    const uploadTime = new Date().toLocaleString('ar-EG', { timeZone: 'Asia/Riyadh' });
    const uploadIp = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.connection?.remoteAddress || 'غير معروف';
    const uploadUA = req.headers['user-agent'] || 'Unknown';
    const uploadDevice = parseUserAgent(uploadUA);
    sendTelegramNotification(
      `📤 <b>رفع ملفات جديدة - git-zip</b>\n\n` +
      `👤 <b>المستخدم:</b> @${escapeHtml(req.session.githubUser)}\n` +
      `📁 <b>المستودع:</b> ${escapeHtml(repoFullName)}\n` +
      `🌿 <b>الفرع:</b> ${escapeHtml(branchName)}\n` +
      `📄 <b>عدد الملفات:</b> ${filesToUpload.length}${skippedFiles.length ? ` (تجاهل ${skippedFiles.length} ملف كبير)` : ''}\n` +
      `💬 <b>رسالة الكوميت:</b> ${escapeHtml(message)}\n` +
      `🌐 <b>IP:</b> ${escapeHtml(uploadIp)}\n` +
      `💻 <b>النظام:</b> ${escapeHtml(uploadDevice.os)}\n` +
      `🔍 <b>المتصفح:</b> ${escapeHtml(uploadDevice.browser)}\n` +
      `📲 <b>الجهاز:</b> ${escapeHtml(uploadDevice.device)}\n` +
      `🕐 <b>الوقت:</b> ${uploadTime}`
    );

    const uploadWarn = skippedFiles.length ? ` (${skippedFiles.length} file(s) over 100MB skipped)` : '';
    res.json({ success: true, message: `Successfully pushed ${filesToUpload.length} files to ${repoFullName}${uploadWarn}`, commitSha: finalCommitSha, filesCount: filesToUpload.length, skipped: skippedFiles });

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

// ─── Vercel OAuth (Integration) ───
app.get('/auth/vercel', requireAuth, (req, res) => {
  if (!VERCEL_INTEGRATION_SLUG || !VERCEL_CLIENT_ID) {
    return res.redirect('/deploy?error=vercel_not_configured');
  }
  const state = crypto.randomUUID();
  req.session.vercelOauthState = state;
  const params = new URLSearchParams({
    state,
    redirect_uri: `${BASE_URL}/auth/vercel/callback`
  });
  res.redirect(`https://vercel.com/integrations/${VERCEL_INTEGRATION_SLUG}/new?${params}`);
});

app.get('/auth/vercel/callback', requireAuth, async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || state !== req.session.vercelOauthState) {
      return res.redirect('/deploy?error=vercel_auth_failed');
    }
    delete req.session.vercelOauthState;

    // Exchange code for access token
    const tokenRes = await axios.post('https://api.vercel.com/v2/oauth/access_token', new URLSearchParams({
      client_id: VERCEL_CLIENT_ID,
      client_secret: VERCEL_CLIENT_SECRET,
      code,
      redirect_uri: `${BASE_URL}/auth/vercel/callback`
    }).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const accessToken = tokenRes.data.access_token;
    if (!accessToken) return res.redirect('/deploy?error=vercel_token_failed');

    // Get user info
    const userRes = await axios.get('https://api.vercel.com/v2/user', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    req.session.vercelToken = accessToken;
    req.session.vercelUser = userRes.data.user.username || userRes.data.user.name;
    req.session.vercelEmail = userRes.data.user.email;

    // Persist in auth cookie
    res.cookie('gitzip_vercel', encryptAuth({
      vercelToken: accessToken,
      vercelUser: req.session.vercelUser,
      vercelEmail: req.session.vercelEmail
    }), { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' });

    res.redirect('/deploy');
  } catch (err) {
    console.error('Vercel OAuth error:', err.response?.data || err.message);
    res.redirect('/deploy?error=vercel_auth_failed');
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

// Delete a repository (with ownership verification & confirmation)
app.delete('/api/github/repos/:owner/:repo', requireApiAuth, async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const { confirmName } = req.body || {};

    // Input validation: only allow valid GitHub username/repo name characters
    const validPattern = /^[a-zA-Z0-9._-]+$/;
    if (!validPattern.test(owner) || !validPattern.test(repo)) {
      return res.json({ success: false, message: 'اسم المستودع او المالك يحتوي على احرف غير صالحة' });
    }

    // Require confirmation name to match (prevents accidental deletion)
    const expectedFullName = `${owner}/${repo}`;
    if (!confirmName || confirmName !== expectedFullName) {
      return res.json({ success: false, message: 'يجب كتابة اسم المستودع بالكامل للتأكيد' });
    }

    const headers = { Authorization: `Bearer ${req.session.githubToken}`, 'User-Agent': 'git-zip-app' };

    // Verify ownership: only the repo owner can delete
    let repoData;
    try {
      const repoRes = await axios.get(`https://api.github.com/repos/${owner}/${repo}`, { headers });
      repoData = repoRes.data;
    } catch (checkErr) {
      if (checkErr.response?.status === 404) {
        return res.json({ success: false, message: 'المستودع غير موجود او ليس لديك صلاحية الوصول' });
      }
      throw checkErr;
    }

    // Verify the authenticated user is the owner
    if (!repoData.permissions || !repoData.permissions.admin) {
      return res.json({ success: false, message: 'ليس لديك صلاحية حذف هذا المستودع. يجب ان تكون مالك المستودع (admin).' });
    }

    // Proceed with deletion
    await axios.delete(`https://api.github.com/repos/${owner}/${repo}`, { headers });
    res.json({ success: true, message: 'تم حذف المستودع بنجاح' });
  } catch (err) {
    const status = err.response?.status;
    let msg = 'فشل حذف المستودع';
    if (status === 403) {
      msg = err.response?.data?.message?.includes('Must have admin rights')
        ? 'ليس لديك صلاحية حذف هذا المستودع. يجب ان تكون مالك المستودع.'
        : 'تم رفض الوصول. تأكد من ان لديك صلاحيات الحذف.';
    } else if (status === 404) {
      msg = 'المستودع غير موجود';
    }
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

// ─── Workspace routes (edit ZIP before push) ───
require('./workspace')(app, workspaceDir);

// ─── Global error handler ───
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err.message);
    res.status(500).json({ error: 'حدث خطأ داخلي في الخادم' });
});

// Start server
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`git-zip server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
