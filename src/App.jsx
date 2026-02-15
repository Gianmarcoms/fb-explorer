import { useState, useCallback, useMemo, useRef, useEffect } from "react";

// --- Constants & Config ---
const ZONES = ["FR", "DE", "NL", "BE"];
const ZONE_COLORS = {
  FR: "#2563eb",
  DE: "#dc2626",
  NL: "#f59e0b",
  BE: "#16a34a",
};
const ZONE_FULL = {
  FR: "France",
  DE: "Germany",
  NL: "Netherlands",
  BE: "Belgium",
};

const CRITICAL_BRANCHES = [
  { id: "CB1", name: "FR→DE interconnector", fmax: 3000 },
  { id: "CB2", name: "DE→NL interconnector", fmax: 2500 },
  { id: "CB3", name: "NL→BE internal line", fmax: 2000 },
  { id: "CB4", name: "BE→FR interconnector", fmax: 1800 },
  { id: "CB5", name: "FR→NL (loop flow path)", fmax: 1500 },
];

// Default PTDFs: how 1 MW net export in zone X affects each CB
const DEFAULT_PTDFS = {
  CB1: { FR: 0.4, DE: -0.35, NL: -0.05, BE: 0.0 },
  CB2: { FR: 0.1, DE: 0.45, NL: -0.4, BE: -0.15 },
  CB3: { FR: 0.05, DE: 0.1, NL: 0.35, BE: -0.5 },
  CB4: { FR: -0.35, DE: 0.05, NL: 0.1, BE: 0.2 },
  CB5: { FR: 0.25, DE: -0.1, NL: -0.2, BE: 0.05 },
};

const DEFAULT_RAMS = {
  CB1: 1800,
  CB2: 1500,
  CB3: 1200,
  CB4: 1000,
  CB5: 800,
};

// --- Utility: compute flow-based domain polygon for 2 zones ---
// Each constraint: ptdf_x * Px + ptdf_y * Py <= RAM  (and >= -RAM for reverse)
function computeDomainPolygon(ptdfs, rams, xZone, yZone, range = 4000) {
  // Collect half-plane constraints
  const constraints = [];
  for (const cb of CRITICAL_BRANCHES) {
    const px = ptdfs[cb.id][xZone];
    const py = ptdfs[cb.id][yZone];
    const ram = rams[cb.id];
    // Forward: px*X + py*Y <= ram
    constraints.push({ a: px, b: py, c: ram, cb: cb.id, dir: "fwd" });
    // Reverse: -px*X - py*Y <= ram  (i.e. px*X + py*Y >= -ram)
    constraints.push({ a: -px, b: -py, c: ram, cb: cb.id, dir: "rev" });
  }

  // Start with a large bounding box
  let polygon = [
    [-range, -range],
    [range, -range],
    [range, range],
    [-range, range],
  ];

  for (const con of constraints) {
    polygon = clipPolygon(polygon, con.a, con.b, con.c);
    if (polygon.length < 3) return [];
  }
  return polygon;
}

// Sutherland-Hodgman polygon clipping against half-plane ax + by <= c
function clipPolygon(polygon, a, b, c) {
  if (polygon.length === 0) return [];
  const output = [];
  for (let i = 0; i < polygon.length; i++) {
    const curr = polygon[i];
    const next = polygon[(i + 1) % polygon.length];
    const currInside = a * curr[0] + b * curr[1] <= c + 0.001;
    const nextInside = a * next[0] + b * next[1] <= c + 0.001;
    if (currInside) {
      output.push(curr);
      if (!nextInside) {
        output.push(intersect(curr, next, a, b, c));
      }
    } else if (nextInside) {
      output.push(intersect(curr, next, a, b, c));
    }
  }
  return output;
}

function intersect(p1, p2, a, b, c) {
  const d1 = a * p1[0] + b * p1[1] - c;
  const d2 = a * p2[0] + b * p2[1] - c;
  const t = d1 / (d1 - d2);
  return [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])];
}

// --- Components ---

function Tabs({ tabs, active, onChange }) {
  return (
    <div style={{
      display: "flex", gap: 0, borderBottom: "2px solid #1a1a2e",
      marginBottom: 24, flexWrap: "wrap"
    }}>
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          style={{
            padding: "10px 20px",
            background: active === t.id ? "#1a1a2e" : "transparent",
            color: active === t.id ? "#e0e0e0" : "#666",
            border: "none",
            borderBottom: active === t.id ? "2px solid #6ee7b7" : "2px solid transparent",
            cursor: "pointer",
            fontFamily: "'DM Mono', monospace",
            fontSize: 13,
            fontWeight: active === t.id ? 600 : 400,
            letterSpacing: "0.03em",
            transition: "all 0.2s",
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function Slider({ label, value, min, max, step, onChange, color }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        marginBottom: 3, fontFamily: "'DM Mono', monospace", fontSize: 12
      }}>
        <span style={{ color: "#aaa" }}>{label}</span>
        <span style={{
          color: color || "#6ee7b7", fontWeight: 600,
          background: "rgba(110,231,183,0.08)", padding: "2px 8px",
          borderRadius: 4, fontSize: 12
        }}>
          {typeof value === "number" ? (Math.abs(value) < 1 ? value.toFixed(2) : Math.round(value) + " MW") : value}
        </span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ width: "100%", accentColor: color || "#6ee7b7", height: 4 }}
      />
    </div>
  );
}

// Domain visualization using canvas
function DomainCanvas({ ptdfs, rams, xZone, yZone, operatingPoint }) {
  const canvasRef = useRef(null);
  const W = 460, H = 420;
  const margin = 50;
  const scale = (H - 2 * margin) / 8000; // -4000 to 4000
  const cx = W / 2, cy = H / 2;

  const toCanvas = useCallback((x, y) => [
    cx + x * scale,
    cy - y * scale, // flip y
  ], [cx, cy, scale]);

  const polygon = useMemo(
    () => computeDomainPolygon(ptdfs, rams, xZone, yZone),
    [ptdfs, rams, xZone, yZone]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";

    // Background
    ctx.fillStyle = "#0d0d1a";
    ctx.fillRect(0, 0, W, H);

    // Grid
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    for (let v = -4000; v <= 4000; v += 1000) {
      const [gx] = toCanvas(v, 0);
      const [, gy] = toCanvas(0, v);
      ctx.beginPath(); ctx.moveTo(gx, margin); ctx.lineTo(gx, H - margin); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(margin, gy); ctx.lineTo(W - margin, gy); ctx.stroke();
    }

    // Axes
    ctx.strokeStyle = "rgba(255,255,255,0.2)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(margin, cy); ctx.lineTo(W - margin, cy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, margin); ctx.lineTo(cx, H - margin); ctx.stroke();

    // Axis labels
    ctx.fillStyle = "#888";
    ctx.font = "11px 'DM Mono', monospace";
    ctx.textAlign = "center";
    ctx.fillText(`${xZone} net position (MW)`, W / 2, H - 10);
    ctx.save();
    ctx.translate(14, H / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(`${yZone} net position (MW)`, 0, 0);
    ctx.restore();

    // Tick labels
    ctx.fillStyle = "#555";
    ctx.font = "9px 'DM Mono', monospace";
    ctx.textAlign = "center";
    for (let v = -3000; v <= 3000; v += 1000) {
      if (v === 0) continue;
      const [tx] = toCanvas(v, 0);
      ctx.fillText(v.toString(), tx, cy + 14);
      const [, ty] = toCanvas(0, v);
      ctx.fillText(v.toString(), cx - 20, ty + 4);
    }

    // Draw individual constraint lines (faintly)
    for (const cb of CRITICAL_BRANCHES) {
      const px = ptdfs[cb.id][xZone];
      const py = ptdfs[cb.id][yZone];
      const ram = rams[cb.id];
      // px*x + py*y = ram
      if (Math.abs(py) > 0.001) {
        const x1 = -4000, y1 = (ram - px * x1) / py;
        const x2 = 4000, y2 = (ram - px * x2) / py;
        const [cx1, cy1] = toCanvas(x1, y1);
        const [cx2, cy2] = toCanvas(x2, y2);
        ctx.strokeStyle = "rgba(110,231,183,0.12)";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(cx1, cy1); ctx.lineTo(cx2, cy2); ctx.stroke();
        ctx.setLineDash([]);
      } else if (Math.abs(px) > 0.001) {
        const xv = ram / px;
        const [lx, ly1c] = toCanvas(xv, -4000);
        const [, ly2c] = toCanvas(xv, 4000);
        ctx.strokeStyle = "rgba(110,231,183,0.12)";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(lx, ly1c); ctx.lineTo(lx, ly2c); ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Domain polygon
    if (polygon.length >= 3) {
      ctx.beginPath();
      const [sx, sy] = toCanvas(polygon[0][0], polygon[0][1]);
      ctx.moveTo(sx, sy);
      for (let i = 1; i < polygon.length; i++) {
        const [px, py] = toCanvas(polygon[i][0], polygon[i][1]);
        ctx.lineTo(px, py);
      }
      ctx.closePath();

      // Fill
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 200);
      grad.addColorStop(0, "rgba(110,231,183,0.18)");
      grad.addColorStop(1, "rgba(110,231,183,0.04)");
      ctx.fillStyle = grad;
      ctx.fill();

      // Stroke
      ctx.strokeStyle = "#6ee7b7";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Operating point
    if (operatingPoint) {
      const [opx, opy] = toCanvas(operatingPoint[0], operatingPoint[1]);
      // Check if inside domain
      let inside = true;
      for (const cb of CRITICAL_BRANCHES) {
        const px = ptdfs[cb.id][xZone];
        const py = ptdfs[cb.id][yZone];
        const ram = rams[cb.id];
        const flow = px * operatingPoint[0] + py * operatingPoint[1];
        if (Math.abs(flow) > ram + 1) { inside = false; break; }
      }

      ctx.beginPath();
      ctx.arc(opx, opy, 7, 0, Math.PI * 2);
      ctx.fillStyle = inside ? "#6ee7b7" : "#ef4444";
      ctx.fill();
      ctx.strokeStyle = inside ? "#fff" : "#fca5a5";
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = inside ? "#6ee7b7" : "#ef4444";
      ctx.font = "bold 11px 'DM Mono', monospace";
      ctx.textAlign = "left";
      ctx.fillText(
        inside ? "✓ feasible" : "✗ infeasible",
        opx + 12, opy + 4
      );
    }

    // Legend
    ctx.fillStyle = "#6ee7b7";
    ctx.font = "bold 11px 'DM Mono', monospace";
    ctx.textAlign = "left";
    ctx.fillText("Flow-Based Domain", margin + 4, margin - 10);
    ctx.fillStyle = "#666";
    ctx.font = "10px 'DM Mono', monospace";
    ctx.fillText("All feasible net position combinations", margin + 4, margin + 4);

  }, [polygon, ptdfs, rams, xZone, yZone, operatingPoint, toCanvas]);

  return <canvas ref={canvasRef} style={{ borderRadius: 8, width: W, height: H, maxWidth: "100%" }} />;
}

// RAM breakdown bar
function RAMBar({ cb, fmax, frm, fref, fav, ram }) {
  const total = fmax;
  const usedByRef = Math.abs(fref);
  const usedByFRM = frm;
  const usedByFAV = fav;
  const remaining = Math.max(0, ram);
  const barW = 320;
  const s = barW / total;

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{
        fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#aaa",
        marginBottom: 4, display: "flex", justifyContent: "space-between"
      }}>
        <span>{cb.name}</span>
        <span style={{ color: "#6ee7b7" }}>RAM = {Math.round(remaining)} MW</span>
      </div>
      <div style={{
        display: "flex", height: 22, borderRadius: 4, overflow: "hidden",
        background: "#1a1a2e", width: barW, maxWidth: "100%"
      }}>
        <div style={{ width: usedByRef * s, background: "#dc2626", opacity: 0.7 }}
          title={`F_ref: ${Math.round(usedByRef)} MW`} />
        <div style={{ width: usedByFRM * s, background: "#f59e0b", opacity: 0.7 }}
          title={`FRM: ${Math.round(usedByFRM)} MW`} />
        <div style={{ width: usedByFAV * s, background: "#8b5cf6", opacity: 0.7 }}
          title={`FAV: ${Math.round(usedByFAV)} MW`} />
        <div style={{ width: remaining * s, background: "#6ee7b7", opacity: 0.5 }}
          title={`RAM: ${Math.round(remaining)} MW`} />
      </div>
      <div style={{
        display: "flex", gap: 12, marginTop: 3,
        fontFamily: "'DM Mono', monospace", fontSize: 9, color: "#666"
      }}>
        <span>Fmax: {total}</span>
      </div>
    </div>
  );
}

// PTDF heatmap
function PTDFHeatmap({ ptdfs }) {
  const maxVal = 0.5;
  const getColor = (v) => {
    if (v > 0) {
      const t = Math.min(v / maxVal, 1);
      return `rgba(110,231,183,${0.15 + t * 0.65})`;
    } else {
      const t = Math.min(-v / maxVal, 1);
      return `rgba(239,68,68,${0.15 + t * 0.65})`;
    }
  };

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{
        borderCollapse: "collapse", fontFamily: "'DM Mono', monospace", fontSize: 12
      }}>
        <thead>
          <tr>
            <th style={{ padding: "8px 12px", color: "#666", textAlign: "left", borderBottom: "1px solid #333" }}>
              CB \ Zone
            </th>
            {ZONES.map((z) => (
              <th key={z} style={{
                padding: "8px 14px", color: ZONE_COLORS[z],
                textAlign: "center", borderBottom: "1px solid #333", fontWeight: 700
              }}>
                {z}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {CRITICAL_BRANCHES.map((cb) => (
            <tr key={cb.id}>
              <td style={{
                padding: "6px 12px", color: "#aaa", fontSize: 11,
                borderBottom: "1px solid #1a1a2e", whiteSpace: "nowrap"
              }}>
                {cb.id}: {cb.name}
              </td>
              {ZONES.map((z) => (
                <td key={z} style={{
                  padding: "6px 14px", textAlign: "center",
                  background: getColor(ptdfs[cb.id][z]),
                  color: "#e0e0e0", fontWeight: 600,
                  borderBottom: "1px solid #1a1a2e", borderRadius: 2
                }}>
                  {ptdfs[cb.id][z] > 0 ? "+" : ""}{ptdfs[cb.id][z].toFixed(2)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{
        display: "flex", gap: 16, marginTop: 10,
        fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#666"
      }}>
        <span><span style={{ color: "#6ee7b7" }}>■</span> Positive = export loads this branch</span>
        <span><span style={{ color: "#ef4444" }}>■</span> Negative = export relieves this branch</span>
      </div>
    </div>
  );
}

// Info button component
function InfoButton({ isOpen, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: 18, height: 18, borderRadius: "50%",
        background: isOpen ? "#6ee7b7" : "transparent",
        border: `1.5px solid ${isOpen ? "#6ee7b7" : "#555"}`,
        color: isOpen ? "#111122" : "#888",
        fontSize: 11, fontWeight: 700,
        fontFamily: "'DM Mono', monospace",
        cursor: "pointer", display: "inline-flex",
        alignItems: "center", justifyContent: "center",
        marginLeft: 6, padding: 0,
        transition: "all 0.2s",
        flexShrink: 0,
      }}
      title="Show calculation breakdown"
    >
      i
    </button>
  );
}

// Step-by-step calculation panel for a single CB
function CalcBreakdown({ cbId, ptdfs, netPos }) {
  // Compute each zone's contribution
  const terms = ZONES.map((z) => {
    const ptdf = ptdfs[cbId][z];
    const np = netPos[z];
    const contribution = ptdf * np;
    return { zone: z, ptdf, np, contribution };
  });
  const total = terms.reduce((s, t) => s + t.contribution, 0);

  // Format a number with explicit sign
  const signed = (v, decimals = 0) => {
    const abs = decimals > 0 ? Math.abs(v).toFixed(decimals) : Math.abs(Math.round(v));
    return v >= 0 ? `+${abs}` : `−${abs}`;
  };

  return (
    <div style={{
      background: "#141428", borderRadius: 6, padding: "10px 14px",
      marginTop: 4, marginBottom: 4,
      borderLeft: "2px solid #6ee7b7",
      fontFamily: "'DM Mono', monospace", fontSize: 11, lineHeight: 1.9,
    }}>
      {/* Formula */}
      <div style={{ color: "#888", marginBottom: 6 }}>
        Flow = Σ (PTDF<sub>zone</sub> × NP<sub>zone</sub>)
      </div>

      {/* Each zone's row */}
      {terms.map((t, i) => (
        <div key={t.zone} style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ color: "#666", width: 14 }}>{i === 0 ? "=" : "+"}</span>
          <span style={{ color: t.ptdf >= 0 ? "#6ee7b7" : "#ef4444", width: 48, textAlign: "right" }}>
            {signed(t.ptdf, 2)}
          </span>
          <span style={{ color: "#555" }}>×</span>
          <span style={{ color: ZONE_COLORS[t.zone], width: 60, textAlign: "right" }}>
            {t.np >= 0 ? "+" : ""}{Math.round(t.np)}
          </span>
          <span style={{ color: "#555", marginLeft: 4 }}>=</span>
          <span style={{
            color: t.contribution >= 0 ? "rgba(110,231,183,0.8)" : "rgba(239,68,68,0.8)",
            width: 56, textAlign: "right", fontWeight: 600
          }}>
            {signed(t.contribution)}
          </span>
          <span style={{ color: "#555", marginLeft: 8, fontSize: 10 }}>
            ({t.zone})
          </span>
        </div>
      ))}

      {/* Total */}
      <div style={{
        borderTop: "1px solid #2a2a3e", marginTop: 6, paddingTop: 6,
        display: "flex", alignItems: "center", gap: 4
      }}>
        <span style={{ color: "#666", width: 14 }}>=</span>
        <span style={{ color: "#e0e0e0", fontWeight: 700, fontSize: 12 }}>
          {Math.round(total)} MW
        </span>
        <span style={{ color: "#555", fontSize: 10, marginLeft: 8 }}>
          total flow on this branch
        </span>
      </div>
    </div>
  );
}

// Flow impact calculator
function FlowCalculator({ ptdfs, rams }) {
  const [netPos, setNetPos] = useState({ FR: 500, DE: -300, NL: -100, BE: -100 });
  const [expandedCB, setExpandedCB] = useState(null);

  const flows = useMemo(() => {
    return CRITICAL_BRANCHES.map((cb) => {
      let flow = 0;
      for (const z of ZONES) {
        flow += ptdfs[cb.id][z] * netPos[z];
      }
      return { ...cb, flow, ram: rams[cb.id], pct: Math.abs(flow) / rams[cb.id] * 100 };
    });
  }, [ptdfs, rams, netPos]);

  const balanceCheck = ZONES.reduce((s, z) => s + netPos[z], 0);

  return (
    <div>
      <div style={{
        fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#888",
        marginBottom: 12, padding: "8px 12px", background: "#1a1a2e", borderRadius: 6
      }}>
        Set each zone's net position (positive = net exporter, negative = net importer).
        The sum should be zero for energy balance.
        {Math.abs(balanceCheck) > 1 && (
          <span style={{ color: "#f59e0b", marginLeft: 8 }}>
            ⚠ Imbalance: {balanceCheck > 0 ? "+" : ""}{Math.round(balanceCheck)} MW
          </span>
        )}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 20px", marginBottom: 20 }}>
        {ZONES.map((z) => (
          <Slider
            key={z}
            label={`${ZONE_FULL[z]} (${z})`}
            value={netPos[z]}
            min={-3000} max={3000} step={50}
            onChange={(v) => setNetPos((p) => ({ ...p, [z]: v }))}
            color={ZONE_COLORS[z]}
          />
        ))}
      </div>

      <div style={{
        fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#aaa", marginBottom: 8,
        display: "flex", alignItems: "center", gap: 8
      }}>
        Resulting flows on each critical branch:
        <span style={{ fontSize: 10, color: "#555" }}>
          (click <span style={{
            display: "inline-flex", width: 14, height: 14, borderRadius: "50%",
            border: "1.5px solid #555", alignItems: "center", justifyContent: "center",
            fontSize: 9, fontWeight: 700, color: "#888", position: "relative", top: 1
          }}>i</span> to see calculation)
        </span>
      </div>
      {flows.map((f) => {
        const overloaded = Math.abs(f.flow) > f.ram;
        const isExpanded = expandedCB === f.id;
        return (
          <div key={f.id} style={{ marginBottom: isExpanded ? 14 : 10 }}>
            <div style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              fontFamily: "'DM Mono', monospace", fontSize: 11, marginBottom: 2
            }}>
              <span style={{ color: "#aaa", display: "flex", alignItems: "center" }}>
                {f.id}: {f.name}
                <InfoButton
                  isOpen={isExpanded}
                  onClick={() => setExpandedCB(isExpanded ? null : f.id)}
                />
              </span>
              <span style={{ color: overloaded ? "#ef4444" : "#6ee7b7", fontWeight: 600 }}>
                {Math.round(f.flow)} / {f.ram} MW {overloaded ? "⚠ OVERLOAD" : "✓"}
              </span>
            </div>
            <div style={{
              height: 12, background: "#1a1a2e", borderRadius: 3, overflow: "hidden", position: "relative"
            }}>
              <div style={{
                height: "100%",
                width: `${Math.min(f.pct, 100)}%`,
                background: f.pct > 100 ? "#ef4444" : f.pct > 80 ? "#f59e0b" : "#6ee7b7",
                borderRadius: 3,
                transition: "width 0.2s, background 0.2s"
              }} />
              {f.pct > 100 && (
                <div style={{
                  position: "absolute", right: 4, top: 0, height: "100%",
                  display: "flex", alignItems: "center",
                  fontSize: 9, color: "#fff", fontWeight: 700
                }}>
                  {Math.round(f.pct)}%
                </div>
              )}
            </div>
            {/* Expandable calculation breakdown */}
            {isExpanded && (
              <CalcBreakdown cbId={f.id} ptdfs={ptdfs} netPos={netPos} />
            )}
          </div>
        );
      })}
    </div>
  );
}


// --- Main App ---
export default function FlowBasedExplorer() {
  const [tab, setTab] = useState("domain");
  const [rams, setRams] = useState({ ...DEFAULT_RAMS });
  const [xZone, setXZone] = useState("FR");
  const [yZone, setYZone] = useState("DE");
  const [opX, setOpX] = useState(800);
  const [opY, setOpY] = useState(-500);
  const [showOp, setShowOp] = useState(true);

  // RAM breakdown values (for visualization)
  const ramBreakdown = useMemo(() => {
    return CRITICAL_BRANCHES.map((cb) => {
      const fmax = cb.fmax;
      const frm = fmax * 0.1;
      const fref = fmax * 0.25;
      const fav = fmax * 0.05;
      const ram = fmax - frm - fref - fav;
      return { cb, fmax, frm, fref, fav, ram };
    });
  }, []);

  const tabs = [
    { id: "domain", label: "⬡ FB Domain" },
    { id: "ptdf", label: "◫ PTDF Matrix" },
    { id: "ram", label: "▮ RAM Breakdown" },
    { id: "calc", label: "⚡ Flow Calculator" },
  ];

  return (
    <div style={{
      minHeight: "100vh",
      background: "#111122",
      color: "#e0e0e0",
      fontFamily: "'DM Sans', 'Segoe UI', sans-serif",
      padding: "24px 20px",
    }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet" />

      <div style={{ maxWidth: 820, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ marginBottom: 28 }}>
          <h1 style={{
            fontFamily: "'DM Mono', monospace", fontSize: 22, fontWeight: 700,
            color: "#6ee7b7", margin: 0, letterSpacing: "-0.02em"
          }}>
            Flow-Based Market Coupling
          </h1>
          <p style={{
            fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#666",
            margin: "6px 0 0"
          }}>
            Interactive explorer — EU Day-Ahead capacity allocation
          </p>
        </div>

        <Tabs tabs={tabs} active={tab} onChange={setTab} />

        {/* --- DOMAIN TAB --- */}
        {tab === "domain" && (
          <div>
            <p style={{ fontSize: 13, color: "#999", lineHeight: 1.7, marginBottom: 16, fontFamily: "'DM Mono', monospace" }}>
              The <strong style={{ color: "#6ee7b7" }}>flow-based domain</strong> is the set of all
              feasible combinations of zone net positions. Each edge is a constraint from one critical
              branch. Adjust the RAM sliders to see how the domain expands or contracts.
              Drag the operating point to check feasibility.
            </p>

            <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
              <div>
                {/* Zone selector */}
                <div style={{
                  display: "flex", gap: 12, marginBottom: 12,
                  fontFamily: "'DM Mono', monospace", fontSize: 11
                }}>
                  <div>
                    <span style={{ color: "#666" }}>X-axis: </span>
                    <select value={xZone} onChange={(e) => setXZone(e.target.value)}
                      style={{
                        background: "#1a1a2e", color: ZONE_COLORS[xZone],
                        border: "1px solid #333", borderRadius: 4, padding: "2px 6px",
                        fontFamily: "'DM Mono', monospace", fontSize: 11
                      }}>
                      {ZONES.filter((z) => z !== yZone).map((z) => (
                        <option key={z} value={z}>{z}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <span style={{ color: "#666" }}>Y-axis: </span>
                    <select value={yZone} onChange={(e) => setYZone(e.target.value)}
                      style={{
                        background: "#1a1a2e", color: ZONE_COLORS[yZone],
                        border: "1px solid #333", borderRadius: 4, padding: "2px 6px",
                        fontFamily: "'DM Mono', monospace", fontSize: 11
                      }}>
                      {ZONES.filter((z) => z !== xZone).map((z) => (
                        <option key={z} value={z}>{z}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <DomainCanvas
                  ptdfs={DEFAULT_PTDFS}
                  rams={rams}
                  xZone={xZone}
                  yZone={yZone}
                  operatingPoint={showOp ? [opX, opY] : null}
                />
              </div>

              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{
                  fontFamily: "'DM Mono', monospace", fontSize: 11,
                  color: "#6ee7b7", marginBottom: 8, fontWeight: 600
                }}>
                  RAM per Critical Branch
                </div>
                {CRITICAL_BRANCHES.map((cb) => (
                  <Slider
                    key={cb.id}
                    label={`${cb.id}: ${cb.name}`}
                    value={rams[cb.id]}
                    min={0} max={cb.fmax} step={50}
                    onChange={(v) => setRams((p) => ({ ...p, [cb.id]: v }))}
                  />
                ))}

                <div style={{
                  borderTop: "1px solid #222", paddingTop: 12, marginTop: 12
                }}>
                  <div style={{
                    fontFamily: "'DM Mono', monospace", fontSize: 11,
                    color: "#6ee7b7", marginBottom: 8, fontWeight: 600
                  }}>
                    Operating Point
                  </div>
                  <label style={{
                    fontFamily: "'DM Mono', monospace", fontSize: 11,
                    color: "#888", display: "flex", alignItems: "center", gap: 6, marginBottom: 8
                  }}>
                    <input type="checkbox" checked={showOp}
                      onChange={(e) => setShowOp(e.target.checked)}
                      style={{ accentColor: "#6ee7b7" }} />
                    Show operating point
                  </label>
                  {showOp && (
                    <>
                      <Slider
                        label={`${xZone} position`}
                        value={opX} min={-3000} max={3000} step={50}
                        onChange={setOpX} color={ZONE_COLORS[xZone]}
                      />
                      <Slider
                        label={`${yZone} position`}
                        value={opY} min={-3000} max={3000} step={50}
                        onChange={setOpY} color={ZONE_COLORS[yZone]}
                      />
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* --- PTDF TAB --- */}
        {tab === "ptdf" && (
          <div>
            <p style={{ fontSize: 13, color: "#999", lineHeight: 1.7, marginBottom: 16, fontFamily: "'DM Mono', monospace" }}>
              The <strong style={{ color: "#6ee7b7" }}>PTDF matrix</strong> shows how each MW of net
              export from a zone loads each critical branch. A value of +0.35 means 35% of the
              exported power flows through that branch. Negative values mean the export
              <em> relieves</em> that branch.
            </p>
            <PTDFHeatmap ptdfs={DEFAULT_PTDFS} />
            <div style={{
              marginTop: 20, padding: 14, background: "#1a1a2e", borderRadius: 8,
              fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#888", lineHeight: 1.8
            }}>
              <strong style={{ color: "#6ee7b7" }}>Reading this table:</strong> If France (FR)
              increases net exports by 100 MW, CB1 (FR→DE interconnector) sees +40 MW of additional flow
              (PTDF = +0.40), while CB4 (BE→FR) sees −35 MW of flow relief (PTDF = −0.35). This is
              because power follows physical paths, not commercial contracts — the loop flow effect.
            </div>
          </div>
        )}

        {/* --- RAM TAB --- */}
        {tab === "ram" && (
          <div>
            <p style={{ fontSize: 13, color: "#999", lineHeight: 1.7, marginBottom: 16, fontFamily: "'DM Mono', monospace" }}>
              <strong style={{ color: "#6ee7b7" }}>RAM (Remaining Available Margin)</strong> is the
              capacity left on each critical branch for cross-zonal trade, after subtracting reference
              flows, reliability margins, and long-term allocations from the thermal limit.
            </p>
            <div style={{
              display: "flex", gap: 16, marginBottom: 16, flexWrap: "wrap",
              fontFamily: "'DM Mono', monospace", fontSize: 10
            }}>
              <span><span style={{ display: "inline-block", width: 10, height: 10, background: "#dc2626", opacity: 0.7, borderRadius: 2, marginRight: 4 }} />F_ref (reference flow)</span>
              <span><span style={{ display: "inline-block", width: 10, height: 10, background: "#f59e0b", opacity: 0.7, borderRadius: 2, marginRight: 4 }} />FRM (reliability margin)</span>
              <span><span style={{ display: "inline-block", width: 10, height: 10, background: "#8b5cf6", opacity: 0.7, borderRadius: 2, marginRight: 4 }} />FAV (long-term alloc.)</span>
              <span><span style={{ display: "inline-block", width: 10, height: 10, background: "#6ee7b7", opacity: 0.5, borderRadius: 2, marginRight: 4 }} />RAM (available for DA)</span>
            </div>
            {ramBreakdown.map((r) => (
              <RAMBar key={r.cb.id} {...r} />
            ))}
            <div style={{
              marginTop: 16, padding: 14, background: "#1a1a2e", borderRadius: 8,
              fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#888", lineHeight: 1.8
            }}>
              <strong style={{ color: "#6ee7b7" }}>Formula:</strong> RAM = F<sub>max</sub> − F<sub>ref</sub> − FRM − FAV
              <br />
              The larger the RAM, the more cross-zonal trade the market algorithm can allocate.
              The 70% minRAM rule in EU regulation requires that at least 70% of F<sub>max</sub> is
              offered as cross-zonal capacity.
            </div>
          </div>
        )}

        {/* --- CALCULATOR TAB --- */}
        {tab === "calc" && (
          <div>
            <p style={{ fontSize: 13, color: "#999", lineHeight: 1.7, marginBottom: 16, fontFamily: "'DM Mono', monospace" }}>
              Set net positions for each zone to see the <strong style={{ color: "#6ee7b7" }}>resulting
              physical flows</strong> on each critical branch. This is the core calculation EUPHEMIA
              performs — checking that the sum of (PTDF × net position) stays within RAM limits.
            </p>
            <FlowCalculator ptdfs={DEFAULT_PTDFS} rams={DEFAULT_RAMS} />
          </div>
        )}

        {/* Footer */}
        <div style={{
          marginTop: 32, paddingTop: 16, borderTop: "1px solid #1a1a2e",
          fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#444",
          textAlign: "center"
        }}>
          Illustrative model with simplified values — actual CWE/Core FB parameters differ
        </div>
      </div>
    </div>
  );
}
