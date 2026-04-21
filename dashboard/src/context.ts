import { createContext, useContext } from "react";

export interface AppContextValue {
  observerId: string | null;
  setObserverId: (id: string | null) => void;
}

export const AppContext = createContext<AppContextValue>({
  observerId: null,
  setObserverId: () => {},
});

export function useAppContext(): AppContextValue {
  return useContext(AppContext);
}
