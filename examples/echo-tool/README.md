# echo-tool

The reference implementation of the Veistra tool protocol (see
`docs/tool-protocol.md`): a `veistra-tool.toml`, a headless core that speaks
transport A when passed `--veistra-rpc`, and (once the frontend half lands) a
bundle whose only host coupling is `@veistra/bridge`. `veistra-rpc`'s tests run
against this binary.

## A note on `bin`

`veistra-tool.toml`'s `[core] bin` is written the way a standalone tool
checkout would write it: `target/debug/veistra-echo-tool`, relative to the
checkout root. That's correct for a tool that lives in its own repo, where
`cargo build` puts its output under its own `target/`.

Inside this workspace it's misleading, though: Cargo builds every workspace
member into one shared `target/` at the *workspace* root
(`../../target/debug/veistra-echo-tool` from here), not a `target/` under
`examples/echo-tool/`. `veistra-tool.toml`'s `bin` field can't express "shared
workspace target dir" and "standalone checkout" at the same time, so it says
what a real tool repo would say, and this repo's own test does not use it.

`tests/roundtrip.rs` instead locates the binary with
`env!("CARGO_BIN_EXE_veistra-echo-tool")`, which Cargo sets to the actual
build output path regardless of workspace layout. A future broker resolving
`bin` from the manifest for a real standalone tool checkout won't have this
problem; it only exists for this in-workspace example.

## Running it by hand

```
cargo build -p veistra-echo-tool
target/debug/veistra-echo-tool --veistra-rpc
```

It then reads JSON-RPC requests from stdin and writes responses to stdout,
one per line. Without `--veistra-rpc` it prints a usage message to stderr and
exits non-zero -- it is not a general-purpose CLI.
