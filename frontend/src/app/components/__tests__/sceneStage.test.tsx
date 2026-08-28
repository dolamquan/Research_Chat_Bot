import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import * as THREE from "three";

import legacyScene from "../../../../../backend/tests/fixtures/mechanism/legacy_mechanism_scene.json";
import type { MechanismScene, SceneActor, SceneBeat } from "../../types";
import SceneStage, {
  FORM_UNITS,
  actorStateAt,
  correspondencePairs,
  safeActor,
  slotOffsets,
  unitRowWidth,
  worldAnchor,
  type ActorState,
} from "../SceneStage";
import { spread } from "../visualization/primitives/shared";

/**
 * Renders the legacy-shape fixture (no `values`, no `items`, no `correspond`)
 * in jsdom. This is the regression guard for old stored rows: the scene JSON
 * in `node_expansions.content_json` reaches the renderer with no validation,
 * so a field the renderer assumes but old rows lack white-screens the app.
 * R3F's intrinsic elements (`group`, `mesh`, ...) render as inert unknown
 * tags under jsdom, which is enough to exercise every code path that touches
 * the scene data.
 */

vi.mock("@react-three/drei", () => ({
  Html: ({ children }: { children?: unknown }) => <div>{children as never}</div>,
}));

const scene = legacyScene as unknown as MechanismScene;

describe("SceneStage with a legacy-shape scene", () => {
  it.each([0, 0.1, 0.45, 0.7, 1] as const)(
    "renders without throwing at t=%s",
    (t) => {
      expect(() => render(<SceneStage scene={scene} t={t} />)).not.toThrow();
    },
  );

  it("shows every actor label", () => {
    render(<SceneStage scene={scene} t={0.5} />);
    expect(screen.getByText("Input Tokens")).toBeTruthy();
    expect(screen.getByText("Dense Vectors")).toBeTruthy();
  });

  it("shows the caption of the beat active at t", () => {
    render(<SceneStage scene={scene} t={0.4} />);
    expect(
      screen.getByText(
        "Each token is mapped to a vector using a learned embedding matrix.",
      ),
    ).toBeTruthy();
  });

  it("falls back to the admitted-gap stage when described is false", () => {
    render(
      <SceneStage scene={{ ...scene, described: false }} t={0.5} />,
    );
    expect(screen.getByText(/not described/i)).toBeTruthy();
  });

  it("falls back to the admitted-gap stage when the cast is empty", () => {
    render(<SceneStage scene={{ ...scene, actors: [] }} t={0.5} />);
    expect(screen.queryByText("Input Tokens")).toBeNull();
  });

  it("survives an unknown actor form by rendering the fallback", () => {
    const mutated = {
      ...scene,
      actors: scene.actors.map((actor) => ({
        ...actor,
        form: "definitely_not_a_form",
      })),
    };
    expect(() => render(<SceneStage scene={mutated} t={0.5} />)).not.toThrow();
  });

  it("silently ignores a beat kind it does not know", () => {
    const mutated = {
      ...scene,
      beats: scene.beats.map((beat) => ({
        ...beat,
        kind: "definitely_not_a_kind",
      })),
    };
    expect(() => render(<SceneStage scene={mutated} t={0.5} />)).not.toThrow();
  });

  it("survives actors whose new fields are null (JSON fallback rows)", () => {
    const mutated = {
      ...scene,
      actors: scene.actors.map((actor) => ({
        ...actor,
        items: null as unknown as string[],
        values: null as unknown as number[],
      })),
    };
    expect(() => render(<SceneStage scene={mutated} t={0.5} />)).not.toThrow();
  });
});

// --- the new-shape scene ----------------------------------------------------

function makeActor(overrides: Partial<SceneActor> & { actor_id: string }): SceneActor {
  return {
    label: overrides.actor_id,
    form: "particles",
    tone: "primary",
    count: 3,
    at: "left",
    note: "",
    items: [],
    values: [],
    ...overrides,
  };
}

function makeBeat(overrides: Partial<SceneBeat> & { actor_id: string }): SceneBeat {
  return {
    start: 0.3,
    duration: 0.4,
    kind: "correspond",
    target_id: "",
    to: "same",
    magnitude: 1,
    caption: "",
    weights: [],
    ...overrides,
  };
}

const newShapeScene: MechanismScene = {
  title: "Input Embeddings",
  summary: "Tokens become dense vectors.",
  actors: [
    makeActor({ actor_id: "tokens", items: ["the", "cat", "sat"], at: "left" }),
    makeActor({
      actor_id: "vectors",
      form: "array",
      values: [0.42, -0.13, 0.87],
      at: "right",
    }),
  ],
  beats: [
    makeBeat({ actor_id: "tokens", target_id: "vectors", caption: "mapped" }),
  ],
  evidence: "",
  described: true,
};

describe("SceneStage with a new-shape scene", () => {
  it("renders an array actor with correspond links without throwing", () => {
    expect(() => render(<SceneStage scene={newShapeScene} t={0.6} />)).not.toThrow();
  });

  it("labels particle units from items", () => {
    render(<SceneStage scene={newShapeScene} t={0.6} />);
    expect(screen.getByText("the")).toBeTruthy();
    expect(screen.getByText("cat")).toBeTruthy();
    expect(screen.getByText("sat")).toBeTruthy();
  });
});

// --- pure geometry/state logic ------------------------------------------------

function stateFor(actor: SceneActor, beats: SceneBeat[] = [], t = 0.5): ActorState {
  return actorStateAt(safeActor(actor), beats, new Map(), t);
}

describe("correspondencePairs", () => {
  function pairsFor(source: SceneActor, target: SceneActor, beat?: Partial<SceneBeat>) {
    const actors = new Map([
      [source.actor_id, safeActor(source)],
      [target.actor_id, safeActor(target)],
    ]);
    const states = new Map([
      [source.actor_id, stateFor(source)],
      [target.actor_id, stateFor(target)],
    ]);
    return correspondencePairs(
      makeBeat({ actor_id: source.actor_id, target_id: target.actor_id, ...beat }),
      actors,
      states,
    );
  }

  it("pairs index-aligned over the smaller unit count", () => {
    const pairs = pairsFor(
      makeActor({ actor_id: "s", count: 3 }),
      makeActor({ actor_id: "t", form: "array", values: [0.5, 0.5, 0.5] }),
    );
    expect(pairs).toHaveLength(3);
  });

  it("fans every unit into a singular target", () => {
    const pairs = pairsFor(
      makeActor({ actor_id: "s", count: 5, at: "left" }),
      makeActor({ actor_id: "t", form: "blob", count: 1, at: "right" }),
    );
    expect(pairs).toHaveLength(5);
    // Ends are trimmed back to the blob's silhouette, so each lands within
    // the blob's extent of its centre rather than at one shared point.
    const center = new THREE.Vector3(3.4, 0, 0);
    for (const pair of pairs) {
      expect(pair.to.distanceTo(center)).toBeLessThanOrEqual(0.86);
    }
  });

  it("prunes pairs below the weight threshold", () => {
    const pairs = pairsFor(
      makeActor({ actor_id: "s", count: 3 }),
      makeActor({ actor_id: "t", form: "array", values: [1, 1, 1] }),
      { weights: [0.9, 0.05, 0.9] },
    );
    expect(pairs).toHaveLength(2);
  });

  it("draws nothing when the target has not entered", () => {
    const source = makeActor({ actor_id: "s" });
    const target = makeActor({ actor_id: "t" });
    const actors = new Map([
      ["s", safeActor(source)],
      ["t", safeActor(target)],
    ]);
    // target has an enter beat that has not fired at t=0
    const beats = [makeBeat({ actor_id: "t", kind: "enter", start: 0.5 })];
    const states = new Map([
      ["s", stateFor(source)],
      ["t", actorStateAt(safeActor(target), beats, new Map(), 0)],
    ]);
    expect(
      correspondencePairs(
        makeBeat({ actor_id: "s", target_id: "t" }),
        actors,
        states,
      ),
    ).toHaveLength(0);
  });

  it("caps the pair count", () => {
    const pairs = pairsFor(
      makeActor({ actor_id: "s", count: 28 }),
      makeActor({ actor_id: "t", count: 28 }),
    );
    expect(pairs.length).toBeLessThanOrEqual(12);
  });
});

describe("worldAnchor", () => {
  it("places array unit i at spread(i, n) scaled and offset", () => {
    const actor = safeActor(
      makeActor({ actor_id: "a", form: "array", values: [1, 2, 3, 4] }),
    );
    const state = stateFor(actor);
    state.position = new THREE.Vector3(2, 1, 0);
    state.scale = 2;
    const n = FORM_UNITS.array(actor);
    const anchor = worldAnchor(actor, state, 1, n);
    expect(anchor.x).toBeCloseTo(spread(1, n, unitRowWidth(n)) * 2 + 2);
    expect(anchor.y).toBeCloseTo(1);
  });
});

describe("slotOffsets", () => {
  it("leaves lone actors unoffset", () => {
    const offsets = slotOffsets([
      makeActor({ actor_id: "a", at: "left" }),
      makeActor({ actor_id: "b", at: "right" }),
    ]);
    expect(offsets.size).toBe(0);
  });

  it("fans same-slot actors apart", () => {
    const offsets = slotOffsets([
      makeActor({ actor_id: "a", at: "center" }),
      makeActor({ actor_id: "b", at: "center" }),
      makeActor({ actor_id: "c", at: "left" }),
    ]);
    const a = offsets.get("a");
    const b = offsets.get("b");
    expect(a && b && a.distanceTo(b)).toBeGreaterThan(1.5);
    expect(offsets.has("c")).toBe(false);
  });

  it("lays a piled-up cast out in dataflow order", () => {
    // Everything at center, but the beats say tokens -> vectors -> output:
    // the layout should read left to right in that order.
    const actors = [
      makeActor({ actor_id: "output", at: "center" }),
      makeActor({ actor_id: "tokens", at: "center" }),
      makeActor({ actor_id: "vectors", at: "center" }),
    ];
    const beats = [
      makeBeat({ actor_id: "tokens", target_id: "vectors" }),
      makeBeat({ actor_id: "vectors", target_id: "output" }),
    ];
    const offsets = slotOffsets(actors, beats);
    const x = (id: string) =>
      slotOffsets(actors, beats).get(id)!.x + 0; // offset from center slot (0,0,0)
    expect(offsets.size).toBe(3);
    expect(x("tokens")).toBeLessThan(x("vectors"));
    expect(x("vectors")).toBeLessThan(x("output"));
  });

  it("keeps declared slots when placement is not degenerate", () => {
    const actors = [
      makeActor({ actor_id: "a", at: "left" }),
      makeActor({ actor_id: "b", at: "right" }),
    ];
    const beats = [makeBeat({ actor_id: "a", target_id: "b" })];
    expect(slotOffsets(actors, beats).size).toBe(0);
  });

  it("survives a dataflow cycle", () => {
    const actors = [
      makeActor({ actor_id: "a", at: "center" }),
      makeActor({ actor_id: "b", at: "center" }),
    ];
    const beats = [
      makeBeat({ actor_id: "a", target_id: "b" }),
      makeBeat({ actor_id: "b", target_id: "a" }),
    ];
    const offsets = slotOffsets(actors, beats);
    expect(offsets.size).toBe(2);
    const a = offsets.get("a")!;
    const b = offsets.get("b")!;
    expect(a.distanceTo(b)).toBeGreaterThan(1);
  });

  it("separates geometry in the rendered state", () => {
    const actors = [
      makeActor({ actor_id: "a", at: "center" }),
      makeActor({ actor_id: "b", form: "vessel", at: "center" }),
    ];
    const offsets = slotOffsets(actors);
    const stateA = actorStateAt(safeActor(actors[0]), [], new Map(), 0.5, offsets.get("a"));
    const stateB = actorStateAt(safeActor(actors[1]), [], new Map(), 0.5, offsets.get("b"));
    expect(stateA.position.distanceTo(stateB.position)).toBeGreaterThan(1.5);
  });
});

describe("actorStateAt", () => {
  it("returns the initial state for an unknown beat kind", () => {
    const actor = makeActor({ actor_id: "a" });
    const beats = [makeBeat({ actor_id: "a", kind: "definitely_not_a_kind", start: 0 })];
    const state = actorStateAt(safeActor(actor), beats, new Map(), 0.5);
    expect(state.opacity).toBe(1);
    expect(state.scale).toBe(1);
  });

  it("treats correspond as a no-op on the actor itself", () => {
    const actor = makeActor({ actor_id: "a" });
    const beats = [makeBeat({ actor_id: "a", target_id: "b", start: 0 })];
    const state = actorStateAt(safeActor(actor), beats, new Map(), 0.5);
    expect(state.position.x).toBeCloseTo(-3.4); // still at its slot
  });
});
