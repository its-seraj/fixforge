'use strict';

const BugDetectionAgent = require('./BugDetectionAgent');
const BugResolverAgent = require('./BugResolverAgent');
const JiraClient = require('../integrations/jira');
const GitHubClient = require('../integrations/github');
const MetricsStore = require('../dashboard/MetricsStore');
const logger = require('../utils/logger');

/**
 * Orchestrates Detection → Resolution pipeline.
 * Also monitors and handles Pull Request merge events to update Jira tickets to Done.
 */
class AgentOrchestrator {
  constructor() {
    this.jira = new JiraClient();
    this.github = new GitHubClient();
    this.metrics = new MetricsStore();
    this.activeResolutions = new Set();
    this._mergePollTimer = null;
    this.startMergePoller();
    // Run an initial sweep for any tickets stuck in "In Progress"
    setTimeout(() => {
      this.checkStuckInProgressTickets().catch(() => {});
    }, 4000);
  }

  async handleError(errorPayload) {
    logger.info('[Orchestrator] Error event received', {
      message: errorPayload.message?.slice(0, 120),
    });

    const detectionAgent = new BugDetectionAgent();
    const detectionResult = await detectionAgent.run(errorPayload);

    const resolverAgent = new BugResolverAgent();
    const activeKey = detectionResult.jiraKey || detectionResult.ticketId;
    if (activeKey) this.activeResolutions.add(activeKey);

    // Run resolution asynchronously so webhook can return immediately
    resolverAgent.run(detectionResult)
      .catch((err) => {
        logger.error('[Orchestrator] Resolver crashed', { err: err.message });
      })
      .finally(() => {
        if (activeKey) this.activeResolutions.delete(activeKey);
      });

    return detectionResult;
  }

  async resolveJiraIssue(issueOrKey, source = 'manual') {
    let issue;
    let jiraKey;
    if (typeof issueOrKey === 'string') {
      jiraKey = issueOrKey;
      issue = await this.jira.getIssue(jiraKey);
    } else {
      issue = issueOrKey;
      jiraKey = issue.key;
    }

    logger.info(`[Orchestrator] Resolving Jira ticket ${jiraKey} (source: ${source})`);

    let message = issue.fields?.summary || '';
    let stack = '';
    let repo = this.github.cfg?.githubRepo || 'its-seraj/runtime-error-service';
    let branch = 'main';

    // Parse structured JSON from description code block if present
    if (issue.fields?.description?.content) {
      for (const block of issue.fields.description.content) {
        if (block.type === 'codeBlock' && block.content?.[0]?.text) {
          try {
            const parsed = JSON.parse(block.content[0].text);
            if (parsed.message) message = parsed.message;
            if (parsed.stack) stack = parsed.stack;
            if (parsed.repo) repo = parsed.repo;
            if (parsed.branch) branch = parsed.branch;
          } catch {}
        }
      }
    }

    const errorPayload = {
      message,
      stack,
      repo,
      branch,
      source,
      jiraKey,
    };

    const classification = {
      title: issue.fields?.summary || message,
      severity: issue.fields?.priority?.name || 'High',
      affectedFiles: [],
      labels: issue.fields?.labels || [],
    };

    const ticketId = `jira-${jiraKey.toLowerCase()}-${Date.now()}`;
    const resolver = new BugResolverAgent();
    await resolver.run({
      ticketId,
      jiraKey,
      classification,
      errorPayload,
    });
  }

  async handleManualResolve(jiraKey) {
    if (jiraKey) this.activeResolutions.add(jiraKey);
    try {
      await this.resolveJiraIssue(jiraKey, 'manual');
    } finally {
      if (jiraKey) this.activeResolutions.delete(jiraKey);
    }
  }

  /**
   * Called when a Pull Request is merged (via GitHub webhook or proactive merge poller).
   * Transitions corresponding Jira ticket to "Done" and updates ticket metrics.
   */
  async handlePullRequestMerged(pr, repoName) {
    const prNumber = pr.number;
    const repo = repoName || pr.base?.repo?.full_name || this.github.cfg?.githubRepo || 'its-seraj/runtime-error-service';
    const prUrl = pr.html_url || `https://github.com/${repo}/pull/${prNumber}`;
    logger.info('[Orchestrator] Handling merged Pull Request', { prNumber, prUrl });

    // 1. Identify Jira issue key
    let jiraKey = null;

    // Check branch name e.g. fixforge/kan-15-1790418247994
    const branchMatch = (pr.head?.ref || '').match(/fixforge\/([a-zA-Z0-9]+-\d+)/i);
    if (branchMatch) {
      jiraKey = branchMatch[1].toUpperCase();
    }

    // Check PR title e.g. [KAN-15] or fix(KAN-15)
    if (!jiraKey) {
      const titleMatch = (pr.title || '').match(/\[?([A-Z][A-Z0-9]+-\d+)\]?/);
      if (titleMatch) jiraKey = titleMatch[1];
    }

    // Check body
    if (!jiraKey && pr.body) {
      const bodyMatch = pr.body.match(/Jira:\s*([A-Z][A-Z0-9]+-\d+)/i) || pr.body.match(/([A-Z][A-Z0-9]+-\d+)/);
      if (bodyMatch) jiraKey = bodyMatch[1];
    }

    // Search metrics store by prNumber or prUrl
    const tickets = this.metrics.getTickets(50);
    const matchedTicket = tickets.find(
      (t) => t.pr_number === prNumber || t.pr_url === prUrl || (jiraKey && t.jira_key === jiraKey)
    );

    if (!jiraKey && matchedTicket?.jira_key) {
      jiraKey = matchedTicket.jira_key;
    }

    if (!jiraKey) {
      logger.warn('[Orchestrator] Could not determine Jira issue key for merged PR', { prNumber });
      return;
    }

    logger.info(`[Orchestrator] PR #${prNumber} merged! Updating Jira issue ${jiraKey} to Done…`);

    // 2. Transition Jira issue to "Done"
    await this.jira.transitionIssue(jiraKey, 'Done').catch((err) => {
      logger.warn(`Could not transition ${jiraKey} to Done: ${err.message}`);
    });

    // 3. Post resolution comment to Jira
    const baseBranch = pr.base?.ref || 'main';
    const mergedBy = pr.merged_by?.login || 'developer';
    await this.jira.addComment(
      jiraKey,
      [
        '🎉 *FixForge Auto-Resolution:*',
        `Pull Request [#${prNumber}: ${pr.title}|${prUrl}] was successfully merged into \`${baseBranch}\` by @${mergedBy}.`,
        '',
        '✅ *Status:* Fix merged to codebase. Issue marked as *Done*.',
      ].join('\n')
    ).catch(() => {});

    // 4. Update Jira labels
    await this.jira.removeLabel(jiraKey, 'in-progress').catch(() => {});
    await this.jira.addLabel(jiraKey, 'merged').catch(() => {});
    await this.jira.addLabel(jiraKey, 'resolved').catch(() => {});

    // 5. Update MetricsStore
    if (matchedTicket) {
      this.metrics.upsertTicket({
        id: matchedTicket.id,
        status: 'done',
        jiraKey,
        prUrl,
        prNumber,
      });
    }

    logger.info(`[Orchestrator] Jira issue ${jiraKey} successfully updated after PR #${prNumber} merge!`);
  }

  /**
   * Proactive poller that checks GitHub for merged PRs every 15 seconds
   * and checks for stuck in-progress tickets every 30 seconds.
   * Ensures Jira tickets are updated even if GitHub webhooks cannot reach localhost.
   */
  startMergePoller(intervalMs = 15_000) {
    if (this._mergePollTimer) return;

    let tick = 0;
    this._mergePollTimer = setInterval(async () => {
      try {
        await this.checkOpenPullRequests();
      } catch (err) {
        logger.debug('Merge poller check note', { err: err.message });
      }

      // Check for tickets placed in "To Do" to pick up autonomously
      try {
        await this.checkPendingToDoTickets();
      } catch (err) {
        logger.debug('To Do queue poller note', { err: err.message });
      }

      // Check for stuck in-progress tickets every 2 ticks (~30s)
      tick++;
      if (tick % 2 === 0) {
        try {
          await this.checkStuckInProgressTickets(5);
        } catch (err) {
          logger.debug('Watchdog stuck tickets check note', { err: err.message });
        }
      }
    }, intervalMs);

    if (this._mergePollTimer.unref) this._mergePollTimer.unref();
  }

  async checkOpenPullRequests() {
    const tickets = this.metrics.getTickets(30);
    // Find tickets that have PR created but not yet marked 'done'
    const pendingTickets = tickets.filter(
      (t) => t.status === 'pr_created' && (t.pr_number || t.pr_url)
    );

    if (!pendingTickets.length) return;

    for (const t of pendingTickets) {
      let repo = t.repo || this.github.cfg?.githubRepo || 'its-seraj/runtime-error-service';
      let prNumber = t.pr_number;

      if (!prNumber && t.pr_url) {
        const m = t.pr_url.match(/\/pull\/(\d+)/);
        if (m) prNumber = parseInt(m[1], 10);
      }

      if (!prNumber) continue;

      try {
        const { owner, repo: repoName } = this.github._parseRepo(repo);
        const { data: prData } = await this.github.octokit.pulls.get({
          owner,
          repo: repoName,
          pull_number: prNumber,
        });

        if (prData.merged) {
          await this.handlePullRequestMerged(prData, repo);
        }
      } catch (err) {
        logger.debug(`Could not check PR #${prNumber} status`, { err: err.message });
      }
    }
  }

  /**
   * Watchdog to detect tickets that have stayed in "In Progress" without finishing
   * (e.g., from network timeouts, crashed processes, or unresolvable AI issues).
   * Automatically transitions them to "Unable To Resolve".
   */
  async checkStuckInProgressTickets(maxAgeMinutes = 5) {
    try {
      const jql = `project = ${this.jira.project} AND status = "In Progress"`;
      const issues = await this.jira.getIssuesByJql(jql, 50);
      if (!issues || !issues.length) return;

      const now = Date.now();
      for (const issue of issues) {
        const key = issue.key;
        const isActivelyResolving = this.activeResolutions.has(key);
        const lastUpdated = new Date(issue.fields.updated).getTime();
        const ageMinutes = (now - lastUpdated) / (1000 * 60);

        // If not actively executing in this running process, or if age > maxAgeMinutes
        if (!isActivelyResolving || ageMinutes >= maxAgeMinutes) {
          logger.warn(`[Orchestrator] Ticket ${key} was In Progress for ${Math.round(ageMinutes)}m — transitioning to Unable To Resolve`);
          await this.jira.markUnableToResolve(
            key,
            `Ticket was in "In Progress" for ${Math.round(ageMinutes)} minutes without completing resolution.`
          );

          const tickets = this.metrics.getTickets(50);
          const matched = tickets.find((t) => t.jira_key === key);
          if (matched) {
            this.metrics.upsertTicket({
              id: matched.id,
              status: 'unable_to_resolve',
              jiraKey: key,
              error: 'Resolution timed out in progress',
            });
          }
        }
      }
    } catch (err) {
      logger.debug('Watchdog checkStuckInProgressTickets note', { err: err.message });
    }
  }

  /**
   * Proactively discovers tickets sitting in "To Do" on Jira.
   * When an engineer moves a ticket to "To Do", FixForge picks it up,
   * transitions it to "In Progress", and executes autonomous resolution.
   */
  async checkPendingToDoTickets() {
    if (this.activeResolutions.size > 0) return; // avoid concurrent collisions

    try {
      const jql = `project = ${this.jira.project} AND status = "To Do" ORDER BY created ASC`;
      const issues = await this.jira.getIssuesByJql(jql, 5);
      if (!issues || !issues.length) return;

      for (const issue of issues) {
        const key = issue.key;
        if (this.activeResolutions.has(key)) continue;

        logger.info(`[Orchestrator] Detected ticket ${key} in "To Do" — picking up for autonomous resolution`);
        this.activeResolutions.add(key);

        // Remove any old unable-to-resolve label since it's now in To Do
        await this.jira.removeLabel(key, 'unable-to-resolve').catch(() => {});

        this.resolveJiraIssue(issue, 'jira_todo_queue')
          .catch((err) => {
            logger.error(`[Orchestrator] Error resolving To Do ticket ${key}`, { err: err.message });
          })
          .finally(() => {
            this.activeResolutions.delete(key);
          });

        // Pick one at a time per poll cycle
        break;
      }
    } catch (err) {
      logger.debug('checkPendingToDoTickets note', { err: err.message });
    }
  }
}

module.exports = AgentOrchestrator;
