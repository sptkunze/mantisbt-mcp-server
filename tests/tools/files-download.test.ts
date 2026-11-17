import { mkdtemp, mkdir, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MantisClient } from '../../src/client.js';
import { registerFileTools } from '../../src/tools/files.js';
import { MockMcpServer, makeResponse } from '../helpers/mock-server.js';

// get_issue_file — uses the real filesystem for save_dir, like files-symlink.test.ts.

let root: string;
let mockServer: MockMcpServer;

const PNG_B64 = Buffer.from('fake-png-bytes').toString('base64');
const PDF_B64 = Buffer.from('%PDF-1.4 fake').toString('base64');

function fileResponse(file: Record<string, unknown>) {
  return makeResponse(200, JSON.stringify({ files: [file] }));
}

function register(transport: 'stdio' | 'http' = 'stdio', downloadDir?: string): void {
  mockServer = new MockMcpServer();
  registerFileTools(mockServer as never, new MantisClient('https://mantis.example.com', 'test-token'), undefined, transport, downloadDir);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mantis-download-'));
  register();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

describe('get_issue_file', () => {
  it('is registered', () => {
    expect(mockServer.hasToolRegistered('get_issue_file')).toBe(true);
  });

  it('requests the file endpoint of the issue', async () => {
    vi.mocked(fetch).mockResolvedValue(fileResponse({ id: 7, filename: 'a.png', size: 3, content_type: 'image/png', content: PNG_B64 }));

    await mockServer.callTool('get_issue_file', { issue_id: 42, file_id: 7 });

    expect(String(vi.mocked(fetch).mock.calls[0]![0])).toBe('https://mantis.example.com/api/rest/issues/42/files/7');
  });

  it('returns images inline as image content', async () => {
    vi.mocked(fetch).mockResolvedValue(fileResponse({ id: 7, filename: 'a.png', size: 14, content_type: 'image/png; charset=binary', content: PNG_B64 }));

    const result = await mockServer.callTool('get_issue_file', { issue_id: 42, file_id: 7 });

    expect(result.isError).toBeUndefined();
    const [image, meta] = result.content as unknown as [{ type: string; data: string; mimeType: string }, { text: string }];
    expect(image).toEqual({ type: 'image', data: PNG_B64, mimeType: 'image/png' });
    expect(JSON.parse(meta.text)).toMatchObject({ id: 7, issue_id: 42, filename: 'a.png', size: 14 });
  });

  it('returns other files as Base64 text', async () => {
    vi.mocked(fetch).mockResolvedValue(fileResponse({ id: 8, filename: 'r.pdf', size: 13, content_type: 'application/pdf', content: PDF_B64 }));

    const result = await mockServer.callTool('get_issue_file', { issue_id: 42, file_id: 8 });

    expect(result.content[1]!.text).toBe(`base64:${PDF_B64}`);
  });

  it('reports a missing attachment as error', async () => {
    vi.mocked(fetch).mockResolvedValue(makeResponse(200, JSON.stringify({ files: [] })));

    const result = await mockServer.callTool('get_issue_file', { issue_id: 42, file_id: 9 });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('not found');
  });

  it('saves to save_dir, creates it, and returns only path and metadata', async () => {
    vi.mocked(fetch).mockResolvedValue(fileResponse({ id: 8, filename: 'r.pdf', size: 13, content_type: 'application/pdf', content: PDF_B64 }));
    const dir = path.join(root, 'new', 'sub');

    const result = await mockServer.callTool('get_issue_file', { issue_id: 42, file_id: 8, save_dir: dir });

    expect(result.content).toHaveLength(1);
    const meta = JSON.parse(result.content[0]!.text) as { saved_path: string };
    expect(meta.saved_path).toBe(path.join(dir, 'r.pdf'));
    expect(await readFile(meta.saved_path, 'utf8')).toBe('%PDF-1.4 fake');
  });

  it('never overwrites an existing file', async () => {
    vi.mocked(fetch).mockImplementation(async () => fileResponse({ id: 8, filename: 'r.pdf', size: 13, content_type: 'application/pdf', content: PDF_B64 }));

    await mockServer.callTool('get_issue_file', { issue_id: 42, file_id: 8, save_dir: root });
    const second = await mockServer.callTool('get_issue_file', { issue_id: 42, file_id: 8, save_dir: root });

    expect((JSON.parse(second.content[0]!.text) as { saved_path: string }).saved_path).toBe(path.join(root, 'r (1).pdf'));
    expect((await readdir(root)).sort()).toEqual(['r (1).pdf', 'r.pdf']);
  });

  it('strips directory parts from the attachment name', async () => {
    vi.mocked(fetch).mockResolvedValue(fileResponse({ id: 8, filename: '..\\..\\evil.txt', size: 1, content_type: 'text/plain', content: PDF_B64 }));

    const result = await mockServer.callTool('get_issue_file', { issue_id: 42, file_id: 8, save_dir: root });

    expect((JSON.parse(result.content[0]!.text) as { saved_path: string }).saved_path).toBe(path.join(root, 'evil.txt'));
  });

  it('rejects save_dir over HTTP without MANTIS_DOWNLOAD_DIR', async () => {
    register('http');

    const result = await mockServer.callTool('get_issue_file', { issue_id: 42, file_id: 8, save_dir: root });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('MANTIS_DOWNLOAD_DIR');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('allows save_dir inside MANTIS_DOWNLOAD_DIR and rejects it outside', async () => {
    const downloads = path.join(root, 'downloads');
    await mkdir(downloads);
    register('http', downloads);
    vi.mocked(fetch).mockImplementation(async () => fileResponse({ id: 8, filename: 'r.pdf', size: 13, content_type: 'application/pdf', content: PDF_B64 }));

    const inside = await mockServer.callTool('get_issue_file', { issue_id: 42, file_id: 8, save_dir: path.join(downloads, 'x') });
    const outside = await mockServer.callTool('get_issue_file', { issue_id: 42, file_id: 8, save_dir: path.join(root, 'elsewhere') });
    const traversal = await mockServer.callTool('get_issue_file', { issue_id: 42, file_id: 8, save_dir: path.join(downloads, '..', 'elsewhere') });

    expect(inside.isError).toBeUndefined();
    expect(outside.isError).toBe(true);
    expect(traversal.isError).toBe(true);
  });

  it('rejects a link inside MANTIS_DOWNLOAD_DIR that leads outside', async () => {
    const downloads = path.join(root, 'downloads');
    const outsideDir = path.join(root, 'outside');
    await mkdir(downloads);
    await mkdir(outsideDir);
    try {
      await symlink(outsideDir, path.join(downloads, 'link'), 'junction');
    } catch {
      return; // links not permitted on this system
    }
    register('stdio', downloads);
    vi.mocked(fetch).mockResolvedValue(fileResponse({ id: 8, filename: 'r.pdf', size: 13, content_type: 'application/pdf', content: PDF_B64 }));

    const result = await mockServer.callTool('get_issue_file', { issue_id: 42, file_id: 8, save_dir: path.join(downloads, 'link') });

    expect(result.isError).toBe(true);
    expect(await readdir(outsideDir)).toEqual([]);
  });
});
