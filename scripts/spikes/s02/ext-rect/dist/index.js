export async function activate(host) {
  const base = await host.getApi("dev.spike.base");
  return { shape: base.registerShape("rect"), answer: base.answer };
}
