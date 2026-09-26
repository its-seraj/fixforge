'use strict';

const axios = require('axios');
const path = require('path');
const fs = require('fs');
const os = require('os');
const PortScanner = require('./PortScanner');
const LogWatcher = require('./LogWatcher');
const MetricsStore = require('../dashboard/MetricsStore');
const AgentOrchestrator = require('../agents/AgentOrchestrator');
const logger = require('../utils/logger');

/**
 * Continuous Autonomous Background Scanner.
 * Automatically scans open ports, detects active web services, monitors their logs
 * and health, and autonomously raises Jira bug tickets if any error occurs.
 */
class BackgroundScanner {
  constructor(options = {}) {
    this.intervalMs = options.intervalMs || 5000;
    this.metrics = new MetricsStore();
    this.orchestrator = new AgentOrchestrator();
    this.timer = null;
    this.isRunning = false;
    this.seenErrorSignatures = new Map(); // key -> lastSeenTimestamp
    this.logWatcher = null;
    this.monitoredLogWatchers = new Map();
    this.serviceCache = new Map();
  }

  _isDuplicate(key, cooldownMs = 60000) {
    const lastSeen = this.seenErrorSignatures.get(key);
    const now = Date.now();
    if (lastSeen && now - lastSeen < cooldownMs) {
      return true;
    }
    this.seenErrorSignatures.set(key, now);
    return false;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info('[BackgroundScanner] Autonomous port & log scanner started');

    // Start LogWatcher on common project and scratch directories
    this._startLogWatcher();

    // Run first scan immediately
    this._scanCycle().catch(() => {});

    // Periodic scanner
    this.timer = setInterval(() => {
      this._scanCycle().catch((err) => {
        logger.debug('[BackgroundScanner] Scan cycle error', { err: err.message });
      });
    }, this.intervalMs);
  }

  _startLogWatcher() {
    try {
      const searchDirs = [
        process.cwd(),
        path.join(os.homedir(), '.gemini', 'antigravity-ide', 'scratch'),
        path.join(os.homedir(), '.fixforge', 'logs'),
      ];

      const candidateFiles = [];
      for (const d of searchDirs) {
        if (fs.existsSync(d)) {
          const found = LogWatcher.findLogFiles(d, 2);
          candidateFiles.push(...found);
        }
      }

      if (candidateFiles.length > 0) {
        this.logWatcher = new LogWatcher({ paths: candidateFiles });
        this.logWatcher.on('error', (payload) => {
          this._handleDiscoveredError(payload);
        });
        this.logWatcher.watch();
        logger.info('[BackgroundScanner] Real-time LogWatcher active on', { files: candidateFiles.length });
      }
    } catch (err) {
      logger.debug('[BackgroundScanner] LogWatcher init note', { err: err.message });
    }
  }

  stop() {
    this.isRunning = false;
    if (this.timer) clearInterval(this.timer);
    if (this.logWatcher) {
      try { this.logWatcher.stop(); } catch {}
      this.logWatcher = null;
    }
    for (const watcher of this.monitoredLogWatchers.values()) {
      try { watcher.stop(); } catch {}
    }
    this.monitoredLogWatchers.clear();
  }

  async _scanCycle() {
    const rawServices = PortScanner.scanOpenPorts({ includeSystem: false });

    // Focus on developer app servers and project runtimes (ignore OS internals and browser/IDE debuggers)
    const appServices = rawServices.filter((s) => {
      const name = s.processName.toLowerCase();
      const isAppProcess = ['node.exe', 'python.exe', 'java.exe', 'go.exe', 'ruby.exe', 'dotnet.exe', 'node', 'python', 'java'].includes(name);
      const isExcluded = [
        'lsass.exe', 'wininit.exe', 'svchost.exe', 'services.exe', 'spoolsv.exe',
        'chrome.exe', 'msedge.exe', 'antigravity ide.exe', 'code.exe', 'postman.exe',
      ].includes(name);
      return isAppProcess && !isExcluded;
    });

    const enrichedServices = [];

    for (const s of appServices) {
      const isFixforge = s.port === 4242;
      let title = isFixforge ? 'FixForge Webhook Service' : 'App Server';
      let status = 'ONLINE';
      let healthData = null;

      // Quick probe to get project title / identity
      try {
        const res = await axios.get(`http://127.0.0.1:${s.port}/`, {
          timeout: 1200,
          validateStatus: () => true, // accept any status code
        });

      if (!isFixforge) {
        if (typeof res.data === 'string') {
          const match = res.data.match(/<title>([^<]+)<\/title>/i);
          if (match && match[1].trim().toLowerCase() !== 'error') {
            title = match[1].trim();
          }
        } else if (res.data && typeof res.data === 'object') {
          if (res.data.name || res.data.service) {
            title = res.data.name || res.data.service;
          }
        }
      }

        // Check if endpoint is returning a 500 error directly
        if (res.status >= 500) {
          status = 'ERROR (500)';
          this._handleDiscoveredError({
            message: `HTTP ${res.status} returned by service on port ${s.port} (${title})`,
            stack: typeof res.data === 'object' ? JSON.stringify(res.data, null, 2) : String(res.data).slice(0, 500),
            context: { port: s.port, service: title, status: res.status },
          });
        }
      } catch (err) {
        // Connection refused or timed out
        if (err.code === 'ECONNREFUSED') {
          status = 'OFFLINE';
        }
      }

      // Check /api/errors if this is a test lab or error reporting service
      if (!isFixforge && status === 'ONLINE') {
        try {
          const probe = await axios.get(`http://127.0.0.1:${s.port}/api/errors`, {
            timeout: 800,
            validateStatus: () => true,
          });
          if (probe.data?.service) {
            title = probe.data.service;
          }
        } catch {}

        // Proactively inspect error logs endpoint if present
        try {
          const logProbe = await axios.get(`http://127.0.0.1:${s.port}/api/errors/logs`, {
            timeout: 800,
            validateStatus: () => true,
          });
          if (logProbe.status === 200 && Array.isArray(logProbe.data?.logs)) {
            for (const logItem of logProbe.data.logs) {
              const logKey = `port-${s.port}:${logItem.id || logItem.timestamp || logItem.message}`;
              if (!this._isDuplicate(logKey, 60000)) {
                this._handleDiscoveredError({
                  message: `[${logItem.type || 'Error'}] ${logItem.name || 'RuntimeError'}: ${logItem.message}`,
                  stack: logItem.stack || `${logItem.name}: ${logItem.message}\n    at service on port ${s.port}`,
                  context: { port: s.port, service: title, logId: logItem.id },
                });
              }
            }
          }
        } catch {}
      }

      const item = {
        port: s.port,
        pid: s.pid,
        processName: s.processName,
        title,
        status,
        lastChecked: new Date().toLocaleTimeString(),
      };

      enrichedServices.push(item);
    }

    // Save active services to MetricsStore for the dashboard to render
    this.metrics.setServices(enrichedServices);
  }

  /**
   * Dispatches an autonomous error finding to FixForge orchestrator.
   * Includes deduplication so identical errors aren't spammed to Jira.
   */
  async _handleDiscoveredError(payload) {
    const sig = `${payload.context?.port || 0}:${payload.message}`;
    if (this._isDuplicate(sig, 60000)) return; // debounce identical errors for 60s

    logger.info('[BackgroundScanner] Discovered service error! Dispatching to orchestrator to raise bug…', {
      message: payload.message?.slice(0, 100),
      port: payload.context?.port,
    });

    this.metrics.recordEvent('service_error');

    try {
      await this.orchestrator.handleError(payload);
    } catch (err) {
      logger.error('[BackgroundScanner] Orchestrator error', { err: err.message });
    }
  }
}

// Singleton scanner instance
let _globalScanner = null;

function getBackgroundScanner() {
  if (!_globalScanner) {
    _globalScanner = new BackgroundScanner();
  }
  return _globalScanner;
}

module.exports = { BackgroundScanner, getBackgroundScanner };
