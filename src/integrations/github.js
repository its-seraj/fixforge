'use strict';

const { Octokit } = require('@octokit/rest');
const simpleGit = require('simple-git');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadConfig } = require('../config/ConfigManager');
const logger = require('../utils/logger');

class GitHubClient {
  constructor() {
    const cfg = loadConfig();
    if (!cfg) throw new Error('FixForge not configured. Run `fixforge setup` first.');
    this.token = cfg.githubToken;
    this.defaultRepo = cfg.githubRepo;
    this.baseBranch = cfg.githubBaseBranch || 'main';
    this.octokit = new Octokit({ auth: this.token });
  }

  _parseRepo(repo) {
    const r = repo || this.defaultRepo;
    if (!r) throw new Error('No GitHub repo specified. Pass `repo` in the webhook payload (owner/repo) or set a default in `fixforge setup`.');
    const [owner, name] = r.split('/');
    if (!owner || !name) throw new Error(`Invalid repo format: "${r}". Expected owner/repo.`);
    return { owner, repo: name };
  }

  async getFileContent(filePath, repo) {
    const { owner, repo: repoName } = this._parseRepo(repo);
    const { data } = await this.octokit.repos.getContent({ owner, repo: repoName, path: filePath });
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    return { content, sha: data.sha };
  }

  async searchCode(query, repo) {
    const { owner, repo: repoName } = this._parseRepo(repo);
    const { data } = await this.octokit.search.code({
      q: `${query} repo:${owner}/${repoName}`,
    });
    return data.items.slice(0, 10).map((i) => i.path);
  }

  async cloneToSandbox(repo, branch) {
    const { owner, repo: repoName } = this._parseRepo(repo);
    const sandboxDir = path.join(os.tmpdir(), `fixforge-sandbox-${Date.now()}`);
    fs.mkdirSync(sandboxDir, { recursive: true });

    const cloneUrl = `https://${this.token}@github.com/${owner}/${repoName}.git`;
    const git = simpleGit();
    try {
      await git.clone(cloneUrl, sandboxDir, ['--depth', '1', '--branch', branch || this.baseBranch]);
    } catch {
      try {
        fs.rmSync(sandboxDir, { recursive: true, force: true });
        fs.mkdirSync(sandboxDir, { recursive: true });
      } catch {}
      await git.clone(cloneUrl, sandboxDir, ['--depth', '1']);
    }

    logger.info('Repo cloned to sandbox', { sandboxDir });
    return sandboxDir;
  }

  async createBranch(branchName, repo) {
    const { owner, repo: repoName } = this._parseRepo(repo);

    // Get SHA of base branch HEAD
    const { data: ref } = await this.octokit.git.getRef({
      owner,
      repo: repoName,
      ref: `heads/${this.baseBranch}`,
    });

    await this.octokit.git.createRef({
      owner,
      repo: repoName,
      ref: `refs/heads/${branchName}`,
      sha: ref.object.sha,
    });

    logger.info('Branch created', { branchName });
    return branchName;
  }

  async commitAndPush(sandboxDir, branchName, commitMessage) {
    const git = simpleGit(sandboxDir);
    await git.addConfig('user.email', 'fixforge-bot@fixforge.ai');
    await git.addConfig('user.name', 'FixForge Bot');
    await git.checkoutLocalBranch(branchName);
    await git.add('.');
    await git.commit(commitMessage);
    await git.push('origin', branchName);
    logger.info('Changes pushed', { branchName });
  }

  async createPullRequest({ title, body, branchName, repo }) {
    const { owner, repo: repoName } = this._parseRepo(repo);
    const { data: pr } = await this.octokit.pulls.create({
      owner,
      repo: repoName,
      title,
      body,
      head: branchName,
      base: this.baseBranch,
    });
    logger.info('Pull request created', { number: pr.number, url: pr.html_url });
    return pr;
  }

  async getRecentCommits(repo, n = 10) {
    const { owner, repo: repoName } = this._parseRepo(repo);
    const { data } = await this.octokit.repos.listCommits({ owner, repo: repoName, per_page: n });
    return data.map((c) => ({
      sha: c.sha.slice(0, 7),
      message: c.commit.message.split('\n')[0],
      author: c.commit.author.name,
      date: c.commit.author.date,
    }));
  }

  async cleanupSandbox(sandboxDir) {
    fs.rmSync(sandboxDir, { recursive: true, force: true });
    logger.info('Sandbox cleaned up', { sandboxDir });
  }
}

module.exports = GitHubClient;
