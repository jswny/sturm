import type { WorkspaceFsLike } from "@cloudflare/shell";
import { tool } from "ai";
import { z } from "zod";
import {
  getBasename,
  sanitizeArtifactFilename,
  storeResponseArtifact,
  type ArtifactEnv,
  type ResponseArtifact,
  type WorkspaceExportArtifactMetadata
} from "../artifacts";
import { logError, logWarn } from "../logging";

const WORKSPACE_EXPORT_KEY_PREFIX = "files/workspace";
const DEFAULT_WORKSPACE_EXPORT_MIME_TYPE = "application/octet-stream";
const MAX_WORKSPACE_EXPORT_BYTES = 20 * 1024 * 1024;
const MAX_WORKSPACE_EXPORT_MIB = MAX_WORKSPACE_EXPORT_BYTES / (1024 * 1024);

export type WorkspaceArtifactOptions = {
  onArtifactCreated?: (artifact: ResponseArtifact) => void | Promise<void>;
};

export type ExportWorkspaceFileResponse = {
  artifactId?: string;
  path: string;
  filename?: string;
  mimeType?: string;
  sha256?: string;
  error?: string;
};

const exportWorkspaceFileResponseSchema = z.object({
  artifactId: z.string().optional().describe("Exported artifact ID"),
  path: z.string().describe("Workspace path that was exported"),
  filename: z.string().optional().describe("Attachment filename"),
  mimeType: z.string().optional().describe("Attachment MIME type"),
  sha256: z.string().optional().describe("Exported file SHA-256 hash"),
  error: z.string().optional().describe("Error message when export failed")
});

export function createArtifactTools(
  env: ArtifactEnv,
  workspace: WorkspaceFsLike | undefined,
  options: WorkspaceArtifactOptions = {}
) {
  return {
    exportWorkspaceFile: tool({
      description: `Attach a file from the persistent channel workspace to the Discord response. Use after creating or updating a workspace file when the user should receive it as a downloadable attachment. Sturm automatically attaches successful exports to the final Discord/debug response, so the final chat response should mention the attachment briefly without pasting raw file data, artifact IDs, storage keys, hashes, or workspace internals unless the user explicitly asks for diagnostic details. If later code needs the exported artifact details, keep or return the structured tool result. Files larger than ${MAX_WORKSPACE_EXPORT_MIB} MiB cannot be attached.`,
      inputSchema: z.object({
        path: z
          .string()
          .min(1)
          .describe("Path to the workspace file to attach"),
        filename: z
          .string()
          .min(1)
          .optional()
          .describe("Optional attachment filename. Defaults to the file name."),
        description: z
          .string()
          .min(1)
          .optional()
          .describe("Short attachment description for Discord")
      }),
      outputSchema: exportWorkspaceFileResponseSchema,
      execute: ({ path, filename, description }) =>
        exportWorkspaceFile(env, workspace, options, {
          path,
          filename,
          description
        })
    })
  };
}

async function exportWorkspaceFile(
  env: ArtifactEnv,
  workspace: WorkspaceFsLike | undefined,
  options: WorkspaceArtifactOptions,
  input: {
    path: string;
    filename?: string;
    description?: string;
  }
): Promise<ExportWorkspaceFileResponse> {
  const path = normalizeWorkspacePath(input.path);
  if (!workspace) {
    return {
      path,
      error: "Workspace export is not available in this turn."
    };
  }

  const stat = await workspace.stat(path);
  if (!stat) {
    return {
      path,
      error: "Workspace file was not found."
    };
  }

  if (stat.type !== "file") {
    return {
      path,
      error: "Workspace path is not a file."
    };
  }

  if (stat.size > MAX_WORKSPACE_EXPORT_BYTES) {
    return {
      path,
      filename: stat.name,
      mimeType: stat.mimeType,
      error: "Workspace file is too large to attach."
    };
  }

  const bytes = await workspace.readFileBytes(path);
  if (!bytes) {
    logWarn("Workspace export read returned no bytes", {
      path,
      sizeBytes: stat.size
    });
    return {
      path,
      error: "Workspace file could not be read."
    };
  }

  const attachmentFilename = sanitizeArtifactFilename(
    input.filename ?? getBasename(path) ?? stat.name,
    stat.name || "workspace-file.bin"
  );
  const mimeType =
    stat.mimeType ||
    inferMimeType(attachmentFilename) ||
    DEFAULT_WORKSPACE_EXPORT_MIME_TYPE;

  try {
    const artifact = await storeResponseArtifact(env, {
      source: "workspace_export",
      filename: attachmentFilename,
      mimeType,
      keyPrefix: WORKSPACE_EXPORT_KEY_PREFIX,
      bytes,
      description: input.description ?? `Exported workspace file: ${path}`,
      metadata: {
        workspacePath: path
      } satisfies WorkspaceExportArtifactMetadata
    });

    await options.onArtifactCreated?.(artifact);

    return {
      artifactId: artifact.id,
      path,
      filename: artifact.filename,
      mimeType: artifact.mimeType,
      sha256: artifact.sha256
    };
  } catch (error) {
    logError("Workspace artifact export failed", error, {
      path,
      filename: attachmentFilename,
      mimeType,
      sizeBytes: bytes.byteLength
    });
    return {
      path,
      filename: attachmentFilename,
      mimeType,
      error: "Workspace file could not be stored as a response artifact."
    };
  }
}

function normalizeWorkspacePath(path: string) {
  const trimmed = path.trim();
  const absolute = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return absolute.replace(/\/+/g, "/");
}

function inferMimeType(filename: string) {
  const extension = filename.toLowerCase().split(".").at(-1);
  switch (extension) {
    case "css":
      return "text/css";
    case "csv":
      return "text/csv";
    case "html":
    case "htm":
      return "text/html";
    case "json":
      return "application/json";
    case "md":
      return "text/markdown";
    case "pdf":
      return "application/pdf";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "svg":
      return "image/svg+xml";
    case "txt":
      return "text/plain";
    case "xml":
      return "application/xml";
    case "zip":
      return "application/zip";
    default:
      return undefined;
  }
}
