// Tool schemas handed to Claude: the six Surface actions plus assert_checkpoint, emit_output,
// and escalate. The model chooses tools; discover.ts executes them via the Surface and safety
// gate, then validates target/checkpoint payloads against the CANONICAL Zod schemas from
// src/artifact (ElementDescriptorSchema/CheckpointSchema) rather than re-implementing
// validation here — the JSON schemas below just need to be permissive enough for Claude to
// produce input that schema can then strictly parse.
import type Anthropic from "@anthropic-ai/sdk";

const elementDescriptorJsonSchema = {
  type: "object",
  properties: {
    describedAs: {
      type: "string",
      description: 'Short human description of the element, e.g. "Search button".',
    },
    strategies: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["roleName", "labelText", "textAnchor", "tableCell", "css", "visual"],
          },
          role: { type: "string", description: "ARIA role. Required when kind is roleName." },
          name: { type: "string", description: "Accessible name. Required when kind is roleName." },
          labelText: { type: "string", description: "Required when kind is labelText." },
          anchorText: { type: "string", description: "Required when kind is textAnchor." },
          rowLabel: { type: "string", description: "Required when kind is tableCell." },
          column: {
            type: "integer",
            description: "Optional 0-based column index for tableCell; defaults to the last cell in the row.",
          },
          css: { type: "string", description: "Required when kind is css." },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["kind", "confidence"],
      },
      description:
        "Ranked list of ways to find this element, most reliable first: prefer roleName or " +
        "labelText; use tableCell for a value in a labeled table row; use textAnchor when " +
        "there's no formal label; use css only as a last resort.",
    },
  },
  required: ["describedAs", "strategies"],
};

const checkpointJsonSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["urlMatches", "textPresent", "textAbsent", "elementPresent"] },
    pattern: {
      type: "string",
      description: "Regex source tested against the current URL. Required when kind is urlMatches.",
    },
    text: {
      type: "string",
      description: "Substring tested against visible page text. Required when kind is textPresent/textAbsent.",
    },
    target: { ...elementDescriptorJsonSchema, description: "Required when kind is elementPresent." },
  },
  required: ["kind"],
};

export const DISCOVERY_TOOLS: Anthropic.Tool[] = [
  {
    name: "click",
    description: "Click an element, e.g. a button or link.",
    input_schema: {
      type: "object",
      properties: {
        target: elementDescriptorJsonSchema,
        intent: { type: "string", description: "One sentence: why this click, right now." },
      },
      required: ["target", "intent"],
    },
  },
  {
    name: "type",
    description: "Type a value into a text input.",
    input_schema: {
      type: "object",
      properties: {
        target: elementDescriptorJsonSchema,
        value: { type: "string", description: "The text to type." },
        redact: {
          type: "boolean",
          description:
            "Set true if this value is a credential or otherwise sensitive; it is redacted from " +
            "evidence and is never stored as a plaintext literal in the compiled capability.",
        },
        intent: { type: "string", description: "One sentence: why this value, right now." },
      },
      required: ["target", "value", "intent"],
    },
  },
  {
    name: "selectOption",
    description: "Choose an option in a <select> dropdown.",
    input_schema: {
      type: "object",
      properties: {
        target: elementDescriptorJsonSchema,
        value: { type: "string", description: "The option's value/text to select." },
        intent: { type: "string" },
      },
      required: ["target", "value", "intent"],
    },
  },
  {
    name: "navigate",
    description: "Navigate the browser directly to a URL.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string" },
        intent: { type: "string" },
      },
      required: ["url", "intent"],
    },
  },
  {
    name: "readText",
    description: "Read the text content of an element, e.g. to capture a value the goal asks for.",
    input_schema: {
      type: "object",
      properties: {
        target: elementDescriptorJsonSchema,
        intent: { type: "string" },
      },
      required: ["target", "intent"],
    },
  },
  {
    name: "waitFor",
    description: "Wait for an element to appear before continuing, e.g. after a slow navigation.",
    input_schema: {
      type: "object",
      properties: {
        target: elementDescriptorJsonSchema,
        timeoutMs: { type: "integer", description: "Max time to wait, in milliseconds. Defaults to 5000." },
        intent: { type: "string" },
      },
      required: ["target", "intent"],
    },
  },
  {
    name: "assert_checkpoint",
    description:
      "Check a condition against the CURRENT page state (after your last action) and get a " +
      "pass/fail result. Use this to confirm an action had the effect you expected.",
    input_schema: {
      type: "object",
      properties: {
        checkpoint: checkpointJsonSchema,
      },
      required: ["checkpoint"],
    },
  },
  {
    name: "emit_output",
    description: "Declare a named output value the goal asked you to capture, e.g. a balance you just read.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: 'Short camelCase name, e.g. "savingsBalance".' },
        value: { type: "string" },
      },
      required: ["name", "value"],
    },
  },
  {
    name: "escalate",
    description:
      "Stop and hand off to a human: use this when you're stuck, blocked, or the page shows " +
      "something the goal didn't anticipate and you can't safely proceed.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string" },
      },
      required: ["reason"],
    },
  },
];
