// @effect-diagnostics-next-line nodeBuiltinImport:off - Attachment paths are captured without a new runtime service requirement.
import * as NodePath from "node:path";
import {
  ChatAttachment,
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ThreadId,
} from "@t3tools/contracts";
import {
  chatAttachmentStableKey,
  createDeterministicAttachmentId,
} from "@t3tools/shared/attachmentIdentity";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";

const decodeAttachment = Schema.decodeOption(ChatAttachment);
const encodeIdentity = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

export const captureOutputAttachment = Effect.fn("OpenCode.captureOutputAttachment")(function* (
  host: ProviderHost.ProviderHost["Service"],
  threadId: ThreadId,
  part: {
    readonly id: string;
    readonly messageID: string;
    readonly mime: string;
    readonly filename?: string;
    readonly url: string;
  },
) {
  const name =
    NodePath.basename(part.filename ?? "attachment")
      .replace(/[\x00-\x1f]/g, "_")
      .slice(0, 255) || "attachment";
  const unavailable = {
    text: `[Attachment unavailable: ${name}]`,
    attachments: [] as ChatAttachment[],
  };
  const match = /^data:([^;,]+);base64,/.exec(part.url);
  const mimeType = part.mime.toLowerCase();
  const image = isProviderSendTurnSupportedImageMimeType(mimeType);
  const limit = image ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
  if (
    !match ||
    match[1]!.toLowerCase() !== mimeType ||
    part.url.length - match[0].length > Math.ceil(limit / 3) * 4
  )
    return unavailable;
  const encoded = part.url.slice(match[0].length);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return unavailable;
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > limit || bytes.toString("base64") !== encoded)
    return unavailable;
  const baseId = createDeterministicAttachmentId(
    threadId,
    chatAttachmentStableKey(encodeIdentity([part.messageID, part.id, mimeType, name]), 0, bytes),
  );
  if (!baseId) return unavailable;
  const extension = NodePath.extname(name).toLowerCase();
  const suffix =
    extension !== ".part" && /^\.[a-z0-9]{1,10}$/.test(extension) ? extension.slice(1) : "bin";
  const id = image ? baseId : `${baseId}-${suffix}`;
  const decoded = decodeAttachment({
    type: image ? "image" : "file",
    id,
    name,
    mimeType,
    sizeBytes: bytes.length,
  });
  const fs = yield* Effect.serviceOption(FileSystem.FileSystem);
  if (Option.isNone(decoded) || Option.isNone(fs)) return unavailable;
  const attachment = decoded.value;
  const destination = host.resolveAttachmentPath(attachment);
  if (!destination) return unavailable;
  const stored = yield* Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* fs.value.makeTempDirectoryScoped({
        directory: NodePath.dirname(destination),
        prefix: ".opencode-output-",
      });
      const temporary = NodePath.join(directory, "content");
      const file = yield* fs.value.open(temporary, { flag: "wx", mode: 0o600 });
      yield* file.writeAll(bytes);
      yield* file.sync;
      return yield* fs.value.link(temporary, destination).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => error.reason._tag === "AlreadyExists",
          () =>
            Effect.gen(function* () {
              const existing = yield* fs.value.open(destination, { noFollow: true });
              const stat = yield* existing.stat;
              if (stat.type !== "File" || Number(stat.size) !== bytes.length) return false;
              const content = new Uint8Array(bytes.length);
              let offset = 0;
              while (offset < content.length) {
                const read = yield* existing.read(content.subarray(offset));
                if (read === 0) return false;
                offset += read;
              }
              return Buffer.from(content).equals(bytes);
            }),
        ),
      );
    }),
  ).pipe(Effect.orElseSucceed(() => false));
  return stored ? { text: "", attachments: [attachment] } : unavailable;
});

export const captureToolOutputAttachments = Effect.fn("OpenCode.captureToolOutputAttachments")(
  function* (
    host: ProviderHost.ProviderHost["Service"],
    threadId: ThreadId,
    toolId: string,
    files: ReadonlyArray<{
      readonly url: string;
      readonly mime: string;
      readonly filename?: string;
    }>,
  ) {
    const outputAttachments: ChatAttachment[] = [];
    const outputAttachmentErrors: string[] = [];
    for (const [index, file] of files.slice(0, 8).entries()) {
      const result = yield* captureOutputAttachment(host, threadId, {
        ...file,
        messageID: toolId,
        id: `${toolId}:file:${index}`,
      });
      outputAttachments.push(...result.attachments);
      if (result.text) outputAttachmentErrors.push(result.text);
    }
    if (files.length > 8)
      outputAttachmentErrors.push(
        `${files.length - 8} additional tool files are unavailable (limit: 8 per result).`,
      );
    return {
      ...(outputAttachments.length ? { outputAttachments } : {}),
      ...(outputAttachmentErrors.length
        ? { outputAttachmentErrors: [...new Set(outputAttachmentErrors)] }
        : {}),
    };
  },
);
