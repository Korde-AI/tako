/**
 * CLI: tako logs — view Tako log files.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { getLogPath, getLogDir } from '../utils/logger.js';

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

export async function runLogs(args: string[]): Promise<void> {
  const logFile = getLogPath();

  if (!existsSync(logFile)) {
    console.log('No log file for today.');
    console.log(`Log directory: ${getLogDir()}`);
    return;
  }

  // --follow mode
  if (args.includes('--follow') || args.includes('-f')) {
    console.log(`Following ${logFile} (Ctrl+C to stop)\n`);
    const tail = spawn('tail', ['-f', logFile], { stdio: 'inherit' });
    await new Promise<void>((resolve) => {
      tail.on('close', () => resolve());
    });
    return;
  }

  // Read the file
  const content = await readFile(logFile, 'utf-8');
  let lines = content.split('\n');

  // --grep filter
  const grepPattern = getArg(args, '--grep');
  if (grepPattern) {
    const regex = new RegExp(grepPattern, 'i');
    lines = lines.filter((line) => regex.test(line));
  }

  // --lines limit
  const linesArg = getArg(args, '--lines') ?? getArg(args, '-n');
  const lineCount = linesArg ? parseInt(linesArg, 10) : 50;

  // Show last N lines
  const output = lines.slice(-lineCount).join('\n');
  if (output.trim()) {
    console.log(output);
  } else {
    console.log('No matching log entries.');
  }
}
