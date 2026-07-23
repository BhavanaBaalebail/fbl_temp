/**
 * TopologyCanvas Component
 * Renders the SVG-based topology/connectivity map visualization
 */

import {
  resolveLinkStrokeColor,
  getNodeStrokeColor,
  getNodeFill,
} from "../../utils/helpers";
import {
  TOPOLOGY_CENTER,
  centerEdgeToward,
  peripheralEdgeTowardCenter,
  INTERFACE_HALF_W,
  INTERFACE_HALF_H,
  rectInsetAlongRay
} from "../../data/topologyData";

export function TopologyCanvas({
  mapName,
  mapSubtitle,
  centerNode,
  links,
  showingCPU,
  componentHealth,
}) {
  const center = TOPOLOGY_CENTER;

  const strokeForLink = (linkId) =>
    resolveLinkStrokeColor(centerNode.label, linkId, componentHealth);

  const strokeForNode = (componentId) =>
    getNodeStrokeColor(componentId, componentHealth);

  const fillForNode = (componentId, variant = "peripheral") =>
    getNodeFill(componentId, componentHealth, variant);

  return (
    <section className="hw-module relative overflow-hidden !p-6">
      <div
        className="absolute left-0 right-0 top-0 h-0.5"
        style={{
          background: "linear-gradient(90deg, transparent, #22d3ee, transparent)",
          opacity: 0.5,
        }}
      />
      <div className="mx-auto max-w-[1200px] pt-1">
        <svg
          viewBox="0 0 1200 700"
          className="h-auto w-full"
          preserveAspectRatio="xMidYMid meet"
          style={{ background: "rgba(8, 12, 18, 0.4)", borderRadius: 8 }}
        >
          <defs>
            <linearGradient id="peripheralCardGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#161c24" />
              <stop offset="100%" stopColor="#0c121c" />
            </linearGradient>
            <linearGradient id="ifaceCardGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#1a2332" />
              <stop offset="100%" stopColor="#0f1419" />
            </linearGradient>
            <linearGradient id="centerNavyGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#0c121c" />
              <stop offset="100%" stopColor="#161c24" />
            </linearGradient>
            <filter id="unifiedNodeShadow" x="-18%" y="-18%" width="136%" height="136%">
              <feDropShadow dx="0" dy="2" stdDeviation="4" floodColor="#22d3ee" floodOpacity="0.2" result="glowDrop" />
              <feDropShadow dx="0" dy="5" stdDeviation="8" floodColor="#000000" floodOpacity="0.4" result="depthDrop" />
              <feMerge>
                <feMergeNode in="glowDrop" />
                <feMergeNode in="depthDrop" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <filter id="centerNodeStandard" x="-35%" y="-35%" width="170%" height="170%">
              <feGaussianBlur in="SourceAlpha" stdDeviation="4" result="blur" />
              <feFlood floodColor="#22d3ee" floodOpacity="0.25" result="flood" />
              <feComposite in="flood" in2="blur" operator="in" result="glow" />
              <feMerge>
                <feMergeNode in="glow" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <filter id="centerNodeCpuHero" x="-55%" y="-55%" width="210%" height="210%">
              <feGaussianBlur in="SourceAlpha" stdDeviation="7" result="blur" />
              <feFlood floodColor="#22d3ee" floodOpacity="0.5" result="flood" />
              <feComposite in="flood" in2="blur" operator="in" result="glow" />
              <feGaussianBlur in="glow" stdDeviation="10" result="glowSoft" />
              <feMerge>
                <feMergeNode in="glowSoft" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {links.map((node) => {
            const hubEdge = centerEdgeToward(node.nodeX, node.nodeY, center);
            const periphEdge = peripheralEdgeTowardCenter(node.nodeX, node.nodeY, center);

            // chord vector and unit
            const dx = periphEdge.x - hubEdge.x;
            const dy = periphEdge.y - hubEdge.y;
            const length = Math.hypot(dx, dy) || 1;
            const nx = dx / length;
            const ny = dy / length;

            // interface half-extent along chord (so lines terminate at the rect edge)
            const ifaceHalf = rectInsetAlongRay(INTERFACE_HALF_W, INTERFACE_HALF_H, nx, ny);

            const ifaceInner = {
              x: Math.round(node.ifaceX - nx * ifaceHalf),
              y: Math.round(node.ifaceY - ny * ifaceHalf),
            };

            const ifaceOuter = {
              x: Math.round(node.ifaceX + nx * ifaceHalf),
              y: Math.round(node.ifaceY + ny * ifaceHalf),
            };

            return (
              <g key={`${node.id}-line`}>
                <line
                  className="dash-flow"
                  x1={hubEdge.x}
                  y1={hubEdge.y}
                  x2={ifaceInner.x}
                  y2={ifaceInner.y}
                  stroke={strokeForLink(node.id)}
                  strokeWidth="2"
                  strokeDasharray="8 6"
                  strokeLinecap="round"
                />
                <line
                  className="dash-flow"
                  x1={ifaceOuter.x}
                  y1={ifaceOuter.y}
                  x2={periphEdge.x}
                  y2={periphEdge.y}
                  stroke={strokeForLink(node.id)}
                  strokeWidth="2"
                  strokeDasharray="8 6"
                  strokeLinecap="round"
                />
              </g>
            );
          })}

          <rect
            x={center.x - 120}
            y={center.y - 55}
            width="240"
            height="110"
            rx="18"
            fill={fillForNode(centerNode.label, "center")}
            stroke={strokeForNode(centerNode.label)}
            strokeWidth={showingCPU ? 3 : 2.5}
            filter={
              showingCPU ? "url(#centerNodeCpuHero)" : "url(#centerNodeStandard)"
            }
          />
          <text
            x={center.x}
            y={center.y - 8}
            fill="#f1f5f9"
            fontSize="34"
            fontWeight="800"
            textAnchor="middle"
          >
            {centerNode.label}
          </text>
          <text
            x={center.x}
            y={center.y + 20}
            fill="#64748b"
            fontSize="12"
            textAnchor="middle"
          >
            {centerNode.subtitle}
          </text>

          {links.map((node) => (
            <g key={`${node.id}-iface`}>
              <rect
                x={node.ifaceX - 105}
                y={node.ifaceY - 30}
                width="210"
                height="60"
                rx="10"
                fill="url(#ifaceCardGrad)"
                stroke={strokeForLink(node.id)}
                strokeWidth="2"
                filter="url(#unifiedNodeShadow)"
              />
              <text
                x={node.ifaceX}
                y={node.ifaceY - 9}
                fill="#f1f5f9"
                fontSize="13"
                fontWeight="800"
                textAnchor="middle"
              >
                {node.ifaceLabel}
              </text>
              <text
                x={node.ifaceX}
                y={node.ifaceY + 5}
                fill="#64748b"
                fontSize="10"
                textAnchor="middle"
              >
                {node.ifaceSubtitle1 || node.ifaceSubtitle}
              </text>
              <text
                x={node.ifaceX}
                y={node.ifaceY + 18}
                fill="#38bdf8"
                fontSize="10"
                fontWeight="800"
                textAnchor="middle"
              >
                {node.ifaceSubtitle2 || ""}
              </text>
            </g>
          ))}

          {links.map((node) => (
            <g key={`${node.id}-peripheral`}>
              <rect
                x={node.nodeX - 95}
                y={node.nodeY - 42}
                width="190"
                height="84"
                rx="12"
                fill={fillForNode(node.id)}
                stroke={strokeForNode(node.id)}
                strokeWidth="2"
                filter="url(#unifiedNodeShadow)"
              />
              <text
                x={node.nodeX}
                y={node.nodeY - 8}
                fill="#f1f5f9"
                fontSize="24"
                fontWeight="800"
                textAnchor="middle"
              >
                {node.title}
              </text>
              <text
                x={node.nodeX}
                y={node.nodeY + 16}
                fill="#64748b"
                fontSize="12"
                textAnchor="middle"
              >
                {node.subtitle}
              </text>
            </g>
          ))}

          <text x="600" y="690" fill="#64748b" fontSize="12" textAnchor="middle">
            <tspan>- - - - Physical Bus (PCIe/DMI) | </tspan>
            <tspan fill="#38bdf8" fontWeight="700">Cyan text</tspan>
            <tspan> = port / channel detail</tspan>
          </text>
        </svg>
      </div>

      <style>{`
        @keyframes dashFlow {
          to {
            stroke-dashoffset: -22;
          }
        }
        .dash-flow {
          animation: dashFlow 1.7s linear infinite;
        }
      `}</style>
    </section>
  );
}
