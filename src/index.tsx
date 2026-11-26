import { render } from "solid-js/web";
import { App } from "./App";
import "./themes/index.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("#root element not found");
}
render(() => <App />, root);
