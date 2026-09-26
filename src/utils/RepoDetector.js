'use strict';

const { Octokit } = require('@octokit/rest');
const { loadConfig } = require('../config/ConfigManager');
const logger = require('../utils/logger');

/**
 * Extracts file paths from a Node.js / Python / Java stack trace.
 */
function extractPathsFromStack(stack) {
  if (!stack || typeof stack !== 'string') return [];

  const found = new Set();

  for (const line of stack.split('\n')) {
    const patterns = [
      // Node.js:  at fn (/abs/path/file.js:line:col)  OR  at async fn (/path/file.js:line)
      /at\s+(?:async\s+)?\S+\s+\(([^)]+\.(?:js|ts|mjs|cjs)):\d+/,
      // Node.js anonymous: at /abs/path/file.js:line
      /at\s+((?:\/|[A-Za-z]:)[^\s:]+\.(?:js|ts|mjs|cjs)):\d+/,
      // Windows Node.js: at fn (C:\path\file.js:line)
      /at\s+(?:async\s+)?\S+\s+\(([A-Za-z]:[^)]+\.(?:js|ts|mjs|cjs)):\d+/,
      // Python: File "path/file.py", line N
      /File\s+"([^"]+\.py)",\s+line\s+\d+/,
    ];

    for (const re of patterns) {
      const m = line.match(re);
      if (m) {
        const p = m[1].replace(/\\/g, '/');
        if (!p.includes('node_modules') && !p.includes('internal/') && !p.startsWith('node:')) {
          found.add(p);
        }
        break;
      }
    }
  }

  return [...found];
}

/**
 * Given a list of file paths, derive candidate repo/project names.
 */
function deriveProjectNames(paths) {
  const SRC_MARKERS = new Set([
    'src', 'app', 'lib', 'dist', 'build', 'pkg', 'server', 'api',
    'routes', 'controllers', 'middleware', 'handlers', 'services',
    'models', 'utils', 'helpers', 'config', 'jobs', 'workers',
  ]);

  const IGNORED_NAMES = new Set([
    'home', 'usr', 'var', 'opt', 'deploy', 'runner', 'work', 'root',
    'windows', 'users', 'downloads', 'documents', 'desktop', 'temp', 'tmp',
    ...SRC_MARKERS,
  ]);

  const names = new Set();

  for (const p of paths) {
    const parts = p.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      if (SRC_MARKERS.has(parts[i].toLowerCase()) && i > 0) {
        const candidate = parts[i - 1].toLowerCase();
        if (!IGNORED_NAMES.has(candidate)) {
          names.add(candidate);
        }
      }
    }
  }
  return [...names];
}

/**
 * Uses the GitHub Search API to find which accessible repo contains a given file.
 */
async function searchRepoForFile(octokit, filePath, username) {
  const parts = filePath.split('/').filter(Boolean);
  if (parts.length < 2) return [];
  const fileName = parts[parts.length - 1];
  const pathDir = parts[parts.length - 2];

  const q = username
    ? `user:${username} filename:${fileName} path:${pathDir}`
    : `filename:${fileName} path:${pathDir}`;

  try {
    const { data } = await octokit.search.code({ q, per_page: 5 });
    if (data.items?.length > 0) {
      return data.items.map((i) => i.repository.full_name);
    }
  } catch (err) {
    logger.debug('GitHub code search failed', { q, err: err.message });
  }
  return [];
}

/**
 * Main entry point: given a stack trace string, return the best-guess { owner, repo, branch }.
 * Restricted strictly to repositories the authenticated user owns or has access to.
 */
async function detectRepoFromStack(stack) {
  const cfg = loadConfig();
  const defaultBranch = cfg?.githubBaseBranch || 'main';
  const defaultRepo = cfg?.githubRepo || null;

  if (!stack || !cfg?.githubToken) {
    return { repo: defaultRepo, branch: defaultBranch, detected: false };
  }

  const paths = extractPathsFromStack(stack);
  logger.debug('RepoDetector: extracted paths', { count: paths.length, paths: paths.slice(0, 5) });

  if (paths.length === 0) {
    return { repo: defaultRepo, branch: defaultBranch, detected: false };
  }

  const octokit = new Octokit({ auth: cfg.githubToken });

  // 1. Fetch user's accessible repos
  let accessibleRepos = [];
  let username = null;
  try {
    const { data: user } = await octokit.users.getAuthenticated();
    username = user.login;
    const { data: repos } = await octokit.repos.listForAuthenticatedUser({ per_page: 100, sort: 'updated' });
    accessibleRepos = repos.map((r) => r.full_name);
  } catch (err) {
    logger.debug('RepoDetector: could not fetch authenticated user repos', { err: err.message });
  }

  // ── Strategy 1: match project directory name against accessible repos ───────
  const projectNames = deriveProjectNames(paths);
  logger.debug('RepoDetector: candidate project names', { projectNames, accessibleCount: accessibleRepos.length });

  if (projectNames.length > 0 && accessibleRepos.length > 0) {
    for (const name of projectNames) {
      const match = accessibleRepos.find((r) => {
        const repoName = r.split('/')[1]?.toLowerCase();
        return repoName === name || repoName.includes(name);
      });
      if (match) {
        logger.info('RepoDetector: matched accessible repo by project name', { name, match });
        return { repo: match, branch: defaultBranch, detected: true };
      }
    }
  }

  // ── Strategy 2: search accessible repos for the file ───────────────────────
  try {
    const repoVotes = {};
    for (const filePath of paths.slice(0, 3)) {
      const repos = await searchRepoForFile(octokit, filePath, username);
      for (const r of repos) {
        // Only count if it belongs to the authenticated user/org
        if (accessibleRepos.length === 0 || accessibleRepos.includes(r)) {
          repoVotes[r] = (repoVotes[r] || 0) + 1;
        }
      }
    }
    const sorted = Object.entries(repoVotes).sort((a, b) => b[1] - a[1]);
    if (sorted.length > 0) {
      const [bestRepo] = sorted[0];
      logger.info('RepoDetector: matched accessible repo by file search', { bestRepo, votes: sorted[0][1] });
      return { repo: bestRepo, branch: defaultBranch, detected: true };
    }
  } catch (err) {
    logger.debug('RepoDetector: file search failed', { err: err.message });
  }

  // ── Fallback to configured default repo ─────────────────────────────────────
  logger.info('RepoDetector: could not detect specific repo, using default', { defaultRepo });
  return { repo: defaultRepo, branch: defaultBranch, detected: false };
}

module.exports = { detectRepoFromStack, extractPathsFromStack, deriveProjectNames };
