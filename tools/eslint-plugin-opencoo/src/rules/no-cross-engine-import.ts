import { createRule } from "../utils/create-rule.js";
import { importSourceVisitor } from "../utils/import-source-visitor.js";

type AppliesTo = "ingestion" | "self-operating" | "auto";
type Engine = "ingestion" | "self-operating";

export interface NoCrossEngineImportOptions {
  appliesTo?: AppliesTo;
}

type MessageIds = "crossEngineImport";

const ENGINE_PATH_FRAGMENTS: Record<Engine, readonly string[]> = {
  ingestion: ["packages/engine-ingestion/", "/engine-ingestion/"],
  "self-operating": [
    "packages/engine-self-operating/",
    "/engine-self-operating/",
  ],
};

const ENGINE_PACKAGE_NAMES: Record<Engine, string> = {
  ingestion: "@opencoo/engine-ingestion",
  "self-operating": "@opencoo/engine-self-operating",
};

function detectEngineFromPath(filename: string): Engine | null {
  const normalised = filename.replace(/\\/g, "/");
  if (
    ENGINE_PATH_FRAGMENTS.ingestion.some((f) => normalised.includes(f))
  ) {
    return "ingestion";
  }
  if (
    ENGINE_PATH_FRAGMENTS["self-operating"].some((f) =>
      normalised.includes(f),
    )
  ) {
    return "self-operating";
  }
  return null;
}

function resolveCurrentEngine(
  filename: string,
  appliesTo: AppliesTo,
): Engine | null {
  if (appliesTo === "ingestion") return "ingestion";
  if (appliesTo === "self-operating") return "self-operating";
  return detectEngineFromPath(filename);
}

function peerOf(engine: Engine): Engine {
  return engine === "ingestion" ? "self-operating" : "ingestion";
}

function importTargetsEngine(source: string, peer: Engine): boolean {
  const packageName = ENGINE_PACKAGE_NAMES[peer];
  if (source === packageName || source.startsWith(`${packageName}/`)) {
    return true;
  }
  const fragments = ENGINE_PATH_FRAGMENTS[peer];
  return fragments.some((f) => source.includes(f));
}

export const noCrossEngineImport = createRule<
  [NoCrossEngineImportOptions],
  MessageIds
>({
  name: "no-cross-engine-import",
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid imports across the ingestion and self-operating engine boundary (architecture.md §2.5; THREAT-MODEL.md §2 invariant 10).",
    },
    schema: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          appliesTo: {
            type: "string",
            enum: ["ingestion", "self-operating", "auto"],
          },
        },
      },
    ],
    messages: {
      crossEngineImport:
        "Engine {{current}} must not import from engine {{peer}} — cross-engine sharing goes through packages/shared/*.",
    },
  },
  defaultOptions: [{ appliesTo: "auto" }],
  create(context, [options]) {
    const appliesTo: AppliesTo = options.appliesTo ?? "auto";
    const current = resolveCurrentEngine(context.filename, appliesTo);

    if (current === null) {
      return {};
    }

    const peer = peerOf(current);

    return importSourceVisitor((node, source) => {
      if (importTargetsEngine(source, peer)) {
        context.report({
          node,
          messageId: "crossEngineImport",
          data: { current, peer },
        });
      }
    });
  },
});
