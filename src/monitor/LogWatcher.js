'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const EventEmitter = require('events');
const { loadConfig } = require('../config/ConfigManager');
const logger = require('../utils/logger');

/**
 * Real-time Log & Error Watcher.
 * Tails log files or streams, extracts stack traces and errors,
 * and automatically dispatches them to the FixForge webhook.
 */
class LogWatcher extends EventEmitter {
  constructor(options = {}) {
    super();
    this.targetPaths = options.paths || [];
    this.webhookPort = options.port || 4242;
    this.offsets = new Map();
    this.watchers = [];
    this.errorBuffer = [];
    this.bufferTimer = null;
  }

  /**
   * Find candidate log files in a directory.
   */
  static findLogFiles(dir = process.cwd(), depth = 2) {
    const results = [];
    try {
      function scan(currentDir, currentDepth) {
        if (currentDepth > depth) return;
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(currentDir, entry.name);
          if (entry.isDirectory()) {
            if (!['node_modules', '.git', '.next', 'dist', 'build'].includes(entry.name)) {
              scan(fullPath, currentDepth + 1);
            }
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            const base = entry.name.toLowerCase();
            if (ext === '.log' || base.includes('error') || base.includes('server.out') || base.includes('app.out')) {
              results.push(fullPath);
            }
          }
        }
      }
      scan(dir, 1);
    } catch {}
    return results;
  }

  /**
   * Start watching files for new errors.
   */
  watch() {
    if (this.targetPaths.length === 0) {
      // Auto-discover log files in current directory
      this.targetPaths = LogWatcher.findLogFiles(process.cwd());
    }

    for (const filePath of this.targetPaths) {
      if (!fs.existsSync(filePath)) continue;

      // Start tailing from the end of existing file so we only catch NEW errors
      try {
        const stat = fs.statSync(filePath);
        this.offsets.set(filePath, stat.size);
      } catch {
        this.offsets.set(filePath, 0);
      }

      try {
        const watcher = fs.watch(filePath, (eventType) => {
          if (eventType === 'change') {
            this._readNewContent(filePath);
          }
        });
        this.watchers.push(watcher);
      } catch (err) {
        logger.debug('Could not watch file', { filePath, err: err.message });
      }
    }

    // Also poll every 1s for platforms where fs.watch change events are spotty
    this.pollInterval = setInterval(() => {
      for (const filePath of this.targetPaths) {
        this._readNewContent(filePath);
      }
    }, 1000);
  }

  stop() {
    for (const w of this.watchers) {
      try { w.close(); } catch {}
    }
    this.watchers = [];
    if (this.pollInterval) clearInterval(this.pollInterval);
  }

  _readNewContent(filePath) {
    try {
      if (!fs.existsSync(filePath)) return;
      const stat = fs.statSync(filePath);
      const prevOffset = this.offsets.get(filePath) || 0;

      if (stat.size <= prevOffset) {
        // File may have been truncated/rotated
        if (stat.size < prevOffset) this.offsets.set(filePath, 0);
        return;
      }

      const stream = fs.createReadStream(filePath, {
        start: prevOffset,
        end: stat.size,
        encoding: 'utf8',
      });

      let chunk = '';
      stream.on('data', (d) => (chunk += d));
      stream.on('end', () => {
        this.offsets.set(filePath, stat.size);
        this.processLogChunk(chunk, filePath);
      });
    } catch {}
  }

  /**
   * Process a stream chunk of log lines and detect stack traces.
   */
  processLogChunk(chunk, source = 'stream') {
    const lines = chunk.split('\n');
    for (const line of lines) {
      this._analyzeLine(line, source);
    }
  }

  _analyzeLine(line, source) {
    const trimmed = line.trim();
    if (!trimmed) return;

    // Error indicators
    const isErrorLine =
      /^(?:(?:Uncaught\s+)?(?:TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError|Error|Exception)):\s+/i.test(trimmed) ||
      /^Traceback \(most recent call last\):/i.test(trimmed) ||
      /^(?:panic:\s+|fatal error:\s+)/i.test(trimmed) ||
      /^\d{4}[-/]\d{2}[-/]\d{2}.*\[(?:error|fatal|crit)\]/i.test(trimmed) ||
      /HTTP\/\d(?:\.\d)?\s+500/i.test(trimmed);

    const isStackLine =
      /^\s*at\s+(?:async\s+)?\S+\s+\(?[^)]+:\d+(?::\d+)?\)?/.test(line) ||
      /^\s*File\s+"[^"]+",\s+line\s+\d+/.test(line);

    if (isErrorLine) {
      // Flush previous error if pending
      this._flushErrorBuffer();
      this.errorBuffer.push({ line: trimmed, source, isStart: true });
      this._scheduleFlush();
    } else if (isStackLine && this.errorBuffer.length > 0) {
      this.errorBuffer.push({ line, source, isStart: false });
      this._scheduleFlush();
    }
  }

  _scheduleFlush() {
    if (this.bufferTimer) clearTimeout(this.bufferTimer);
    // Debounce 600ms so multi-line stack traces are assembled together
    this.bufferTimer = setTimeout(() => {
      this._flushErrorBuffer();
    }, 600);
  }

  async _flushErrorBuffer() {
    if (this.errorBuffer.length === 0) return;
    const items = [...this.errorBuffer];
    this.errorBuffer = [];

    const message = items[0]?.line || 'Runtime Error';
    const stack = items.map((i) => i.line).join('\n');
    const source = items[0]?.source || 'service';

    const payload = {
      message,
      stack,
      context: {
        source,
        detectedAt: new Date().toISOString(),
      },
    };

    this.emit('error-detected', payload);
    await this.dispatchToWebhook(payload);
  }

  /**
   * Sends the detected error to FixForge's webhook.
   */
  async dispatchToWebhook(payload) {
    const cfg = loadConfig();
    const port = this.webhookPort || cfg?.webhookPort || 4242;
    const secret = cfg?.webhookSecret;

    const headers = {
      'Content-Type': 'application/json',
    };
    if (secret) {
      headers['x-fixforge-signature'] = secret;
    }

    try {
      const res = await axios.post(`http://127.0.0.1:${port}/webhook/error`, payload, {
        headers,
        timeout: 4000,
      });
      this.emit('dispatched', { payload, response: res.data });
      return res.data;
    } catch (err) {
      this.emit('dispatch-error', { err: err.response?.data || err.message });
      throw err;
    }
  }
}

module.exports = LogWatcher;
