import { answer } from "./util.js";
export function activate(host) {
  return { answer, registerShape: (name) => `registered:${name}` };
}
export function deactivate() {}
