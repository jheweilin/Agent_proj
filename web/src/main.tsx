import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/source-sans-3";       // body / UI
import "@fontsource-variable/source-serif-4";       // headings (Latin)
import "@fontsource/noto-serif-tc/400.css";          // headings (Chinese)
import "@fontsource/noto-serif-tc/600.css";
import "@fontsource/noto-serif-tc/700.css";
import "@fontsource/ibm-plex-mono/400.css";          // data / code
import "@fontsource/ibm-plex-mono/500.css";
import "katex/dist/katex.min.css";
import "./index.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
