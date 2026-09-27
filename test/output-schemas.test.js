import assert from "node:assert/strict";
import test from "node:test";
import * as z from "zod/v4";
import { OUTPUT_SCHEMAS, outputSchemaFor } from "../src/output-schemas.js";

test("every output contract converts to JSON Schema", () => {
  assert.equal(Object.keys(OUTPUT_SCHEMAS).length, 32);
  for (const [name, schema] of Object.entries(OUTPUT_SCHEMAS)) {
    const jsonSchema = z.toJSONSchema(schema);
    assert.equal(typeof jsonSchema, "object", name);
    assert.equal(outputSchemaFor(name), schema);
  }
  assert.throws(() => outputSchemaFor("missing_tool"), /Missing output schema/);
});
