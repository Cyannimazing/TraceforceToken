export function TraceForgeMark({ className = "size-10" }: { className?: string }) {
  return <svg viewBox="0 0 48 48" fill="none" aria-hidden="true" className={`tf-brand-mark ${className}`}>
    <path className="tf-brand-trace" pathLength="1" d="M9 10H39V20H25V39M9 20H16V39M25 29H36" stroke="currentColor" strokeWidth="2.4" strokeLinecap="square" strokeLinejoin="miter" />
    <rect className="tf-brand-node tf-brand-node-one" x="5" y="6" width="8" height="8" fill="currentColor" />
    <rect className="tf-brand-node tf-brand-node-two" x="35" y="6" width="8" height="8" fill="currentColor" />
    <rect className="tf-brand-node tf-brand-node-three" x="21" y="35" width="8" height="8" fill="currentColor" />
  </svg>;
}
