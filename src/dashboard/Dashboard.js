'use strict';

const blessed = require('blessed');
const contrib = require('blessed-contrib');
const dayjs = require('dayjs');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');

const MetricsStore = require('./MetricsStore');
const { loadConfig } = require('../config/ConfigManager');

class Dashboard {
  constructor() {
    this.store = new MetricsStore();
    this.cfg = loadConfig();
    this.logFile = path.join(os.homedir(), '.fixforge', 'logs', `fixforge-${dayjs().format('YYYY-MM-DD')}.log`);
    this.logPosition = 0;
  }

  // ── Build blessed screen ──────────────────────────────────────────────────
  _buildScreen() {
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'FixForge Dashboard',
      fullUnicode: true,
      cursor: { artificial: true, shape: 'line', blink: true, color: null },
    });

    // ── Header bar (top: 0, height: 3) ──────────────────────────────────────
    this.headerBox = blessed.box({
      top: 0,
      left: 0,
      width: '100%',
      height: 3,
      content: ' {bold}{cyan-fg}⚡ FixForge{/cyan-fg}{/bold} {white-fg}| AI-Powered Autonomous Ticket Resolver{/white-fg}    {bold}{yellow-fg}[Q]{/yellow-fg}{/bold} {white-fg}Quit{/white-fg}   {bold}{yellow-fg}[R]{/yellow-fg}{/bold} {white-fg}Refresh{/white-fg}',
      tags: true,
      border: { type: 'line' },
      style: {
        border: { fg: 'cyan' },
        fg: 'white',
      },
    });
    this.screen.append(this.headerBox);

    // ── Metrics Stat Cards (top: 3, height: 5) ──────────────────────────────
    // 5-column balanced distribution across 100% width
    this.totalBox    = this._metricBox(3, '0%',  '20%', 'TOTAL TICKETS',    '0',  'cyan');
    this.resolvedBox = this._metricBox(3, '20%', '20%', 'RESOLVED (PR)',    '0',  'green');
    this.pendingBox  = this._metricBox(3, '40%', '20%', 'IN PROGRESS',      '0',  'yellow');
    this.scannedBox  = this._metricBox(3, '60%', '20%', 'SCANNED PROJECTS', '0',  'magenta');
    this.mttrBox     = this._metricBox(3, '80%', '20%', 'AVG MTTR',         '0m', 'blue');

    // ── Upper Main Panels (top: 8, height: '50%-4') ─────────────────────────
    // Left: Ticket table (width: 65%)
    this.ticketTable = contrib.table({
      top: 8,
      left: 0,
      width: '65%',
      height: '50%-4',
      label: ' 🎫 Active Tickets ',
      columnWidth: [14, 28, 14, 10, 14],
      columnSpacing: 1,
      fg: 'white',
      selectedFg: 'white',
      selectedBg: 'blue',
      interactive: true,
      tags: true,
      border: { type: 'line' },
      style: {
        border: { fg: 'cyan' },
        header: { fg: 'cyan', bold: true },
        cell: { fg: 'white', selected: { bg: 'blue' } },
        label: { fg: 'cyan', bold: true },
      },
    });

    // Right: Severity breakdown donut chart (left: 65%, width: 35%)
    this.donut = contrib.donut({
      top: 8,
      left: '65%',
      width: '35%',
      height: '50%-4',
      label: ' 📊 Severity Breakdown ',
      radius: 8,
      arcWidth: 3,
      remainColor: 'black',
      yPadding: 2,
      border: { type: 'line' },
      style: {
        border: { fg: 'magenta' },
        label: { fg: 'magenta', bold: true },
      },
    });

    // ── Lower Main Panels (top: '50%+4', height: '50%-4') ───────────────────
    // Left: Agent Activity Log (width: 65%)
    this.logBox = blessed.log({
      top: '50%+4',
      left: 0,
      width: '65%',
      height: '50%-4',
      label: ' 📋 Agent Activity Log ',
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      mouse: true,
      border: { type: 'line' },
      style: {
        border: { fg: 'blue' },
        label: { fg: 'blue', bold: true },
        fg: 'white',
      },
    });

    // Right: Live Scanned Projects & System Status (left: 65%, width: 35%)
    this.servicesBox = blessed.box({
      top: '50%+4',
      left: '65%',
      width: '35%',
      height: '50%-4',
      label: ' 📡 Live Scanned Projects & Status ',
      tags: true,
      scrollable: true,
      border: { type: 'line' },
      style: {
        border: { fg: 'green' },
        label: { fg: 'green', bold: true },
        fg: 'white',
      },
    });

    this.screen.append(this.ticketTable);
    this.screen.append(this.donut);
    this.screen.append(this.logBox);
    this.screen.append(this.servicesBox);

    // ── Key bindings ────────────────────────────────────────────────────────
    const exitDashboard = () => {
      try {
        this.screen.destroy();
      } catch {}
      process.stdout.write('\x1b[2J\x1b[H');
      process.exit(0);
    };

    this.screen.key(['q', 'Q', 'C-c'], exitDashboard);
    this.screen.key(['r', 'R'], () => this._refresh());
  }

  _metricBox(top, left, width, label, value, color) {
    const box = blessed.box({
      top,
      left,
      width,
      height: 5,
      label: ` ${label} `,
      content: `\n{center}{bold}{${color}-fg}${value}{/${color}-fg}{/bold}{/center}`,
      tags: true,
      border: { type: 'line' },
      style: {
        border: { fg: color },
        label: { fg: color, bold: true },
      },
    });
    box._color = color;
    this.screen.append(box);
    return box;
  }

  _updateMetricBox(box, value) {
    const color = box._color || 'white';
    box.setContent(`\n{center}{bold}{${color}-fg}${value}{/${color}-fg}{/bold}{/center}`);
  }

  // ── Data refresh ──────────────────────────────────────────────────────────
  async _refresh() {
    try {
      const summary = this.store.getSummary();
      const tickets = this.store.getTickets(20);
      const services = this.store.getServices();

      // Metrics cards
      this._updateMetricBox(this.totalBox, String(summary.total || 0));
      this._updateMetricBox(this.resolvedBox, String(summary.resolved || 0));
      this._updateMetricBox(this.pendingBox, String(summary.pending || 0));
      this._updateMetricBox(this.scannedBox, `${services.length} Active`);
      this._updateMetricBox(this.mttrBox, `${summary.mttrMinutes || 0}m`);

      // Ticket table
      const headers = ['JIRA KEY', 'TITLE', 'STATUS', 'SEVERITY', 'UPDATED'];
      const formatStatus = (s) => {
        if (!s) return 'Unknown';
        if (s === 'done') return 'Done';
        if (s === 'pr_created' || s === 'awaiting_approval') return 'In Review';
        if (s === 'unable_to_resolve' || s === 'failed' || s === 'rejected') return 'Unable To Resolve';
        if (['resolving', 'in_progress', 'code_fetched', 'root_cause_found', 'patch_generated', 'patch_applied'].includes(s)) {
          return 'In Progress';
        }
        return s;
      };

      const rows = tickets.length
        ? tickets.map((t) => [
            t.jira_key || t.id?.slice(0, 10) || 'N/A',
            (t.title || 'Untitled').slice(0, 36),
            formatStatus(t.status),
            t.severity || '-',
            dayjs.unix(t.updated_at).format('MM-DD HH:mm'),
          ])
        : [['-', 'No tickets processed yet', '-', '-', '-']];

      this.ticketTable.setData({ headers, data: rows });

      // Donut chart - only use supported contrib colors: red, green, blue, yellow, magenta, cyan
      const severities = summary.bySeverity || [];
      const colorMap = {
        Critical: 'red',
        High: 'yellow',
        Medium: 'cyan',
        Low: 'green',
      };

      if (severities.length > 0 && summary.total > 0) {
        this.donut.setData(
          severities.map((s) => ({
            percent: Math.max(1, Math.round((s.c / summary.total) * 100)),
            label: s.severity || 'Other',
            color: colorMap[s.severity] || 'cyan',
          }))
        );
      } else {
        this.donut.setData([
          { percent: 100, label: 'Idle', color: 'cyan' },
        ]);
      }

      // Webhook & Config status
      const port = this.cfg?.webhookPort || 4242;
      let webhookAlive = false;
      try {
        await axios.get(`http://127.0.0.1:${port}/health`, { timeout: 1000 });
        webhookAlive = true;
      } catch {}

      // Format live scanned services list
      const servicesDisplay = services.length
        ? services
            .map((s) => {
              const statusTag = s.status === 'ONLINE' ? '{green-fg}● ONLINE{/green-fg}' : `{red-fg}● ${s.status}{/red-fg}`;
              return `  • {bold}Port ${s.port}{/bold} [${s.processName} | PID ${s.pid}] ${statusTag}\n    {white-fg}${s.title}{/white-fg}`;
            })
            .join('\n')
        : '  {yellow-fg}Scanning ports... no dev services detected yet{/yellow-fg}';

      this.servicesBox.setContent(
        [
          '',
          `  {bold}Autonomous Scanner:{/bold}  {green-fg}● ACTIVE{/green-fg} {gray-fg}(Continuous Port & Error Watch){/gray-fg}`,
          `  {bold}Live Monitored Apps:{/bold} {bold}{cyan-fg}${services.length} running project${services.length === 1 ? '' : 's'}{/cyan-fg}{/bold}`,
          '',
          '  {bold}Detected Projects & Services:{/bold}',
          servicesDisplay,
          '',
          '  {bold}System Integrations:{/bold}',
          `  Jira:      ${this.cfg?.jiraUrl ? '{green-fg}✓ Connected (' + (this.cfg?.jiraProject || 'KAN') + '){/green-fg}' : '{red-fg}✗ Not Set{/red-fg}'}`,
          `  GitHub:    ${this.cfg?.githubToken ? '{green-fg}✓ Authenticated{/green-fg}' : '{red-fg}✗ Not Set{/red-fg}'}`,
          `  Gemini AI: ${this.cfg?.geminiApiKey ? `{green-fg}✓ ${this.cfg?.geminiModel || 'gemini-2.5-flash'}{/green-fg}` : '{red-fg}✗ Not Set{/red-fg}'}`,
          `  Webhook:   ${webhookAlive ? '{green-fg}● Port ' + port + ' (Online){/green-fg}' : '{yellow-fg}● Port ' + port + ' (Standalone){/yellow-fg}'}`,
        ].join('\n')
      );

      this.screen.render();
    } catch (err) {
      // silently continue
    }
  }

  // ── Tail log file ─────────────────────────────────────────────────────────
  _tailLogs() {
    if (!fs.existsSync(this.logFile)) return;
    try {
      const stat = fs.statSync(this.logFile);
      if (stat.size <= this.logPosition) return;

      const stream = fs.createReadStream(this.logFile, {
        start: this.logPosition,
        end: stat.size,
        encoding: 'utf8',
      });

      let buf = '';
      stream.on('data', (chunk) => (buf += chunk));
      stream.on('end', () => {
        this.logPosition = stat.size;
        const lines = buf.split('\n').filter(Boolean).slice(-50);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            const time = dayjs(entry.timestamp).format('HH:mm:ss');
            const lvl = entry.level === 'error' ? '{red-fg}ERROR{/red-fg}' : entry.level === 'warn' ? '{yellow-fg}WARN{/yellow-fg}' : '{cyan-fg}INFO{/cyan-fg}';
            const cleanMsg = String(entry.message || '')
              .replace(/[\r\n]+/g, ' ')
              .replace(/[{}\\\"]/g, '')
              .slice(0, 95);
            this.logBox.log(`{white-fg}${time}{/white-fg} [${lvl}] ${cleanMsg}`);
          } catch {
            const cleanLine = line
              .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
              .replace(/[\r\n]+/g, ' ')
              .trim()
              .slice(0, 95);
            if (cleanLine) {
              this.logBox.log(cleanLine);
            }
          }
        }
        this.screen.render();
      });
    } catch {}
  }

  // ── Start ─────────────────────────────────────────────────────────────────
  async start() {
    process.env.FIXFORGE_QUIET = '1';

    const logger = require('../utils/logger');
    if (typeof logger.silenceConsole === 'function') {
      logger.silenceConsole();
    }

    // Intercept console.log and console.error so no rogue output corrupts the blessed screen
    const logSink = (...args) => {
      const msg = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
      if (this.logBox) this.logBox.log(msg.slice(0, 100));
    };
    console.log = logSink;
    console.warn = logSink;
    console.error = logSink;

    // Clear terminal screen and scrollback buffer
    process.stdout.write('\x1b[2J\x1b[3J\x1b[H');

    this._buildScreen();
    this.screen.render();

    // Initial load
    await this._refresh();
    this._tailLogs();

    // Refresh every 3s
    setInterval(() => this._refresh(), 3000);
    // Tail logs every 2s
    setInterval(() => this._tailLogs(), 2000);

    this.logBox.log('{green-fg}✓ FixForge Autonomous Dashboard active.{/green-fg} Monitoring ports & tickets…');
    this.screen.render();
  }
}

module.exports = Dashboard;
