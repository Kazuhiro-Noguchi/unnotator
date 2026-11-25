# @unnotator/plugin-api

unnotator の拡張機能が使う型定義（TypeScript）。

```ts
import type { ActivateFunction } from "@unnotator/plugin-api";

export const activate: ActivateFunction = (host) => {
  // host から API を使う
};
```

この型定義は契約の正本（`index.d.ts`）で、版は `API_VERSION` と一致する。
