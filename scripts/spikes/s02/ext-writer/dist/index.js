// 権限ダイアログ・書き込みと Undo・候補（suggest）・storage を、パレットのコマンドから実機で確かめる拡張機能。
// 使い方: アセットを開き、パレット（Cmd+Shift+P）で「Writer: ...」を実行する。結果は通知に出る。
export function activate(host) {
  host.annotationTypes.register("rect", {
    summarize: (s) => `rect ${s.x},${s.y} ${s.w}x${s.h}`,
  });

  // 同期の API（assets.current）は、同意の前は null を返し、確認ダイアログも出せない。
  // そこで、非同期の呼び出し（assets.get）で、先に assets.read の同意を求める。
  const current = async () => {
    let target = host.assets.current();
    if (target === null) {
      await host.assets.get("00000000-0000-0000-0000-000000000000").catch(() => {});
      target = host.assets.current();
    }
    if (target === null) throw new Error("開いているアセットが無い（または assets.read が許可されていない）");
    return target;
  };
  const rect = (i) => ({
    type: "dev.spike.writer/rect",
    selector: { x: 10 * i, y: 5 * i, w: 30, h: 20 },
  });
  const fail = (e) => host.ui.notify(`writer: ${e.code ?? ""} ${e.message}`, "error");

  host.commands.register("create", async () => {
    try {
      const a = await host.annotations.create({ target: await current(), ...rect(1) });
      host.ui.notify(`writer: created ${a.id}`, "info");
    } catch (e) {
      fail(e);
    }
  });
  host.commands.register("suggest", async () => {
    try {
      const target = await current();
      const list = [1, 2, 3].map((i) => ({ target, ...rect(i) }));
      const r = await host.annotations.suggest(list, { title: "Writer suggestions" });
      host.ui.notify(`writer: accepted ${r.accepted.length}, rejected ${r.rejectedCount}`, "info");
    } catch (e) {
      fail(e);
    }
  });
  host.commands.register("query", async () => {
    try {
      const list = await host.annotations.query({ assetId: (await current()).assetId });
      host.ui.notify(`writer: ${list.length} annotations`, "info");
    } catch (e) {
      fail(e);
    }
  });
  host.commands.register("store", async () => {
    try {
      const prev = (await host.storage.get("counter")) ?? 0;
      await host.storage.set("counter", prev + 1);
      host.ui.notify(`writer: counter ${prev} -> ${prev + 1}`, "info");
    } catch (e) {
      fail(e);
    }
  });
}
export function deactivate() {}
