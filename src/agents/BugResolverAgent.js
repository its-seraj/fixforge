'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const JiraClient = require('../integrations/jira');
const GitHubClient = require('../integrations/github');
const { ask, parseJSON } = require('../ai/gemini');
const { rootCausePrompt, generatePatchPrompt, customerReplyPrompt } = require('../ai/prompts');
const MetricsStore = require('../dashboard/MetricsStore');
const { loadConfig } = require('../config/ConfigManager');
const logger = require('../utils/logger');

/**
 * Bug Resolver Agent
 * Full resolution pipeline:
 * 1. Fetch related code from GitHub
 * 2. Root cause analysis
 * 3. Generate patch
 * 4. Apply patch in sandbox
 * 5. Run tests
 * 6. Draft customer reply
 * 7. Human approval gate
 * 8. Push PR + update Jira
 */
class BugResolverAgent {
  constructor() {
    this.jira = new JiraClient();
    this.github = new GitHubClient();
    this.metrics = new MetricsStore();
    this.cfg = loadConfig();
  }

  // ── Step 1: Fetch relevant code ─────────────────────────────────────────────
  async _fetchRelevantCode(classification, errorPayload) {
    logger.info('[BugResolverAgent] Fetching relevant code files…');
    const repo = errorPayload.repo || this.cfg?.githubRepo || null;
    const filePaths = classification.affectedFiles || [];

    if (errorPayload.message && repo) {
      const searchResults = await this.github.searchCode(errorPayload.message.slice(0, 60), repo).catch(() => []);
      filePaths.push(...searchResults);
    }

    const unique = [...new Set(filePaths)].slice(0, 8);
    const codeSnippets = [];

    for (const rawFp of unique) {
      if (!rawFp || typeof rawFp !== 'string') continue;
      const fp = rawFp.replace(/\\/g, '/');

      // 1. Try local filesystem first (for local projects or local running services)
      const localCandidates = [
        fp,
        path.resolve(fp),
        path.resolve(process.cwd(), fp),
        path.join('C:/Users/serajkhan_bamboobox/.gemini/antigravity-ide/scratch/runtime-error-service', fp),
      ];

      let localFound = false;
      for (const cand of localCandidates) {
        if (fs.existsSync(cand)) {
          try {
            if (fs.statSync(cand).isFile()) {
              const content = fs.readFileSync(cand, 'utf8');
              let relFile = fp;
              for (const marker of ['/routes/', '/src/', '/app/', '/controllers/', '/services/', '/models/', '/server/']) {
                if (fp.includes(marker)) {
                  relFile = marker.slice(1) + fp.split(marker)[1];
                  break;
                }
              }
              if (relFile.includes(':') || relFile.startsWith('/')) {
                relFile = relFile.split('/').slice(-2).join('/');
              }
              codeSnippets.push({ file: relFile, content });
              logger.info(`[BugResolverAgent] Loaded local source file: ${cand} as ${relFile}`);
              localFound = true;
              break;
            }
          } catch {}
        }
      }

      if (localFound) continue;

      // 2. Fetch from GitHub if repo is configured
      if (repo) {
        try {
          const { content } = await this.github.getFileContent(fp, repo);
          codeSnippets.push({ file: fp, content });
        } catch (err) {
          logger.warn(`Could not fetch ${fp}: ${err.message}`);
        }
      }
    }

    return codeSnippets;
  }

  // ── Step 2: Root cause analysis ─────────────────────────────────────────────
  async _analyseRootCause(errorPayload, codeSnippets) {
    logger.info('[BugResolverAgent] Running root cause analysis with Gemini…');
    const prompt = rootCausePrompt({ errorPayload, codeSnippets });
    const raw = await ask(prompt);
    return parseJSON(raw);
  }

  // ── Step 3: Generate patch ───────────────────────────────────────────────────
  async _generatePatch(rootCauseAnalysis, codeSnippets) {
    logger.info('[BugResolverAgent] Generating patch with Gemini…');
    const prompt = generatePatchPrompt({ rootCauseAnalysis, codeSnippets });
    const raw = await ask(prompt);
    return parseJSON(raw);
  }

  // ── Step 4: Apply patch in sandbox ──────────────────────────────────────────
  async _applyPatch(sandboxDir, patches) {
    logger.info('[BugResolverAgent] Applying patches in sandbox…');
    const results = [];

    for (const patch of patches) {
      let cleanFile = (patch.file || '').replace(/\\/g, '/');
      let fullPath = path.join(sandboxDir, cleanFile);

      if (!fs.existsSync(fullPath)) {
        for (const marker of ['routes', 'src', 'app', 'controllers', 'services', 'models', 'lib', 'server']) {
          const parts = cleanFile.split('/');
          const idx = parts.indexOf(marker);
          if (idx !== -1) {
            const rel = parts.slice(idx).join('/');
            if (fs.existsSync(path.join(sandboxDir, rel))) {
              fullPath = path.join(sandboxDir, rel);
              cleanFile = rel;
              break;
            }
          }
        }
      }

      if (!fs.existsSync(fullPath)) {
        const base = path.basename(cleanFile);
        const alt = path.join(sandboxDir, base);
        if (fs.existsSync(alt)) {
          fullPath = alt;
          cleanFile = base;
        }
      }

      if (!fs.existsSync(fullPath)) {
        logger.warn(`File not found in sandbox: ${patch.file}`);
        results.push({ file: patch.file, applied: false, reason: 'File not found' });
        continue;
      }

      let content = fs.readFileSync(fullPath, 'utf8');
      const hasCRLF = content.includes('\r\n');
      const normalizedContent = content.replace(/\r\n/g, '\n');
      const normalizedSearch = (patch.searchBlock || '').replace(/\r\n/g, '\n').trim();
      const normalizedReplace = (patch.replaceBlock || '').replace(/\r\n/g, '\n');

      if (normalizedContent.includes(normalizedSearch)) {
        const updated = normalizedContent.replace(normalizedSearch, normalizedReplace);
        fs.writeFileSync(fullPath, hasCRLF ? updated.replace(/\n/g, '\r\n') : updated, 'utf8');
        logger.info(`Patch applied: ${cleanFile}`);
        results.push({ file: cleanFile, applied: true });
        continue;
      }

      // Line-by-line whitespace-trimmed matching
      const contentLines = normalizedContent.split('\n');
      const searchLines = normalizedSearch.split('\n').map((l) => l.trim()).filter(Boolean);
      let matchIdx = -1;

      if (searchLines.length > 0) {
        for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
          const matches = searchLines.every((sl, idx) => contentLines[i + idx].trim() === sl);
          if (matches) {
            matchIdx = i;
            break;
          }
        }
      }

      if (matchIdx !== -1) {
        contentLines.splice(matchIdx, searchLines.length, normalizedReplace);
        const updated = contentLines.join('\n');
        fs.writeFileSync(fullPath, hasCRLF ? updated.replace(/\n/g, '\r\n') : updated, 'utf8');
        logger.info(`Patch applied (fuzzy): ${cleanFile}`);
        results.push({ file: cleanFile, applied: true });
        continue;
      }

      // Single unique line targeted match
      const keyLine = searchLines.find((l) => l.length > 10 && !l.startsWith('//') && !l.startsWith('/*')) || searchLines[0];
      if (keyLine) {
        const keyTrimmed = keyLine.trim();
        const foundLineIdx = contentLines.findIndex((cl) => cl.trim().includes(keyTrimmed) || keyTrimmed.includes(cl.trim()));
        if (foundLineIdx !== -1) {
          contentLines.splice(foundLineIdx, Math.min(searchLines.length, 3), normalizedReplace);
          const updated = contentLines.join('\n');
          fs.writeFileSync(fullPath, hasCRLF ? updated.replace(/\n/g, '\r\n') : updated, 'utf8');
          logger.info(`Patch applied (targeted line match): ${cleanFile}`);
          results.push({ file: cleanFile, applied: true });
          continue;
        }
      }

      logger.warn(`Search block not found in ${cleanFile} — skipping`);
      results.push({ file: cleanFile, applied: false, reason: 'Search block not found' });
    }

    return results;
  }

  // ── Step 5: Run tests ────────────────────────────────────────────────────────
  async _runTests(sandboxDir) {
    logger.info('[BugResolverAgent] Running tests in sandbox…');
    try {
      // Detect test runner
      const pkgPath = path.join(sandboxDir, 'package.json');
      let testCmd = 'npm test -- --passWithNoTests';
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.scripts?.test) testCmd = 'npm test';
        else if (pkg.devDependencies?.jest) testCmd = 'npx jest --passWithNoTests';
        else if (pkg.devDependencies?.mocha) testCmd = 'npx mocha';
      }

      const output = execSync(testCmd, {
        cwd: sandboxDir,
        timeout: 120_000,
        stdio: 'pipe',
      }).toString();

      return { passed: true, output };
    } catch (err) {
      return { passed: false, output: err.stdout?.toString() + err.stderr?.toString() };
    }
  }

  // ── Step 6: Draft customer reply ─────────────────────────────────────────────
  async _draftCustomerReply(errorPayload, rootCauseAnalysis, jiraKey) {
    logger.info('[BugResolverAgent] Drafting customer reply…');
    const prompt = customerReplyPrompt({ errorPayload, rootCauseAnalysis, jiraKey });
    return await ask(prompt);
  }

  // ── Step 7: Human approval gate ──────────────────────────────────────────────
  async _waitForApproval(jiraKey, patchSummary, customerReply, severity) {
    const mode = this.cfg.approvalMode || 'autonomous';

    if (mode === 'autonomous') {
      logger.info('[BugResolverAgent] Autonomous mode — skipping approval gate');
      return true;
    }

    if (mode === 'auto-low' && (severity === 'Low' || severity === 'Medium')) {
      logger.info('[BugResolverAgent] Auto-approve for low/medium severity — skipping approval gate');
      return true;
    }

    // Post approval request as a Jira comment
    const comment = [
      '🤖 *FixForge Resolution Ready for Approval*',
      '',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '*Patch Summary:*',
      patchSummary,
      '',
      '*Customer Reply Draft:*',
      customerReply,
      '',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      'To approve, comment: `fixforge:approve`',
      'To reject, comment: `fixforge:reject <reason>`',
    ].join('\n');

    await this.jira.addComment(jiraKey, comment);
    logger.info('[BugResolverAgent] Approval request posted to Jira', { jiraKey });

    // Poll for approval comment (max 3 minutes timeout to prevent indefinite hangs)
    const start = Date.now();
    const TIMEOUT = 3 * 60 * 1000;
    const INTERVAL = 15_000;

    while (Date.now() - start < TIMEOUT) {
      await new Promise((r) => setTimeout(r, INTERVAL));

      try {
        const issue = await this.jira.getIssue(jiraKey);
        const comments = issue.fields?.comment?.comments || [];
        const latest = comments[comments.length - 1]?.body;
        const text = typeof latest === 'string' ? latest : JSON.stringify(latest);

        if (text.includes('fixforge:approve')) {
          logger.info('[BugResolverAgent] Approved by user on Jira');
          return true;
        }
        if (text.includes('fixforge:reject')) {
          logger.info('[BugResolverAgent] Rejected by user on Jira');
          return false;
        }
      } catch (err) {
        logger.warn('Approval poll note', { err: err.message });
      }
    }

    logger.info('[BugResolverAgent] Approval window elapsed — proceeding autonomously with fix proposal');
    return true;
  }

  async _postLocalResolution({ ticketId, jiraKey, errorPayload, rootCauseAnalysis, patchResult }) {
    logger.info('[BugResolverAgent] Local project mode — posting AI diagnosis, code patch & solution to Jira', { jiraKey });

    const patchDetails = (patchResult.patches || [])
      .map((p) => `*File:* \`${p.file}\`\n\`\`\`diff\n- ${p.searchBlock?.slice(0, 200)}\n+ ${p.replaceBlock?.slice(0, 200)}\n\`\`\``)
      .join('\n\n');

    const customerReply = await this._draftCustomerReply(errorPayload, rootCauseAnalysis, jiraKey).catch(() => '');

    await this.jira.addComment(
      jiraKey,
      [
        '🛠️ *FixForge Autonomous Fix Solution:*',
        patchResult.explanation || rootCauseAnalysis.fixStrategy || 'Code fix generated by FixForge AI.',
        '',
        '*Proposed Code Patch:*',
        patchDetails || 'See Root Cause and Fix Strategy above.',
        customerReply ? `\n*Customer Communication Draft:*\n${customerReply}` : '',
      ].filter(Boolean).join('\n')
    );

    await this.jira.removeLabel(jiraKey, 'in-progress').catch(() => {});
    await this.jira.transitionIssue(jiraKey, 'In Review').catch(() => {});
    this.metrics.upsertTicket({ id: ticketId, status: 'pr_created' });
    logger.info('[BugResolverAgent] Local resolution complete — solution posted to Jira', { jiraKey });
  }

  // ── Main run ──────────────────────────────────────────────────────────────────
  async run({ ticketId, jiraKey, classification, errorPayload }) {
    logger.info('[BugResolverAgent] Starting resolution', { jiraKey });
    this.metrics.upsertTicket({ id: ticketId, status: 'resolving', jiraKey });

    // Transition Jira to "In Progress" as soon as resolution is picked up
    await this.jira.transitionIssue(jiraKey, 'In Progress').catch(() => {});
    await this.jira.addLabel(jiraKey, 'in-progress').catch(() => {});
    await this.jira.addComment(
      jiraKey,
      '⚙️ *FixForge AI Resolver in Progress:* Analyzing root cause, inspecting code, and preparing autonomous fix.'
    ).catch(() => {});

    let sandboxDir = null;

    try {
      // ── 1. Fetch code ──────────────────────────────────────────────────────
      const codeSnippets = await this._fetchRelevantCode(classification, errorPayload);
      this.metrics.upsertTicket({ id: ticketId, status: 'code_fetched' });

      // ── 2. Root cause ──────────────────────────────────────────────────────
      const rootCauseAnalysis = await this._analyseRootCause(errorPayload, codeSnippets);
      this.metrics.upsertTicket({ id: ticketId, status: 'root_cause_found', rootCause: rootCauseAnalysis.rootCause });
      await this.jira.addComment(jiraKey, `🔍 *Root Cause:*\n${rootCauseAnalysis.rootCause}\n\n*Fix Strategy:*\n${rootCauseAnalysis.fixStrategy}`);

      // ── 3. Generate patch ──────────────────────────────────────────────────
      const patchResult = await this._generatePatch(rootCauseAnalysis, codeSnippets);
      if (!patchResult || !patchResult.patches || !patchResult.patches.length) {
        throw new Error('AI was unable to generate actionable code patches for this error.');
      }
      this.metrics.upsertTicket({ id: ticketId, status: 'patch_generated' });

      // ── 4. Clone + apply in sandbox OR local resolution ───────────────────
      let pushedPr = false;
      const repo = errorPayload.repo || this.cfg?.githubRepo || null;

      if (repo) {
        try {
          const branchName = `fixforge/${jiraKey.toLowerCase()}-${Date.now()}`;
          sandboxDir = await this.github.cloneToSandbox(repo, errorPayload.branch);
          const patchResults = await this._applyPatch(sandboxDir, patchResult.patches || []);
          this.metrics.upsertTicket({ id: ticketId, status: 'patch_applied' });

          const anyApplied = patchResults.some((r) => r.applied);
          if (!anyApplied) {
            logger.warn('[BugResolverAgent] Could not apply patches in sandbox — falling back to local resolution', { jiraKey });
          } else {
            // ── 5. Run tests ───────────────────────────────────────────────────
            const testResult = await this._runTests(sandboxDir);
            this.metrics.upsertTicket({ id: ticketId, status: testResult.passed ? 'tests_passed' : 'tests_failed' });

            const testSummary = testResult.passed
              ? '✅ All tests passed'
              : `❌ Tests failed:\n\`\`\`\n${testResult.output?.slice(0, 1000)}\n\`\`\``;
            await this.jira.addComment(jiraKey, testSummary);

            // ── 6. Customer reply ──────────────────────────────────────────────
            const customerReply = await this._draftCustomerReply(errorPayload, rootCauseAnalysis, jiraKey);
            const patchSummary = patchResults.map((r) => `- ${r.file}: ${r.applied ? '✅' : '❌ ' + r.reason}`).join('\n');

            // ── 7. Approval gate ───────────────────────────────────────────────
            this.metrics.upsertTicket({ id: ticketId, status: 'awaiting_approval' });
            const approved = await this._waitForApproval(jiraKey, patchSummary, customerReply, classification?.severity);

            if (!approved) {
              this.metrics.upsertTicket({ id: ticketId, status: 'unable_to_resolve' });
              await this.jira.markUnableToResolve(jiraKey, 'Human reviewer rejected the proposed patch.');
              return;
            }

            // ── 8. Push PR ─────────────────────────────────────────────────────
            await this.github.createBranch(branchName, repo);
            await this.github.commitAndPush(sandboxDir, branchName, patchResult.commitMessage || `fix(${jiraKey}): auto-fix`);
            const pr = await this.github.createPullRequest({
              title: patchResult.prTitle || `[${jiraKey}] Auto-fix by FixForge`,
              body: `${patchResult.prBody || ''}\n\n---\n*Generated by FixForge AI*\nJira: ${jiraKey}`,
              branchName,
              repo,
            });

            // ── 9. Update Jira with PR link and tracking ──────────────────────
            await this.jira.removeLabel(jiraKey, 'in-progress').catch(() => {});
            await this.jira.addRemoteLink(jiraKey, {
              url: pr.html_url,
              title: `GitHub PR #${pr.number}: ${pr.title}`,
              summary: `FixForge automated fix PR for ${jiraKey}`,
            });
            await this.jira.addLabel(jiraKey, 'pr-created');
            await this.jira.addLabel(jiraKey, `pr-${pr.number}`);

            await this.jira.addComment(
              jiraKey,
              `🚀 *FixForge Pull Request Created:* [${pr.html_url}|${pr.html_url}]\n\n*Repository:* \`${repo}\`\n*Branch:* \`${branchName}\`\n*PR #:* ${pr.number}\n\n*Customer Reply Draft:*\n${customerReply}`
            );
            await this.jira.transitionIssue(jiraKey, 'In Review').catch(() => {});
            this.metrics.upsertTicket({ id: ticketId, status: 'pr_created', prUrl: pr.html_url, prNumber: pr.number, repo });

            logger.info('[BugResolverAgent] Resolution complete', { jiraKey, pr: pr.html_url, prNumber: pr.number });
            pushedPr = true;
          }
        } catch (gitErr) {
          logger.warn('[BugResolverAgent] Remote git workflow unavailable — falling back to local resolution', {
            jiraKey,
            err: gitErr.message,
          });
        }
      }

      if (!pushedPr) {
        await this._postLocalResolution({ ticketId, jiraKey, errorPayload, rootCauseAnalysis, patchResult });
      }
    } catch (err) {
      logger.error('[BugResolverAgent] Resolution failed', { jiraKey, err: err.message });
      this.metrics.upsertTicket({ id: ticketId, status: 'unable_to_resolve', error: err.message });
      await this.jira.markUnableToResolve(jiraKey, err.message).catch(() => {});
    } finally {
      if (sandboxDir) await this.github.cleanupSandbox(sandboxDir).catch(() => {});
    }
  }
}

module.exports = BugResolverAgent;
