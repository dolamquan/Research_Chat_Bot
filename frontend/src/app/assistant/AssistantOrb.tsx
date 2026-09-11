import { Component, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";

import type { VoiceState } from "./assistantTypes";

export type OrbDisplay = VoiceState | "speaking";

type OrbProps = {
  display: OrbDisplay;
  micLevel: MutableRefObject<number>;
  ttsLevel: MutableRefObject<number>;
  size?: number;
  /** Render continuously; otherwise draw once and idle (dormant, muted, text-only). */
  active: boolean;
  /** Another WebGL canvas is on screen: draw on demand to spare the GPU. */
  yield?: boolean;
};

// Ashima 3D simplex noise (MIT), trimmed for a vertex shader.
const NOISE_GLSL = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

const VERTEX = /* glsl */ `
uniform float uTime; uniform float uDistort; uniform float uLevel;
varying vec3 vNormal; varying vec3 vView; varying float vNoise;
${NOISE_GLSL}
void main(){
  float n = snoise(normal * 1.6 + vec3(uTime * 0.35));
  float n2 = snoise(normal * 4.2 - vec3(uTime * 0.9));
  float d = n * uDistort + n2 * uDistort * 0.4 * uLevel;
  vec3 p = position + normal * d;
  vNoise = n;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vNormal = normalize(normalMatrix * normal);
  vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const FRAGMENT = /* glsl */ `
uniform float uRim; uniform float uAlpha; uniform vec3 uTint;
varying vec3 vNormal; varying vec3 vView; varying float vNoise;
void main(){
  float fres = pow(1.0 - max(dot(vNormal, vView), 0.0), 2.2);
  float body = 0.09 + 0.07 * (vNoise * 0.5 + 0.5);
  vec3 col = mix(vec3(body), uTint, fres * uRim);
  float a = uAlpha * (0.5 + 0.5 * fres);
  gl_FragColor = vec4(col, a);
}`;

type Targets = {
  scale: number; distort: number; rim: number; alpha: number; spin: number;
  ring: number; ringScale: number; ringSpeed: number; arc: number; red: number; wire: number;
};

function targetsFor(display: OrbDisplay, mic: number, tts: number, t: number): Targets {
  const base: Targets = { scale: 1, distort: 0.08, rim: 0.3, alpha: 0.45, spin: 0, ring: 0, ringScale: 1.3, ringSpeed: 0, arc: 1, red: 0, wire: 0.08 };
  switch (display) {
    case "idle_listening":
      return { ...base, scale: 1 + 0.02 * Math.sin(t * Math.PI * 2 * 0.2), distort: 0.12, rim: 0.55, alpha: 0.7, spin: 0.03, wire: 0.12 };
    case "capturing":
      return { ...base, scale: 1 + 0.22 * mic, distort: 0.15 + 0.45 * mic, rim: 0.85, alpha: 0.9, spin: 0.05, ring: 0.6, ringScale: 1.2 + 0.4 * mic, ringSpeed: 0.2, wire: 0.12 + 0.5 * mic };
    case "sending":
    case "thinking":
      return { ...base, distort: 0.15 + 0.15 * Math.sin(t * Math.PI * 2 * 1.2), rim: 0.7, alpha: 0.85, spin: 0.18, ring: 0.5, ringScale: 1.3, ringSpeed: 0.8, wire: 0.14 };
    case "executing":
      return { ...base, distort: 0.18 + 0.15 * Math.sin(t * Math.PI * 2 * 1.6), rim: 0.75, alpha: 0.9, spin: 0.22, ring: 0.7, ringScale: 1.32, ringSpeed: 1.6, arc: 0.7, wire: 0.14 };
    case "speaking":
      return { ...base, distort: 0.2 + 0.5 * tts, rim: 0.6 + 0.4 * tts, alpha: 0.95, spin: 0.06, ring: 0.15, ringScale: 1.1, ringSpeed: 0.1, wire: 0.1 + 0.2 * tts };
    case "awaiting_confirmation":
      return { ...base, distort: 0.12, rim: 0.8 + 0.2 * Math.sin(t * Math.PI * 2), alpha: 0.9, spin: 0.04, ring: 0.6, ringScale: 1.3, ringSpeed: 0, wire: 0.12 };
    case "error":
      return { ...base, distort: 0.1, rim: 0.7, alpha: 0.6, red: 1 };
    case "muted":
      return { ...base, alpha: 0.4 };
    default:
      return base;
  }
}

const GREY = new THREE.Color("#ffffff");
const RED = new THREE.Color("#e05243");

function OrbScene({ displayRef, micLevel, ttsLevel }: { displayRef: MutableRefObject<OrbDisplay>; micLevel: MutableRefObject<number>; ttsLevel: MutableRefObject<number> }) {
  const bodyRef = useRef<THREE.Mesh>(null);
  const wireRef = useRef<THREE.Mesh>(null);
  const ringRef = useRef<THREE.Mesh>(null);
  const arcRef = useRef<THREE.Mesh>(null);
  const current = useRef<Targets>(targetsFor("dormant", 0, 0, 0));
  const redFlash = useRef(0);
  const lastDisplay = useRef<OrbDisplay>("dormant");

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 }, uDistort: { value: 0.08 }, uLevel: { value: 0 }, uRim: { value: 0.3 }, uAlpha: { value: 0.45 },
      uTint: { value: new THREE.Color("#ffffff") },
    }),
    [],
  );

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    const display = displayRef.current;
    if (display === "error" && lastDisplay.current !== "error") redFlash.current = 1;
    lastDisplay.current = display;
    redFlash.current = Math.max(0, redFlash.current - delta / 0.6);
    const mic = micLevel.current;
    const tts = ttsLevel.current;
    const target = targetsFor(display, mic, tts, t);
    const k = 1 - Math.exp(-delta * 7);
    const c = current.current;
    (Object.keys(target) as Array<keyof Targets>).forEach((key) => {
      c[key] += (target[key] - c[key]) * k;
    });

    uniforms.uTime.value = t;
    uniforms.uDistort.value = c.distort;
    uniforms.uLevel.value = display === "capturing" ? mic : display === "speaking" ? tts : 0.3;
    uniforms.uRim.value = c.rim;
    uniforms.uAlpha.value = c.alpha;
    uniforms.uTint.value.copy(GREY).lerp(RED, redFlash.current);

    if (bodyRef.current) {
      bodyRef.current.scale.setScalar(c.scale);
      bodyRef.current.rotation.y += c.spin * delta * 6;
      bodyRef.current.rotation.x += c.spin * delta * 2;
    }
    if (wireRef.current) {
      wireRef.current.scale.setScalar(c.scale * 1.08);
      wireRef.current.rotation.y -= c.spin * delta * 3;
      (wireRef.current.material as THREE.MeshBasicMaterial).opacity = c.wire;
    }
    if (ringRef.current) {
      ringRef.current.scale.setScalar(c.ringScale);
      ringRef.current.rotation.z += c.ringSpeed * delta;
      (ringRef.current.material as THREE.MeshBasicMaterial).opacity = c.ring * c.arc;
    }
    if (arcRef.current) {
      arcRef.current.scale.setScalar(c.ringScale * 1.02);
      arcRef.current.rotation.z -= c.ringSpeed * 1.4 * delta;
      (arcRef.current.material as THREE.MeshBasicMaterial).opacity = c.ring * (1 - c.arc) * 1.4;
    }
  });

  return (
    <group>
      <mesh ref={bodyRef}>
        <icosahedronGeometry args={[1, 5]} />
        <shaderMaterial vertexShader={VERTEX} fragmentShader={FRAGMENT} uniforms={uniforms} transparent depthWrite={false} />
      </mesh>
      <mesh ref={wireRef}>
        <icosahedronGeometry args={[1, 1]} />
        <meshBasicMaterial color="#ffffff" wireframe transparent opacity={0.1} depthWrite={false} />
      </mesh>
      <group rotation={[Math.PI * 0.42, 0.35, 0]}>
        <mesh ref={ringRef}>
          <torusGeometry args={[1, 0.008, 6, 96]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0} depthWrite={false} />
        </mesh>
        <mesh ref={arcRef}>
          <torusGeometry args={[1, 0.012, 6, 64, Math.PI * 1.25]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0} depthWrite={false} />
        </mesh>
      </group>
    </group>
  );
}

export function OrbFallback({ display, size = 44 }: { display: OrbDisplay; size?: number }) {
  const busy = display === "thinking" || display === "executing" || display === "sending";
  const alert = display === "error";
  const dim = display === "dormant" || display === "muted" || display === "text_only";
  return (
    <div
      aria-hidden
      className={`rounded-full ${busy ? "animate-pulse" : ""}`}
      style={{
        width: size,
        height: size,
        opacity: dim ? 0.45 : 0.9,
        background: alert
          ? "radial-gradient(circle at 35% 35%, rgba(224,82,67,0.7), rgba(224,82,67,0.15) 60%, transparent 72%)"
          : "radial-gradient(circle at 35% 35%, rgba(255,255,255,0.55), rgba(255,255,255,0.12) 60%, transparent 72%)",
        border: "1px solid rgba(255,255,255,0.28)",
      }}
    />
  );
}

class OrbErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function AssistantOrb({ display, micLevel, ttsLevel, size = 44, active, yield: yieldGpu = false }: OrbProps) {
  const displayRef = useRef<OrbDisplay>(display);
  displayRef.current = display;
  const [lost, setLost] = useState(false);
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.visibilityState === "hidden");
  const reduced = useMemo(prefersReducedMotion, []);

  useEffect(() => {
    const onVisibility = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const fallback = <OrbFallback display={display} size={size} />;
  if (lost || hidden || reduced) return fallback;

  return (
    <div style={{ width: size, height: size }} aria-hidden>
      <OrbErrorBoundary fallback={fallback}>
        <Canvas
          dpr={[1, 1.5]}
          gl={{ alpha: true, antialias: true, powerPreference: "low-power" }}
          frameloop={active && !yieldGpu ? "always" : "demand"}
          camera={{ position: [0, 0, 3.2], fov: 35 }}
          style={{ background: "transparent" }}
          onCreated={({ gl }) => {
            gl.domElement.addEventListener("webglcontextlost", (event) => {
              event.preventDefault();
              setLost(true);
            });
          }}
        >
          <OrbScene displayRef={displayRef} micLevel={micLevel} ttsLevel={ttsLevel} />
        </Canvas>
      </OrbErrorBoundary>
    </div>
  );
}
