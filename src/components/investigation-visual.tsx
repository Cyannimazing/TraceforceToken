export function InvestigationVisual() {
  return (
    <figure className="investigation-visual">
      <div className="visual-heading"><span><span className="small-cross" aria-hidden="true">+</span> RELATIONSHIP EXPLORER</span><span className="visual-label">CONCEPT VIEW</span></div>
      <svg className="relationship-illustration" viewBox="0 0 600 430" role="img" aria-labelledby="graph-title graph-description">
        <title id="graph-title">An illustration of the relationships an investigation could examine</title>
        <desc id="graph-description">A funding source connects to three example wallets. Transfers connect the wallets to a pool. These are illustrative relationships rather than actual blockchain transactions.</desc>
        <defs>
          <pattern id="graph-grid" width="28" height="28" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".8" fill="currentColor" opacity=".22" /></pattern>
          <linearGradient id="funding-line" x1="0" y1="0" x2="1" y2="0"><stop stopColor="#bd8f70" stopOpacity=".35" /><stop offset="1" stopColor="#d4a17e" /></linearGradient>
          <linearGradient id="transfer-line" x1="0" y1="0" x2="1" y2="0"><stop stopColor="#79c6bd" /><stop offset="1" stopColor="#79c6bd" stopOpacity=".3" /></linearGradient>
          <radialGradient id="graph-glow"><stop stopColor="#507973" stopOpacity=".13" /><stop offset="1" stopColor="#507973" stopOpacity="0" /></radialGradient>
        </defs>
        <rect width="600" height="430" fill="url(#graph-grid)" />
        <ellipse cx="331" cy="212" rx="235" ry="195" fill="url(#graph-glow)" />
        <path d="M244 54H358a22 22 0 0 1 22 22v272a22 22 0 0 1-22 22H244a22 22 0 0 1-22-22V76a22 22 0 0 1 22-22Z" className="graph-cluster" />
        <text x="240" y="76" className="graph-overline">OBSERVED CONNECTIONS</text>
        <g fill="none" stroke="url(#funding-line)" strokeWidth="1.5">
          <path d="M115 210C181 210 185 124 277 124" /><path d="M115 210H277" /><path d="M115 210C183 210 185 300 277 300" />
        </g>
        <g fill="none" stroke="url(#transfer-line)" strokeWidth="1.5"><path d="M323 124C415 124 398 210 486 210" /><path d="M323 210H486" /><path d="M323 300C416 300 398 210 486 210" /></g>
        <path d="M300 150v34M300 236v38" fill="none" stroke="#79c6bd" strokeWidth="1" strokeDasharray="3 5" opacity=".55" />
        <g className="graph-packet"><circle cx="192" cy="157" r="3" fill="#d4a17e" /><circle cx="182" cy="210" r="3" fill="#d4a17e" /><circle cx="404" cy="271" r="3" fill="#79c6bd" /></g>
        <g transform="translate(91 210)"><circle r="31" fill="#1c2326" stroke="#a67c60" strokeOpacity=".5" /><path d="M-11-8h22v16h-22zM-5-13H5v5M-5 8v5H5V8" fill="none" stroke="#d4a17e" strokeWidth="1.5" /><circle r="3" fill="#d4a17e" /></g>
        <text x="91" y="263" textAnchor="middle" className="graph-label">Funding source</text><text x="91" y="281" textAnchor="middle" className="graph-detail">OBSERVED INFLOW</text>
        <g transform="translate(300 124)"><circle r="26" className="graph-wallet-ring" /><rect x="-10" y="-8" width="20" height="16" rx="3" className="graph-wallet" /><path d="M3-3h9v6H3z" className="graph-wallet" /><circle cx="7" r="1" fill="#b3d5cf" /></g>
        <g transform="translate(300 210)"><circle r="31" className="graph-wallet-highlight" /><circle r="26" className="graph-wallet-ring" /><rect x="-10" y="-8" width="20" height="16" rx="3" className="graph-wallet" /><path d="M3-3h9v6H3z" className="graph-wallet" /><circle cx="7" r="1" fill="#b3d5cf" /></g>
        <g transform="translate(300 300)"><circle r="26" className="graph-wallet-ring" /><rect x="-10" y="-8" width="20" height="16" rx="3" className="graph-wallet" /><path d="M3-3h9v6H3z" className="graph-wallet" /><circle cx="7" r="1" fill="#b3d5cf" /></g>
        <text x="339" y="129" className="graph-label">A</text><text x="344" y="215" className="graph-label">B</text><text x="339" y="305" className="graph-label">C</text>
        <g transform="translate(511 210)"><circle r="31" fill="#1c292a" stroke="#79c6bd" strokeOpacity=".5" /><path d="M-11-6 0-12 11-6 0 0zM-11 0 0 6 11 0M-11 6 0 12 11 6" fill="none" stroke="#8bc9c0" strokeWidth="1.5" /></g>
        <text x="511" y="263" textAnchor="middle" className="graph-label">Liquidity pool</text><text x="511" y="281" textAnchor="middle" className="graph-detail">TOKEN TRANSFERS</text>
        <g transform="translate(145 94)"><rect width="94" height="25" rx="4" fill="#302b27" stroke="#a67c60" strokeOpacity=".3" /><circle cx="12" cy="12.5" r="2.5" fill="#d4a17e" /><text x="23" y="16" className="graph-note">Shared source</text></g>
        <g transform="translate(365 325)"><rect width="111" height="25" rx="4" fill="#24312f" stroke="#79c6bd" strokeOpacity=".3" /><circle cx="12" cy="12.5" r="2.5" fill="#79c6bd" /><text x="23" y="16" className="graph-note">Timing &amp; token flow</text></g>
        <text x="25" y="405" className="graph-coordinate">FUNDING</text><path d="M96 401h159" stroke="#6c7775" strokeWidth=".6" /><text x="275" y="405" className="graph-coordinate">WALLETS</text><path d="M345 401h159" stroke="#6c7775" strokeWidth=".6" /><text x="527" y="405" className="graph-coordinate">FLOW</text>
      </svg>
      <div className="visual-key"><span><i className="key-line funding" />Funding path</span><span><i className="key-line transfer" />Token flow</span><span className="visual-synthetic">Illustrative · no live data</span></div>
      <figcaption>A connection is a starting point for investigation, not proof of common ownership.</figcaption>
    </figure>
  );
}
