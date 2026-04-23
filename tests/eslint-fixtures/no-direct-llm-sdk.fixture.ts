// Negative-case fixture for opencoo/no-direct-llm-sdk.
// Vercel AI SDK + provider plugin outside packages/shared/llm-router/** must fail.

import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

export const _ = { generateText, openai };
