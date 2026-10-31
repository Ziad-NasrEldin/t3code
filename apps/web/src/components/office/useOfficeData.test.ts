import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vite-plus/test";
import { makeMethods } from "@effect/vitest";
import { EnvironmentId, NodeId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { makeThreadFixture } from "../../test-fixtures";
import { useOfficeData } from "./useOfficeData";

const it = makeMethods(test);

type Inventory = {
  threads: Array<ReturnType<typeof makeThreadFixture>["source"]>;
  children: Array<import("@t3tools/contracts").OrchestrationV2OfficeChild>;
};
type Query = Atom.Writable<AsyncResult.AsyncResult<Inventory, unknown>>;
type Target = { environmentId: EnvironmentId; input: { generation: number } };
const h = vi.hoisted(() => ({
  registry: null! as AtomRegistry.AtomRegistry,
  queries: new Map<string, Query>(),
  generations: new Map<EnvironmentId, Atom.Writable<{ generation: number }>>(),
  query: null! as Query,
  target: null! as Target,
  onAnswer: undefined as
    | undefined
    | ((
        target: Target,
        value: Inventory,
        registry: AtomRegistry.AtomRegistry,
      ) => Effect.Effect<void>),
  shellStatus: "live",
  phase: "connected",
}));
vi.mock(import("../../connection/runtime"), () => ({ connectionAtomRuntime: null! }));
vi.mock(import("@effect/atom-react"), () => ({
  useAtomValue: (atom: Atom.Atom<unknown>) => h.registry.get(atom),
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  createEnvironmentQueryAtomFamily: (
    _runtime: unknown,
    options: { onAnswer?: typeof h.onAnswer },
  ) => {
    h.onAnswer = options.onAnswer;
    return (target: typeof h.target) => {
      h.target = target;
      const key = JSON.stringify(target);
      let query = h.queries.get(key);
      if (!query) {
        query = Atom.make<AsyncResult.AsyncResult<Inventory, unknown>>(AsyncResult.initial(true));
        h.queries.set(key, query);
      }
      h.query = query;
      return query;
    };
  },
}));
vi.mock("../../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: Atom.Atom<unknown>) => h.registry.get(atom),
    set: (atom: Atom.Writable<unknown>, value: unknown) => h.registry.set(atom, value),
    refresh: (atom: Atom.Atom<unknown>) => h.registry.refresh(atom),
  },
}));
vi.mock("../../state/shell", () => ({
  environmentShell: {
    stateValueAtom: (id: EnvironmentId) => {
      let atom = h.generations.get(id);
      if (!atom) {
        atom = Atom.make({ generation: 1 }).pipe(Atom.keepAlive);
        h.generations.set(id, atom);
      }
      return atom;
    },
  },
  useEnvironmentShellStatus: () => h.shellStatus,
}));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({ connection: { phase: h.phase } }),
}));
vi.mock(import("../../state/entities"), () => ({ useQuietThreadShells: () => [] }));

function OfficeDataProbe({ id, active }: { id: EnvironmentId; active: boolean }) {
  const view = useOfficeData(id, true, active);
  return createElement("script", {
    type: "application/json",
    dangerouslySetInnerHTML: { __html: JSON.stringify(view) },
  });
}

function setup() {
  h.registry = AtomRegistry.make();
  h.queries.clear();
  h.generations.clear();
  h.shellStatus = "live";
  h.phase = "connected";
  let mount = 0;
  const read = (id = EnvironmentId.make("office-a"), active = true) => {
    const html = renderToStaticMarkup(createElement(OfficeDataProbe, { id, active }), {
      identifierPrefix: String(mount++),
    });
    return JSON.parse(html.slice(html.indexOf(">") + 1, html.lastIndexOf("</script>"))) as Pick<
      ReturnType<typeof useOfficeData>,
      "actors" | "children" | "online" | "ready" | "failed"
    >;
  };
  const answer = (value: Inventory) =>
    Effect.gen(function* () {
      h.registry.set(h.query, AsyncResult.success(value));
      if (h.onAnswer) yield* h.onAnswer(h.target, value, h.registry);
    });
  const parent = makeThreadFixture().source;
  const value: Inventory = {
    threads: [parent],
    children: [
      {
        id: NodeId.make("retained-native"),
        threadId: parent.id,
        childThreadId: null,
        origin: "provider_native",
        status: "completed",
        title: "Retained child",
        result: "Done",
      },
    ],
  };
  return { read, answer, value, [Symbol.dispose]: () => h.registry.dispose() };
}

it.effect(
  "retains authoritative children and online state across selection, dialog activation and inventory refresh",
  () =>
    Effect.gen(function* () {
      using test = setup();
      test.read();
      expect(test.read().online).toBe(true);
      expect(test.read().ready).toBe(false);
      yield* test.answer(test.value);
      expect(test.read().actors).toHaveLength(2);
      expect(test.read().ready).toBe(true);
      expect(test.read(undefined, false).children).toEqual(test.value.children);
      expect(test.read().online).toBe(true);
      expect(test.read().ready).toBe(true);
      h.registry.set(h.query, AsyncResult.initial(true));
      expect(test.read().children).toEqual(test.value.children);
      expect(test.read().online).toBe(true);
      expect(test.read().ready).toBe(true);
      h.shellStatus = "synchronizing";
      expect(test.read().online).toBe(true);
      expect(test.read().ready).toBe(false);
      h.shellStatus = "live";
      h.registry.set(h.query, AsyncResult.failure(Cause.fail(new Error("inventory failed"))));
      expect(test.read().children).toEqual(test.value.children);
      expect(test.read().online).toBe(true);
      expect(test.read().failed).toBe(true);
      expect(test.read().ready).toBe(false);
      h.phase = "reconnecting";
      expect(test.read().online).toBe(false);
      expect(test.read().actors.every((actor) => actor.status === "offline")).toBe(true);
    }),
);

it.effect(
  "keeps cached inventories environment scoped and replaces them only with an authoritative answer",
  () =>
    Effect.gen(function* () {
      using test = setup();
      const id = EnvironmentId.make("office-a");
      test.read(id);
      yield* test.answer(test.value);
      const previousTarget = h.target;
      h.registry.set(h.generations.get(id)!, { generation: 2 });
      expect(test.read(id).children).toEqual(test.value.children);
      expect(test.read(id).ready).toBe(false);
      if (h.onAnswer) yield* h.onAnswer(previousTarget, { threads: [], children: [] }, h.registry);
      expect(test.read(id).children).toEqual(test.value.children);
      expect(test.read(EnvironmentId.make("office-b")).children).toEqual([]);
      test.read(id);
      yield* test.answer({ threads: [], children: [] });
      expect(test.read(id).actors).toEqual([]);
      expect(test.read(id).ready).toBe(true);
      if (h.onAnswer) yield* h.onAnswer(previousTarget, test.value, h.registry);
      expect(test.read(id).actors).toEqual([]);
    }),
);
