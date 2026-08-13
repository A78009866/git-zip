const fs = require('fs');
const path = require('path');
const axios = require('axios');

const MAX_GITHUB_FILE_SIZE = 100 * 1024 * 1024; // 100 MB per file

async function retryWithDelay(fn, retries = 3, delayMs = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

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

async function pushExtractedFolder({ extractPath, repoFullName, branch, commitMessage, token }) {
  if (!repoFullName) {
    throw Object.assign(new Error('Repository is required'), { userMessage: 'Repository is required' });
  }

  const branchName = branch || 'main';
  const message = commitMessage || 'Upload via git-zip';
  const headers = { Authorization: `Bearer ${token}`, 'User-Agent': 'git-zip-app' };

  const access = await checkRepoWriteAccess(repoFullName, headers);
  if (!access.ok) {
    const err = new Error(access.message);
    err.userMessage = access.message;
    throw err;
  }

  repoFullName = access.data.full_name || repoFullName;

  const allFiles = [];
  function walkDir(dir, baseDir) {
    const items = fs.readdirSync(dir);
    for (const item of items) {
      if (item === '.git' || item === '__MACOSX') continue;
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);

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

  const skippedFiles = allFiles.filter((f) => f.size > MAX_GITHUB_FILE_SIZE).map((f) => f.path);
  const filesToUpload = allFiles.filter((f) => f.size <= MAX_GITHUB_FILE_SIZE);

  if (filesToUpload.length === 0) {
    const err = new Error(`ZIP contains no files under ${MAX_GITHUB_FILE_SIZE / 1024 / 1024}MB. Skipped: ${skippedFiles.join(', ')}`);
    err.userMessage = err.message;
    throw err;
  }

  let latestCommitSha, treeSha;
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
      isEmptyRepo = true;
    }
  }

  if (isEmptyRepo) {
    const seedFileName = `.gitkeep-${Date.now()}`;
    let seedCreated = false;

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
        if (seedStatus === 422) {
          seedCreated = true;
          break;
        }
      }
    }

    if (!seedCreated) {
      const err = new Error('Failed to initialize empty repository. Please add a README or any file to the repo on GitHub first, then try uploading again.');
      err.userMessage = err.message;
      throw err;
    }

    try {
      const initRef = await retryWithDelay(() =>
        axios.get(`https://api.github.com/repos/${repoFullName}/git/ref/heads/${defaultBranch}`, { headers })
      , 5, 1500);
      latestCommitSha = initRef.data.object.sha;
      const initCommit = await axios.get(`https://api.github.com/repos/${repoFullName}/git/commits/${latestCommitSha}`, { headers });
      treeSha = initCommit.data.tree.sha;
      if (branchName !== defaultBranch) {
        await axios.post(`https://api.github.com/repos/${repoFullName}/git/refs`, { ref: `refs/heads/${branchName}`, sha: latestCommitSha }, { headers });
      }
      isEmptyRepo = false;
      console.log('Empty repo initialized successfully, Git Data API should now be available');
    } catch (refErr) {
      console.error('Failed to get ref after seed commit:', refErr.response?.data?.message || refErr.message);
    }
  }

  if (isEmptyRepo) {
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
    const warn = skippedFiles.length ? ` (skipped ${skippedFiles.length} file(s) over 100MB)` : '';
    return { success: true, message: `Successfully pushed ${filesToUpload.length} files to ${repoFullName} (via Contents API)${warn}`, commitSha: lastCommitSha, filesCount: filesToUpload.length, skipped: skippedFiles, branchName, message };
  }

  let finalCommitSha = null;

  try {
    const treeItems = [];
    for (const file of filesToUpload) {
      const content = fs.readFileSync(file.fullPath);
      const blobRes = await axios.post(`https://api.github.com/repos/${repoFullName}/git/blobs`, {
        content: content.toString('base64'), encoding: 'base64'
      }, { headers });
      treeItems.push({ path: file.path, mode: '100644', type: 'blob', sha: blobRes.data.sha });
    }

    const newTree = await retryWithDelay(() =>
      axios.post(`https://api.github.com/repos/${repoFullName}/git/trees`, { base_tree: treeSha, tree: treeItems }, { headers })
    , 3, 2000);
    const newCommit = await axios.post(`https://api.github.com/repos/${repoFullName}/git/commits`, { message, tree: newTree.data.sha, parents: [latestCommitSha] }, { headers });
    await axios.patch(`https://api.github.com/repos/${repoFullName}/git/refs/heads/${branchName}`, { sha: newCommit.data.sha }, { headers });
    finalCommitSha = newCommit.data.sha;
  } catch (gitApiErr) {
    const gitApiStatus = gitApiErr.response?.status;
    console.warn('Git Data API failed (status ' + gitApiStatus + '), falling back to Contents API...', gitApiErr.response?.data?.message || gitApiErr.message);

    let lastSha = null;
    let uploadedCount = 0;
    for (const file of filesToUpload) {
      try {
        const content = fs.readFileSync(file.fullPath);

        let existingFileSha;
        try {
          const existingRes = await axios.get(`https://api.github.com/repos/${repoFullName}/contents/${file.path}?ref=${branchName}`, { headers });
          existingFileSha = existingRes.data.sha;
        } catch (e) {
          // File doesn't exist yet
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
      const err = new Error(gitApiErr.response?.data?.message || gitApiErr.message || 'Git Data API and Contents API both failed');
      err.status = gitApiErr.response?.status;
      err.userMessage = gitApiErr.response?.data?.message || 'Failed to push to GitHub';
      throw err;
    }

    finalCommitSha = lastSha;
    console.log(`Fallback succeeded: uploaded ${uploadedCount}/${filesToUpload.length} files via Contents API`);
  }

  const uploadWarn = skippedFiles.length ? ` (${skippedFiles.length} file(s) over 100MB skipped)` : '';
  return { success: true, message: `Successfully pushed ${filesToUpload.length} files to ${repoFullName}${uploadWarn}`, commitSha: finalCommitSha, filesCount: filesToUpload.length, skipped: skippedFiles, branchName, message };
}

module.exports = { pushExtractedFolder, MAX_GITHUB_FILE_SIZE };
