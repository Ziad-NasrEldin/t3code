import {
  DesktopUpdateActionResultSchema,
  DesktopUpdateChannelSchema,
  DesktopUpdateCheckResultSchema,
  DesktopUpdateStateSchema,
  OfficialNightlyMergeSchema,
  OfficialNightlyMergeBeginSchema,
  OfficialNightlyMergeReviewSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopUpdates from "../../updates/DesktopUpdates.ts";
import * as NightlyMerge from "../../updates/NightlyMerge.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getUpdateState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateStateSchema,
  handler: Effect.fn("desktop.ipc.updates.getState")(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.getState;
  }),
});

export const setUpdateChannel = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_SET_CHANNEL_CHANNEL,
  payload: Schema.Struct({
    channel: DesktopUpdateChannelSchema,
    minimumVersion: Schema.optional(Schema.String),
  }),
  result: DesktopUpdateStateSchema,
  handler: Effect.fn("desktop.ipc.updates.setChannel")(function* ({ channel, minimumVersion }) {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.setChannel(channel, { minimumVersion });
  }),
});

export const downloadUpdate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_DOWNLOAD_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateActionResultSchema,
  handler: Effect.fn("desktop.ipc.updates.download")(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.download;
  }),
});

export const installUpdate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_INSTALL_CHANNEL,
  /** A version installs only that downloaded build, never one that replaced it. */
  payload: Schema.UndefinedOr(Schema.String),
  result: DesktopUpdateActionResultSchema,
  handler: Effect.fn("desktop.ipc.updates.install")(function* (expectedVersion) {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    if (expectedVersion === undefined) return yield* updates.install;
    const { accepted, completed, state } = yield* updates.installPrepared(expectedVersion);
    return { accepted, completed, state };
  }),
});

export const checkForUpdate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UPDATE_CHECK_CHANNEL,
  payload: Schema.Void,
  result: DesktopUpdateCheckResultSchema,
  handler: Effect.fn("desktop.ipc.updates.check")(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    return yield* updates.check("manual");
  }),
});

export const getNightlyMerge = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.NIGHTLY_MERGE_GET_CHANNEL,
  payload: Schema.String,
  result: Schema.NullOr(OfficialNightlyMergeSchema),
  handler: Effect.fn("desktop.ipc.updates.getNightlyMerge")(function* (tag) {
    return yield* (yield* NightlyMerge.NightlyMerge).get(tag);
  }),
});
export const beginNightlyMerge = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.NIGHTLY_MERGE_BEGIN_CHANNEL,
  payload: OfficialNightlyMergeBeginSchema,
  result: OfficialNightlyMergeSchema,
  handler: Effect.fn("desktop.ipc.updates.beginNightlyMerge")(function* (input) {
    return yield* (yield* NightlyMerge.NightlyMerge).begin(input);
  }),
});
export const reviewNightlyMerge = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.NIGHTLY_MERGE_REVIEW_CHANNEL,
  payload: Schema.Struct({ tag: Schema.String, worktreePath: Schema.String }),
  result: OfficialNightlyMergeReviewSchema,
  handler: Effect.fn("desktop.ipc.updates.reviewNightlyMerge")(function* ({ tag, worktreePath }) {
    return yield* (yield* NightlyMerge.NightlyMerge).review(tag, worktreePath);
  }),
});
export const approveNightlyMerge = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.NIGHTLY_MERGE_APPROVE_CHANNEL,
  payload: Schema.Struct({
    tag: Schema.String,
    worktreePath: Schema.String,
    preparedCommit: Schema.String,
    version: Schema.String,
  }),
  result: OfficialNightlyMergeSchema,
  handler: Effect.fn("desktop.ipc.updates.approveNightlyMerge")(function* ({
    tag,
    worktreePath,
    preparedCommit,
    version,
  }) {
    return yield* (yield* NightlyMerge.NightlyMerge).approve(
      tag,
      worktreePath,
      preparedCommit,
      version,
    );
  }),
});
