'use strict';

const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const { loadConfig } = require('../config/ConfigManager');
const AgentOrchestrator = require('../agents/AgentOrchestrator');
const MetricsStore = require('../dashboard/MetricsStore');
const { getBackgroundScanner } = require('../monitor/BackgroundScanner');
const logger = require('../utils/logger');

function createWebhookServer() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  const orchestrator = new AgentOrchestrator();
  const metrics = new MetricsStore();
  const scanner = getBackgroundScanner();

  // Start autonomous background port and error scanner
  try {
    scanner.start();
  } catch (err) {
    logger.warn('[WebhookServer] Background scanner could not be auto-started', { err: err.message });
  }

  // ── Signature & Auth verification ─────────────────────────────────────────
  function verifySignature(req, res, next) {
    const cfg = loadConfig();
    const secret = cfg?.webhookSecret;
    if (!secret) return next(); // no secret configured → allow all

    const sig = req.headers['x-fixforge-signature'] || req.headers['x-hub-signature-256'];
    const directSecret = req.headers['x-fixforge-secret'] || req.headers['x-api-key'];
    const authHeader = req.headers['authorization'];

    // 1. Direct secret match: accept secret directly in x-fixforge-secret, x-fixforge-signature, or Bearer token
    if (directSecret && directSecret === secret) {
      return next();
    }
    if (authHeader && authHeader.replace(/^Bearer\s+/i, '') === secret) {
      return next();
    }
    if (sig && sig === secret) {
      return next();
    }

    // 2. If nothing was sent, return clean JSON 401
    if (!sig) {
      return res.status(401).json({
        error: 'Missing authentication. Provide your secret via `x-fixforge-signature: <secret>` or `x-fixforge-secret: <secret>`.',
      });
    }

    // 3. HMAC-SHA256 signature verification (GitHub style)
    try {
      const hmacHex = crypto.createHmac('sha256', secret).update(JSON.stringify(req.body)).digest('hex');
      const expectedWithPrefix = 'sha256=' + hmacHex;

      // Handle both "sha256=..." and raw hex
      const cleanSig = sig.startsWith('sha256=') ? sig : ('sha256=' + sig);

      const bufA = Buffer.from(cleanSig);
      const bufB = Buffer.from(expectedWithPrefix);

      if (bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB)) {
        return next();
      }

      // Also check raw hex without sha256=
      const bufRawSig = Buffer.from(sig);
      const bufRawExpected = Buffer.from(hmacHex);
      if (bufRawSig.length === bufRawExpected.length && crypto.timingSafeEqual(bufRawSig, bufRawExpected)) {
        return next();
      }

      return res.status(401).json({ error: 'Invalid signature' });
    } catch (err) {
      return res.status(401).json({ error: 'Invalid signature format: ' + err.message });
    }
  }

  // ── Health check ──────────────────────────────────────────────────────────
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', version: require('../../package.json').version, ts: new Date().toISOString() });
  });

  // ── Error webhook ─────────────────────────────────────────────────────────
  /**
   * POST /webhook/error
   * Body: { message, stack, context, repo?, branch?, severity? }
   */
  app.post('/webhook/error', verifySignature, async (req, res) => {
    const payload = req.body;
    if (!payload.message) {
      return res.status(400).json({ error: '`message` field required' });
    }

    logger.info('Webhook: error received', {
      message: payload.message?.slice(0, 80),
      repo: payload.repo || '(uses default)',
    });
    metrics.recordEvent('webhook_error');

    res.json({ received: true, message: 'FixForge is processing the error' });

    orchestrator.handleError(payload).catch((err) => {
      logger.error('Orchestrator error', { err: err.message });
    });
  });

  // ── GitHub webhook (push events) ──────────────────────────────────────────
  /**
   * POST /webhook/github
   * Standard GitHub push event payload
   */
  app.post('/webhook/github', verifySignature, async (req, res) => {
    const event = req.headers['x-github-event'];
    const payload = req.body;

    res.json({ received: true, event });

    if (event === 'pull_request') {
      const pr = payload.pull_request;
      if (payload.action === 'closed' && pr?.merged) {
        logger.info('GitHub pull_request merged event received', { pr: pr.number, url: pr.html_url });
        metrics.recordEvent('github_pr_merged');
        orchestrator.handlePullRequestMerged(pr, payload.repository?.full_name).catch((err) => {
          logger.error('Failed to handle merged PR', { err: err.message });
        });
      }
    } else if (event === 'push') {
      logger.info('GitHub push event', { ref: payload.ref, commits: payload.commits?.length });
      metrics.recordEvent('github_push');
    }
  });

  // ── Manual trigger ────────────────────────────────────────────────────────
  /**
   * POST /webhook/resolve
   * Body: { jiraKey }
   */
  app.post('/webhook/resolve', verifySignature, async (req, res) => {
    const { jiraKey } = req.body;
    if (!jiraKey) return res.status(400).json({ error: '`jiraKey` required' });

    res.json({ received: true, jiraKey });
    orchestrator.handleManualResolve(jiraKey).catch((err) => {
      logger.error('Manual resolve error', { err: err.message });
    });
  });

  // ── Metrics API (used by dashboard) ──────────────────────────────────────
  app.get('/api/metrics', (req, res) => {
    res.json(metrics.getSummary());
  });

  app.get('/api/tickets', (req, res) => {
    res.json(metrics.getTickets());
  });

  app.get('/api/services', (req, res) => {
    const services = metrics.getServices();
    res.json({
      scannerActive: scanner ? scanner.isRunning : false,
      count: services.length,
      services,
    });
  });

  return app;
}

module.exports = { createWebhookServer };
