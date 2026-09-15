/**
 * The Console's card surfaces: frosted, translucent white on the app's
 * near-black ground, hairline borders, a brighter ring for the selected card.
 * Kept monochrome on purpose — the rest of the app has a white accent and no
 * colour, so the glass reads as depth, not decoration.
 */
export const glass =
  "rounded-xl border border-white/10 bg-white/[0.04] backdrop-blur-md shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_1px_2px_rgba(0,0,0,0.4)]";

/** For cards that can be picked. */
export const glassHover = "transition-colors hover:border-white/25 hover:bg-white/[0.08]";

/** The picked card: brighter fill, a soft outer ring, a lift. */
export const glassActive =
  "border-white/40 bg-white/[0.10] shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_0_0_1px_rgba(255,255,255,0.18),0_12px_32px_-12px_rgba(0,0,0,0.8)]";

/** A card that warns: same glass, red hairline. */
export const glassDanger = "rounded-xl border border-destructive/40 bg-destructive/10 backdrop-blur-md";

/** A faint light source so the frosted surfaces have something to frost. */
export const glassBackdrop =
  "bg-[radial-gradient(ellipse_80%_60%_at_20%_0%,rgba(255,255,255,0.06),transparent_60%),radial-gradient(ellipse_60%_50%_at_100%_100%,rgba(255,255,255,0.035),transparent_60%)]";
