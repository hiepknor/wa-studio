import React from "react";
import ReactDOM from "react-dom/client";

import "./fonts.css";
import "./styles/tokens.css";
import "./styles/scrollbars.css";
import { App } from "./app/App";
import "./styles/focus.css";
import { installFocusModality } from "./app/installFocusModality";
import { installHmrContextRecovery } from "./app/installHmrContextRecovery";

installFocusModality(document);

if (import.meta.hot) {
  const disposeHmrRecovery = installHmrContextRecovery(import.meta.hot);
  import.meta.hot.dispose(disposeHmrRecovery);
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
