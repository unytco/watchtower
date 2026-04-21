import { Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { DnaList } from "./pages/DnaList";
import { DnaDetail } from "./pages/DnaDetail";
import { DnaOverview } from "./pages/dna/Overview";
import { DnaAgents } from "./pages/dna/Agents";
import { DnaWarrants } from "./pages/dna/Warrants";
import { DnaObservers } from "./pages/dna/Observers";
import { DnaMetrics } from "./pages/dna/Metrics";
import { DnaDiff } from "./pages/dna/Diff";
import { Alerts } from "./pages/Alerts";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<DnaList />} />
        <Route path="dnas/:dna" element={<DnaDetail />}>
          <Route index element={<DnaOverview />} />
          <Route path="agents" element={<DnaAgents />} />
          <Route path="warrants" element={<DnaWarrants />} />
          <Route path="observers" element={<DnaObservers />} />
          <Route path="metrics" element={<DnaMetrics />} />
          <Route path="diff" element={<DnaDiff />} />
        </Route>
        <Route path="alerts" element={<Alerts />} />
      </Route>
    </Routes>
  );
}
