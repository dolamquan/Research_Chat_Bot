// Brand mark: a zoetrope drum seen from above. The drum wall is an open ring
// broken by eight viewing slits (gaps sit on the cardinal and diagonal axes);
// the axle is a small solid disc. Everything follows currentColor, so the mark
// sits on any ground without hard-coded cutout colors.
const RADIUS = 11.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const SLITS = 8;
const SLIT_DEGREES = 15;
const SLIT = (CIRCUMFERENCE * SLIT_DEGREES) / 360;
const WALL = CIRCUMFERENCE / SLITS - SLIT;
// Dashes start at 3 o'clock; rotate so a slit is centered there instead.
const ROTATION = -(((WALL + SLIT / 2) / CIRCUMFERENCE) * 360);

export default function ZoetropeMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle
        cx="16"
        cy="16"
        r={RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth="3.1"
        strokeLinecap="butt"
        strokeDasharray={`${WALL} ${SLIT}`}
        transform={`rotate(${ROTATION} 16 16)`}
      />
      <circle cx="16" cy="16" r="2.8" fill="currentColor" />
    </svg>
  );
}
