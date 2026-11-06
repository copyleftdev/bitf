import { layoutNetwork, type NetworkEdge } from "./networkLayout";
self.onmessage = (
  event: MessageEvent<{
    revision: number;
    ids: string[];
    edges: NetworkEdge[];
  }>,
) => {
  const { revision, ids, edges } = event.data;
  self.postMessage({ revision, points: layoutNetwork(ids, edges) });
};
