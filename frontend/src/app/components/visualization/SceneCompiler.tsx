import { useMemo } from "react";

import type { AlgorithmScene, PrimitiveSceneProps, SceneStep } from "./sceneTypes";
import AttentionLinksScene from "./primitives/AttentionLinksScene";
import CompareScene from "./primitives/CompareScene";
import DataTransferScene from "./primitives/DataTransferScene";
import DistributionScene from "./primitives/DistributionScene";
import ElementwiseCombineScene from "./primitives/ElementwiseCombineScene";
import FilterSelectScene from "./primitives/FilterSelectScene";
import LoopScene from "./primitives/LoopScene";
import MatrixTransformScene from "./primitives/MatrixTransformScene";
import NonlinearityScene from "./primitives/NonlinearityScene";
import NormalizationScene from "./primitives/NormalizationScene";
import NoteScene from "./primitives/NoteScene";
import ParallelMergeScene from "./primitives/ParallelMergeScene";
import ParallelSplitScene from "./primitives/ParallelSplitScene";
import StateTransitionScene from "./primitives/StateTransitionScene";
import TokenStreamScene from "./primitives/TokenStreamScene";
import VectorArrayScene from "./primitives/VectorArrayScene";

/**
 * Maps a validated primitive name onto a React component.
 *
 * This lookup is the security boundary on the frontend. A model-supplied
 * string is only ever used as a key into this object -- never imported,
 * evaluated, or turned into markup. A key that is not present resolves to
 * `NoteScene`, which states the caption without asserting a mechanism, so an
 * unexpected value degrades instead of crashing the canvas.
 */
type PrimitiveComponent = (props: PrimitiveSceneProps) => JSX.Element | null;

/**
 * Built with a null prototype on purpose.
 *
 * A plain object literal inherits from Object.prototype, so a model-supplied
 * string of "toString" or "constructor" would resolve to an inherited function
 * and be rendered as a component. Removing the prototype means a lookup can
 * only ever return something written below, and the fallback handles the rest.
 */
export const primitiveRegistry: Record<string, PrimitiveComponent> =
  Object.assign(Object.create(null) as Record<string, PrimitiveComponent>, {
  token_stream: TokenStreamScene,
  vector_array: VectorArrayScene,
  matrix_transform: MatrixTransformScene,
  attention_links: AttentionLinksScene,
  split_parallel: ParallelSplitScene,
  merge_parallel: ParallelMergeScene,
  elementwise_combine: ElementwiseCombineScene,
  nonlinearity: NonlinearityScene,
  normalize: NormalizationScene,
  distribution: DistributionScene,
  filter_select: FilterSelectScene,
  compare: CompareScene,
  loop_repeat: LoopScene,
  data_transfer: DataTransferScene,
  state_transition: StateTransitionScene,
  note: NoteScene,
});

/** The component for a primitive, or the safe fallback. */
export function isKnownPrimitive(primitive: string): boolean {
  return Object.prototype.hasOwnProperty.call(primitiveRegistry, primitive);
}

export function resolvePrimitive(primitive: string): PrimitiveComponent {
  return isKnownPrimitive(primitive) ? primitiveRegistry[primitive] : NoteScene;
}

/**
 * Render one step of a scene.
 *
 * Depth is applied here rather than inside each primitive: in `3d` the step is
 * pushed back along z according to its index so the sequence reads as a stack,
 * in `2_5d` the offset is slight, and in `2d` it is flat. Every primitive
 * therefore works in all three modes without knowing which one is active,
 * which is what allows mode switching without regenerating the scene.
 */
export function CompiledStep({
  scene,
  step,
  t,
  dimmed,
  depthIndex,
  mode,
  onSelectEntity,
}: {
  scene: AlgorithmScene;
  step: SceneStep;
  t: number;
  dimmed?: boolean;
  depthIndex: number;
  mode: AlgorithmScene["visualization_mode"];
  onSelectEntity?: (entityId: string) => void;
}) {
  const Primitive = resolvePrimitive(step.primitive);

  const { inputs, outputs } = useMemo(() => {
    const byId = new Map(scene.entities.map((entity) => [entity.id, entity]));
    return {
      inputs: step.input_ids.map((id) => byId.get(id)).filter(Boolean) as never[],
      outputs: step.output_ids.map((id) => byId.get(id)).filter(Boolean) as never[],
    };
  }, [scene.entities, step.input_ids, step.output_ids]);

  const z = mode === "3d" ? -depthIndex * 2.6 : mode === "2_5d" ? -depthIndex * 0.7 : 0;

  return (
    <group position={[0, 0, z]}>
      <Primitive
        step={step}
        t={t}
        inputs={inputs}
        outputs={outputs}
        dimmed={dimmed}
        onSelectEntity={onSelectEntity}
      />
    </group>
  );
}

export default CompiledStep;
