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

/** A component changing from one state into another. */
export function StateTransitionScene({ step, t, inputs, outputs, dimmed, onSelectEntity }: PrimitiveSceneProps) {
  const opacity = dimmed ? 0.3 : 1;
  const shift = easeInOut(phase(t, 0.2, 0.8));
  return (
    <group>
      <group position={[-2.4, 0, 0]} scale={1 - 0.35 * shift}>
        <mesh>
          <icosahedronGeometry args={[0.95, 1]} />
          <meshStandardMaterial
            color={PALETTE.secondary}
            emissive={PALETTE.secondary}
            emissiveIntensity={0.4}
            transparent
            opacity={opacity * (1 - 0.7 * shift)}
            toneMapped={false}
          />
        </mesh>
      </group>
      <Link
        from={new THREE.Vector3(-1.3, 0, 0)}
        to={new THREE.Vector3(1.3, 0, 0)}
        color={PALETTE.accent}
        opacity={opacity * shift}
        thickness={0.04}
      />
      <group position={[2.4, 0, 0]} scale={0.5 + 0.6 * shift}>
        <mesh>
          <octahedronGeometry args={[1, 0]} />
          <meshStandardMaterial
            color={PALETTE.accent}
            emissive={PALETTE.accent}
            emissiveIntensity={0.6}
            transparent
            opacity={opacity * shift}
            toneMapped={false}
          />
        </mesh>
      </group>
      <EntityLabel entity={inputs[0]} position={[-2.4, 1.7, 0]} onSelect={onSelectEntity} />
      <EntityLabel entity={outputs[0]} position={[2.4, 1.7, 0]} onSelect={onSelectEntity} />
      <Caption text={step.label_in && step.label_out ? `${step.label_in} to ${step.label_out}` : step.caption} />
    </group>
  );
}

export default StateTransitionScene;
