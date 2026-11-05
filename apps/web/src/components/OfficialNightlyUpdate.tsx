import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { PullRequestGlyph } from "./pullRequest/pullRequestIcons";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type OfficialNightlyState,
  type OfficialNightlyMerge,
  type OfficialNightlyMergeReview,
  type DesktopUpdateState,
} from "@t3tools/contracts";
import { useEnvironmentScope } from "../state/session";
import { useDesktopUpdateState } from "../state/desktopUpdate";
import { readPrimaryEnvironmentTarget } from "../environments/primary/target";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useProjects, useThreadShells } from "../state/entities";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { threadEnvironment } from "../state/threads";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../state/server";
import { resolveProjectDefaultProviderModelSelection } from "../providerInstances";
import { buildThreadRouteParams } from "../threadRoutes";
import { newMessageId, newThreadId } from "../lib/utils";
import { getDesktopUpdateActionError } from "./desktopUpdate.logic";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
} from "./ui/dialog";
import { Select, SelectPopup, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { toastManager } from "./ui/toast";
import {
  officialNightlyMergePrompt,
  officialNightlyReleaseApproval,
} from "./officialNightlyMergePrompt";

export function OfficialNightlyUpdate({ settings = false }: { readonly settings?: boolean }) {
  const state = useDesktopUpdateState();
  const source = state?.officialNightly;
  return source && state ? (
    <OfficialNightlyUpdateContent
      key={source.tag}
      source={source}
      settings={settings}
      update={state}
    />
  ) : null;
}

function OfficialNightlyUpdateContent({
  source,
  settings,
  update,
}: {
  readonly source: OfficialNightlyState;
  readonly settings: boolean;
  readonly update: DesktopUpdateState;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const primary = usePrimaryEnvironmentId();
  const local = readPrimaryEnvironmentTarget()?.source === "desktop-managed";
  const projects = useProjects().filter(
    (p) => local && p.environmentId === primary && !p.isScratch,
  );
  const threads = useThreadShells();
  const [projectId, setProjectId] = useState<string | null>(null);
  const project =
    projects.find((p) => p.id === projectId) ??
    projects.find((p) => /(?:^|\/)t3code$/.test(p.workspaceRoot)) ??
    projects.find(
      (p) =>
        p.repositoryIdentity?.name === "t3code" &&
        p.workspaceRoot === p.repositoryIdentity.rootPath,
    );
  const navigate = useNavigate();
  const start = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const available = source.status === "available";
  const canOperate = useEnvironmentScope(primary, AuthOrchestrationOperateScope);
  const [session, setSession] = useState<OfficialNightlyMerge | null>(null);
  const [review, setReview] = useState<OfficialNightlyMergeReview | null>(null);
  const [loaded, setLoaded] = useState(false);
  const existing =
    session &&
    threads.find((t) => t.environmentId === session.environmentId && t.id === session.threadId);
  const completed = existing?.latestRun?.status === "completed";
  const hasActiveWork = threads.some(
    (thread) =>
      thread.environmentId === primary &&
      thread.latestRun !== null &&
      ["preparing", "queued", "starting", "running", "waiting"].includes(thread.latestRun.status),
  );
  const approved = session?.approvedCommit !== null && session?.approvedCommit !== undefined;
  const goToThread = (merge: OfficialNightlyMerge) =>
    navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(merge.environmentId, merge.threadId)),
    });
  const run = async (action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setReview(null);
      setError(
        cause instanceof Error
          ? cause.message
          : "The update action failed. Try again or inspect the merge thread.",
      );
    }
    pending.current = false;
    setBusy(false);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reloads the durable desktop merge session when its dialog opens
  useEffect(() => {
    if (!open || !source.tag || !window.desktopBridge?.officialNightlyMerge) return;
    let active = true;
    void window.desktopBridge.officialNightlyMerge.get(source.tag).then(
      (value) => {
        if (active) {
          setSession(value);
          setLoaded(true);
        }
      },
      (cause: unknown) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : "Could not load the saved merge.");
          setLoaded(false);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [open, source.tag]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- announces a newly detected external release once per browser profile
  useEffect(() => {
    if (settings || !available || !source.tag) return;
    const key = `signal-crew:announced-nightly:${source.tag}`;
    try {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, "1");
    } catch {}
    toastManager.add({
      type: "info",
      title: "Official T3 Code nightly available",
      description: source.tag,
      timeout: 0,
      actionProps: { children: "Review update", onClick: () => setOpen(true) },
    });
  }, [available, settings, source.tag]);

  const approve = () =>
    run(async () => {
      const bridge = window.desktopBridge;
      if (!bridge || !session || !existing?.worktreePath || !completed || !review || !canOperate)
        return;
      const authorized = await bridge.officialNightlyMerge.approve(
        session.tag,
        existing.worktreePath,
        review.preparedCommit,
        review.version,
      );
      setSession(authorized);
      const result = await start({
        environmentId: authorized.environmentId,
        input: {
          threadId: authorized.threadId,
          message: {
            messageId: authorized.approvalMessageId,
            role: "user",
            text: officialNightlyReleaseApproval(
              authorized.tag,
              authorized.upstreamCommit,
              review.preparedCommit,
              review.version,
            ),
            attachments: [],
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          createdAt: new Date().toISOString(),
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      await goToThread(authorized);
      setOpen(false);
    });

  const inspect = () =>
    run(async () => {
      if (!session || !existing?.worktreePath || !window.desktopBridge) return;
      setReview(null);
      setReview(
        await window.desktopBridge.officialNightlyMerge.review(session.tag, existing.worktreePath),
      );
    });

  const prepare = () =>
    run(async () => {
      const bridge = window.desktopBridge;
      if (!bridge || !loaded || !primary || !source.tag || !source.commit || !canOperate) return;
      if (session && existing) {
        await goToThread(session);
        setOpen(false);
        return;
      }
      if (!available || !project) return;
      const config = appAtomRegistry.get(environmentServerConfigsAtom).get(project.environmentId);
      const selection =
        project.defaultModelSelection ??
        (config &&
          resolveProjectDefaultProviderModelSelection(
            config.providers,
            config.settings,
            project.id,
          ));
      if (!selection)
        throw new Error(
          "Configure a provider and model for this project before starting the merge agent.",
        );
      const merge =
        session ??
        (await bridge.officialNightlyMerge.begin({
          tag: source.tag,
          upstreamCommit: source.commit,
          sourceDirectory: project.workspaceRoot,
          environmentId: project.environmentId,
          projectId: project.id,
          threadId: newThreadId(),
          messageId: newMessageId(),
          approvalMessageId: newMessageId(),
        }));
      setSession(merge);
      if (merge.environmentId !== primary)
        throw new Error("Open the local environment that owns this saved merge.");
      const title = `Merge official nightly ${merge.tag}`;
      const createdAt = new Date().toISOString();
      const result = await start({
        environmentId: merge.environmentId,
        input: {
          threadId: merge.threadId,
          message: {
            messageId: merge.messageId,
            role: "user",
            text: officialNightlyMergePrompt(merge.tag, merge.upstreamCommit),
            attachments: [],
          },
          modelSelection: selection,
          titleSeed: title,
          runtimeMode: "approval-required",
          interactionMode: "default",
          createdAt,
          bootstrap: {
            createThread: {
              projectId: merge.projectId,
              title,
              modelSelection: selection,
              runtimeMode: "approval-required",
              interactionMode: "default",
              branch: "feat/signal-crew-office",
              worktreePath: null,
              createdAt,
            },
            prepareWorktree: {
              projectCwd: merge.sourceDirectory,
              baseBranch: "fork/feat/signal-crew-office",
              requireWorktree: true,
            },
            runSetupScript: true,
          },
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      await goToThread(merge);
      setOpen(false);
    });
  return (
    <>
      <div>
        <Button
          variant={settings ? "outline" : "ghost"}
          size={settings ? "sm" : "icon"}
          aria-label="Official T3 Code nightly updates"
          onClick={() => {
            setReview(null);
            setOpen(true);
          }}
        >
          <PullRequestGlyph.merged />
          {settings ? (
            "Official T3 Code nightlies"
          ) : available ? (
            <span aria-label="New official nightly">●</span>
          ) : null}
        </Button>
      </div>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          setReview(null);
          setOpen(value);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Official T3 Code nightly</DialogTitle>
            <DialogDescription>
              {source.status === "error"
                ? source.message
                : available
                  ? `${source.tag} is ready to merge with Signal Crew.`
                  : `Signal Crew already includes ${source.integratedTag}.`}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <p className="text-sm">
              An agent will prepare the merge in a separate worktree, resolve conflicts, and run
              checks. It will return here for your approval before merging or publishing. The signed
              Signal Crew build will then be offered for installation.
            </p>
            {source.releaseUrl && (
              <a
                href={source.releaseUrl}
                target="_blank"
                rel="noreferrer"
                className="text-sm underline"
              >
                View the official nightly
              </a>
            )}
            {available && !session && (
              <Select value={project?.id ?? null} onValueChange={(value) => setProjectId(value)}>
                <SelectTrigger aria-label="Signal Crew source project">
                  <SelectValue>{project?.title ?? "Choose the T3 Code source project"}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.title} · {p.workspaceRoot}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            )}
            <p className="text-xs text-muted-foreground">
              Source: pingdotgg/t3code · Nightly. Agent work uses your configured provider
              subscription. Your Office and existing app data are preserved.
            </p>
            {existing && (
              <p className="text-sm">
                {approved
                  ? "Merge and build approved. Follow the agent thread for signing and release progress."
                  : completed
                    ? "The preparation turn finished. Inspect its report and review the changes before approving."
                    : existing.latestRun &&
                        ["failed", "cancelled", "interrupted"].includes(existing.latestRun.status)
                      ? "Preparation stopped. Open the saved agent thread to resolve the issue and retry."
                      : "The merge agent is preparing this update. Open the thread to follow progress or respond to requests."}
              </p>
            )}
            {session && completed && (
              <Button variant="outline" disabled={busy} onClick={() => void inspect()}>
                Inspect prepared merge
              </Button>
            )}
            {review && (
              <div className="space-y-2 text-sm">
                <p>{review.summary}</p>
                <p>
                  Reviewed commit: <code>{review.preparedCommit}</code>
                </p>
                <p>Signal Crew build: {review.version}</p>
                <p>
                  Checks passed. Approval applies only to this clean commit. Restart remains a
                  separate approval.
                </p>
              </div>
            )}
            {approved && update.availableVersion === session?.approvedVersion && (
              <p className="text-sm">
                Signal Crew {update.availableVersion} is available in the app updater. Use Download
                update, then Restart and install.
              </p>
            )}
            {update.status === "downloaded" && hasActiveWork && (
              <p role="status" className="text-sm">
                Wait for running work to finish before restarting.
              </p>
            )}
            {!local && (
              <p role="alert" className="text-sm">
                Open this desktop’s local environment to prepare a Signal Crew update.
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Later
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await window.desktopBridge?.checkForUpdate();
                })
              }
            >
              {approved ? "Check for installer" : "Check again"}
            </Button>
            {review && completed && (
              <Button disabled={busy || !canOperate} onClick={() => void approve()}>
                Approve merge and build
              </Button>
            )}
            {session?.approvedVersion &&
              update.availableVersion === session.approvedVersion &&
              update.status === "available" && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const result = await window.desktopBridge?.downloadUpdate();
                      const failure = result && getDesktopUpdateActionError(result);
                      if (failure) throw new Error(failure);
                    })
                  }
                >
                  Download update
                </Button>
              )}
            {session?.approvedVersion &&
              update.downloadedVersion === session.approvedVersion &&
              update.status === "downloaded" && (
                <Button
                  disabled={busy || hasActiveWork}
                  onClick={() =>
                    void run(async () => {
                      if (hasActiveWork)
                        throw new Error("Wait for running work to finish before restarting.");
                      const result = await window.desktopBridge?.installUpdate(
                        session.approvedVersion ?? undefined,
                      );
                      const failure = result && getDesktopUpdateActionError(result);
                      if (failure) throw new Error(failure);
                    })
                  }
                >
                  Restart and install
                </Button>
              )}
            {(available || session) && (
              <Button
                disabled={!loaded || !canOperate || (!session && !project) || busy}
                onClick={() => void prepare()}
              >
                {busy
                  ? "Working…"
                  : existing
                    ? "Open merge agent"
                    : session
                      ? "Retry starting agent"
                      : "Start merge agent"}
              </Button>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
