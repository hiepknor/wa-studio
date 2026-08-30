import ReactDOM from "react-dom/client";

import "../fonts.css";
import "../styles/tokens.css";
import "../styles/scrollbars.css";
import "../styles/motion.css";
import "../styles/focus.css";
import "../app/app.css";
import { installFocusModality } from "../app/installFocusModality";
import { ProductScreenFixtures } from "./ProductScreenFixtures";

installFocusModality(document);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <ProductScreenFixtures />,
);
