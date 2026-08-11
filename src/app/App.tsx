import { InkProvider } from "@hiepknor/ink-react";

import { ConnectionScreen } from "@/features/connection/ConnectionScreen";
import "./app.css";

export function App() {
  return (
    <InkProvider density="compact">
      <ConnectionScreen />
    </InkProvider>
  );
}
