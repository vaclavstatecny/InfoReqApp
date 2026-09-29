import test from "node:test";
import assert from "node:assert/strict";
import type {
  IdsProjectSpecification,
  Project,
  PropertyRequirement,
} from "../src/project/types.ts";
import {
  convertProjectGroupToIds,
  filterSpecificationForScope,
  hashIdsStandardSpecification,
  reassignIdsSpecification,
  saveIdsSpecification,
  validateIdsSpecification,
} from "../src/ids/authoring.ts";
import {
  groupRequirementsByItem,
  requirementGroupMatchesEntity,
} from "../src/project/requirementFingerprint.ts";
import {
  getIdsProjectedPropertyNameConstraint,
  getIdsProjectedPropertySetConstraint,
  getPropertyRequirementGroupKey,
  isIdsProjectedRequirement,
  projectIdsRequirementsForEntity,
} from "../src/ids/requirementProjection.ts";
import {
  mergeIdsIntoProjectWithReport,
  type IdsParsed,
} from "../src/import/ids.ts";
import type { SchemaIndex } from "../src/schema/types.ts";
import { generateIDS } from "../src/export/ids.ts";
import {
  hasProjectObjectIdsDefinition,
  projectObjectToIdsSpecificationPreview,
} from "../src/ids/projectDefinition.ts";

const projectBase = (): Project => ({
  projectId: "project",
  name: "Test",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ifcSchemaVersion: "IFC4X3",
  classification: { nodes: [], sourceName: "IFC" },
  classifications: [],
  primaryClassificationId: "ifc",
  phases: [
    { id: "phase-a", code: "A", name: "A" },
    { id: "phase-b", code: "B", name: "B" },
  ],
  purposeOfUseEntries: [{ id: "use-a", name: "Use A" }],
  objects: {},
  classificationSystemEntries: [],
  idsSpecifications: [],
});

const specification = (
  id: string,
  entity: string,
  pset = "Pset_Common",
): IdsProjectSpecification => ({
  id,
  identifier: id,
  name: `Specification ${id}`,
  ifcVersion: "IFC4X3_ADD2",
  minOccurs: 0,
  maxOccurs: "unbounded",
  source: "authored",
  applicability: [
    { id: `${id}:entity`, kind: "entity", name: { simpleValue: entity } },
  ],
  requirements: [
    {
      id: `${id}:property`,
      kind: "property",
      propertySet: { simpleValue: pset },
      baseName: { simpleValue: "Reference" },
      value: { enumerations: ["A", "B"] },
      cardinality: "required",
    },
  ],
});

const addObject = (
  project: Project,
  code: string,
  entity: string,
  predefinedType?: string,
  properties: PropertyRequirement[] = [],
): void => {
  project.objects[code] = {
    code,
    description: code,
    ifcEntity: entity,
    predefinedType: predefinedType ? { mode: "ENUM", value: predefinedType } : { mode: "NONE" },
    ifcEntityPhases: ["phase-a", "phase-b"],
    predefinedTypePhases: ["phase-a", "phase-b"],
    requirements: {
      attributes: [],
      properties,
      relations: [],
      classifications: [],
      materials: [],
    },
  };
};

test("source edit updates every projection without persisting projected rows", () => {
  const project = projectBase();
  addObject(project, "wall-1", "IfcWall");
  addObject(project, "wall-2", "IfcWall");
  project.idsSpecifications = [specification("spec-1", "IFCWALL")];
  const draft = structuredClone(project.idsSpecifications[0]);
  const property = draft.requirements[0];
  assert.equal(property.kind, "property");
  if (property.kind !== "property") return;
  property.value = { pattern: "^NEW.*" };
  property.propertySet = { simpleValue: "Pset_Renamed" };
  const next = saveIdsSpecification(project, draft);

  for (const object of Object.values(next.objects)) {
    assert.equal(object.requirements.properties.length, 0);
    const projected = projectIdsRequirementsForEntity(next, object.ifcEntity);
    assert.equal(projected.properties[0]?.constraint, "PATTERN");
    assert.equal(projected.properties[0]?.value, "^NEW.*");
    assert.equal(projected.properties[0]?.psetName, "Pset_Renamed");
    assert.deepEqual(
      getIdsProjectedPropertySetConstraint(projected.properties[0]),
      { simpleValue: "Pset_Renamed" },
    );
    assert.equal(isIdsProjectedRequirement(projected.properties[0]), true);
  }
});

test("same Pset in two IDS specifications stays in two source groups", () => {
  const project = projectBase();
  addObject(project, "wall-1", "IfcWall");
  project.idsSpecifications = [
    specification("spec-1", "IFCWALL"),
    specification("spec-2", "IFCWALL"),
  ];
  const idsPsets = groupRequirementsByItem(project).filter(
    (group) => group.origin === "ids" && group.kind === "pset",
  );
  assert.equal(idsPsets.length, 2);
  assert.notEqual(idsPsets[0].fingerprint, idsPsets[1].fingerprint);
  assert.notEqual(idsPsets[0].idsReference?.specificationId, idsPsets[1].idsReference?.specificationId);
});

test("entity projection keeps equal Psets isolated by IDS specification and facet section", () => {
  const project = projectBase();
  addObject(project, "wall-1", "IfcWall");
  const first = specification("spec-1", "IFCWALL");
  first.applicability.push({
    id: "spec-1:applicability-property",
    kind: "property",
    propertySet: { simpleValue: "Pset_Common" },
    baseName: { simpleValue: "Status" },
    cardinality: "required",
  });
  first.requirements.push({
    id: "spec-1:second-property",
    kind: "property",
    propertySet: { simpleValue: "Pset_Common" },
    baseName: { simpleValue: "Name" },
    cardinality: "required",
  });
  project.idsSpecifications = [
    first,
    specification("spec-2", "IFCWALL"),
  ];

  const projected = projectIdsRequirementsForEntity(project, "IfcWall");
  assert.equal(projected.properties.length, 4);

  const byId = new Map(projected.properties.map((item) => [item.id, item]));
  const firstRequirement = byId.get("ids-projection:requirements:spec-1:property")!;
  const samePsetRequirement = byId.get("ids-projection:requirements:spec-1:second-property")!;
  const applicability = byId.get("ids-projection:applicability:spec-1:applicability-property")!;
  const otherSpecification = byId.get("ids-projection:requirements:spec-2:property")!;

  assert.equal(
    getPropertyRequirementGroupKey(firstRequirement),
    getPropertyRequirementGroupKey(samePsetRequirement),
  );
  assert.notEqual(
    getPropertyRequirementGroupKey(firstRequirement),
    getPropertyRequirementGroupKey(applicability),
  );
  assert.notEqual(
    getPropertyRequirementGroupKey(firstRequirement),
    getPropertyRequirementGroupKey(otherSpecification),
  );
});

test("projected Pset retains OR constraint instead of presenting one alternative as the source", () => {
  const project = projectBase();
  addObject(project, "wall-1", "IfcWall");
  const source = specification("spec-or", "IFCWALL");
  const property = source.requirements[0];
  assert.equal(property.kind, "property");
  if (property.kind !== "property") return;
  property.propertySet = { enumerations: ["Pset_One", "Pset_Two"] };
  property.baseName = { enumerations: ["Reference", "Status"] };
  project.idsSpecifications = [source];

  const projected = projectIdsRequirementsForEntity(project, "IfcWall");
  assert.equal(projected.properties[0]?.psetName, "Pset_One");
  assert.deepEqual(
    getIdsProjectedPropertySetConstraint(projected.properties[0]),
    { enumerations: ["Pset_One", "Pset_Two"] },
  );
  assert.deepEqual(
    getIdsProjectedPropertyNameConstraint(projected.properties[0]),
    { enumerations: ["Reference", "Status"] },
  );
});

test("entity-scoped groups exclude IDS requirements for unrelated entities", () => {
  const project = projectBase();
  addObject(project, "actuator", "IfcActuator");
  addObject(project, "system", "IfcSystem");
  project.idsSpecifications = [
    specification("actuator-spec", "IFCACTUATOR", "Pset_Actuator"),
    specification("system-spec", "IFCSYSTEM", "Pset_System"),
  ];

  const matchingGroups = groupRequirementsByItem(project).filter((group) =>
    requirementGroupMatchesEntity(group, project, "IfcActuator", "NOTDEFINED"),
  );

  assert.deepEqual(
    matchingGroups.map((group) => group.idsReference?.specificationId),
    ["actuator-spec"],
  );
});

test("project IDS definition is derived without persisting and respects phase, use-case and occurrence", () => {
  const project = projectBase();
  addObject(project, "terminal", "IfcWasteTerminal", "FLOORTRAP");
  const object = project.objects.terminal;
  object.ifcEntityPhases = ["phase-a"];
  object.predefinedTypePhases = ["phase-a"];
  object.requirements.attributes.push({
    id: "attribute-a",
    attribute: "Name",
    required: true,
    occurrence: "required",
    constraint: "FILLED",
    phases: ["phase-a"],
    useCaseMode: "custom",
    useCaseIds: ["use-a"],
    extensions: {},
  });
  object.requirements.properties.push({
    id: "property-b",
    source: "PSET",
    psetName: "Pset_Test",
    propertyName: "Reference",
    dataType: "IfcLabel",
    required: false,
    occurrence: "optional",
    constraint: "FILLED",
    phases: ["phase-b"],
    useCaseMode: "inherit",
    extensions: {},
  });

  const matching = projectObjectToIdsSpecificationPreview(project, object, {
    phaseId: "phase-a",
    useCaseId: "use-a",
    occurrence: "required",
  });
  assert.equal(hasProjectObjectIdsDefinition(project, object), true);
  assert.equal(matching?.applicability[0]?.kind, "entity");
  assert.equal(matching?.requirements.length, 1);
  assert.equal(matching?.requirements[0]?.kind, "attribute");
  assert.equal(project.idsSpecifications?.length, 0);

  const otherUseCase = projectObjectToIdsSpecificationPreview(project, object, {
    phaseId: "phase-a",
    useCaseId: "use-b",
    occurrence: "required",
  });
  assert.equal(otherUseCase?.requirements.length, 0);

  const inactivePhase = projectObjectToIdsSpecificationPreview(project, object, {
    phaseId: "phase-b",
  });
  assert.equal(inactivePhase, null);

  const canonicalOnly = projectBase();
  addObject(canonicalOnly, "canonical-object", "IfcWall");
  canonicalOnly.idsSpecifications = [specification("canonical-spec", "IFCWALL")];
  canonicalOnly.objects["canonical-object"].requirements.classifications.push({
    id: "primary-classification",
    classificationId: "primary",
    systemEntryId: "primary",
    system: "Primary",
    identification: "WALL",
    value: "WALL",
    name: "Wall",
    readOnly: true,
    occurrence: "required",
    isApplicability: true,
    extensions: {},
  });
  assert.equal(
    hasProjectObjectIdsDefinition(canonicalOnly, canonicalOnly.objects["canonical-object"]),
    false,
  );
});

test("full assignment splits entities and keeps PredefinedType alternatives as OR", () => {
  const project = projectBase();
  addObject(project, "door-a", "IfcDoor", "DOOR");
  addObject(project, "door-b", "IfcDoor", "GATE");
  addObject(project, "wall", "IfcWall");
  project.idsSpecifications = [specification("source", "IFCDOOR")];
  const result = reassignIdsSpecification(project, "source", ["door-a", "door-b", "wall"]);
  assert.equal(result.error, undefined);
  assert.equal(result.project.idsSpecifications?.length, 2);
  const door = result.project.idsSpecifications?.find((item) => item.id === "source");
  const entity = door?.applicability.find((facet) => facet.kind === "entity");
  assert.equal(entity?.kind, "entity");
  if (entity?.kind !== "entity") return;
  assert.deepEqual(entity.predefinedType?.enumerations, ["DOOR", "GATE"]);
  assert.equal(door?.identifier, "source");
  assert.equal(result.project.idsSpecifications?.find((item) => item.id !== "source")?.source, "authored");
});

test("entity pattern cannot be reduced implicitly", () => {
  const project = projectBase();
  addObject(project, "wall", "IfcWall");
  addObject(project, "door", "IfcDoor");
  const source = specification("pattern", "IFCWALL");
  const entity = source.applicability[0];
  assert.equal(entity.kind, "entity");
  if (entity.kind !== "entity") return;
  entity.name = { pattern: "^Ifc.*$" };
  project.idsSpecifications = [source];
  const result = reassignIdsSpecification(project, source.id, ["wall"]);
  assert.match(result.error ?? "", /pattern/i);
  assert.equal(result.project, project);
});

test("project group conversion removes native copies only after IDS validation", () => {
  const project = projectBase();
  const property: PropertyRequirement = {
    id: "p1",
    extensions: {},
    source: "PSET",
    psetName: "Pset_Test",
    propertyName: "Status",
    dataType: "IfcLabel",
    required: true,
    occurrence: "required",
    constraint: "ENUM",
    allowedValues: ["A", "B"],
    value: "A|B",
  };
  addObject(project, "wall", "IfcWall", undefined, [property]);
  const group = groupRequirementsByItem(project).find((item) => item.origin === "project");
  assert.ok(group);
  if (!group) return;
  const converted = convertProjectGroupToIds(project, group);
  assert.equal(converted.error, undefined);
  assert.equal(converted.project.objects.wall.requirements.properties.length, 0);
  assert.equal(converted.project.idsSpecifications?.length, 1);
  const facet = converted.project.idsSpecifications?.[0].requirements[0];
  assert.equal(facet?.kind, "property");
  if (facet?.kind === "property") assert.deepEqual(facet.value?.enumerations, ["A", "B"]);
});

test("scope is inherited by facets and ignored by the standard hash", () => {
  const source = specification("scope", "IFCWALL");
  source.authoring = { scope: { phaseIds: ["phase-a"], useCaseMode: "custom", useCaseIds: ["use-a"] } };
  const hash = hashIdsStandardSpecification(source);
  source.authoring.note = "local only";
  source.requirements[0].authoring = { note: "also local" };
  assert.equal(hashIdsStandardSpecification(source), hash);
  assert.ok(filterSpecificationForScope(source, "phase-a", "use-a"));
  assert.equal(filterSpecificationForScope(source, "phase-b", "use-a"), null);
  assert.equal(filterSpecificationForScope(source, "phase-a", "other"), null);
});

test("canonical IDS export filters internal phase and use-case scope without serializing it", () => {
  const project = projectBase();
  addObject(project, "wall", "IfcWall");
  const source = specification("export-scope", "IFCWALL");
  source.authoring = {
    scope: {
      phaseIds: ["phase-a"],
      useCaseMode: "custom",
      useCaseIds: ["use-a"],
    },
    note: "internal-only-note",
  };
  project.idsSpecifications = [source];
  project.idsMetadata = { title: "Scope test" };
  const xml = generateIDS({ project, phaseId: "phase-a", useCaseId: "use-a" });
  assert.match(xml, /Specification export-scope/);
  assert.doesNotMatch(xml, /internal-only-note|phase-a|use-a/);
  assert.throws(() => generateIDS({ project, phaseId: "phase-b", useCaseId: "use-a" }));
  assert.throws(() => generateIDS({ project, phaseId: "phase-a", useCaseId: "other" }));
});

test("validation blocks missing entity and invalid ranges", () => {
  const project = projectBase();
  const source = specification("invalid", "IFCWALL");
  source.applicability = [];
  const property = source.requirements[0];
  if (property.kind === "property") property.value = { minInclusive: "10", maxInclusive: "2" };
  const validation = validateIdsSpecification(project, source);
  assert.ok(validation.errors.some((message) => message.includes("entity facet")));
  assert.ok(validation.errors.some((message) => message.includes("dolní mez")));
});

const schema: SchemaIndex = {
  entities: {
    IfcWall: {
      name: "IfcWall",
      attributes: [],
      standardPsets: [],
      standardQtoSets: [],
      predefinedTypeValues: [],
      abstract: false,
    },
  },
  psets: {},
  qtos: {},
  types: {},
};

const parsed = (name: string, instructions?: string): IdsParsed => ({
  info: { title: "Reimport" },
  specifications: [{
    name,
    identifier: "stable",
    ifcVersion: "IFC4X3_ADD2",
    instructions,
    applicability: {
      entity: { name: "IFCWALL" },
      partOf: [],
      classification: [],
      attribute: [],
      property: [],
      material: [],
    },
    requirements: {
      entity: [],
      partOf: [],
      classification: [],
      attribute: [],
      property: [],
      material: [],
    },
  }],
});

test("reimport detects both-sided changes and supports all conflict choices", () => {
  const first = mergeIdsIntoProjectWithReport(parsed("Original"), null, schema).project;
  const local = structuredClone(first);
  local.idsSpecifications![0].instructions = "Local edit";
  local.idsSpecifications![0].authoring = { scope: { phaseIds: [local.phases[0].id] }, note: "keep" };

  const conflict = mergeIdsIntoProjectWithReport(parsed("Incoming edit"), local, schema);
  assert.equal(conflict.report.reimportConflicts.length, 1);
  const sourceKey = conflict.report.reimportConflicts[0].sourceKey;

  const kept = mergeIdsIntoProjectWithReport(parsed("Incoming edit"), local, schema, {
    reimportResolutions: { [sourceKey]: "keep-local" },
  }).project;
  assert.equal(kept.idsSpecifications?.[0].instructions, "Local edit");

  const accepted = mergeIdsIntoProjectWithReport(parsed("Incoming edit"), local, schema, {
    reimportResolutions: { [sourceKey]: "accept-import" },
  }).project;
  assert.equal(accepted.idsSpecifications?.[0].name, "Incoming edit");
  assert.equal(accepted.idsSpecifications?.[0].authoring?.note, "keep");

  const duplicated = mergeIdsIntoProjectWithReport(parsed("Incoming edit"), local, schema, {
    reimportResolutions: { [sourceKey]: "duplicate-both" },
  }).project;
  assert.equal(duplicated.idsSpecifications?.length, 2);
  assert.ok(duplicated.idsSpecifications?.some((item) => item.name?.includes("nová importovaná verze")));
});
