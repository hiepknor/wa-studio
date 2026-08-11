import React from "react";
import ReactDOM from "react-dom/client";

import "./fonts.css";
import "./styles/tokens.css";
import "./styles/scrollbars.css";
import { App } from "./app/App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
