import { afterEach, describe, expect, it, vi } from "vitest";
import { generateStageScene } from "../../../api";

afterEach(() => vi.unstubAllGlobals());

describe("stage generation requests", () => {
  it("shares a pending scene between preparation and playback", async () => {
    let resolve!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((done) => { resolve = done; }));
    vi.stubGlobal("fetch", fetch);
    const first = generateStageScene({vizId: "paper", nodeId: "norm"});
    const second = generateStageScene({vizId: "paper", nodeId: "norm"});
    expect(first).toBe(second);
    expect(fetch).toHaveBeenCalledTimes(1);
    resolve(new Response(JSON.stringify({stage_scene: {node_id: "norm"}})));
    await expect(first).resolves.toEqual({stage_scene: {node_id: "norm"}});
  });

  it("retries after errors", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(new Response(JSON.stringify({stage_scene: {}})));
    vi.stubGlobal("fetch", fetch);
    await expect(generateStageScene({vizId: "paper", nodeId: "norm"})).rejects.toThrow("offline");
    await generateStageScene({vizId: "paper", nodeId: "norm"});
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps requests for different stages independent", async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({stage_scene: {}}))));
    vi.stubGlobal("fetch", fetch);
    const first = generateStageScene({vizId: "paper", nodeId: "input"});
    const second = generateStageScene({vizId: "paper", nodeId: "norm"});
    expect(first).not.toBe(second);
    expect(fetch).toHaveBeenCalledTimes(2);
    await Promise.all([first, second]);
  });
});
