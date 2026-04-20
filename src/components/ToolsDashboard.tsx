import DashboardShell from "./shared/DashboardShell";
import TradingPanel from "./TradingPanel";
import OrderFlowPanel from "./OrderFlowPanel";
import VolDivergencePanel from "./VolDivergencePanel";
import ApexWalletsPanel from "./ApexWalletsPanel";
import CondProbPanel from "./CondProbPanel";
import SignalCombinerPanel from "./SignalCombinerPanel";
import ArbMatrixPanel from "./ArbMatrixPanel";

// Lazy import inline tabs (these were originally in Dashboard.tsx)
// For now we import Dashboard and use it as the tools view,
// or we extract them. Since extraction is complex (Swarm has 230 lines),
// we re-export Dashboard's inline tabs by importing Dashboard itself.
// Actually, to keep it simple, we import the original Dashboard component
// which already has all these tabs.

// Simpler approach: since Dashboard.tsx still exists and works,
// just render it directly for /tools.
import Dashboard from "./Dashboard";

export default function ToolsDashboard() {
  return <Dashboard />;
}
