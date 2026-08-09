const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const AdmZip = require('adm-zip');
const multer = require('multer');

// ─── Config ───
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB for edited files
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'xml', 'svg', 'yml', 'yaml',
  'py', 'rb', 'php', 'go', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'swift',
  'kt', 'rs', 'sh', 'bash', 'zsh', 'ps1', 'sql', 'env', 'gitignore',
  'ini', 'cfg', 'conf', 'toml', 'lua', 'r', 'dart', 'vue'
]);

function requireApiAuth(req, res, next) {
  if (req.session && req.session.githubToken) return next();
  return res.status(401).json({ success: false, message: 'Not authenticated', authRequired: true });
}

function getWorkspacePath(req, workspaceDir) {
  if (!req.session.workspaceId) {
    req.session.workspaceId = crypto.randomUUID();
  }
  return path.join(workspaceDir, req.session.workspaceId);
}

function safeResolve(baseDir, relPath) {
  const target = path.resolve(baseDir, relPath);
  const resolvedBase = path.resolve(baseDir);
  if (!target.startsWith(resolvedBase + path.sep) && target !== resolvedBase) {
    return null;
  }
  return target;
}

function isTextFile(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

async function checkRepoWriteAccess(repoFullName, token) {
  try {
    const res = await axios.get(`https://api.github.com/repos/${repoFullName}`, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'git-zip-app' }
    });
    if (!res.data.permissions || !res.data.permissions.push) {
      return { ok: false, message: 'ليس لديك صلاحية الكتابة في هذا المستودع' };
    }
    return { ok: true, data: res.data };
  } catch (err) {
    if (err.response?.status === 404) {
      return { ok: false, message: 'المستودع غير موجود او ليس لديك صلاحية الوصول' };
    }
    return { ok: false, message: 'تعذر التحقق من صلاحيات المستودع' };
  }
}

async function createBranchIfNeeded(repoFullName, branchName, defaultBranch, token) {
  const headers = { Authorization: `Bearer ${token}`, 'User-Agent': 'git-zip-app' };
  if (branchName === defaultBranch) return true;
  try {
    await axios.get(`https://api.github.com/repos/${repoFullName}/git/ref/heads/${branchName}`, { headers });
    return true;
  } catch (err) {
    if (err.response?.status !== 404) return false;
  }
  try {
    const def = await axios.get(`https://api.github.com/repos/${repoFullName}/git/ref/heads/${defaultBranch}`, { headers });
    await axios.post(`https://api.github.com/repos/${repoFullName}/git/refs`, {
      ref: `refs/heads/${branchName}`,
      sha: def.data.object.sha
    }, { headers });
    return true;
  } catch (err) {
    return false;
  }
}

function walkWorkspace(dir, baseDir, result = []) {
  const items = fs.readdirSync(dir);
  for (const item of items) {
    if (item === '.git') continue;
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      walkWorkspace(fullPath, baseDir, result);
    } else {
      result.push({
        path: path.relative(baseDir, fullPath).replace(/\\/g, '/'),
        fullPath
      });
    }
  }
  return result;
}

module.exports = function (app, workspaceDir) {
  const workspaceUploadDir = workspaceDir + '_uploads';
  if (!fs.existsSync(workspaceUploadDir)) fs.mkdirSync(workspaceUploadDir, { recursive: true });

  const workspaceUpload = multer({
    dest: workspaceUploadDir,
    limits: { fileSize: 100 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (file.mimetype === 'application/zip' || file.mimetype === 'application/x-zip-compressed' || file.originalname.endsWith('.zip')) {
        cb(null, true);
      } else {
        cb(new Error('Only ZIP files are allowed'));
      }
    }
  });

  // ─── Upload ZIP to workspace ───
  app.post('/api/workspace/upload', requireApiAuth, workspaceUpload.single('zipfile'), async (req, res) => {
    try {
      if (!req.file) return res.json({ success: false, message: 'لم يتم رفع اي ملف' });

      const wsPath = getWorkspacePath(req, workspaceDir);
      if (fs.existsSync(wsPath)) fs.rmSync(wsPath, { recursive: true, force: true });
      fs.mkdirSync(wsPath, { recursive: true });

      const zip = new AdmZip(req.file.path);
      zip.extractAllTo(wsPath, true);
      fs.unlinkSync(req.file.path);

      // If zip contains a single top-level folder, move contents up
      const top = fs.readdirSync(wsPath);
      if (top.length === 1) {
        const single = path.join(wsPath, top[0]);
        if (fs.statSync(single).isDirectory()) {
          const temp = wsPath + '_tmp_' + Date.now();
          fs.renameSync(single, temp);
          fs.rmSync(wsPath, { recursive: true, force: true });
          fs.renameSync(temp, wsPath);
        }
      }

      const files = walkWorkspace(wsPath, wsPath).map(f => f.path);
      res.json({ success: true, files, workspaceId: req.session.workspaceId });
    } catch (err) {
      console.error('Workspace upload error:', err.message);
      res.json({ success: false, message: err.message || 'فشل رفع الملف المضغوط' });
    }
  });

  // ─── List workspace files ───
  app.get('/api/workspace/files', requireApiAuth, (req, res) => {
    try {
      const wsPath = getWorkspacePath(req, workspaceDir);
      if (!fs.existsSync(wsPath)) return res.json({ success: true, entries: [] });

      const rel = req.query.path || '';
      const target = safeResolve(wsPath, rel);
      if (!target) return res.status(400).json({ success: false, message: 'مسار غير صالح' });
      if (!fs.existsSync(target)) return res.json({ success: true, entries: [] });

      const stat = fs.statSync(target);
      if (stat.isFile()) {
        return res.json({ success: true, entries: [] });
      }

      const entries = fs.readdirSync(target).map(name => {
        const p = path.join(target, name);
        const s = fs.statSync(p);
        return { name, type: s.isDirectory() ? 'dir' : 'file' };
      }).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'dir' ? -1 : 1)));

      res.json({ success: true, entries, path: rel });
    } catch (err) {
      console.error('Workspace files error:', err.message);
      res.json({ success: false, message: 'فشل قراءة الملفات' });
    }
  });

  // ─── Read workspace file ───
  app.get('/api/workspace/file', requireApiAuth, (req, res) => {
    try {
      const wsPath = getWorkspacePath(req, workspaceDir);
      const rel = req.query.path || '';
      const target = safeResolve(wsPath, rel);
      if (!target || !fs.existsSync(target)) return res.status(404).json({ success: false, message: 'الملف غير موجود' });
      if (fs.statSync(target).isDirectory()) return res.status(400).json({ success: false, message: 'المسار هو مجلد' });

      const name = path.basename(target);
      const buffer = fs.readFileSync(target);
      if (isTextFile(name)) {
        return res.json({ success: true, content: buffer.toString('utf8'), encoding: 'utf8', name });
      }
      return res.json({ success: true, content: buffer.toString('base64'), encoding: 'base64', name, binary: true });
    } catch (err) {
      console.error('Workspace read error:', err.message);
      res.json({ success: false, message: 'فشل قراءة الملف' });
    }
  });

  // ─── Write workspace file ───
  app.post('/api/workspace/file', requireApiAuth, (req, res) => {
    try {
      const wsPath = getWorkspacePath(req, workspaceDir);
      const rel = req.body.path || '';
      const target = safeResolve(wsPath, rel);
      if (!target) return res.status(400).json({ success: false, message: 'مسار غير صالح' });

      const content = req.body.content || '';
      const encoding = req.body.encoding || 'utf8';
      const buf = Buffer.from(content, encoding === 'base64' ? 'base64' : 'utf8');
      if (buf.length > MAX_FILE_SIZE) return res.status(400).json({ success: false, message: 'حجم الملف كبير جدا' });

      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buf);
      res.json({ success: true, message: 'تم حفظ الملف' });
    } catch (err) {
      console.error('Workspace write error:', err.message);
      res.json({ success: false, message: 'فشل حفظ الملف' });
    }
  });

  // ─── Delete workspace file/folder ───
  app.delete('/api/workspace/file', requireApiAuth, (req, res) => {
    try {
      const wsPath = getWorkspacePath(req, workspaceDir);
      const rel = req.query.path || '';
      const target = safeResolve(wsPath, rel);
      if (!target || !fs.existsSync(target)) return res.status(404).json({ success: false, message: 'العنصر غير موجود' });
      if (target === wsPath) return res.status(400).json({ success: false, message: 'لا يمكن حذف مجلد العمل كاملا' });

      const stat = fs.statSync(target);
      if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
      else fs.unlinkSync(target);

      res.json({ success: true, message: 'تم الحذف' });
    } catch (err) {
      console.error('Workspace delete error:', err.message);
      res.json({ success: false, message: 'فشل الحذف' });
    }
  });

  // ─── Push workspace to GitHub ───
  app.post('/api/workspace/commit', requireApiAuth, async (req, res) => {
    let pushed = 0;
    try {
      const { repoFullName, branch, commitMessage } = req.body;
      if (!repoFullName) return res.json({ success: false, message: 'اسم المستودع مطلوب' });

      const wsPath = getWorkspacePath(req, workspaceDir);
      if (!fs.existsSync(wsPath)) return res.json({ success: false, message: 'لا يوجد مساحة عمل' });

      const files = walkWorkspace(wsPath, wsPath);
      if (files.length === 0) return res.json({ success: false, message: 'مساحة العمل فارغة' });

      const token = req.session.githubToken;
      const access = await checkRepoWriteAccess(repoFullName, token);
      if (!access.ok) return res.json({ success: false, message: access.message });

      const repoData = access.data;
      const canonicalName = repoData.full_name || repoFullName;
      const defaultBranch = repoData.default_branch || 'main';
      const branchName = branch || defaultBranch;

      const created = await createBranchIfNeeded(canonicalName, branchName, defaultBranch, token);
      if (!created) return res.json({ success: false, message: 'تعذر انشاء/التحقق من الفرع' });

      const headers = { Authorization: `Bearer ${token}`, 'User-Agent': 'git-zip-app' };
      const message = commitMessage || 'Update from git-zip workspace';
      let lastSha = null;

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const content = fs.readFileSync(file.fullPath).toString('base64');

        let existingSha;
        try {
          const existing = await axios.get(
            `https://api.github.com/repos/${canonicalName}/contents/${file.path}?ref=${branchName}`,
            { headers }
          );
          existingSha = existing.data.sha;
        } catch (e) {
          // file does not exist
        }

        const body = {
          message: files.length === 1 ? message : `${message} (${file.path})`,
          content,
          branch: branchName,
          ...(existingSha ? { sha: existingSha } : {})
        };

        const putRes = await axios.put(
          `https://api.github.com/repos/${canonicalName}/contents/${file.path}`,
          body,
          { headers }
        );
        lastSha = putRes.data.commit.sha;
        pushed++;
      }

      res.json({ success: true, message: `تم رفع ${pushed} ملفاً الى ${canonicalName}`, commitSha: lastSha, filesCount: pushed });
    } catch (err) {
      console.error('Workspace commit error:', err.response?.data || err.message);
      res.json({ success: false, message: err.response?.data?.message || 'فشل رفع التعديلات' });
    }
  });

  // ─── Download workspace as ZIP ───
  app.get('/api/workspace/download', requireApiAuth, (req, res) => {
    try {
      const wsPath = getWorkspacePath(req, workspaceDir);
      if (!fs.existsSync(wsPath)) return res.status(404).json({ success: false, message: 'لا يوجد مساحة عمل' });

      const zip = new AdmZip();
      zip.addLocalFolder(wsPath);
      const zipBuf = zip.toBuffer();
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="workspace.zip"');
      res.send(zipBuf);
    } catch (err) {
      console.error('Workspace download error:', err.message);
      res.status(500).json({ success: false, message: 'فشل تحميل الملف المضغوط' });
    }
  });
};
