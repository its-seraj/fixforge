'use strict';

const JiraClient = require('../integrations/jira');
const GitHubClient = require('../integrations/github');
const { ask, parseJSON } = require('../ai/gemini');
const { classifyErrorPrompt } = require('../ai/prompts');
const { detectRepoFromStack, extractPathsFromStack } = require('../utils/RepoDetector');
const MetricsStore = require('../dashboard/MetricsStore');
const logger = require('../utils/logger');

/**
 * Bug Detection Agent
 * Receives an error payload, classifies it with AI,
 * creates a Jira bug, and returns the issue key.
 */
class BugDetectionAgent {
  constructor() {
    this.jira = new JiraClient();
    this.github = new GitHubClient();
    this.metrics = new MetricsStore();
  }

  async run(errorPayload) {
    const ticketId = `det-${Date.now()}`;
    logger.info('[BugDetectionAgent] Starting', { ticketId });
    this.metrics.upsertTicket({ id: ticketId, status: 'detecting', errorPayload });

    // ── 0. Detect repo from stack trace ───────────────────────────────────
    // If the caller already specified a repo, honour it; otherwise auto-detect.
    let repoInfo = { repo: errorPayload.repo || null, branch: errorPayload.branch || null, detected: false };
    if (!repoInfo.repo && errorPayload.stack) {
      logger.info('[BugDetectionAgent] Auto-detecting repo from stack trace…');
      repoInfo = await detectRepoFromStack(errorPayload.stack);
      if (repoInfo.detected) {
        logger.info('[BugDetectionAgent] Repo detected', { repo: repoInfo.repo, branch: repoInfo.branch });
      } else {
        logger.info('[BugDetectionAgent] Repo not detected from stack — using config default', { repo: repoInfo.repo });
      }
    }

    // ── 1. Classify error with AI ──────────────────────────────────────────
    logger.info('[BugDetectionAgent] Classifying error with Gemini…');
    const prompt = classifyErrorPrompt(errorPayload);
    const raw = await ask(prompt);
    const classification = parseJSON(raw);

    // Enrich affectedFiles with paths already known from the stack trace
    const stackPaths = extractPathsFromStack(errorPayload.stack || '');
    const SRC_MARKERS = ['src', 'app', 'lib', 'server', 'api', 'pkg',
      'routes', 'controllers', 'middleware', 'handlers', 'services',
      'models', 'utils', 'helpers', 'config', 'jobs', 'workers'];
    const relativePaths = stackPaths.map((p) => {
      const parts = p.split('/');
      // Find the LAST occurrence of a src marker so /opt/app/myproject/app/models/x
      // resolves to app/models/x, not app/myproject/app/models/x
      let idx = -1;
      for (let i = parts.length - 1; i >= 0; i--) {
        if (SRC_MARKERS.includes(parts[i])) { idx = i; break; }
      }
      return idx >= 0 ? parts.slice(idx).join('/') : parts.slice(-2).join('/');
    });
    classification.affectedFiles = [
      ...new Set([...(classification.affectedFiles || []), ...relativePaths]),
    ].slice(0, 10);

    logger.info('[BugDetectionAgent] Classification complete', {
      severity: classification.severity,
      category: classification.category,
      affectedFiles: classification.affectedFiles,
    });

    this.metrics.upsertTicket({
      id: ticketId,
      status: 'classified',
      severity: classification.severity,
      category: classification.category,
      title: classification.title,
    });

    // ── 2. Create Jira bug ─────────────────────────────────────────────────
    logger.info('[BugDetectionAgent] Creating Jira bug…');
    let jiraIssue;
    try {
      jiraIssue = await this.jira.createBug({
        summary: classification.title,
        description: `${classification.rootCauseHypothesis}\n\nCustomer impact: ${classification.customerFacingSummary}`,
        priority: classification.severity === 'Critical' ? 'Highest' : classification.severity,
        labels: classification.labels || [],
        errorPayload,
      });
    } catch (err) {
      const errMsg = err.response?.data?.errorMessages?.[0] || err.response?.data?.message || err.message;
      logger.error('[BugDetectionAgent] Failed to create Jira bug', { error: errMsg });
      this.metrics.upsertTicket({
        id: ticketId,
        status: 'failed',
        error: `Jira error: ${errMsg}`,
      });
      throw err;
    }

    this.metrics.upsertTicket({
      id: ticketId,
      jiraKey: jiraIssue.key,
      status: 'jira_created',
    });

    logger.info('[BugDetectionAgent] Jira bug created', { jiraKey: jiraIssue.key });

    return {
      ticketId,
      jiraKey: jiraIssue.key,
      classification,
      errorPayload: {
        ...errorPayload,
        repo: repoInfo.repo,      // resolved repo (detected or default)
        branch: repoInfo.branch,  // resolved branch
        repoDetected: repoInfo.detected,
      },
    };
  }
}

module.exports = BugDetectionAgent;
