import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import graphFixture from "../../../../../backend/tests/fixtures/mechanism/embedding_scene_graph.json";
import type { MechanismGraph, SceneGraphTrack } from "../../types";
import SceneGraphStage, { instanceOffset, trackValue } from "../SceneGraphStage";

vi.mock("@react-three/drei", () => ({
  Html: ({ children }: { children?: unknown }) => <div>{children as never}</div>,
}));

const graph = graphFixture as unknown as MechanismGraph;

describe("SceneGraphStage", () => {
  it.each([0, 0.3, 0.55, 0.9, 1] as const)("renders the fixture at t=%s", (t) => {
    expect(() => render(<SceneGraphStage graph={graph} t={t} />)).not.toThrow();
  });

  it("shows node labels and the caption", () => {
    render(<SceneGraphStage graph={graph} t={0.6} />);
    expect(screen.getByText("Input Tokens")).toBeTruthy();
    expect(screen.getByText("Dense Vectors")).toBeTruthy();
    expect(screen.getByText("Embedding Matrix")).toBeTruthy();
    expect(
      screen.getByText("Each token is mapped to a vector by the embedding matrix."),
    ).toBeTruthy();
  });

  it("labels instances from items", () => {
    render(<SceneGraphStage graph={graph} t={0.6} />);
    expect(screen.getAllByText("cat").length).toBeGreaterThan(0);
  });

  it("renders nothing when undescribed or empty", () => {
    const { container } = render(
      <SceneGraphStage graph={{ ...graph, described: false }} t={0.5} />,
    );
    expect(container.querySelector("group")).toBeNull();
    const empty = render(<SceneGraphStage graph={{ ...graph, nodes: [] }} t={0.5} />);
    expect(empty.container.querySelector("group")).toBeNull();
  });

  it("survives unknown geometry, layouts, and null lists", () => {
    const mutated = {
      ...graph,
      nodes: graph.nodes.map((node) => ({
        ...node,
        geometry: "definitely_not_geometry",
        layout: "definitely_not_layout",
        items: null as unknown as string[],
        values: null as unknown as number[],
        position: null as unknown as number[],
      })),
      tracks: null as unknown as SceneGraphTrack[],
    };
    expect(() => render(<SceneGraphStage graph={mutated} t={0.5} />)).not.toThrow();
  });

  it("survives a stored parent cycle by rendering the nodes as roots", () => {
    const cyclic = {
      ...graph,
      nodes: [
        { ...graph.nodes[0], node_id: "a", parent_id: "b" },
        { ...graph.nodes[1], node_id: "b", parent_id: "a" },
      ],
    };
    expect(() => render(<SceneGraphStage graph={cyclic} t={0.5} />)).not.toThrow();
  });
});

describe("trackValue", () => {
  const track = (over: Partial<SceneGraphTrack>): SceneGraphTrack => ({
    node_id: "n",
    prop: "position_x",
    times: [0.2, 0.8],
    keys: [0, 10],
    easing: "linear",
    ...over,
  });

  it("holds the first and last keys outside the keyframe range", () => {
    expect(trackValue(track({}), 0)).toBe(0);
    expect(trackValue(track({}), 1)).toBe(10);
  });

  it("interpolates linearly between keys", () => {
    expect(trackValue(track({}), 0.5)).toBeCloseTo(5);
  });

  it("returns null for empty tracks", () => {
    expect(trackValue(track({ times: [], keys: [] }), 0.5)).toBeNull();
  });

  it("ignores mismatched tail keys", () => {
    expect(trackValue(track({ times: [0.2], keys: [3, 9] }), 0.9)).toBe(3);
  });
});

describe("instanceOffset", () => {
  it("centers a row around the origin", () => {
    expect(instanceOffset("row", 0, 3, 1)[0]).toBeCloseTo(-1);
    expect(instanceOffset("row", 1, 3, 1)[0]).toBeCloseTo(0);
    expect(instanceOffset("row", 2, 3, 1)[0]).toBeCloseTo(1);
  });

  it("uses y for columns", () => {
    const [x, y] = instanceOffset("column", 0, 3, 1);
    expect(x).toBe(0);
    expect(y).toBeCloseTo(-1);
  });

  it("keeps grids near-square", () => {
    const offsets = Array.from({ length: 9 }, (_, i) => instanceOffset("grid", i, 9, 1));
    const xs = new Set(offsets.map(([x]) => x.toFixed(2)));
    expect(xs.size).toBe(3);
  });

  it("returns the origin for singles", () => {
    expect(instanceOffset("single", 0, 1, 1)).toEqual([0, 0, 0]);
  });

  it("falls back to a row for unknown layouts", () => {
    expect(instanceOffset("mystery", 2, 3, 1)[0]).toBeCloseTo(1);
  });
});
