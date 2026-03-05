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
      return { success: false, error: e.message, branch: info.branch };
    }
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

  cleanupOrphans(activeSessionIds, repoPath) {
    if (!repoPath) return;
    const worktreeDir = path.join(repoPath, '.nexus-worktrees');
    if (!fs.existsSync(worktreeDir)) return;

    // Remove orphaned worktree directories
    try {
      const dirs = fs.readdirSync(worktreeDir);
      for (const dir of dirs) {
        if (activeSessionIds.has(dir)) continue;
        const dirPath = path.join(worktreeDir, dir);
        if (!fs.statSync(dirPath).isDirectory()) continue;
        try {
          execSync(`git worktree remove "${dirPath}" --force`, {
            cwd: repoPath,
            stdio: 'pipe',
            timeout: 10000,
          });
        } catch {
          // If git worktree remove fails, try manual cleanup
          try { fs.rmSync(dirPath, { recursive: true, force: true }); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore readdir errors */ }

    // Clean up orphaned nexus-* git branches
    try {
      const branches = execSync('git branch --list "nexus-*"', {
        cwd: repoPath,
        encoding: 'utf8',
        timeout: 10000,
      }).trim().split('\n').map(b => b.trim()).filter(Boolean);

      for (const branch of branches) {
        // Extract session ID from branch name (nexus-{sessionId}-{timestamp})
        const match = branch.match(/^nexus-(.+)-\d+$/);
        if (!match) continue;
        const sessionId = match[1];
        if (activeSessionIds.has(sessionId)) continue;
        try {
          execSync(`git branch -D "${branch}"`, {
            cwd: repoPath,
            stdio: 'pipe',
            timeout: 5000,
          });
        } catch { /* ignore */ }
      }
    } catch { /* ignore branch listing errors */ }
  }

  cleanup() {
    for (const [id] of this.worktrees) {
      this.removeWorktree(id);
    }
  }
}

module.exports = { WorktreeManager };
