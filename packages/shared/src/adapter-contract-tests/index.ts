// Barrel for `@opencoo/shared/adapter-contract-tests`. Each boundary we
// publish (document-converter, source, output, automation, ...) gets its
// own submodule and is re-exported here for convenience; consumers that
// care about tree-shaking can still import the concrete submodule via
// `@opencoo/shared/adapter-contract-tests/<name>`.
export * from "./document-converter.js";
export * from "./guard.js";
export * from "./source-adapter.js";
export * from "./wiki-adapter.js";
