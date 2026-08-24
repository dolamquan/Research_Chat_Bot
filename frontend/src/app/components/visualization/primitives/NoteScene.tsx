import * as THREE from "three";

import type { PrimitiveSceneProps } from "../sceneTypes";
import {
  Caption,
  Cell,
  EntityLabel,
  Link,
  PALETTE,
  clamp01,
  easeInOut,
  normalizedValues,
  phase,
  seriesColor,
  spread,
  stagger,
  unitCount,
} from "./shared";

/**
 * No mechanism asserted.
 *
 * Used both for the `note` primitive and, via the compiler, for any primitive
 * the renderer does not implement -- so an unexpected value degrades into an
 * honest statement instead of a crash or an invented animation.
 */
export function NoteScene({ step, t, dimmed }: PrimitiveSceneProps) {
  const opacity = dimmed ? 0.3 : 1;
  const appear = easeInOut(phase(t, 0, 0.4));
  return (
    <group>
      <mesh scale={0.9 + 0.1 * appear}>
        <planeGeometry args={[5.4, 2.6]} />
        <meshBasicMaterial
          color={PALETTE.muted}
          wireframe
          transparent
          opacity={opacity * 0.45 * appear}
        />
      </mesh>
      <Caption text={step.caption || step.detail} position={[0, 0, 0.1]} />
    </group>
  );
}

export default NoteScene;
