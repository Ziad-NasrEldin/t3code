import type { TimelineEntry } from "../../session-logic";
import type { ChatMessage } from "../../types";

function humanAuthored(message: ChatMessage): boolean {
  if (
    message.role !== "user" ||
    message.senderThreadId !== undefined ||
    message.scheduledTaskId !== undefined ||
    message.idleCompaction !== undefined ||
    message.context?.guest !== undefined
  )
    return false;
  if (message.createdBy !== undefined) return message.createdBy === "user";
  // Legacy user messages had no provenance. Retain them unless an available source
  // explicitly identifies automation. Text, command names and attachments are not authorship.
  return (
    message.creationSource === undefined ||
    message.creationSource === "web" ||
    message.creationSource === "mobile"
  );
}
export function cleanTranscript(
  entries: ReadonlyArray<TimelineEntry>,
): ReadonlyArray<TimelineEntry> {
  return entries.filter(
    (entry) =>
      entry.kind === "message" &&
      (humanAuthored(entry.message) ||
        (entry.message.role === "assistant" &&
          entry.message.responseKind === "final" &&
          !entry.message.streaming &&
          (entry.message.text.length > 0 || (entry.message.attachments?.length ?? 0) > 0))),
  );
}
export function hasUnknownResponseKind(entries: ReadonlyArray<TimelineEntry>): boolean {
  return entries.some(
    (entry) =>
      entry.kind === "message" &&
      entry.message.role === "assistant" &&
      entry.message.responseKind === undefined,
  );
}
