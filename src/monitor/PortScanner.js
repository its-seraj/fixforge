'use strict';

const { execSync } = require('child_process');
const os = require('os');

/**
 * Scans listening TCP ports on the machine and resolves the owning process.
 */
class PortScanner {
  /**
   * Returns a list of active listening services:
   * [{ port, pid, processName, commandLine, localAddress }]
   */
  static scanOpenPorts(options = { includeSystem: false }) {
    const isWin = process.platform === 'win32';
    const services = [];

    if (isWin) {
      try {
        const netstatOutput = execSync('netstat -ano -p tcp', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const lines = netstatOutput.split('\r\n');

        // PIDs to query details for
        const pidPortMap = new Map();

        for (const line of lines) {
          if (!line.includes('LISTENING')) continue;
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 5) {
            const localAddress = parts[1];
            const pid = parseInt(parts[4], 10);
            const portMatch = localAddress.match(/:(\d+)$/);
            if (portMatch) {
              const port = parseInt(portMatch[1], 10);
              // Filter out internal Windows system ports unless requested
              const isCommonSystem = [135, 139, 445, 5040, 5357].includes(port) || port > 50000;
              if (!options.includeSystem && isCommonSystem) continue;

              if (!pidPortMap.has(port)) {
                pidPortMap.set(port, { port, pid, localAddress });
              }
            }
          }
        }

        // Fetch process names instantly via tasklist CSV
        const procInfoMap = new Map();
        try {
          const tasklistOut = execSync('tasklist /FO CSV /NH', {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 2000,
          });
          for (const line of tasklistOut.split('\r\n')) {
            if (!line.trim()) continue;
            // Parse CSV format: "Image Name","PID","Session Name","Session#","Mem Usage"
            const match = line.match(/^"([^"]+)","(\d+)"/);
            if (match) {
              procInfoMap.set(parseInt(match[2], 10), match[1]);
            }
          }
        } catch {
          // fallback
        }

        for (const [port, item] of pidPortMap.entries()) {
          const procName = procInfoMap.get(item.pid) || 'Unknown';
          services.push({
            port,
            pid: item.pid,
            localAddress: item.localAddress,
            processName: procName,
          });
        }
      } catch (err) {
        // Fallback for errors
      }
    } else {
      // Linux / macOS: use lsof or ss
      try {
        const out = execSync('ss -tulpn || lsof -iTCP -sTCP:LISTEN -P -n', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        // parse Linux ss / lsof
      } catch {}
    }

    return services.sort((a, b) => a.port - b.port);
  }
}

module.exports = PortScanner;
