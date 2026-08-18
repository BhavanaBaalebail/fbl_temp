/**
 * Animated PCB trace background layer
 */

export function PcbBackground() {
  return (
    <div className="pcb-bg" aria-hidden="true">
      <svg preserveAspectRatio="xMidYMid slice">
        <defs>
          <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path
              d="M 40 0 L 0 0 0 40"
              fill="none"
              stroke="rgba(34, 211, 238, 0.03)"
              strokeWidth="0.5"
            />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)" />

        {/* Horizontal bus traces */}
        <path className="pcb-trace" d="M0 120 H400 M400 120 H800 M800 120 H1200 M1200 120 H1600 M1600 120 H2000" />
        <path className="pcb-trace pcb-trace-slow" d="M0 280 H350 M350 280 H700 M700 280 H1100 M1100 280 H1600 M1600 280 H2000" />
        <path className="pcb-trace" d="M0 440 H500 M500 440 H900 M900 440 H1400 M1400 440 H2000" style={{ animationDelay: "-3s" }} />
        <path className="pcb-trace pcb-trace-slow" d="M0 600 H300 M300 600 H650 M650 600 H1000 M1000 600 H1500 M1500 600 H2000" style={{ animationDelay: "-6s" }} />

        {/* Vertical traces */}
        <path className="pcb-trace pcb-trace-slow" d="M200 0 V200 M200 200 V400 M200 400 V600 M200 600 V800" />
        <path className="pcb-trace" d="M600 0 V180 M600 180 V360 M600 360 V540 M600 540 V720 M600 720 V900" style={{ animationDelay: "-2s" }} />
        <path className="pcb-trace pcb-trace-slow" d="M1000 0 V250 M1000 250 V500 M1000 500 V750 M1000 750 V1000" style={{ animationDelay: "-5s" }} />
        <path className="pcb-trace" d="M1400 0 V150 M1400 150 V350 M1400 350 V550 M1400 550 V800" style={{ animationDelay: "-4s" }} />

        {/* Diagonal data paths */}
        <path className="pcb-trace pcb-trace-slow" d="M100 80 L350 200 M350 200 L600 120" style={{ animationDelay: "-1s" }} />
        <path className="pcb-trace" d="M800 320 L1100 400 M1100 400 L1400 280" style={{ animationDelay: "-7s" }} />

        {/* Junction nodes */}
        <circle className="pcb-node" cx="200" cy="120" r="3" />
        <circle className="pcb-node" cx="600" cy="280" r="3" style={{ animationDelay: "-1s" }} />
        <circle className="pcb-node" cx="1000" cy="440" r="3" style={{ animationDelay: "-2s" }} />
        <circle className="pcb-node" cx="1400" cy="600" r="3" style={{ animationDelay: "-3s" }} />
        <circle className="pcb-node" cx="350" cy="200" r="2" />
        <circle className="pcb-node" cx="1100" cy="400" r="2" style={{ animationDelay: "-1.5s" }} />
      </svg>

      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(ellipse 80% 60% at 50% 0%, rgba(34, 211, 238, 0.04) 0%, transparent 55%), radial-gradient(ellipse 60% 40% at 100% 100%, rgba(56, 189, 248, 0.03) 0%, transparent 50%)",
        }}
      />
    </div>
  );
}
