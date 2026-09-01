import { useEffect, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";

// A looping "scene compilation": the Visualizer's real pipeline in miniature.
// Nodes use the app's diagram palette — the one place color carries meaning.
const COLORS = {
  input: "#6ee7d8",
  operation: "#fbbf24",
  data: "#f0abfc",
  output: "#a5b4fc",
  flow: "#8b8b93",
  attention: "#f0abfc",
  residual: "#6ee7d8",
  panel: "#101010",
  label: "#f5f5f5",
  sub: "#969696",
};

const MONO = "'JetBrains Mono', ui-monospace, monospace";

type NodeSpec = {
  id: string;
  label: string;
  sub?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  step: number;
  uncertain?: boolean;
};

const NODES: NodeSpec[] = [
  { id: "x", label: "input", sub: "embeddings", x: 8, y: 158, w: 88, h: 48, color: COLORS.input, step: 1 },
  { id: "q", label: "project Q", x: 150, y: 30, w: 92, h: 44, color: COLORS.operation, step: 2 },
  { id: "k", label: "project K", x: 150, y: 122, w: 92, h: 44, color: COLORS.operation, step: 2 },
  { id: "v", label: "project V", x: 150, y: 286, w: 92, h: 44, color: COLORS.operation, step: 2 },
  { id: "attn", label: "attention weights", sub: "softmax(QKᵀ/√dₖ)", x: 300, y: 76, w: 140, h: 48, color: COLORS.data, step: 3 },
  { id: "drop", label: "dropout", x: 300, y: 170, w: 140, h: 40, color: COLORS.operation, step: 4, uncertain: true },
  { id: "out", label: "output", sub: "Σ attn · V", x: 300, y: 250, w: 140, h: 48, color: COLORS.output, step: 5 },
];

type EdgeSpec = { d: string; color: string; step: number; dashed?: boolean };

const EDGES: EdgeSpec[] = [
  { d: "M96 172 C 122 172, 122 52, 150 52", color: COLORS.flow, step: 2 },
  { d: "M96 180 C 122 180, 122 144, 150 144", color: COLORS.flow, step: 2 },
  { d: "M96 192 C 122 192, 122 308, 150 308", color: COLORS.flow, step: 2 },
  { d: "M242 52 C 272 52, 272 92, 300 92", color: COLORS.attention, step: 3 },
  { d: "M242 144 C 272 144, 272 108, 300 108", color: COLORS.attention, step: 3 },
  { d: "M370 124 L 370 170", color: COLORS.flow, step: 4, dashed: true },
  { d: "M370 210 L 370 250", color: COLORS.flow, step: 5 },
  { d: "M242 308 C 274 308, 274 282, 300 282", color: COLORS.flow, step: 5 },
  { d: "M52 206 C 52 358, 296 372, 366 300", color: COLORS.residual, step: 6, dashed: true },
];

const STEP_COUNT = 7;

const CAPTIONS: { text: string; quote?: string; tone?: "amber" | "moss" }[] = [
  { text: "Compiling scene from indexed passages…" },
  { text: "input — grounded in", quote: "“mapping a query and a set of key-value pairs to an output” · §3.2" },
  { text: "projections — grounded in", quote: "“we linearly project the queries, keys and values h times” · §3.2.2" },
  { text: "weights — grounded in", quote: "“divide each by √dk, and apply a softmax function” · §3.2.1" },
  { text: "dropout — no supporting quote found. Rendered as uncertain.", tone: "amber" },
  { text: "output — grounded in", quote: "“a weighted sum of the values” · §3.2" },
  { text: "residual path — grounded in", quote: "“a residual connection around each of the two sub-layers” · §3.1" },
  { text: "5 of 6 steps grounded — 83%, above the 60% gate. Scene accepted.", tone: "moss" },
];

export default function HeroScene() {
  const reduced = useReducedMotion();
  const [step, setStep] = useState(reduced ? STEP_COUNT : 0);

  useEffect(() => {
    if (reduced) {
      setStep(STEP_COUNT);
      return;
    }
    let cancelled = false;
    let timer: number;
    const tick = (s: number) => {
      if (cancelled) return;
      setStep(s);
      if (s < STEP_COUNT) {
        timer = window.setTimeout(() => tick(s + 1), s === 0 ? 900 : 1700);
      } else {
        timer = window.setTimeout(() => tick(0), 4600);
      }
    };
    tick(0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [reduced]);

  const verified = step >= STEP_COUNT;

  return (
    <div className="rounded-lg bg-desk-900 p-5 sm:p-6">
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <p className="text-[13px] text-ivory-500">
          Attention Is All You Need · §3 — compiled scene
        </p>
        <p className="shrink-0 text-[13px]" style={{ color: verified ? "#86b380" : "#969696" }}>
          {verified ? "verified" : "compiling…"}
        </p>
      </div>

      <svg viewBox="0 0 452 384" className="w-full" role="img" aria-label="Animated diagram of an attention block being compiled step by step, each step citing evidence from the paper">
        {EDGES.map((e, i) => {
          const on = step >= e.step;
          return (
            <motion.path
              key={i}
              d={e.d}
              fill="none"
              stroke={e.color}
              strokeWidth={1.4}
              strokeDasharray={e.dashed ? "5 5" : undefined}
              initial={false}
              animate={{ pathLength: on ? 1 : 0, opacity: on ? 0.9 : 0 }}
              transition={{ duration: reduced ? 0 : 0.8, ease: "easeInOut" }}
            />
          );
        })}
        {NODES.map((n) => {
          const on = step >= n.step;
          const dim = n.uncertain ? 0.55 : 1;
          return (
            <motion.g
              key={n.id}
              initial={false}
              animate={{ opacity: on ? dim : 0, scale: on ? 1 : 0.94 }}
              transition={{ duration: reduced ? 0 : 0.5, ease: "easeOut" }}
              style={{ transformOrigin: `${n.x + n.w / 2}px ${n.y + n.h / 2}px` }}
            >
              <rect
                x={n.x}
                y={n.y}
                width={n.w}
                height={n.h}
                rx={5.5}
                fill={COLORS.panel}
                stroke={n.color}
                strokeWidth={1.2}
                strokeDasharray={n.uncertain ? "4 4" : undefined}
              />
              <text
                x={n.x + n.w / 2}
                y={n.sub ? n.y + n.h / 2 - 4 : n.y + n.h / 2 + 4}
                textAnchor="middle"
                fill={COLORS.label}
                fontSize={12.5}
                fontWeight={500}
              >
                {n.label}
              </text>
              {n.sub && (
                <text
                  x={n.x + n.w / 2}
                  y={n.y + n.h / 2 + 14}
                  textAnchor="middle"
                  fill={COLORS.sub}
                  fontSize={10}
                  fontFamily={MONO}
                >
                  {n.sub}
                </text>
              )}
            </motion.g>
          );
        })}
      </svg>

      <div className="mt-4 min-h-[3.25rem]">
        <AnimatePresence mode="wait">
          <motion.p
            key={step}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: reduced ? 0 : 0.35 }}
            className="text-[13px] leading-relaxed"
            style={{
              color:
                CAPTIONS[step]?.tone === "amber"
                  ? "#cf9f45"
                  : CAPTIONS[step]?.tone === "moss"
                    ? "#86b380"
                    : "#969696",
            }}
          >
            {CAPTIONS[step]?.text}
            {CAPTIONS[step]?.quote && (
              <span className="text-ivory-300"> {CAPTIONS[step].quote}</span>
            )}
          </motion.p>
        </AnimatePresence>
      </div>
    </div>
  );
}
