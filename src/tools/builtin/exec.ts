import { spawn } from 'node:child_process';

import type { Tool } from '../types.js';

const DEFAULT_TIMEOUT_SECONDS = 30;

// exec 的 env 只接受 string:string，避免把复杂对象直接混进 process.env。
function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === 'string');
}

function normalizeTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TIMEOUT_SECONDS;
  }

  return value;
}

function normalizeCwd(value: unknown, defaultCwd: string): string {
  return typeof value === 'string' && value.trim() ? value : defaultCwd;
}

function normalizeEnv(value: unknown): Record<string, string> {
  return isStringRecord(value) ? value : {};
}

export const execTool: Tool = {
  name: 'exec',
  description: 'Execute a shell command in the workspace and return combined stdout/stderr output.',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Shell command to execute.',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in seconds. Defaults to 30.',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for the command. Defaults to the current process directory.',
      },
      env: {
        type: 'object',
        description: 'Additional environment variables to pass to the command.',
        additionalProperties: { type: 'string' },
      },
    },
    required: ['command'],
  },
  execute: async (params, context) => {
    const command = params.command;
    if (typeof command !== 'string' || !command.trim()) {
      return {
        content: 'Invalid input for tool "exec": "command" must be a non-empty string',
        isError: true,
      };
    }

    const timeoutSeconds = normalizeTimeout(params.timeout);
    const cwd = normalizeCwd(params.cwd, process.cwd());
    const env = normalizeEnv(params.env);

    return await new Promise((resolve) => {
      // 通过 shell:true 复用当前平台默认 shell，避免把实现写死到 Unix shell。
      const child = spawn(command, {
        cwd,
        env: { ...process.env, ...env },
        shell: true,
        signal: context?.signal,
      });

      const chunks: Array<{ timestamp: number; text: string }> = [];
      let timedOut = false;

      // stdout/stderr 分开监听，再按时间排序合并，和设计文档保持一致。
      const pushChunk = (data: Buffer | string) => {
        chunks.push({
          timestamp: Date.now(),
          text: data.toString(),
        });
      };

      child.stdout.on('data', pushChunk);
      child.stderr.on('data', pushChunk);

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutSeconds * 1000);

      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({
          content: `Error executing command: ${error.message}`,
          isError: true,
        });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        const output = chunks
          .sort((left, right) => left.timestamp - right.timestamp)
          .map((chunk) => chunk.text)
          .join('');

        // 超时和非零退出都保留已有输出，方便上层定位问题。
        if (timedOut) {
          resolve({
            content: `${output}\n\nProcess timed out after ${timeoutSeconds} seconds`.trim(),
            isError: true,
          });
          return;
        }

        if (code !== 0) {
          resolve({
            content: `${output}\n\nProcess exited with code ${code ?? 'unknown'}`.trim(),
            isError: true,
          });
          return;
        }

        resolve({ content: output });
      });
    });
  },
};