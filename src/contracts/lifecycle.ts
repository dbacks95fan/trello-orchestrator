// Copyright (c) 2026 DPSystems, LLC.
// ABOUTME: Loads and validates records against the canonical Agentic SDLC lifecycle schema.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

interface SchemaError {
  instancePath: string;
  message?: string;
}

interface ValidateFunction {
  (value: unknown): boolean;
  errors?: SchemaError[] | null;
}

interface AjvInstance {
  errors?: SchemaError[] | null;
  validateSchema(schema: object): boolean;
  addSchema(schema: object): void;
  compile(schema: object): ValidateFunction;
}

interface AjvConstructor {
  new (options: { allErrors: boolean; strict: boolean; validateFormats: boolean }): AjvInstance;
}

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020") as AjvConstructor;
const addFormats = require("ajv-formats") as (ajv: AjvInstance) => void;

export type LifecycleDefinition =
  | "ProductConfig"
  | "BoardTransitionEvent"
  | "StageInvocation"
  | "StageResult"
  | "StageResultDecision"
  | "FreezeActivationEvent"
  | "FreezeRevocationEvent"
  | "WorkContract"
  | "SpecAcceptanceRecord"
  | "EvidencePackage"
  | "EvaluationPackage"
  | "HumanApprovalRecord"
  | "DeploymentAuthorizationRecord"
  | "TrelloRecordRef"
  | "ReleaseRecord"
  | "ObservationRecord"
  | "ClosureRecord";

export interface LifecycleValidation {
  valid: boolean;
  errors: string[];
}

export interface LifecycleValidator {
  validate(definition: LifecycleDefinition, value: unknown): LifecycleValidation;
}

/** Build validators once from the schema path configured for this Orchestrator. */
export function createLifecycleValidator(schemaPath: string): LifecycleValidator {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
    $schema?: string;
    $id?: string;
    $defs?: Record<string, unknown>;
  };
  if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema" || !schema.$id || !schema.$defs) {
    throw new Error(`Lifecycle schema at ${schemaPath} is not a Draft 2020-12 schema with $defs.`);
  }

  const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true });
  addFormats(ajv);
  if (!ajv.validateSchema(schema)) {
    const errors = (ajv.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`);
    throw new Error(`Lifecycle schema failed Draft 2020-12 meta-validation: ${errors.join("; ")}`);
  }
  ajv.addSchema(schema);

  const validators = new Map<LifecycleDefinition, ReturnType<typeof ajv.compile>>();
  return {
    validate(definition, value) {
      let validator = validators.get(definition);
      if (!validator) {
        if (!(definition in schema.$defs!)) throw new Error(`Unknown lifecycle schema definition: ${definition}`);
        validator = ajv.compile({ $ref: `${schema.$id}#/$defs/${definition}` });
        validators.set(definition, validator);
      }
      const valid = validator(value);
      return {
        valid: Boolean(valid),
        errors: valid
          ? []
          : (validator.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`),
      };
    },
  };
}
