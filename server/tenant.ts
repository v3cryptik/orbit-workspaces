import { AsyncLocalStorage } from "node:async_hooks";
import mongoose, { type Schema } from "mongoose";

type Scope = { workspaceId: string } | { system: true };
const storage = new AsyncLocalStorage<Scope>();
// System access is used only by the private identity/membership bootstrap in data.ts.
// Await inside the context: Mongoose queries are lazy thenables, not promises.
export const runSystem = <T>(fn: () => T) =>
  storage.run({ system: true }, async () => await fn());
export const runWorkspace = <T>(workspaceId: string, fn: () => T) =>
  storage.run({ workspaceId }, async () => await fn());
function scope() {
  const context = storage.getStore();
  if (!context)
    throw new Error("Tenant guard: a workspace context is required");
  return context;
}

export function tenantGuard(schema: Schema) {
  schema.pre(
    [
      "find",
      "findOne",
      "countDocuments",
      "updateOne",
      "updateMany",
      "findOneAndUpdate",
      "deleteOne",
      "deleteMany",
      "findOneAndDelete",
      "distinct",
      "replaceOne",
      "findOneAndReplace",
    ],
    function () {
      const context = scope();
      if ("system" in context) return;
      this.where({ workspaceId: context.workspaceId });
      const update = this.getUpdate() as Record<string, any> | null;
      if (update) {
        if (
          Array.isArray(update) ||
          ["replaceOne", "findOneAndReplace"].includes((this as any).op) ||
          this.getOptions().upsert
        )
          throw new Error("Tenant guard: unsupported write");
        for (const [operator, fields] of Object.entries(update)) {
          if (
            operator === "workspaceId" ||
            (fields &&
              typeof fields === "object" &&
              Object.keys(fields).some(
                (key) =>
                  key === "workspaceId" ||
                  key.startsWith("workspaceId.") ||
                  (operator === "$rename" && fields[key] === "workspaceId"),
              ))
          )
            throw new Error("Tenant guard: workspace ownership is immutable");
        }
      }
    },
  );
  schema.pre("estimatedDocumentCount", function () {
    throw new Error("Tenant guard: use countDocuments");
  });
  schema.pre("aggregate", function () {
    const context = scope();
    if ("system" in context) return;
    const forbidden = new Set([
      "$lookup",
      "$graphLookup",
      "$unionWith",
      "$out",
      "$merge",
    ]);
    const inspect = (value: unknown): boolean =>
      !!value &&
      typeof value === "object" &&
      Object.entries(value).some(
        ([key, child]) => forbidden.has(key) || inspect(child),
      );
    if (inspect(this.pipeline()))
      throw new Error(
        "Tenant guard: cross-collection pipelines require an explicit scoped implementation",
      );
    this.pipeline().unshift({
      $match: { workspaceId: new mongoose.Types.ObjectId(context.workspaceId) },
    });
  });
  schema.pre("validate", function () {
    const context = scope();
    if ("system" in context) return;
    if (
      String(this.get("workspaceId")) !== context.workspaceId ||
      (!this.isNew && this.isModified("workspaceId"))
    )
      throw new Error("Tenant guard: invalid document workspace");
  });
  schema.pre("save", function () {
    const context = scope();
    if (
      !("system" in context) &&
      (String(this.get("workspaceId")) !== context.workspaceId ||
        (!this.isNew && this.isModified("workspaceId")))
    )
      throw new Error("Tenant guard: invalid document workspace");
  });
  schema.pre("deleteOne", { document: true, query: false }, function () {
    const context = scope();
    if (
      !("system" in context) &&
      String(this.get("workspaceId")) !== context.workspaceId
    )
      throw new Error("Tenant guard: invalid document workspace");
  });
  schema.pre("insertMany", function (next, docs) {
    try {
      const context = scope();
      if (
        !("system" in context) &&
        docs.some((doc: any) => String(doc.workspaceId) !== context.workspaceId)
      )
        throw new Error("Tenant guard: invalid document workspace");
      next();
    } catch (error) {
      next(error as Error);
    }
  });
  // Bulk writes bypass query middleware; keep this path closed until explicitly scoped.
  schema.pre("bulkWrite", function (next) {
    next(new Error("Tenant guard: bulkWrite is not supported"));
  });
}
