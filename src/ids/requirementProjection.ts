import type {
  ClassificationRequirement,
  IdsFacetCardinality,
  IdsProjectFacet,
  IdsProjectSpecification,
  IdsValueConstraint,
  ObjectRequirements,
  PropertyRequirement,
  Project,
  RequirementBase,
} from "../project/types";
import type { SchemaIndex } from "../schema/types";
import {
  formatIdsConstraint,
  getSpecificationsForEntity,
  idsConstraintAlternatives,
} from "./specifications";
import { effectiveIdsScope } from "./authoring";

const PROJECTED_FACET_ID = "idsCanonicalFacetId";
const PROJECTED_SPECIFICATION_ID = "idsCanonicalSpecificationId";
const PROJECTED_PROPERTY_SET_CONSTRAINT = "idsCanonicalPropertySetConstraint";
const PROJECTED_PROPERTY_NAME_CONSTRAINT = "idsCanonicalPropertyNameConstraint";

const EMPTY_REQUIREMENTS = (): ObjectRequirements => ({
  attributes: [],
  properties: [],
  relations: [],
  classifications: [],
  materials: [],
});

type ProjectedRequirement = RequirementBase & {
  extensions: Record<string, unknown>;
};

export function isIdsProjectedRequirement(
  requirement: Pick<RequirementBase, "extensions"> | null | undefined,
): boolean {
  return typeof requirement?.extensions?.[PROJECTED_FACET_ID] === "string";
}

export function withoutIdsProjectedRequirements(
  requirements: ObjectRequirements,
): ObjectRequirements {
  return {
    attributes: requirements.attributes.filter((item) => !isIdsProjectedRequirement(item)),
    properties: requirements.properties.filter((item) => !isIdsProjectedRequirement(item)),
    relations: requirements.relations.filter((item) => !isIdsProjectedRequirement(item)),
    classifications: requirements.classifications.filter((item) => !isIdsProjectedRequirement(item)),
    materials: requirements.materials.filter((item) => !isIdsProjectedRequirement(item)),
  };
}

export function getIdsProjectedSpecificationName(
  requirement: Pick<RequirementBase, "extensions"> | null | undefined,
): string | undefined {
  const value = requirement?.extensions?.idsSpecificationName;
  return typeof value === "string" ? value : undefined;
}

export function getIdsProjectedSpecificationId(
  requirement: Pick<RequirementBase, "extensions"> | null | undefined,
): string | undefined {
  const value = requirement?.extensions?.[PROJECTED_SPECIFICATION_ID];
  return typeof value === "string" ? value : undefined;
}

export function getIdsProjectedFacetId(
  requirement: Pick<RequirementBase, "extensions"> | null | undefined,
): string | undefined {
  const value = requirement?.extensions?.[PROJECTED_FACET_ID];
  return typeof value === "string" ? value : undefined;
}

export function getIdsProjectedFacetSection(
  requirement: Pick<RequirementBase, "extensions"> | null | undefined,
): "applicability" | "requirements" | undefined {
  const value = requirement?.extensions?.idsFacetSection;
  return value === "applicability" || value === "requirements" ? value : undefined;
}

function cloneConstraint(value: IdsValueConstraint): IdsValueConstraint {
  return value.enumerations
    ? { ...value, enumerations: [...value.enumerations] }
    : { ...value };
}

function projectedConstraint(
  requirement: Pick<RequirementBase, "extensions"> | null | undefined,
  key: string,
): IdsValueConstraint | undefined {
  const value = requirement?.extensions?.[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as IdsValueConstraint;
}

/** Full canonical constraint behind the projected Pset/Qto name. */
export function getIdsProjectedPropertySetConstraint(
  requirement: Pick<RequirementBase, "extensions"> | null | undefined,
): IdsValueConstraint | undefined {
  return projectedConstraint(requirement, PROJECTED_PROPERTY_SET_CONSTRAINT);
}

/** Full canonical constraint behind the projected property name. */
export function getIdsProjectedPropertyNameConstraint(
  requirement: Pick<RequirementBase, "extensions"> | null | undefined,
): IdsValueConstraint | undefined {
  return projectedConstraint(requirement, PROJECTED_PROPERTY_NAME_CONSTRAINT);
}

function constraintKey(value: IdsValueConstraint | undefined): string {
  if (!value) return "";
  return JSON.stringify([
    value.simpleValue ?? null,
    value.enumerations ?? null,
    value.pattern ?? null,
    value.minInclusive ?? null,
    value.minExclusive ?? null,
    value.maxInclusive ?? null,
    value.maxExclusive ?? null,
    value.length ?? null,
    value.minLength ?? null,
    value.maxLength ?? null,
  ]);
}

/**
 * UI grouping key for a property requirement.
 * Canonical IDS rows are isolated by specification and section, while facets
 * describing the same Pset constraint inside that source stay together.
 */
export function getPropertyRequirementGroupKey(
  requirement: Pick<PropertyRequirement, "source" | "psetName" | "extensions">,
): string {
  const specificationId = getIdsProjectedSpecificationId(requirement);
  if (!specificationId) {
    return `${requirement.source}:${requirement.psetName || "(custom)"}`;
  }
  return [
    "ids",
    specificationId,
    getIdsProjectedFacetSection(requirement) ?? "requirements",
    constraintKey(getIdsProjectedPropertySetConstraint(requirement)),
  ].join(":");
}

function occurrence(cardinality: IdsFacetCardinality | undefined): IdsFacetCardinality {
  return cardinality ?? "required";
}

function constraintDetails(value: IdsValueConstraint | undefined): {
  constraint: "FILLED" | "ENUM" | "PATTERN" | "RANGE" | "LENGTH";
  value?: string;
  allowedValues?: string[];
} {
  if (!value) return { constraint: "FILLED" };
  if (value.enumerations?.length) {
    return {
      constraint: "ENUM",
      value: value.enumerations.join("|"),
      allowedValues: [...value.enumerations],
    };
  }
  if (value.pattern !== undefined) {
    return { constraint: "PATTERN", value: value.pattern };
  }
  if (
    value.minInclusive !== undefined ||
    value.minExclusive !== undefined ||
    value.maxInclusive !== undefined ||
    value.maxExclusive !== undefined
  ) {
    const parts = [
      value.minInclusive !== undefined ? `min:${value.minInclusive}:inclusive` : undefined,
      value.minExclusive !== undefined ? `min:${value.minExclusive}:exclusive` : undefined,
      value.maxInclusive !== undefined ? `max:${value.maxInclusive}:inclusive` : undefined,
      value.maxExclusive !== undefined ? `max:${value.maxExclusive}:exclusive` : undefined,
    ].filter((item): item is string => Boolean(item));
    return { constraint: "RANGE", value: parts.join("|") };
  }
  if (
    value.length !== undefined ||
    value.minLength !== undefined ||
    value.maxLength !== undefined
  ) {
    const parts = [
      value.length !== undefined ? `length:${value.length}` : undefined,
      value.minLength !== undefined ? `minLength:${value.minLength}` : undefined,
      value.maxLength !== undefined ? `maxLength:${value.maxLength}` : undefined,
    ].filter((item): item is string => Boolean(item));
    return { constraint: "LENGTH", value: parts.join("|") };
  }
  return { constraint: "FILLED", value: value.simpleValue };
}

function projectionBase(
  specification: IdsProjectSpecification,
  facet: IdsProjectFacet,
  section: "applicability" | "requirements",
  phaseIds: string[],
): ProjectedRequirement {
  const scope = effectiveIdsScope(specification, facet);
  return {
    id: `ids-projection:${section}:${facet.id}`,
    phases: phaseIds,
    useCaseMode: scope?.useCaseMode,
    useCaseIds: scope?.useCaseIds ? [...scope.useCaseIds] : undefined,
    extensions: {
      [PROJECTED_FACET_ID]: facet.id,
      [PROJECTED_SPECIFICATION_ID]: specification.id,
      idsCanonicalReadOnly: true,
      idsSpecificationName: specification.name || specification.identifier || "IDS specifikace",
      idsFacetSection: section,
      ...(section === "applicability" ? { idsApplicabilityLogic: "AND" } : {}),
    },
  };
}

function normalizeEntityName(value: string, schema: SchemaIndex | null | undefined): string {
  const normalized = value.trim();
  if (!normalized) return "";
  const fromSchema = Object.keys(schema?.entities ?? {}).find(
    (name) => name.toUpperCase() === normalized.toUpperCase(),
  );
  if (fromSchema) return fromSchema;
  return normalized;
}

const RELATION_TYPES = new Set([
  "IFCRELAGGREGATES",
  "IFCRELASSIGNSTOGROUP",
  "IFCRELCONTAINEDINSPATIALSTRUCTURE",
  "IFCRELNESTS",
  "IFCRELVOIDSELEMENT",
  "IFCRELFILLSELEMENT",
] as const);

function classificationConstraint(
  value: IdsValueConstraint | undefined,
): Pick<ClassificationRequirement, "constraint" | "value" | "identification" | "code"> {
  const details = constraintDetails(value);
  const constraint =
    details.constraint === "ENUM" || details.constraint === "PATTERN"
      ? details.constraint
      : "FILLED";
  const displayValue = details.value ?? "";
  return {
    constraint,
    value: displayValue,
    identification: displayValue,
    code: displayValue,
  };
}

function appendFacet(
  output: ObjectRequirements,
  specification: IdsProjectSpecification,
  facet: IdsProjectFacet,
  section: "applicability" | "requirements",
  phaseIds: string[],
  schema: SchemaIndex | null | undefined,
): void {
  // The selected IFC entity is already represented by the object's identification data.
  if (facet.kind === "entity") return;

  const base = projectionBase(specification, facet, section, phaseIds);
  const facetOccurrence = occurrence(facet.cardinality);
  const isApplicability = section === "applicability";

  switch (facet.kind) {
    case "attribute": {
      const nameAlternatives = idsConstraintAlternatives(facet.name);
      const value = constraintDetails(facet.value);
      output.attributes.push({
        ...base,
        attribute: nameAlternatives[0] ?? formatIdsConstraint(facet.name),
        required: facetOccurrence === "required",
        occurrence: facetOccurrence,
        constraint: value.constraint,
        value: value.value,
        allowedValues: value.allowedValues,
        uri: facet.uri,
        unit: facet.authoring?.unit,
        popis: facet.authoring?.description,
        note: facet.authoring?.note ?? facet.instructions,
        priklady: facet.authoring?.examples,
        isApplicability,
      });
      return;
    }
    case "property": {
      const psetAlternatives = idsConstraintAlternatives(facet.propertySet);
      const nameAlternatives = idsConstraintAlternatives(facet.baseName);
      const psetName = psetAlternatives[0] ?? formatIdsConstraint(facet.propertySet);
      const propertyName = nameAlternatives[0] ?? formatIdsConstraint(facet.baseName);
      const value = constraintDetails(facet.value);
      const normalizedPsetName = psetName.toUpperCase();
      const source =
        normalizedPsetName.startsWith("PSET_")
          ? "PSET"
          : normalizedPsetName.startsWith("QTO_")
            ? "QTO"
            : "CUSTOM";
      output.properties.push({
        ...base,
        source,
        psetName,
        propertyName,
        dataType: facet.dataType ?? "IfcLabel",
        groupLocked: true,
        required: facetOccurrence === "required",
        occurrence: facetOccurrence,
        constraint: value.constraint,
        value: value.value,
        allowedValues: value.allowedValues,
        uri: facet.uri,
        unit: facet.authoring?.unit,
        popis: facet.authoring?.description,
        note: facet.authoring?.note ?? facet.instructions,
        priklady: facet.authoring?.examples,
        isApplicability,
        extensions: {
          ...base.extensions,
          [PROJECTED_PROPERTY_SET_CONSTRAINT]: cloneConstraint(facet.propertySet),
          [PROJECTED_PROPERTY_NAME_CONSTRAINT]: cloneConstraint(facet.baseName),
        },
      });
      return;
    }
    case "classification": {
      const system = formatIdsConstraint(facet.system);
      const value = classificationConstraint(facet.value);
      output.classifications.push({
        ...base,
        classificationId: facet.id,
        systemEntryId: facet.systemEntryId,
        system,
        ...value,
        name: specification.name || system,
        uri: facet.uri,
        description: facet.authoring?.description,
        note: facet.authoring?.note ?? facet.instructions,
        priklady: facet.authoring?.examples,
        readOnly: true,
        occurrence: facetOccurrence,
        isApplicability,
      });
      return;
    }
    case "partOf": {
      const alternatives = idsConstraintAlternatives(facet.entity.name);
      const normalizedAlternatives = alternatives.map((item) => normalizeEntityName(item, schema));
      const rawRelation = facet.relation?.toUpperCase();
      const relationType = rawRelation && RELATION_TYPES.has(rawRelation as never)
        ? rawRelation as typeof output.relations[number]["relationType"]
        : "IFCRELAGGREGATES";
      output.relations.push({
        ...base,
        relationType,
        entityType: normalizedAlternatives[0] ?? formatIdsConstraint(facet.entity.name),
        entityPredefinedType: idsConstraintAlternatives(facet.entity.predefinedType)[0],
        occurrence: facetOccurrence,
        uri: facet.uri,
        popis: facet.authoring?.description,
        note: [
          facet.authoring?.note ?? facet.instructions,
          normalizedAlternatives.length > 1
            ? `IDS alternativy (OR): ${normalizedAlternatives.join(" | ")}`
            : undefined,
        ].filter(Boolean).join(" · ") || undefined,
        isApplicability,
        extensions: {
          ...base.extensions,
          idsEntityAlternatives: normalizedAlternatives,
        },
      });
      return;
    }
    case "material": {
      const value = constraintDetails(facet.value);
      output.materials.push({
        ...base,
        occurrence: facetOccurrence,
        categoryMode: value.constraint === "ENUM" ? "ENUM" : value.value ? "SIMPLE" : "NONE",
        category: value.value,
        constraint: value.constraint,
        value: value.value,
        required: facetOccurrence === "required",
        uri: facet.uri,
        popis: facet.authoring?.description,
        note: facet.authoring?.note ?? facet.instructions,
        priklady: facet.authoring?.examples,
        isApplicability,
      });
    }
  }
}

/**
 * Read-only UI projection of canonical IDS facets for one IFC object.
 * The result must never be persisted; canonical specifications remain the source of truth.
 */
export function projectIdsRequirementsForEntity(
  project: Pick<Project, "idsSpecifications" | "phases"> | null | undefined,
  ifcEntity: string,
  predefinedType?: string,
  schema?: SchemaIndex | null,
): ObjectRequirements {
  const output = EMPTY_REQUIREMENTS();
  if (!project || !ifcEntity) return output;
  const phaseIds = project.phases.map((phase) => phase.id);

  for (const specification of getSpecificationsForEntity(project, ifcEntity, predefinedType)) {
    for (const facet of specification.applicability) {
      const scopedPhases = effectiveIdsScope(specification, facet)?.phaseIds ?? phaseIds;
      appendFacet(output, specification, facet, "applicability", scopedPhases, schema);
    }
    for (const facet of specification.requirements) {
      const scopedPhases = effectiveIdsScope(specification, facet)?.phaseIds ?? phaseIds;
      appendFacet(output, specification, facet, "requirements", scopedPhases, schema);
    }
  }
  return output;
}
