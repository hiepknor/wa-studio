import React from "react";
import ReactDOM from "react-dom/client";

import "../fonts.css";
import "../styles/tokens.css";
import "../styles/scrollbars.css";
import "../styles/motion.css";
import "../styles/focus.css";
import { installFocusModality } from "../app/installFocusModality";
import { ToastProvider } from "../shared/ui/Toast";
import { DesignSystemGallery } from "./DesignSystemGallery";
import "./design-system-gallery.css";

installFocusModality(document);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ToastProvider>
      <DesignSystemGallery />
    </ToastProvider>
  </React.StrictMode>,
);
