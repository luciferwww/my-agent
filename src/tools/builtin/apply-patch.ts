import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Tool } from '../types.js';
import { resolveWorkspacePath } from './common/path-policy.js';
import { applyUpdateHunk, type UpdateFileChunk } from './apply-patch-update.js';

const BEGIN_PATCH_MARKER = '*** Begin Patch';
const END_PATCH_MARKER = '*** End Patch';
const ADD_FILE_MARKER = '*** Add File: ';
const DELETE_FILE_MARKER = '*** Delete File: ';
const UPDATE_FILE_MARKER = '*** Update File: ';
const MOVE_TO_MARKER = '*** Move to: ';
const EOF_MARKER = '*** End of File';
const CHANGE_CONTEXT_MARKER = '@@ ';
const EMPTY_CHANGE_CONTEXT_MARKER = '@@';

type AddFileHunk = {
  kind: 'add';
  path: string;
  contents: string;
};

type DeleteFileHunk = {
  kind: 'delete';
  path: string;
};

type UpdateFileHunk = {
  kind: 'update';
  path: string;
  movePath?: string;
  chunks: UpdateFileChunk[];
};

type Hunk = AddFileHunk | DeleteFileHunk | UpdateFileHunk;

type ApplyPatchSummary = {
  added: string[];
  modified: string[];
  deleted: string[];
};

function parsePatchText(input: string): Hunk[] {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Invalid patch: input is empty.');
  }

  const lines = trimmed.split(/\r?\n/);
  if (lines[0]?.trim() !== BEGIN_PATCH_MARKER) {
    throw new Error(`The first line of the patch must be '${BEGIN_PATCH_MARKER}'`);
  }
  if (lines[lines.length - 1]?.trim() !== END_PATCH_MARKER) {
    throw new Error(`The last line of the patch must be '${END_PATCH_MARKER}'`);
  }

  const hunks: Hunk[] = [];
  let index = 1;

  while (index < lines.length - 1) {
    const current = lines[index]!;
    if (!current.trim()) {
      index += 1;
      continue;
    }

    if (current.startsWith(ADD_FILE_MARKER)) {
      const targetPath = current.slice(ADD_FILE_MARKER.length);
      index += 1;
      const contents: string[] = [];
      while (index < lines.length - 1) {
        const line = lines[index]!;
        if (line.startsWith('*** ')) {
          break;
        }
        if (!line.startsWith('+')) {
          throw new Error(`Invalid add hunk line: '${line}'. Added file contents must start with '+'`);
        }
        contents.push(line.slice(1));
        index += 1;
      }
      hunks.push({ kind: 'add', path: targetPath, contents: `${contents.join('\n')}${contents.length ? '\n' : ''}` });
      continue;
    }

    if (current.startsWith(DELETE_FILE_MARKER)) {
      hunks.push({ kind: 'delete', path: current.slice(DELETE_FILE_MARKER.length) });
      index += 1;
      continue;
    }

    if (current.startsWith(UPDATE_FILE_MARKER)) {
      const targetPath = current.slice(UPDATE_FILE_MARKER.length);
      index += 1;
      let movePath: string | undefined;
      if (index < lines.length - 1 && lines[index]!.startsWith(MOVE_TO_MARKER)) {
        movePath = lines[index]!.slice(MOVE_TO_MARKER.length);
        index += 1;
      }

      const chunks: UpdateFileChunk[] = [];
      while (index < lines.length - 1) {
        const line = lines[index]!;
        if (!line.trim()) {
          index += 1;
          continue;
        }
        if (line.startsWith('*** ')) {
          break;
        }
        const parsed = parseUpdateChunk(lines, index);
        chunks.push(parsed.chunk);
        index += parsed.consumed;
      }

      if (chunks.length === 0) {
        throw new Error(`Update hunk for '${targetPath}' does not contain any chunks.`);
      }

      hunks.push({ kind: 'update', path: targetPath, movePath, chunks });
      continue;
    }

    throw new Error(`Invalid patch hunk header: '${current}'`);
  }

  return hunks;
}

function parseUpdateChunk(lines: string[], startIndex: number): { chunk: UpdateFileChunk; consumed: number } {
  let index = startIndex;
  let changeContext: string | undefined;

  if (lines[index] === EMPTY_CHANGE_CONTEXT_MARKER) {
    index += 1;
  } else if (lines[index]?.startsWith(CHANGE_CONTEXT_MARKER)) {
    changeContext = lines[index]!.slice(CHANGE_CONTEXT_MARKER.length);
    index += 1;
  }

  const chunk: UpdateFileChunk = {
    changeContext,
    oldLines: [],
    newLines: [],
    isEndOfFile: false,
  };

  while (index < lines.length) {
    const line = lines[index]!;
    if (line === EOF_MARKER) {
      chunk.isEndOfFile = true;
      index += 1;
      break;
    }
    if (line.startsWith('*** ') || line === END_PATCH_MARKER) {
      break;
    }
    if (line === EMPTY_CHANGE_CONTEXT_MARKER || line.startsWith(CHANGE_CONTEXT_MARKER)) {
      break;
    }

    const marker = line[0];
    if (!marker) {
      chunk.oldLines.push('');
      chunk.newLines.push('');
      index += 1;
      continue;
    }

    if (marker === ' ') {
      const content = line.slice(1);
      chunk.oldLines.push(content);
      chunk.newLines.push(content);
      index += 1;
      continue;
    }
    if (marker === '+') {
      chunk.newLines.push(line.slice(1));
      index += 1;
      continue;
    }
    if (marker === '-') {
      chunk.oldLines.push(line.slice(1));
      index += 1;
      continue;
    }

    throw new Error(`Unexpected line found in update hunk: '${line}'`);
  }

  if (chunk.oldLines.length === 0 && chunk.newLines.length === 0) {
    throw new Error('Update hunk does not contain any lines.');
  }

  return {
    chunk,
    consumed: index - startIndex,
  };
}

function recordSummary(summary: ApplyPatchSummary, bucket: keyof ApplyPatchSummary, value: string): void {
  if (!summary[bucket].includes(value)) {
    summary[bucket].push(value);
  }
}

function formatSummary(summary: ApplyPatchSummary): string {
  const lines = ['Success. Updated the following files:'];
  for (const file of summary.added) {
    lines.push(`A ${file}`);
  }
  for (const file of summary.modified) {
    lines.push(`M ${file}`);
  }
  for (const file of summary.deleted) {
    lines.push(`D ${file}`);
  }
  return lines.join('\n');
}

async function ensureParentDir(filePath: string): Promise<void> {
  const parentDir = dirname(filePath);
  await mkdir(parentDir, { recursive: true });
}

export const applyPatchTool: Tool = {
  name: 'apply_patch',
  description: 'Apply a multi-file patch using the *** Begin Patch / *** End Patch format.',
  inputSchema: {
    type: 'object',
    properties: {
      input: {
        type: 'string',
        description: 'Full patch contents including *** Begin Patch and *** End Patch.',
      },
    },
    required: ['input'],
  },
  execute: async (params) => {
    try {
      const input = typeof params.input === 'string' ? params.input : '';
      if (!input.trim()) {
        return {
          content: 'Invalid input for tool "apply_patch": "input" must be a non-empty string',
          isError: true,
        };
      }

      const hunks = parsePatchText(input);
      if (hunks.length === 0) {
        return {
          content: 'Error executing tool "apply_patch": No files were modified.',
          isError: true,
        };
      }

      const summary: ApplyPatchSummary = { added: [], modified: [], deleted: [] };

      for (const hunk of hunks) {
        if (hunk.kind === 'add') {
          const target = resolveWorkspacePath(hunk.path);
          await ensureParentDir(target.resolvedPath);
          await writeFile(target.resolvedPath, hunk.contents, 'utf8');
          recordSummary(summary, 'added', target.displayPath);
          continue;
        }

        if (hunk.kind === 'delete') {
          const target = resolveWorkspacePath(hunk.path);
          await rm(target.resolvedPath);
          recordSummary(summary, 'deleted', target.displayPath);
          continue;
        }

        const target = resolveWorkspacePath(hunk.path);
        const updatedContent = await applyUpdateHunk(target.resolvedPath, hunk.chunks, {
          readFile: (filePath) => readFile(filePath, 'utf8'),
        });

        if (hunk.movePath) {
          const moveTarget = resolveWorkspacePath(hunk.movePath);
          await ensureParentDir(moveTarget.resolvedPath);
          await writeFile(moveTarget.resolvedPath, updatedContent, 'utf8');
          await rm(target.resolvedPath);
          recordSummary(summary, 'modified', moveTarget.displayPath);
          continue;
        }

        await writeFile(target.resolvedPath, updatedContent, 'utf8');
        recordSummary(summary, 'modified', target.displayPath);
      }

      return {
        content: formatSummary(summary),
      };
    } catch (error) {
      return {
        content: `Error executing tool "apply_patch": ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  },
};