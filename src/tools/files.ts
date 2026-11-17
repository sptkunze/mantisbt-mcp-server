import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, extname, resolve, sep } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MantisClient } from '../client.js';
import { enrichIssue } from '../issue-enrich.js';
import { getVersionHint } from '../version-hint.js';
import { firstIssue, type IssueEnvelope } from '../issue-envelope.js';
import { deprecationNote } from '../deprecation.js';

function errorText(msg: string): string {
  const vh = getVersionHint();
  vh?.triggerLatestVersionFetch();
  const hint = vh?.getUpdateHint();
  return hint ? `Error: ${msg}\n\n${hint}` : `Error: ${msg}`;
}

export function registerFileTools(
  server: McpServer,
  client: MantisClient,
  uploadDir?: string,
  transport: 'stdio' | 'http' = 'stdio',
  downloadDir?: string,
): void {
  const uploadRoot = uploadDir ? resolve(uploadDir) : undefined;
  const downloadRoot = downloadDir ? resolve(downloadDir) : undefined;
  // save_dir writes to the server's own filesystem — same reasoning as file_path:
  // fine for the local stdio agent, but over HTTP only inside MANTIS_DOWNLOAD_DIR.
  const saveDirAllowed = transport === 'stdio' || downloadRoot !== undefined;
  // file_path reads from the server's own filesystem. Over stdio the caller is
  // the trusted local agent (same machine, same user), so any path is fine. Over
  // HTTP a remote client neither controls nor should reach server-local paths —
  // it must send Base64 via `content`. Only allow file_path in HTTP mode when an
  // explicit MANTIS_UPLOAD_DIR sandboxes it.
  const filePathAllowed = transport === 'stdio' || uploadRoot !== undefined;

  // ---------------------------------------------------------------------------
  // list_issue_files
  // ---------------------------------------------------------------------------

  server.registerTool(
    'list_issue_files',
    {
      title: 'List Issue File Attachments',
      description: `${deprecationNote('list_issue_files', 'get_issue with select: "attachments"')}

List all file attachments of a MantisBT issue. Returns an array of attachment objects, each containing id, filename, size in bytes, content_type, and download_url. Returns an empty array if the issue has no attachments.`,
      inputSchema: z.object({
        issue_id: z.coerce.number().int().positive().describe('Numeric issue ID'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ issue_id }) => {
      try {
        const [result, baseUrl] = await Promise.all([
          client.get<IssueEnvelope>(`issues/${issue_id}`, { select: 'id,attachments' }),
          client.getBaseUrl(),
        ]);
        const issue = firstIssue(result);
        const attachments = (issue && enrichIssue(issue, baseUrl, issue_id).attachments) ?? [];
        return {
          content: [{ type: 'text', text: JSON.stringify(attachments, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: errorText(msg) }], isError: true };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // upload_file
  // ---------------------------------------------------------------------------

  server.registerTool(
    'upload_file',
    {
      title: 'Upload File Attachment',
      description: `Upload a file as an attachment to a MantisBT issue. Adds the file to the issue without modifying any issue fields or status. Returns the created attachment metadata on success.

Provide exactly one of the two input modes:
- file_path (preferred): absolute path to a local file — use this whenever the file exists on disk; the server reads and encodes it automatically; filename is derived from the path. Note: file_path reads from the server's filesystem and is disabled over the HTTP transport unless MANTIS_UPLOAD_DIR is configured — HTTP clients should use content instead.
- content: Base64-encoded file content — only use this when the file is not accessible via a path (e.g. in-memory data); filename must be supplied explicitly via the filename parameter

The optional content_type sets the MIME type (e.g. "image/png"); defaults to "application/octet-stream". Use the optional description to annotate the attachment.

Use this tool to attach files such as logs, screenshots, or patches to an existing issue. To list existing attachments, use get_issue with select: "attachments".`,
      inputSchema: z.object({
        issue_id: z.coerce.number().int().positive().describe('Numeric issue ID'),
        file_path: z.string().min(1).optional().describe('Preferred: absolute path to the local file to upload — use this whenever the file exists on disk (mutually exclusive with content)'),
        content: z.string().min(1).optional().describe('Fallback: Base64-encoded file content — only use when file_path is not available (mutually exclusive with file_path)'),
        filename: z.string().min(1).optional().describe('File name for the attachment (required when using content; overrides the derived name when using file_path)'),
        content_type: z.string().optional().describe('MIME type of the file, e.g. "image/png" (default: "application/octet-stream")'),
        description: z.string().optional().describe('Optional description for the attachment'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ issue_id, file_path, content, filename, content_type, description }) => {
      try {
        if (!file_path && !content) {
          return { content: [{ type: 'text', text: 'Error: Either file_path or content must be provided' }], isError: true };
        }
        if (file_path && content) {
          return { content: [{ type: 'text', text: 'Error: Only one of file_path or content may be provided' }], isError: true };
        }

        let base64Content: string;
        let fileName: string;

        if (file_path) {
          if (!filePathAllowed) {
            return { content: [{ type: 'text', text: errorText('file_path is disabled over the HTTP transport. Send the file via the "content" parameter (Base64), or set MANTIS_UPLOAD_DIR to permit server-local paths within that directory.') }], isError: true };
          }
          let readPath = file_path;
          if (uploadRoot) {
            const denied = { content: [{ type: 'text' as const, text: errorText('file_path is not allowed — access restricted to the designated upload directory') }], isError: true };
            if (!resolve(file_path).startsWith(uploadRoot + sep)) return denied;
            // The textual check alone is not enough: a link inside the directory
            // must not lead the read outside, so compare the real targets (#8618).
            const [realTarget, realRoot] = await Promise.all([realpath(file_path), realpath(uploadRoot)]);
            if (!realTarget.startsWith(realRoot + sep)) return denied;
            readPath = realTarget;
          }
          const fileBuffer = await readFile(readPath);
          base64Content = fileBuffer.toString('base64');
          fileName = filename ?? basename(file_path);
        } else {
          if (!filename) {
            return { content: [{ type: 'text', text: 'Error: filename is required when using content' }], isError: true };
          }
          base64Content = content!;
          fileName = filename;
        }

        const body = {
          files: [{ name: fileName, type: content_type ?? 'application/octet-stream', content: base64Content }],
          ...(description && { description }),
        };
        const result = await client.post<unknown>(`issues/${issue_id}/files`, body);
        return {
          content: [{ type: 'text', text: JSON.stringify(result ?? { success: true }, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: errorText(msg) }], isError: true };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // get_issue_file
  // ---------------------------------------------------------------------------

  server.registerTool(
    'get_issue_file',
    {
      title: 'Download File Attachment',
      description: `Download a file attachment of a MantisBT issue.

Find file ids via get_issue with select: "attachments,notes" — files added together with a note are listed only in that note's "attachments", not in the issue's.

Without save_dir: image attachments are returned as a viewable image, any other file as Base64 text — fine for screenshots, expensive for large files.
With save_dir (preferred for logs, PDFs, archives and other non-image files): the file is written to that local directory and only its path and metadata are returned. An existing file is never overwritten; a numbered suffix is added instead. save_dir writes to the server's filesystem and is disabled over the HTTP transport unless MANTIS_DOWNLOAD_DIR is configured; when MANTIS_DOWNLOAD_DIR is set, save_dir must lie within it.`,
      inputSchema: z.object({
        issue_id: z.coerce.number().int().positive().describe('Numeric issue ID'),
        file_id: z.coerce.number().int().positive().describe('Attachment id (from the issue\'s or a note\'s "attachments" array)'),
        save_dir: z.string().min(1).optional().describe('Local directory to save the file into (created if missing); absolute path recommended'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ issue_id, file_id, save_dir }) => {
      try {
        if (save_dir && !saveDirAllowed) {
          return { content: [{ type: 'text', text: errorText('save_dir is disabled over the HTTP transport. Omit it to receive the file content, or set MANTIS_DOWNLOAD_DIR to permit saving within that directory.') }], isError: true };
        }

        const result = await client.get<{ files?: Array<Record<string, unknown>> }>(`issues/${issue_id}/files/${file_id}`);
        const file = result?.files?.[0];
        if (!file) {
          return { content: [{ type: 'text', text: errorText(`Attachment ${file_id} not found on issue ${issue_id}`) }], isError: true };
        }
        const base64 = typeof file.content === 'string' ? file.content : '';
        if (!base64) {
          return { content: [{ type: 'text', text: errorText(`Attachment ${file_id} returned no content`) }], isError: true };
        }
        const contentType = typeof file.content_type === 'string' ? file.content_type : 'application/octet-stream';
        const mimeType = contentType.split(';')[0]!.trim().toLowerCase();
        const meta = {
          id: Number(file.id ?? file_id),
          issue_id,
          filename: String(file.filename ?? `attachment-${file_id}`),
          size: Number(file.size ?? 0),
          content_type: contentType,
        };

        if (save_dir) {
          const target = resolve(save_dir);
          const denied = { content: [{ type: 'text' as const, text: errorText('save_dir is not allowed — access restricted to the designated download directory') }], isError: true };
          if (downloadRoot && target !== downloadRoot && !target.startsWith(downloadRoot + sep)) return denied;
          await mkdir(target, { recursive: true });
          if (downloadRoot) {
            // As for uploads (#8618): a link inside the directory must not lead the write outside.
            const [realTarget, realRoot] = await Promise.all([realpath(target), realpath(downloadRoot)]);
            if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) return denied;
          }
          const savedPath = await writeUnique(target, meta.filename, file_id, Buffer.from(base64, 'base64'));
          return {
            content: [{ type: 'text', text: JSON.stringify({ ...meta, saved_path: savedPath }, null, 2) }],
          };
        }

        if (mimeType.startsWith('image/')) {
          return {
            content: [
              { type: 'image', data: base64, mimeType },
              { type: 'text', text: JSON.stringify(meta, null, 2) },
            ],
          };
        }
        return {
          content: [
            { type: 'text', text: JSON.stringify(meta, null, 2) },
            { type: 'text', text: `base64:${base64}` },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: errorText(msg) }], isError: true };
      }
    }
  );
}

/**
 * Writes data into dir under the attachment's file name, never overwriting:
 * "name.ext" becomes "name (1).ext" and so on. Directory parts in the name
 * (also Windows backslashes) are stripped, so the file always lands in dir.
 */
async function writeUnique(dir: string, filename: string, fileId: number, data: Buffer): Promise<string> {
  const safeName = basename(filename.replace(/\\/g, '/')).replace(/^\.+$/, '') || `attachment-${fileId}`;
  const ext = extname(safeName);
  const stem = safeName.slice(0, safeName.length - ext.length);
  for (let n = 0; n < 1000; n++) {
    const path = resolve(dir, n === 0 ? safeName : `${stem} (${n})${ext}`);
    try {
      await writeFile(path, data, { flag: 'wx' });
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`Could not find a free file name for "${safeName}" in ${dir}`);
}
