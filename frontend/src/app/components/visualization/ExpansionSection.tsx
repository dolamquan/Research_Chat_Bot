/** One labelled paragraph of a node's expanded explanation; renders nothing when empty. */
export function ExpansionSection({
  title,
  children,
}: {
  title: string;
  children: string;
}) {
  if (!children) return null;
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium text-ivory-500">
        {title}
      </div>
      <p className="text-xs leading-relaxed text-ivory-300">{children}</p>
    </div>
  );
}

export default ExpansionSection;
