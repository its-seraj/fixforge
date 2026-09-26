'use strict';

const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');
const os = require('os');
const fs = require('fs');

const DB_DIR = path.join(os.homedir(), '.fixforge');
const DB_PATH = path.join(DB_DIR, 'metrics.json');

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

class MetricsStore {
  constructor() {
    fs.mkdirSync(DB_DIR, { recursive: true });
    const adapter = new FileSync(DB_PATH);
    this.db = low(adapter);
    this.db.defaults({ tickets: [], events: [], services: [] }).write();
  }

  upsertTicket(fields) {
    this.db.read();
    const { id, ...rest } = fields;
    const tickets = this.db.get('tickets');
    const existing = tickets.find({ id }).value();

    if (!existing) {
      tickets
        .push({
          id,
          jira_key: rest.jiraKey || null,
          title: rest.title || null,
          status: rest.status || 'unknown',
          severity: rest.severity || null,
          category: rest.category || null,
          root_cause: rest.rootCause || null,
          pr_url: rest.prUrl || null,
          pr_number: rest.prNumber || null,
          repo: rest.repo || null,
          error: rest.error || null,
          created_at: nowSec(),
          updated_at: nowSec(),
        })
        .write();
    } else {
      const updates = { updated_at: nowSec() };
      const map = {
        jiraKey: 'jira_key',
        title: 'title',
        status: 'status',
        severity: 'severity',
        category: 'category',
        rootCause: 'root_cause',
        prUrl: 'pr_url',
        prNumber: 'pr_number',
        repo: 'repo',
        error: 'error',
      };
      for (const [k, col] of Object.entries(map)) {
        if (rest[k] !== undefined) updates[col] = rest[k];
      }
      tickets.find({ id }).assign(updates).write();
    }
  }

  recordEvent(type) {
    this.db.read();
    this.db.get('events').push({ type, ts: nowSec() }).write();
  }

  getSummary() {
    this.db.read();
    const tickets = this.db.get('tickets').value() || [];
    const events = this.db.get('events').value() || [];

    const total = tickets.length;
    const resolved = tickets.filter((t) => t.status === 'pr_created' || t.status === 'done').length;
    const failed = tickets.filter((t) => t.status === 'failed' || t.status === 'unable_to_resolve').length;
    const pending = Math.max(0, total - resolved - failed);

    // MTTR in minutes
    const resolvedTickets = tickets.filter((t) => t.status === 'pr_created' || t.status === 'done');
    const mttr =
      resolvedTickets.length
        ? resolvedTickets.reduce((sum, t) => sum + (t.updated_at - t.created_at), 0) /
          resolvedTickets.length /
          60
        : 0;

    // By severity
    const severityMap = {};
    for (const t of tickets) {
      const s = t.severity || 'Unknown';
      severityMap[s] = (severityMap[s] || 0) + 1;
    }
    const bySeverity = Object.entries(severityMap).map(([severity, c]) => ({ severity, c }));

    const webhookHits = events.filter((e) => e.type === 'webhook_error').length;

    return { total, resolved, failed, pending, mttrMinutes: Math.round(mttr), bySeverity, webhookHits };
  }

  getTickets(limit = 50) {
    this.db.read();
    return (this.db.get('tickets').value() || [])
      .slice(-limit)
      .reverse();
  }

  setServices(services) {
    this.db.read();
    this.db.set('services', services).write();
  }

  getServices() {
    this.db.read();
    return this.db.get('services').value() || [];
  }
}

module.exports = MetricsStore;
