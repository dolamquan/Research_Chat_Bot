import { Link } from "react-router";
import { motion, useReducedMotion } from "motion/react";
import HeroScene from "./HeroScene";
import ZoetropeMark from "../components/ZoetropeMark";
import "./landing.css";

const MONO = "'JetBrains Mono', ui-monospace, monospace";

const EASE = [0.21, 0.47, 0.32, 0.98] as const;

function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduced ? false : { opacity: 0, y: 26 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.65, delay, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

const PIPELINE = [
  {
    step: "Step 1",
    title: "Read",
    body: "Papers are parsed and indexed into a vector store. Passages become retrievable evidence — the raw material every answer and every scene is built from.",
  },
  {
    step: "Step 2",
    title: "Compile",
    body: "The model writes a scene description, not code: typed entities, ordered steps, and range-checked values, validated before anything runs. Nothing executable ever comes out of the model.",
    snippet: `{ "op": "softmax_scale",
  "inputs": ["QK_T"],
  "range": [0, 1],
  "evidence": ["e3"] }`,
  },
  {
    step: "Step 3",
    title: "Verify",
    body: "Every step must point at a quote from the source. Scenes where fewer than 60% of steps are grounded fail verification, and anything uncited renders as uncertain — visibly.",
  },
];

const VIEWS = [
  { name: "Chat", body: "Cluster- and article-scoped conversations over your library, with citations." },
  { name: "Visualizer", body: "Verified algorithm scenes in 2D, 2.5D, and 3D, built from the paper itself." },
  { name: "Paper Library", body: "Your indexed collection, with a whole-paper context mode per article." },
  { name: "Agent", body: "A research agent console with paper-search and community bridges." },
  { name: "Crawler", body: "Multi-source paper search and one-step ingestion into the index." },
  { name: "Notes", body: "Findings kept next to the sources they came from." },
];

export default function LandingPage() {
  const reduced = useReducedMotion();

  const heroItem = {
    hidden: reduced ? {} : { opacity: 0, y: 28 },
    show: { opacity: 1, y: 0, transition: { duration: 0.7, ease: EASE } },
  };

  return (
    <div className="landing-root min-h-screen bg-[#0b0b0b] text-ivory-100" style={{ fontFamily: "'Inter', sans-serif" }}>
      {/* Topbar */}
      <header className="sticky top-0 z-20 border-b border-white/[0.08] bg-[#0b0b0b]/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-5 md:px-8">
          <a href="#top" className="flex items-center gap-2.5 text-[15px] font-semibold tracking-tight text-white">
            <ZoetropeMark size={22} />
            Zoetrope
          </a>
          <nav className="hidden items-center gap-7 text-sm text-ivory-500 sm:flex">
            <a href="#pipeline" className="transition-colors duration-150 hover:text-white">
              How scenes are built
            </a>
            <a href="#workspace" className="transition-colors duration-150 hover:text-white">
              Workspace
            </a>
          </nav>
          <Link
            to="/app"
            className="inline-flex h-9 items-center rounded-lg bg-white px-4 text-sm font-medium text-[#0b0b0b] transition-colors duration-150 hover:bg-white/90"
          >
            Launch workspace
          </Link>
        </div>
      </header>

      {/* Hero */}
      <section id="top" className="relative overflow-hidden">
        <div className="landing-grid pointer-events-none absolute inset-0" aria-hidden="true" />
        <div className="relative mx-auto grid max-w-6xl items-center gap-14 px-5 pb-24 pt-20 md:grid-cols-[1.05fr_1fr] md:px-8 md:pb-32 md:pt-28">
          <motion.div
            initial="hidden"
            animate="show"
            variants={{ show: { transition: { staggerChildren: 0.14 } } }}
          >
            <motion.h1
              variants={heroItem}
              className="text-[42px] font-semibold leading-[1.06] tracking-tight sm:text-[56px] lg:text-[64px]"
            >
              <span className="text-ivory-300">Read the paper.</span>
              <br />
              <span className="text-white">Watch the algorithm.</span>
            </motion.h1>
            <motion.p variants={heroItem} className="mt-6 max-w-xl text-[17px] leading-relaxed text-ivory-500">
              Zoetrope indexes your paper library so you can question it — and
              compiles each paper's method into an animated scene where every step
              cites the passage it came from.
            </motion.p>
            <motion.div variants={heroItem} className="mt-9 flex flex-wrap items-center gap-3">
              <Link
                to="/app"
                className="inline-flex h-11 items-center rounded-lg bg-white px-6 text-sm font-medium text-[#0b0b0b] transition-colors duration-150 hover:bg-white/90"
              >
                Launch workspace
              </Link>
              <a
                href="#pipeline"
                className="inline-flex h-11 items-center rounded-lg bg-desk-800 px-6 text-sm font-medium text-ivory-100 transition-colors duration-150 hover:bg-desk-700"
              >
                How scenes are built
              </a>
            </motion.div>
            <motion.p variants={heroItem} className="mt-8 text-sm text-ivory-700">
              Runs locally against your own indexed papers. The model never emits executable code.
            </motion.p>
          </motion.div>

          <motion.div
            initial={reduced ? false : { opacity: 0, y: 34 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.45, ease: EASE }}
          >
            <HeroScene />
          </motion.div>
        </div>
      </section>

      {/* Pipeline */}
      <section id="pipeline" className="border-t border-white/[0.08]">
        <div className="mx-auto max-w-6xl px-5 py-24 md:px-8 md:py-32">
          <Reveal>
            <h2 className="max-w-2xl text-[32px] font-semibold leading-tight tracking-tight text-white sm:text-[40px]">
              From paper to running scene, with the receipts attached.
            </h2>
            <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-ivory-500">
              Most tools summarize papers. Zoetrope rebuilds the method as a
              verifiable data document and animates it — so a wrong scene fails
              loudly instead of looking plausible.
            </p>
          </Reveal>
          <div className="mt-14 grid gap-10 md:grid-cols-3 md:gap-8">
            {PIPELINE.map((p, i) => (
              <Reveal key={p.title} delay={i * 0.12}>
                <p className="text-sm text-ivory-700">{p.step}</p>
                <h3 className="mt-1.5 text-xl font-semibold tracking-tight text-white">{p.title}</h3>
                <p className="mt-3 text-[15px] leading-relaxed text-ivory-500">{p.body}</p>
                {p.snippet && (
                  <pre
                    className="mt-5 overflow-x-auto rounded-lg bg-desk-900 p-4 text-[12px] leading-relaxed text-ivory-300"
                    style={{ fontFamily: MONO }}
                  >
                    {p.snippet}
                  </pre>
                )}
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Grounding claim */}
      <section className="border-t border-white/[0.08] bg-desk-900/40">
        <div className="mx-auto grid max-w-6xl gap-12 px-5 py-24 md:grid-cols-2 md:items-center md:px-8 md:py-32">
          <Reveal>
            <h2 className="text-[32px] font-semibold leading-tight tracking-tight text-white sm:text-[40px]">
              Uncertainty is drawn, not hidden.
            </h2>
            <p className="mt-4 text-[16px] leading-relaxed text-ivory-500">
              Every entity and step in a scene carries evidence pointers back to
              quotes in the paper. When a step has no supporting passage, it isn't
              dropped or dressed up — it renders as uncertain, dimmed and dashed,
              so you can see exactly where the reconstruction is on solid ground
              and where it isn't.
            </p>
            <p className="mt-4 text-[16px] leading-relaxed text-ivory-500">
              A scene where fewer than 60% of steps are grounded never reaches
              your screen at all. And because scenes are data, evaluation is
              deterministic: node and edge precision, recall, F1, grounding
              ratio, and hallucination counts — scored, not vibes.
            </p>
          </Reveal>
          <Reveal delay={0.15}>
            <div className="space-y-2.5">
              {[
                { label: "project queries, keys, values", state: "grounded · §3.2.2", ok: true },
                { label: "scale and normalize scores", state: "grounded · §3.2.1", ok: true },
                { label: "apply dropout to weights", state: "no citation — uncertain", ok: false },
                { label: "weighted sum of values", state: "grounded · §3.2", ok: true },
                { label: "residual connection", state: "grounded · §3.1", ok: true },
              ].map((row) => (
                <div
                  key={row.label}
                  className={`flex items-baseline justify-between gap-6 rounded-lg px-4 py-3 ${
                    row.ok ? "bg-desk-850" : "bg-desk-900 opacity-70"
                  }`}
                >
                  <span className={`text-[15px] font-medium ${row.ok ? "text-ivory-100" : "text-ivory-500"}`}>
                    {row.label}
                  </span>
                  <span className="shrink-0 text-[13px]" style={{ color: row.ok ? "#86b380" : "#cf9f45" }}>
                    {row.state}
                  </span>
                </div>
              ))}
              <p className="pt-2 text-sm text-ivory-700">
                4 of 5 steps grounded — 80%, above the 60% verification gate.
              </p>
            </div>
          </Reveal>
        </div>
      </section>

      {/* Workspace */}
      <section id="workspace" className="border-t border-white/[0.08]">
        <div className="mx-auto max-w-6xl px-5 py-24 md:px-8 md:py-32">
          <Reveal>
            <h2 className="max-w-2xl text-[32px] font-semibold leading-tight tracking-tight text-white sm:text-[40px]">
              One workspace, six ways at your library.
            </h2>
            <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-ivory-500">
              Papers cluster into a topology you can converse with — scope a chat
              to one cluster, one article, or the whole collection. Select a
              passage in the built-in reader and it becomes context for the
              conversation.
            </p>
          </Reveal>
          <div className="mt-14 grid gap-x-12 gap-y-9 sm:grid-cols-2 lg:grid-cols-3">
            {VIEWS.map((v, i) => (
              <Reveal key={v.name} delay={(i % 3) * 0.1}>
                <h3 className="text-[16px] font-medium text-white">{v.name}</h3>
                <p className="mt-1.5 text-[15px] leading-relaxed text-ivory-500">{v.body}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="border-t border-white/[0.08]">
        <div className="mx-auto max-w-6xl px-5 py-28 text-center md:px-8 md:py-36">
          <Reveal>
            <h2 className="mx-auto max-w-3xl text-[36px] font-semibold leading-tight tracking-tight text-white sm:text-[48px]">
              Your library is already interesting.
              <br />
              <span className="text-ivory-500">Point Zoetrope at it.</span>
            </h2>
            <div className="mt-10">
              <Link
                to="/app"
                className="inline-flex h-12 items-center rounded-lg bg-white px-8 text-[15px] font-medium text-[#0b0b0b] transition-colors duration-150 hover:bg-white/90"
              >
                Launch workspace
              </Link>
            </div>
          </Reveal>
        </div>
      </section>

      <footer className="border-t border-white/[0.08]">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-5 py-8 text-sm text-ivory-700 sm:flex-row sm:items-center sm:justify-between md:px-8">
          <p className="flex items-center gap-2 font-medium text-ivory-500">
            <ZoetropeMark size={16} />
            Zoetrope — papers, set in motion
          </p>
          <p>Runs locally. Your papers stay yours.</p>
        </div>
      </footer>
    </div>
  );
}
