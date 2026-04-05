import type { Tool } from '../types.js';
import type { ProcessRecord, ProcessStatus, ProcessToolInput } from './exec-types.js';
import { processRegistry } from './process-registry.js';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function summarizeStatus(status: ProcessStatus, exitCode?: number | null): string {
  switch (status) {
    case 'starting':
      return 'Process is starting.';
    case 'running':
      return 'Process is still running.';
    case 'completed':
      return 'Process completed successfully.';
    case 'failed':
      return `Process failed with code ${exitCode ?? 'unknown'}.`;
    case 'timed_out':
      return 'Process timed out.';
    case 'aborted':
      return 'Process was aborted.';
  }
}

function formatRecordSummary(record: ProcessRecord): string {
  // Status and timing fields are the minimum context the agent needs to continue a background task.
  return [
    `runId: ${record.runId}`,
    `status: ${record.status}`,
    `command: ${record.command}`,
    record.pid ? `pid: ${record.pid}` : undefined,
    record.startedAt ? `startedAt: ${record.startedAt}` : undefined,
    record.endedAt ? `endedAt: ${record.endedAt}` : undefined,
    record.yielded !== undefined ? `yielded: ${record.yielded}` : undefined,
    `summary: ${summarizeStatus(record.status, record.exitCode)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function formatList(records: ProcessRecord[]): string {
  if (records.length === 0) {
    return 'No background processes.';
  }

  return [
    'Background processes:',
    ...records.map((record) => `- ${record.runId} | ${record.status} | ${record.command}`),
  ].join('\n');
}

function parseTailLines(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return Math.floor(value);
}

function applyTailLines(output: string, tailLines?: number): string {
  if (!tailLines) {
    return output;
  }

  return output.split(/\r?\n/).slice(-tailLines).join('\n');
}

export const processTool: Tool = {
  name: 'process',
  description: 'Manage background processes started by exec. Use list, status, log, or kill with a runId.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'status', 'log', 'kill'],
      },
      runId: {
        type: 'string',
        description: 'Background process identifier returned by exec.',
      },
      tailLines: {
        type: 'number',
        description: 'When action=log, return only the last N lines.',
      },
    },
    required: ['action'],
  },
  execute: async (params) => {
    const action = params.action;
    if (action === 'list') {
      // List only exposes records that have actually entered the background-management path.
      return { content: formatList(processRegistry.listVisible()) };
    }

    if ((action === 'status' || action === 'log' || action === 'kill') && !isNonEmptyString(params.runId)) {
      return {
        content: 'Invalid input for tool "process": "runId" must be a non-empty string',
        isError: true,
      };
    }

    if (action === 'status') {
      const record = processRegistry.get((params as Extract<ProcessToolInput, { action: 'status' }>).runId);
      if (!record || record.visibility !== 'background') {
        return {
          content: `runId not found: ${(params as Extract<ProcessToolInput, { action: 'status' }>).runId}`,
          isError: true,
        };
      }

      return { content: formatRecordSummary(record) };
    }

    if (action === 'log') {
      const input = params as Extract<ProcessToolInput, { action: 'log' }>;
      const record = processRegistry.get(input.runId);
      if (!record || record.visibility !== 'background') {
        return {
          content: `runId not found: ${input.runId}`,
          isError: true,
        };
      }

      const output = applyTailLines(record.output, parseTailLines(input.tailLines));
      return {
        content: output || 'No output has been produced yet.',
      };
    }

    if (action === 'kill') {
      const input = params as Extract<ProcessToolInput, { action: 'kill' }>;
      const record = processRegistry.get(input.runId);
      if (!record || record.visibility !== 'background') {
        return {
          content: `runId not found: ${input.runId}`,
          isError: true,
        };
      }

      if (record.status !== 'starting' && record.status !== 'running') {
        // kill stays idempotent for completed tasks by returning the current terminal summary.
        return {
          content: formatRecordSummary(record),
        };
      }

      const killed = record.child?.kill() ?? false;
      if (!killed) {
        return {
          content: formatRecordSummary(record),
        };
      }

      processRegistry.complete(record.runId, {
        status: 'aborted',
        endedAt: Date.now(),
        signal: 'SIGTERM',
      });

      const updated = processRegistry.get(record.runId);
      return {
        content: updated ? formatRecordSummary(updated) : `runId: ${record.runId}\nstatus: aborted`,
      };
    }

    return {
      content: `Invalid input for tool "process": unsupported action ${String(action)}`,
      isError: true,
    };
  },
};