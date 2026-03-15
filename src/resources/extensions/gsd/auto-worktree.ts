/**
 * GSD Auto-Worktree — lifecycle management for auto-mode worktrees.
 *
 * Auto-mode creates worktrees with `milestone/<MID>` branches (distinct from
 * manual `/worktree` which uses `worktree/<name>` branches). This module
 * manages create, enter, detect, and teardown for auto-mode worktrees.
 */

import { existsSync, readFileSync, realpathSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import {
  createWorktree,
  removeWorktree,
  worktreePath,
} from "./worktree-manager.js";
import {
  detectWorktreeName,
  getSliceBranchName,
} from "./worktree.js";
import {
  MergeConflictError,
  inferCommitType,
} from "./git-service.js";
import type { MergeSliceResult } from "./git-service.js";
import {
  nativeBranchExists,
  nativeCommitCountBetween,
} from "./native-git-bridge.js";

// ─── Module State ──────────────────────────────────────────────────────────

/** Original project root before chdir into auto-worktree. */
let originalBase: string | null = null;

// ─── Git Helpers (local, mirrors worktree-command.ts pattern) ──────────────

function resolveGitHeadPath(dir: string): string | null {
  const gitPath = join(dir, ".git");
  if (!existsSync(gitPath)) return null;
  try {
    const content = readFileSync(gitPath, "utf8").trim();
    if (content.startsWith("gitdir: ")) {
      const gitDir = resolve(dir, content.slice(8));
      const headPath = join(gitDir, "HEAD");
      return existsSync(headPath) ? headPath : null;
    }
    const headPath = join(dir, ".git", "HEAD");
    return existsSync(headPath) ? headPath : null;
  } catch {
    return null;
  }
}

/**
 * Nudge pi's FooterDataProvider to re-read the git branch after chdir.
 * Touches HEAD in both old and new cwd to fire the fs watcher.
 */
function nudgeGitBranchCache(previousCwd: string): void {
  const now = new Date();
  for (const dir of [previousCwd, process.cwd()]) {
    try {
      const headPath = resolveGitHeadPath(dir);
      if (headPath) utimesSync(headPath, now, now);
    } catch {
      // Best-effort
    }
  }
}

function getCurrentBranch(cwd: string): string {
  try {
    return execSync("git branch --show-current", {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    }).trim();
  } catch {
    return "";
  }
}

// ─── Auto-Worktree Branch Naming ───────────────────────────────────────────

export function autoWorktreeBranch(milestoneId: string): string {
  return `milestone/${milestoneId}`;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Create a new auto-worktree for a milestone, chdir into it, and store
 * the original base path for later teardown.
 *
 * Atomic: chdir + originalBase update happen in the same try block
 * to prevent split-brain.
 */
export function createAutoWorktree(basePath: string, milestoneId: string): string {
  const branch = autoWorktreeBranch(milestoneId);
  const info = createWorktree(basePath, milestoneId, { branch });
  const previousCwd = process.cwd();

  try {
    process.chdir(info.path);
    originalBase = basePath;
  } catch (err) {
    // If chdir fails, the worktree was created but we couldn't enter it.
    // Don't store originalBase — caller can retry or clean up.
    throw new Error(
      `Auto-worktree created at ${info.path} but chdir failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  nudgeGitBranchCache(previousCwd);
  return info.path;
}

/**
 * Teardown an auto-worktree: chdir back to original base, then remove
 * the worktree and its branch.
 */
export function teardownAutoWorktree(originalBasePath: string, milestoneId: string): void {
  const branch = autoWorktreeBranch(milestoneId);
  const previousCwd = process.cwd();

  try {
    process.chdir(originalBasePath);
    originalBase = null;
  } catch (err) {
    throw new Error(
      `Failed to chdir back to ${originalBasePath} during teardown: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  nudgeGitBranchCache(previousCwd);
  removeWorktree(originalBasePath, milestoneId, { branch });
}

/**
 * Detect if the process is currently inside an auto-worktree.
 * Checks both module state and git branch prefix.
 */
export function isInAutoWorktree(basePath: string): boolean {
  if (!originalBase) return false;
  const cwd = process.cwd();
  const resolvedBase = existsSync(basePath) ? realpathSync(basePath) : basePath;
  const wtDir = join(resolvedBase, ".gsd", "worktrees");
  if (!cwd.startsWith(wtDir)) return false;
  const branch = getCurrentBranch(cwd);
  return branch.startsWith("milestone/");
}

/**
 * Get the filesystem path for an auto-worktree, or null if it doesn't exist.
 */
export function getAutoWorktreePath(basePath: string, milestoneId: string): string | null {
  const p = worktreePath(basePath, milestoneId);
  return existsSync(p) ? p : null;
}

/**
 * Enter an existing auto-worktree (chdir into it, store originalBase).
 * Use for resume — the worktree already exists from a prior create.
 *
 * Atomic: chdir + originalBase update in same try block.
 */
export function enterAutoWorktree(basePath: string, milestoneId: string): string {
  const p = worktreePath(basePath, milestoneId);
  if (!existsSync(p)) {
    throw new Error(`Auto-worktree for ${milestoneId} does not exist at ${p}`);
  }

  const previousCwd = process.cwd();

  try {
    process.chdir(p);
    originalBase = basePath;
  } catch (err) {
    throw new Error(
      `Failed to enter auto-worktree at ${p}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  nudgeGitBranchCache(previousCwd);
  return p;
}

/**
 * Get the original project root stored when entering an auto-worktree.
 * Returns null if not currently in an auto-worktree.
 */
export function getAutoWorktreeOriginalBase(): string | null {
  return originalBase;
}

// ─── Merge Slice → Milestone ───────────────────────────────────────────────

/**
 * Merge a completed slice branch into the milestone branch via `--no-ff`.
 *
 * Worktree-mode merge: `.gsd/` is local to the worktree (not tracked in
 * git), so there are zero `.gsd/` conflict resolution concerns. No runtime
 * exclusion untracking, no `--theirs` checkout, no snapshot creation.
 *
 * On conflict: throws MergeConflictError with conflicted file list.
 * On success: deletes the slice branch and returns MergeSliceResult.
 */
export function mergeSliceToMilestone(
  basePath: string,
  milestoneId: string,
  sliceId: string,
  sliceTitle: string,
): MergeSliceResult {
  if (!isInAutoWorktree(basePath)) {
    throw new Error("mergeSliceToMilestone called outside auto-worktree");
  }

  const cwd = process.cwd();
  const milestoneBranch = autoWorktreeBranch(milestoneId);
  const worktreeName = detectWorktreeName(cwd);
  const sliceBranch = getSliceBranchName(milestoneId, sliceId, worktreeName);

  // Verify slice branch exists
  if (!nativeBranchExists(cwd, sliceBranch)) {
    throw new Error(`Slice branch "${sliceBranch}" does not exist`);
  }

  // Verify slice has commits ahead of milestone branch
  const commitCount = nativeCommitCountBetween(cwd, milestoneBranch, sliceBranch);
  if (commitCount === 0) {
    throw new Error(
      `Slice branch "${sliceBranch}" has no commits ahead of "${milestoneBranch}"`,
    );
  }

  // Checkout milestone branch
  execSync(`git checkout ${milestoneBranch}`, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });

  // Build rich commit message (replicates GitServiceImpl.buildRichCommitMessage format)
  const commitType = inferCommitType(sliceTitle);
  const subject = `${commitType}(${milestoneId}/${sliceId}): ${sliceTitle}`;

  let message = subject;
  try {
    const logOutput = execSync(
      `git log --oneline --format=%s ${milestoneBranch}..${sliceBranch}`,
      { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
    ).trim();

    if (logOutput) {
      const subjects = logOutput.split("\n").filter(Boolean);
      const MAX_ENTRIES = 20;
      const truncated = subjects.length > MAX_ENTRIES;
      const displayed = truncated ? subjects.slice(0, MAX_ENTRIES) : subjects;
      const taskLines = displayed.map(s => `- ${s}`).join("\n");
      const truncationLine = truncated
        ? `\n- ... and ${subjects.length - MAX_ENTRIES} more`
        : "";
      message = `${subject}\n\nTasks:\n${taskLines}${truncationLine}\n\nBranch: ${sliceBranch}`;
    }
  } catch {
    // Fall back to subject-only message
  }

  // Merge --no-ff
  try {
    execSync(`git merge --no-ff -m "${message.replace(/"/g, '\\"')}" ${sliceBranch}`, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
  } catch {
    // Check if this is a merge conflict
    try {
      const conflictOutput = execSync("git diff --name-only --diff-filter=U", {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
      }).trim();

      if (conflictOutput) {
        const conflictedFiles = conflictOutput.split("\n").filter(Boolean);
        throw new MergeConflictError(
          conflictedFiles,
          "merge",
          sliceBranch,
          milestoneBranch,
        );
      }
    } catch (innerErr) {
      if (innerErr instanceof MergeConflictError) throw innerErr;
    }
    // Non-conflict git error
    throw new Error(`git merge --no-ff failed for ${sliceBranch} into ${milestoneBranch}`);
  }

  // Delete slice branch
  let deletedBranch = false;
  try {
    execSync(`git branch -d ${sliceBranch}`, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
    deletedBranch = true;
  } catch {
    // Branch deletion is best-effort
  }

  return {
    branch: sliceBranch,
    mergedCommitMessage: message,
    deletedBranch,
  };
}
