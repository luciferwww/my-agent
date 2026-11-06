import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CURRENT_ROOT = join(REPOSITORY_ROOT, 'docs', 'architecture');

interface ArchitectureDocument {
  name: string;
  absolutePath: string;
  content: string;
}

let documents: ArchitectureDocument[];

describe('FT-12 Current Architecture navigation and links', () => {
  beforeAll(async () => {
    const files = (await readdir(CURRENT_ROOT)).filter((name) => name.endsWith('.md')).sort();
    documents = await Promise.all(files.map(async (name) => {
      const absolutePath = join(CURRENT_ROOT, name);
      return { name, absolutePath, content: await readFile(absolutePath, 'utf8') };
    }));
  });

  it('makes current topics discoverable from the index and overview', () => {
    const index = requireDocument('README.md');
    const overview = requireDocument('overview.md');
    expect(markdownDestinations(index.content)).toContain('overview.md');
    const navigation = markdownDestinations(overview.content);
    for (const document of documents) {
      expect(document.content, document.name).toMatch(/^> Status: .+/mu);
      if (document !== index && document !== overview) {
        expect(navigation, document.name).toContain(document.name);
      }
    }
  });

  it('keeps local document links and their fragments valid', async () => {
    for (const document of documents) {
      for (const destination of markdownDestinations(document.content)) {
        if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(destination)) continue;
        const [targetPath, fragment] = destination.split('#', 2);
        const target = targetPath
          ? resolve(dirname(document.absolutePath), targetPath)
          : document.absolutePath;
        await expect(stat(target), `${document.name}: ${destination}`).resolves.toBeDefined();
        if (fragment) {
          const targetContent = await readFile(target, 'utf8');
          expect(hasMarkdownAnchor(targetContent, fragment), `${document.name}: ${destination}`)
            .toBe(true);
        }
      }
    }
  });
});

function requireDocument(name: string): ArchitectureDocument {
  const document = documents.find((entry) => entry.name === name);
  if (!document) throw new Error(`Missing architecture navigation document: ${name}`);
  return document;
}

function markdownDestinations(content: string): string[] {
  return [...content.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/gu)]
    .map((match) => match[1]?.trim())
    .filter((destination): destination is string => Boolean(destination));
}

function hasMarkdownAnchor(content: string, encodedFragment: string): boolean {
  let fragment: string;
  try {
    fragment = decodeURIComponent(encodedFragment).toLowerCase();
  } catch {
    return false;
  }
  const withoutCodeFences = content
    .replace(/^\s*`{3,}[^\r\n]*\r?\n[\s\S]*?^\s*`{3,}\s*$/gmu, '')
    .replace(/^\s*~{3,}[^\r\n]*\r?\n[\s\S]*?^\s*~{3,}\s*$/gmu, '');
  const explicitAnchors = [...withoutCodeFences.matchAll(/<a\s+[^>]*(?:id|name)=["']([^"']+)["'][^>]*>/giu)]
    .map((match) => match[1]?.toLowerCase());
  if (explicitAnchors.includes(fragment)) return true;

  return [...withoutCodeFences.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gmu)]
    .some((match) => (match[1] ?? '')
      .replace(/<[^>]+>/gu, '')
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/gu, '-') === fragment);
}
