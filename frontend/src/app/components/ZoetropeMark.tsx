// Brand mark: a zoetrope drum seen from above — solid disc, eight viewing
// slits, and a play wedge at the axle. Disc color follows currentColor; the
// cutouts are the app's fixed near-black ground (the app is dark-only).
export default function ZoetropeMark({ size = 24 }: { size?: number }) {
  const slits = [22.5, 67.5, 112.5, 157.5, 202.5, 247.5, 292.5, 337.5];
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="12.5" fill="currentColor" />
      <g stroke="#0b0b0b" strokeWidth="2">
        {slits.map((a) => (
          <line key={a} x1="16" y1="4.5" x2="16" y2="9.5" transform={`rotate(${a} 16 16)`} />
        ))}
      </g>
      <path d="M14 11.6 L21.4 16 L14 20.4 Z" fill="#0b0b0b" />
    </svg>
  );
}
