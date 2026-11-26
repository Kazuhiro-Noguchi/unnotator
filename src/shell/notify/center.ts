// 通知センター（ベルから開く一覧）を開いているか。開いている間は、トーストを出さない。
import { createSignal } from "solid-js";
import { notifyStore } from "../services";

const [open, setOpen] = createSignal(false);

export const centerOpen = open;

export function setCenterOpen(value: boolean): void {
  setOpen(value);
  notifyStore.setToastsEnabled(!value);
}
