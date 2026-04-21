import { useMemo, useState } from "react";
import { Route, Routes } from "react-router-dom";
import { AppContext } from "./context";
import { Layout } from "./components/Layout";
import { Overview } from "./pages/Overview";
import { DNAs } from "./pages/DNAs";
import { Agents } from "./pages/Agents";
import { Warrants } from "./pages/Warrants";
import { Metrics } from "./pages/Metrics";
import { Alerts } from "./pages/Alerts";
import { Diff } from "./pages/Diff";

const STORAGE_KEY = "watchtower.observerId";

export function App() {
  const [observerId, setObserverIdState] = useState<string | null>(
    () => localStorage.getItem(STORAGE_KEY) || null,
  );
  const ctx = useMemo(
    () => ({
      observerId,
      setObserverId: (id: string | null) => {
        setObserverIdState(id);
        if (id) localStorage.setItem(STORAGE_KEY, id);
        else localStorage.removeItem(STORAGE_KEY);
      },
    }),
    [observerId],
  );
  return (
    <AppContext.Provider value={ctx}>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Overview />} />
          <Route path="dnas" element={<DNAs />} />
          <Route path="agents" element={<Agents />} />
          <Route path="warrants" element={<Warrants />} />
          <Route path="metrics" element={<Metrics />} />
          <Route path="alerts" element={<Alerts />} />
          <Route path="diff" element={<Diff />} />
        </Route>
      </Routes>
    </AppContext.Provider>
  );
}
