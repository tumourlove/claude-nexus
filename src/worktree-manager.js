const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

class WorktreeManager {
  constructor() {
    this.worktrees = new Map(); // sessionId -> { path, branch }
  }

  createWorktree(sessionId, repoPath) {
    const branch = `nexus-${sessionId}-${Date.now()}`;
    const worktreePath = path.join(repoPath, '.nexus-worktrees', sessionId);
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

    try {
      execSync(`git worktree add -b "${branch}" "${worktreePath}"`, {
        cwd: repoPath,
        stdio: 'pipe',
      });
    } catch (e) {
      throw new Error(`Failed to create worktree: ${e.message}`);
    }

    this.worktrees.set(sessionId, { path: worktreePath, branch, repoPath });
    return { path: worktreePath, branch };
  }

  removeWorktree(sessionId) {
    const wt = this.worktrees.get(sessionId);
    if (!wt) return;

    try {
      execSync(`git worktree remove "${wt.path}" --force`, {
        cwd: wt.repoPath,
        stdio: 'pipe',
      });
      execSync(`git branch -D "${wt.branch}"`, {
        cwd: wt.repoPath,
        stdio: 'pipe',
      });
    } catch (e) {
      // Best effort cleanup
    }

    this.worktrees.delete(sessionId);
  }

  getWorktree(sessionId) {
    return this.worktrees.get(sessionId);
  }

  mergeWorktree(sessionId, strategy = 'merge') {
    const info = this.worktrees.get(sessionId);
    if (!info) return { success: false, error: 'No worktree found for session' };

    try {
      const opts = { cwd: info.repoPath, encoding: 'utf8', timeout: 30000 };

      if (strategy === 'squash') {
        execSync(`git merge --squash ${info.branch}`, opts);
        execSync(`git commit -m "Squashed merge from ${info.branch}"`, opts);
      } else if (strategy === 'cherry-pick') {
        // Get commits unique to this branch
        const commits = execSync(`git log --format=%H ${info.branch} --not HEAD`, opts).trim().split('\n').filter(Boolean).reverse();
        for (const commit of commits) {
          execSync(`git cherry-pick ${commit}`, opts);
        }
      } else {
        execSync(`git merge ${info.branch}`, opts);
      }

      return { success: true, branch: info.branch, strategy };
    } catch (e) {
      // Check if merge failed due to conflicts
      const conflicts = this._parseConflicts(info.repoPath);
      if (conflicts.length > 0) {
        return {
          success: false,
          branch: info.branch,
          conflicts: conflicts,
          error: 'Merge conflicts detected',
        };
      }
      return { success: false, error: e.message, branch: info.branch };
    }
  }

  _parseConflicts(repoPath) {
    const opts = { cwd: repoPath, encoding: 'utf8', timeout: 10000 };
    let conflictFiles = [];
    try {
      // git diff --name-only --diff-filter=U lists unmerged (conflicting) files
      const output = execSync('git diff --name-only --diff-filter=U', opts).trim();
      conflictFiles = output.split('\n').filter(Boolean);
    } catch (e) {
      return [];
    }

    const conflicts = [];
    for (const file of conflictFiles) {
      const filePath = path.join(repoPath, file);
      let rawContent = '';
      try {
        rawContent = fs.readFileSync(filePath, 'utf8');
      } catch (e) {
        conflicts.push({ file, ours: '', theirs: '', markers: '(could not read file)' });
        continue;
      }

      // Extract conflict sections from markers
      const markerRegex = /^<{7}\s.*\n([\s\S]*?)^={7}\n([\s\S]*?)^>{7}\s.*$/gm;
      let ours = '';
      let theirs = '';
      let match;
      while ((match = markerRegex.exec(rawContent)) !== null) {
        ours += match[1];
        theirs += match[2];
      }

      conflicts.push({
        file,
        ours: ours.trimEnd(),
        theirs: theirs.trimEnd(),
        markers: rawContent,
      });
    }
    return conflicts;
  }

  resolveConflicts(sessionId, resolutions) {
    const info = this.worktrees.get(sessionId);
    if (!info) return { success: false, error: 'No worktree found for session' };

    const opts = { cwd: info.repoPath, encoding: 'utf8', timeout: 10000 };
    const resolved = [];

    for (const res of resolutions) {
      const filePath = path.join(info.repoPath, res.file);
      try {
        if (res.resolution === 'ours') {
          execSync(`git checkout --ours "${res.file}"`, opts);
        } else if (res.resolution === 'theirs') {
          execSync(`git checkout --theirs "${res.file}"`, opts);
        } else if (res.resolution === 'custom' && res.content !== undefined) {
          fs.writeFileSync(filePath, res.content);
        } else {
          resolved.push({ file: res.file, success: false, error: 'Invalid resolution type' });
          continue;
        }
        resolved.push({ file: res.file, success: true });
      } catch (e) {
        resolved.push({ file: res.file, success: false, error: e.message });
      }
    }

    // Stage all resolved files and commit
    try {
      execSync('git add .', opts);
      execSync('git commit --no-edit', opts);
    } catch (e) {
      return { success: false, resolved, error: `Failed to commit: ${e.message}` };
    }

    return { success: true, resolved };
  }

  listWorktrees() {
    const result = [];
    for (const [sessionId, info] of this.worktrees) {
      let changedFiles = [];
      try {
        const output = execSync(`git diff --name-only HEAD`, { cwd: info.path, encoding: 'utf8', timeout: 5000 });
        changedFiles = output.trim().split('\n').filter(Boolean);
      } catch (e) { /* ignore */ }
      result.push({ sessionId, branch: info.branch, path: info.path, changedFiles });
    }
    return result;
  }

  cleanup() {
    for (const [id] of this.worktrees) {
      this.removeWorktree(id);
    }
  }
}

module.exports = { WorktreeManager };
