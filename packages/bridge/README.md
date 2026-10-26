# @veistra/bridge

The transport bridge between a Veistra app's frontend and its host.

An app's UI runs in an iframe on its own origin. This is the only thing it needs
from the host: a typed `invoke` down to the app's own Rust half, and the events
that come back up. **It is the only host coupling an app frontend should have** —
if you find yourself reaching for `window.parent` or `@tauri-apps/api` directly,
something is wrong.

```sh
pnpm add @veistra/bridge
```

## Using it

```ts
import { invoke, on, session, reportPainted } from "@veistra/bridge";

// Call your app's Rust half. The method name is yours; the shell routes it to
// your package's core by which frame the call came from, never by the string.
const specs = await invoke<Spec[]>("schematify/list-specs");

// Which project this frame is placed in. Null until a project is open.
const { projectPath } = await session();

// Tell the shell you have drawn something. Boot waits on this.
reportPainted();
```

`invoke` rejects with a `VeistraRpcError` carrying `{ code, message, data? }` —
the JSON-RPC error object your core returned, unchanged.

## Entry points

| Import | What it is |
|---|---|
| `@veistra/bridge` | `invoke`, `on`, `onCommand`, `declareCommands`, `openIn`, `publish`, `subscribe`, `session`, `host`, `reportPainted` |
| `@veistra/bridge/protocol` | The wire types of transport B, for anyone implementing the other end |
| `@veistra/bridge/errors` | `VeistraRpcError` and the standard codes |

`@tauri-apps/api` is an **optional** peer dependency. It is needed only when an
app runs as a standalone Tauri window rather than inside the orchestrator; inside
the shell, the bridge talks over `postMessage` and pulls in nothing.

## Stability

Transport B is at protocol version 1. `docs/tool-protocol.md` in the
[Veistra repository](https://github.com/Firelight-Innovations/Veistra/blob/main/docs/tool-protocol.md)
is the specification, and §6 is what it promises about changes — the short
version being that additions are additive and a manifest written today keeps
parsing.

Apache-2.0.
