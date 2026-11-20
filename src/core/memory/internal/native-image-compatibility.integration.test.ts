import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../../../../', import.meta.url));

describe('Transformers and attachment native image compatibility', () => {
  it.each(['sharp-first', 'transformers-first'] as const)(
    'processes images without native diagnostics with %s',
    async (order) => {
      const sharpImport = "const { default: sharp } = await import('sharp');";
      const transformersImport = "const { RawImage } = await import('@xenova/transformers');";
      const imports = order === 'sharp-first'
        ? `${sharpImport}\n${transformersImport}`
        : `${transformersImport}\n${sharpImport}`;
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        ['--input-type=module', '-e', `
          import assert from 'node:assert/strict';
          ${imports}
          const png = await sharp({
            create: {
              width: 8, height: 8, channels: 4,
              background: { r: 200, g: 100, b: 50, alpha: 0.5 },
            },
          }).png().toBuffer();
          const jpeg = await sharp(png).rotate().resize(4, 4)
            .flatten({ background: '#ffffff' })
            .jpeg({ quality: 85, mozjpeg: true, chromaSubsampling: '4:2:0' })
            .toBuffer();
          const metadata = await sharp(jpeg).metadata();
          assert.equal(metadata.width, 4);
          assert.equal(metadata.height, 4);
          assert.equal(metadata.format, 'jpeg');

          const image = await RawImage.fromBlob(new Blob([png], { type: 'image/png' }));
          const resized = await image.resize(4, 4);
          assert.equal(resized.width, 4);
          assert.equal(resized.height, 4);
          console.log('IMAGE_COMPATIBILITY_OK');
        `],
        { cwd: projectRoot, timeout: 20_000 },
      );

      expect(stderr).toBe('');
      expect(stdout.trim()).toBe('IMAGE_COMPATIBILITY_OK');
    },
    30_000,
  );
});
