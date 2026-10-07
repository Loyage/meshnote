import { create } from "zustand";

interface Navigation {
  meshId: string | null;
  nodeId: string | null;
  focusVersion: number;
  query: string;
  openMesh: (meshId: string, nodeId?: string | null) => void;
  selectNode: (nodeId: string) => void;
  focus: () => void;
  setQuery: (query: string) => void;
}
export const useNavigation = create<Navigation>((set) => ({
  meshId: null,
  nodeId: null,
  focusVersion: 0,
  query: "",
  openMesh: (meshId, nodeId = null) =>
    set((state) => ({ meshId, nodeId, focusVersion: state.focusVersion + 1 })),
  selectNode: (nodeId) =>
    set((state) => ({ nodeId, focusVersion: state.focusVersion + 1 })),
  focus: () => set((state) => ({ focusVersion: state.focusVersion + 1 })),
  setQuery: (query) => set({ query }),
}));
