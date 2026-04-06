import { readFile } from 'node:fs/promises';

export type UpdateFileChunk = {
  changeContext?: string;
  oldLines: string[];
  newLines: string[];
  isEndOfFile: boolean;
};

export async function applyUpdateHunk(
  filePath: string,
  chunks: UpdateFileChunk[],
  options?: { readFile?: (filePath: string) => Promise<string> },
): Promise<string> {
  const reader = options?.readFile ?? ((targetPath: string) => readFile(targetPath, 'utf8'));
  const originalContents = await reader(filePath).catch((error) => {
    throw new Error(`Failed to read file to update ${filePath}: ${error}`);
  });

  const originalLines = splitContentLines(originalContents);
  const replacements = computeReplacements(originalLines, filePath, chunks);
  let newLines = applyReplacements(originalLines, replacements);
  if (newLines.length === 0 || newLines[newLines.length - 1] !== '') {
    newLines = [...newLines, ''];
  }
  return newLines.join('\n');
}

function splitContentLines(content: string): string[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

function computeReplacements(
  originalLines: string[],
  filePath: string,
  chunks: UpdateFileChunk[],
): Array<[number, number, string[]]> {
  const replacements: Array<[number, number, string[]]> = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    if (chunk.changeContext) {
      const contextIndex = seekSequence(originalLines, [chunk.changeContext], lineIndex, false);
      if (contextIndex === null) {
        throw new Error(`Failed to find context '${chunk.changeContext}' in ${filePath}`);
      }
      lineIndex = contextIndex + 1;
    }

    if (chunk.oldLines.length === 0) {
      const insertionIndex =
        originalLines.length > 0 && originalLines[originalLines.length - 1] === ''
          ? originalLines.length - 1
          : originalLines.length;
      replacements.push([insertionIndex, 0, chunk.newLines]);
      continue;
    }

    let pattern = chunk.oldLines;
    let replacement = chunk.newLines;
    let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);

    if (found === null && pattern[pattern.length - 1] === '') {
      pattern = pattern.slice(0, -1);
      if (replacement.length > 0 && replacement[replacement.length - 1] === '') {
        replacement = replacement.slice(0, -1);
      }
      found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
    }

    if (found === null) {
      throw new Error(`Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join('\n')}`);
    }

    replacements.push([found, pattern.length, replacement]);
    lineIndex = found + pattern.length;
  }

  replacements.sort((left, right) => left[0] - right[0]);
  return replacements;
}

function applyReplacements(
  lines: string[],
  replacements: Array<[number, number, string[]]>,
): string[] {
  const result = [...lines];
  for (const [startIndex, removeCount, newLines] of [...replacements].reverse()) {
    result.splice(startIndex, removeCount, ...newLines);
  }
  return result;
}

function seekSequence(
  lines: string[],
  pattern: string[],
  start: number,
  eof: boolean,
): number | null {
  if (pattern.length === 0) {
    return start;
  }
  if (pattern.length > lines.length) {
    return null;
  }

  const maxStart = lines.length - pattern.length;
  const searchStart = eof && lines.length >= pattern.length ? maxStart : start;
  if (searchStart > maxStart) {
    return null;
  }

  const normalizers = [
    (value: string) => value,
    (value: string) => value.trimEnd(),
    (value: string) => value.trim(),
  ];

  for (const normalize of normalizers) {
    for (let index = searchStart; index <= maxStart; index += 1) {
      if (linesMatch(lines, pattern, index, normalize)) {
        return index;
      }
    }
  }

  return null;
}

function linesMatch(
  lines: string[],
  pattern: string[],
  start: number,
  normalize: (value: string) => string,
): boolean {
  for (let index = 0; index < pattern.length; index += 1) {
    if (normalize(lines[start + index] ?? '') !== normalize(pattern[index] ?? '')) {
      return false;
    }
  }
  return true;
}