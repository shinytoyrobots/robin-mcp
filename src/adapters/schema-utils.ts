import { z, type ZodTypeAny } from "zod";

/**
 * Convert a JSON Schema `properties` object into a Zod shape suitable for
 * `server.tool()` registration. Handles the types that MCP tool schemas
 * commonly use: string (+ enum), number, integer, boolean, array, object.
 */
export function jsonSchemaToZodShape(
  properties: Record<string, Record<string, unknown>> | undefined,
  required: string[] = []
): Record<string, ZodTypeAny> {
  if (!properties) return {};

  const shape: Record<string, ZodTypeAny> = {};
  const requiredSet = new Set(required);

  for (const [key, prop] of Object.entries(properties)) {
    let zodType = jsonSchemaPropertyToZod(prop);

    if (!requiredSet.has(key)) {
      zodType = zodType.optional();
    }

    if (typeof prop.description === "string") {
      zodType = zodType.describe(prop.description);
    }

    shape[key] = zodType;
  }

  return shape;
}

function jsonSchemaPropertyToZod(prop: Record<string, unknown>): ZodTypeAny {
  const type = prop.type as string | undefined;

  switch (type) {
    case "string":
      if (Array.isArray(prop.enum)) {
        const values = prop.enum as [string, ...string[]];
        return z.enum(values);
      }
      return z.string();

    case "number":
    case "integer":
      return z.number();

    case "boolean":
      return z.boolean();

    case "array": {
      const items = prop.items as Record<string, unknown> | undefined;
      if (items) {
        return z.array(jsonSchemaPropertyToZod(items));
      }
      return z.array(z.any());
    }

    case "object": {
      const nested = prop.properties as Record<string, Record<string, unknown>> | undefined;
      const nestedRequired = prop.required as string[] | undefined;
      if (nested) {
        return z.object(jsonSchemaToZodShape(nested, nestedRequired));
      }
      return z.record(z.any());
    }

    default:
      return z.any();
  }
}
