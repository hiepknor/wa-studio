import React from "react";
import ReactDOM from "react-dom/client";
import "@hiepknor/ink-react/styles.css";

import { App } from "./app/App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
