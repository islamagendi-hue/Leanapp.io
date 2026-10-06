# @leanapp/analytics

LeanApp SDK for JavaScript, TypeScript and React Native. Events, identity, sessions, attribution capture and a persistent offline queue with retries. No dependencies.

```ts
import { Analytics } from "@leanapp/analytics";

Analytics.initialize({ apiKey: "la_pk_dev_…" }); // public SDK key from the dashboard
Analytics.track("product_viewed", { product_id: "123", price: 299, currency: "SAR" });
Analytics.identify("user_123", { city: "Riyadh" });
```

React Native: pass `storage: asyncStorageAdapter(AsyncStorage)` so the queue survives restarts.

Full guide: [docs/sdk.md](../../docs/sdk.md). Tests run from `apps/platform` (`npm run test:unit`).

Status: not yet published to npm.
