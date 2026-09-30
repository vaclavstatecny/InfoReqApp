/**
 * IDS (Information Delivery Specification) import.
 * Parses IDS XML and maps to Project: objects by IFC entity, IFC + other classifications, properties grouped by Pset.
 */

import type { SchemaIndex } from "../schema/types";
import type {
  Project,
  ProjectObject,
  ClassificationSystemEntry,
  AttributeRequirement,
  PropertyRequirement,
  ClassificationRequirement,
  RelationRequirement,
  MaterialRequirement,
  ObjectRequirements,
  Phase,
  IdsProjectSpecification,
  IdsProjectFacet,
  IdsProjectEntityFacet,
  IdsValueConstraint,
} from "../project/types";
import { makeId } from "../utils/id";
import { DEFAULT_SINGLE_PHASE, ensureProjectPhases, getDefaultPhases } from "../project/phases";
import {
  getDisplayLabel,
  getIfcDocumentationBaseUrl,
  idsIfcVersionToSchemaVersion,
} from "../schema/ifcVersionConfig";
import { buildClassificationFromSchemaFiltered } from "../classification/ifcTree";
import { collectLeaves } from "../classification/parser";
import type { ClassificationData } from "../classification/types";
import {
  hashIdsStandardSpecification,
  type IdsReimportChoice,
  type IdsReimportConflict,
} from "../ids/authoring";

const IDS_NS = "http://standards.buildingsmart.org/IDS";
const XS_NS = "http://www.w3.org/2001/XMLSchema";

// --- Parsed IDS types (from XML) ---

export interface IdsValue {
  /** Původní xs:restriction base, např. xs:string nebo xs:double. */
  base?: string;
  simpleValue?: string;
  /** xs:restriction – výčet hodnot (ENUM) */
  enumerations?: string[];
  /** xs:restriction – vzor (PATTERN) */
  pattern?: string;
  /** xs:minInclusive / xs:maxInclusive – pro RANGE */
  minInclusive?: string;
  maxInclusive?: string;
  minExclusive?: string;
  maxExclusive?: string;
  /** xs:length / xs:minLength / xs:maxLength – pro LENGTH */
  length?: number;
  minLength?: number;
  maxLength?: number;
}

export interface IdsEntity {
  name: string;
  predefinedType?: string;
  cardinality?: "required" | "prohibited" | "optional";
  instructions?: string;
  /** Původní idsValue pro název entity, včetně všech OR alternativ. */
  nameRestriction?: IdsValue;
  /** Původní idsValue pro PredefinedType, pokud je v IDS uveden. */
  predefinedTypeRestriction?: IdsValue;
  /** Logické alternativy z xs:enumeration; nikdy se neslučují do jednoho IFC názvu s "|". */
  nameAlternatives?: string[];
  /** Logické alternativy PredefinedType z xs:enumeration. */
  predefinedTypeAlternatives?: string[];
}

export interface IdsClassification {
  system: string;
  /** Plná restrikce názvu klasifikačního systému. */
  systemRestriction?: IdsValue;
  value?: string;
  /** Plná restrikce z IDS (pro odvození constraint + value) */
  valueRestriction?: IdsValue;
  uri?: string;
  cardinality?: "required" | "prohibited" | "optional";
  instructions?: string;
}

export interface IdsProperty {
  propertySet: string;
  /** Plná restrikce názvu property setu; např. pattern ".*" není vlastní název Psetu. */
  propertySetRestriction?: IdsValue;
  baseName: string;
  /** Plná restrikce názvu vlastnosti. */
  baseNameRestriction?: IdsValue;
  value?: string;
  /** Plná restrikce z IDS (pro odvození constraint + value) */
  valueRestriction?: IdsValue;
  dataType?: string;
  cardinality?: "required" | "prohibited" | "optional";
  uri?: string;
  instructions?: string;
}

export interface IdsAttribute {
  name: string;
  /** Plná restrikce názvu atributu. */
  nameRestriction?: IdsValue;
  value?: string;
  /** Plná restrikce z IDS (pro odvození constraint + value) */
  valueRestriction?: IdsValue;
  cardinality?: "required" | "prohibited" | "optional";
  instructions?: string;
}

export interface IdsPartOf {
  entity: IdsEntity;
  relation?: string;
  cardinality?: "required" | "prohibited" | "optional";
  instructions?: string;
}

export interface IdsMaterial {
  value?: string;
  /** Plná restrikce z IDS (pro odvození constraint + value) */
  valueRestriction?: IdsValue;
  cardinality?: "required" | "prohibited" | "optional";
  uri?: string;
  instructions?: string;
}

export interface IdsApplicability {
  entity?: IdsEntity;
  partOf: IdsPartOf[];
  classification: IdsClassification[];
  attribute: IdsAttribute[];
  property: IdsProperty[];
  material: IdsMaterial[];
}

export interface IdsRequirements {
  entity: Array<IdsEntity & { instructions?: string }>;
  partOf: IdsPartOf[];
  classification: IdsClassification[];
  attribute: IdsAttribute[];
  property: IdsProperty[];
  material: IdsMaterial[];
}

export interface IdsSpecification {
  name: string;
  ifcVersion?: string;
  description?: string;
  identifier?: string;
  instructions?: string;
  minOccurs?: number;
  maxOccurs?: number | "unbounded";
  applicability: IdsApplicability;
  requirements?: IdsRequirements;
}

export interface IdsInfo {
  title?: string;
  copyright?: string;
  version?: string;
  description?: string;
  author?: string;
  date?: string;
  purpose?: string;
  milestone?: string;
}

export interface IdsParsed {
  info: IdsInfo;
  specifications: IdsSpecification[];
}

export type IdsCatalogMatchStatus = "exact" | "probable" | "unavailable";

export interface IdsClassificationSystemUsage {
  key: string;
  name: string;
  uris: string[];
  rules: string[];
  facetCount: number;
  status: IdsCatalogMatchStatus;
  matchedEntryId?: string;
  matchReason?: "uri" | "externalId" | "explicitAlias" | "name";
}

export interface IdsClassificationImportAnalysis {
  systems: IdsClassificationSystemUsage[];
  specificationCount: number;
  entityAlternativeCount: number;
}

export interface IdsCatalogResolution {
  usageKey: string;
  mode: "catalog" | "auxiliary";
  catalogEntryId?: string;
}

export interface IdsImportOptions {
  catalogResolutions?: IdsCatalogResolution[];
  /** Volby pro specifikace změněné lokálně i v nově importovaném souboru. */
  reimportResolutions?: Record<string, IdsReimportChoice>;
  /** Výchozí true: validní IFC alternativy se po potvrzení importu přidají do IFC stromu. */
  addImportedIfcEntitiesToHierarchy?: boolean;
}

export interface IdsImportReport {
  linkedSystems: Array<{ name: string; catalogName: string }>;
  auxiliarySystems: string[];
  preservedClassificationRules: number;
  importedIfcCodes: number;
  expandedEntityAlternatives: number;
  warnings: string[];
  reimportConflicts: IdsReimportConflict[];
}

export interface IdsImportResult {
  project: Project;
  report: IdsImportReport;
}

// --- XML helpers ---

function getLocalName(el: Element): string {
  return el.localName ?? el.nodeName.replace(/^[^:]+:/, "");
}

function getFirstElement(el: Element, localName: string, ns?: string): Element | null {
  const list = el.getElementsByTagNameNS(ns ?? IDS_NS, localName);
  return list.length > 0 ? list[0] : null;
}

function getElements(el: Element, localName: string, ns?: string): Element[] {
  const list = el.getElementsByTagNameNS(ns ?? IDS_NS, localName);
  return Array.from(list);
}

function getText(el: Element | null): string {
  if (!el) return "";
  const text = el.textContent?.trim() ?? "";
  return text;
}

/**
 * Parse ids:idsValue – simpleValue nebo xs:restriction (enumeration, pattern, min/max, length)
 */
function parseIdsValue(parent: Element): IdsValue {
  const simpleEl = getFirstElement(parent, "simpleValue");
  if (simpleEl) {
    return { simpleValue: getText(simpleEl) };
  }
  const restriction = parent.getElementsByTagNameNS(XS_NS, "restriction").item(0) as Element | null;
  if (!restriction) return {};
  const base = restriction.getAttribute("base")?.trim() || undefined;

  const getAttr = (localName: string): string | undefined => {
    const el = restriction!.getElementsByTagNameNS(XS_NS, localName).item(0);
    if (!el) return undefined;
    const v = (el as Element).getAttribute("value") ?? getText(el as Element);
    return v?.trim() || undefined;
  };
  const getNum = (localName: string): number | undefined => {
    const s = getAttr(localName);
    if (s == null) return undefined;
    const n = parseInt(s, 10);
    return Number.isNaN(n) ? undefined : n;
  };

  const enums = getElements(restriction, "enumeration", XS_NS);
  if (enums.length > 0) {
    return {
      base,
      enumerations: enums.map((e) => (e.getAttribute("value") ?? getText(e)).trim()).filter(Boolean),
    };
  }
  const patternVal = getAttr("pattern");
  if (patternVal) return { base, pattern: patternVal };

  const minInclusive = getAttr("minInclusive");
  const maxInclusive = getAttr("maxInclusive");
  const minExclusive = getAttr("minExclusive");
  const maxExclusive = getAttr("maxExclusive");
  if (minInclusive != null || maxInclusive != null || minExclusive != null || maxExclusive != null) {
    return {
      base,
      minInclusive,
      maxInclusive,
      minExclusive,
      maxExclusive,
    };
  }

  const length = getNum("length");
  const minLength = getNum("minLength");
  const maxLength = getNum("maxLength");
  if (length != null || minLength != null || maxLength != null) {
    return { base, length, minLength, maxLength };
  }

  return {};
}

function valueToString(v: IdsValue): string {
  if (v.simpleValue !== undefined && v.simpleValue !== "") return v.simpleValue;
  if (v.enumerations && v.enumerations.length > 0) return v.enumerations.join("|");
  if (v.pattern) return v.pattern;
  if (v.minInclusive != null || v.maxInclusive != null) {
    return [v.minInclusive ?? "", v.maxInclusive ?? ""].filter(Boolean).join("|");
  }
  if (v.minLength != null || v.maxLength != null) return [v.minLength ?? "", v.maxLength ?? ""].filter((x) => x !== "").join("|");
  if (v.length != null) return String(v.length);
  return "";
}

function hasIdsValue(v: IdsValue): boolean {
  return v.simpleValue !== undefined ||
    !!v.enumerations?.length ||
    v.pattern !== undefined ||
    v.minInclusive !== undefined ||
    v.maxInclusive !== undefined ||
    v.minExclusive !== undefined ||
    v.maxExclusive !== undefined ||
    v.length !== undefined ||
    v.minLength !== undefined ||
    v.maxLength !== undefined;
}

/** Vrátí jednotlivé logické alternativy hodnoty bez jejich slučování do řetězce s "|". */
export function idsValueAlternatives(v: IdsValue): string[] {
  if (v.simpleValue !== undefined && v.simpleValue.trim() !== "") return [v.simpleValue.trim()];
  if (v.enumerations?.length) return v.enumerations.map((value) => value.trim()).filter(Boolean);
  const fallback = valueToString(v).trim();
  return fallback ? [fallback] : [];
}

/** Z IdsValue odvodit typ omezení a hodnotu pro požadavky v aplikaci */
function idsValueToConstraint(v: IdsValue): {
  constraint: "FILLED" | "ENUM" | "PATTERN" | "RANGE" | "LENGTH";
  value?: string;
  allowedValues?: string[];
} {
  if (v.enumerations && v.enumerations.length > 0) {
    return { constraint: "ENUM", value: v.enumerations.join("|"), allowedValues: v.enumerations };
  }
  if (v.pattern) return { constraint: "PATTERN", value: v.pattern };
  if (v.minInclusive != null || v.maxInclusive != null || v.minExclusive != null || v.maxExclusive != null) {
    const minVal = v.minInclusive ?? v.minExclusive ?? "";
    const maxVal = v.maxInclusive ?? v.maxExclusive ?? "";
    const parts: string[] = [];
    if (minVal) parts.push(`min:${minVal}:${v.minExclusive != null ? "exclusive" : "inclusive"}`);
    if (maxVal) parts.push(`max:${maxVal}:${v.maxExclusive != null ? "exclusive" : "inclusive"}`);
    return { constraint: "RANGE", value: parts.join("|") };
  }
  if (v.length != null || v.minLength != null || v.maxLength != null) {
    let val: string;
    if (v.length != null) {
      val = String(v.length);
    } else if (v.minLength != null && v.maxLength == null) {
      val = `min:${v.minLength}`;
    } else if (v.maxLength != null && v.minLength == null) {
      val = `max:${v.maxLength}`;
    } else {
      val = [v.minLength, v.maxLength]
        .filter((x) => x != null)
        .map(String)
        .join("|");
    }
    return { constraint: "LENGTH", value: val };
  }
  return { constraint: "FILLED", value: v.simpleValue ?? undefined };
}

function parseEntity(el: Element): IdsEntity {
  const nameEl = getFirstElement(el, "name");
  const nameVal = nameEl ? parseIdsValue(nameEl) : {};
  const ptEl = getFirstElement(el, "predefinedType");
  const ptVal = ptEl ? parseIdsValue(ptEl) : {};
  const nameAlternatives = idsValueAlternatives(nameVal);
  const predefinedTypeAlternatives = idsValueAlternatives(ptVal);
  return {
    name: nameAlternatives[0] ?? "",
    predefinedType: predefinedTypeAlternatives[0],
    nameRestriction: hasIdsValue(nameVal) ? nameVal : undefined,
    predefinedTypeRestriction: hasIdsValue(ptVal) ? ptVal : undefined,
    nameAlternatives,
    predefinedTypeAlternatives,
    cardinality: (el.getAttribute("cardinality") as IdsEntity["cardinality"]) ?? undefined,
    instructions: el.getAttribute("instructions") ?? undefined,
  };
}

function parseClassification(el: Element): IdsClassification {
  const valueEl = getFirstElement(el, "value");
  const systemEl = getFirstElement(el, "system");
  const valueVal = valueEl ? parseIdsValue(valueEl) : {};
  const systemVal = systemEl ? parseIdsValue(systemEl) : {};
  const hasRestriction = !!(valueVal.enumerations?.length || valueVal.pattern || valueVal.minInclusive != null || valueVal.maxInclusive != null || valueVal.length != null || valueVal.minLength != null || valueVal.maxLength != null);
  return {
    value: valueToString(valueVal).trim() || undefined,
    valueRestriction: hasRestriction ? valueVal : undefined,
    system: valueToString(systemVal).trim() || "",
    systemRestriction: hasIdsValue(systemVal) ? systemVal : undefined,
    uri: el.getAttribute("uri") ?? undefined,
    cardinality: (el.getAttribute("cardinality") as IdsClassification["cardinality"]) ?? undefined,
    instructions: el.getAttribute("instructions") ?? undefined,
  };
}

function parseProperty(el: Element): IdsProperty {
  const psetEl = getFirstElement(el, "propertySet");
  const baseEl = getFirstElement(el, "baseName");
  const valueEl = getFirstElement(el, "value");
  const psetVal = psetEl ? parseIdsValue(psetEl) : {};
  const baseVal = baseEl ? parseIdsValue(baseEl) : {};
  const valueVal = valueEl ? parseIdsValue(valueEl) : {};
  const hasRestriction = !!(valueVal.enumerations?.length || valueVal.pattern || valueVal.minInclusive != null || valueVal.maxInclusive != null || valueVal.length != null || valueVal.minLength != null || valueVal.maxLength != null);
  return {
    propertySet: valueToString(psetVal).trim() || "",
    propertySetRestriction: hasIdsValue(psetVal) ? psetVal : undefined,
    baseName: valueToString(baseVal).trim() || "",
    baseNameRestriction: hasIdsValue(baseVal) ? baseVal : undefined,
    value: valueToString(valueVal).trim() || undefined,
    valueRestriction: hasRestriction ? valueVal : undefined,
    dataType: el.getAttribute("dataType") ?? undefined,
    cardinality: (el.getAttribute("cardinality") as IdsProperty["cardinality"]) ?? undefined,
    uri: el.getAttribute("uri") ?? undefined,
    instructions: el.getAttribute("instructions") ?? undefined,
  };
}

function parseAttribute(el: Element): IdsAttribute {
  const nameEl = getFirstElement(el, "name");
  const valueEl = getFirstElement(el, "value");
  const nameVal = nameEl ? parseIdsValue(nameEl) : {};
  const valueVal = valueEl ? parseIdsValue(valueEl) : {};
  const hasRestriction = !!(valueVal.enumerations?.length || valueVal.pattern || valueVal.minInclusive != null || valueVal.maxInclusive != null || valueVal.length != null || valueVal.minLength != null || valueVal.maxLength != null);
  return {
    name: valueToString(nameVal).trim() || "",
    nameRestriction: hasIdsValue(nameVal) ? nameVal : undefined,
    value: valueToString(valueVal).trim() || undefined,
    valueRestriction: hasRestriction ? valueVal : undefined,
    cardinality: (el.getAttribute("cardinality") as IdsAttribute["cardinality"]) ?? undefined,
    instructions: el.getAttribute("instructions") ?? undefined,
  };
}

function parsePartOf(el: Element): IdsPartOf {
  const entityEl = getFirstElement(el, "entity");
  return {
    entity: entityEl ? parseEntity(entityEl) : { name: "" },
    relation: el.getAttribute("relation") ?? undefined,
    cardinality: (el.getAttribute("cardinality") as IdsPartOf["cardinality"]) ?? undefined,
    instructions: el.getAttribute("instructions") ?? undefined,
  };
}

function parseMaterial(el: Element): IdsMaterial {
  const valueEl = getFirstElement(el, "value");
  const valueVal = valueEl ? parseIdsValue(valueEl) : {};
  const hasRestriction = !!(valueVal.enumerations?.length || valueVal.pattern || valueVal.minInclusive != null || valueVal.maxInclusive != null || valueVal.length != null || valueVal.minLength != null || valueVal.maxLength != null);
  return {
    value: valueToString(valueVal).trim() || undefined,
    valueRestriction: hasRestriction ? valueVal : undefined,
    cardinality: (el.getAttribute("cardinality") as IdsMaterial["cardinality"]) ?? undefined,
    uri: el.getAttribute("uri") ?? undefined,
    instructions: el.getAttribute("instructions") ?? undefined,
  };
}

function parseApplicability(el: Element): IdsApplicability {
  const entityEl = getFirstElement(el, "entity");
  return {
    entity: entityEl ? parseEntity(entityEl) : undefined,
    partOf: getElements(el, "partOf").map(parsePartOf),
    classification: getElements(el, "classification").map(parseClassification),
    attribute: getElements(el, "attribute").map(parseAttribute),
    property: getElements(el, "property").map(parseProperty),
    material: getElements(el, "material").map(parseMaterial),
  };
}

function parseRequirements(el: Element): IdsRequirements {
  return {
    entity: getElements(el, "entity").map(parseEntity),
    partOf: getElements(el, "partOf").map(parsePartOf),
    classification: getElements(el, "classification").map(parseClassification),
    attribute: getElements(el, "attribute").map(parseAttribute),
    property: getElements(el, "property").map(parseProperty),
    material: getElements(el, "material").map(parseMaterial),
  };
}

function parseOccurs(value: string | null | undefined, fallback: number): number {
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseMaxOccurs(
  value: string | null | undefined,
  fallback: number | "unbounded",
): number | "unbounded" {
  if (value == null || value.trim() === "") return fallback;
  if (value.trim().toLowerCase() === "unbounded") return "unbounded";
  return parseOccurs(value, typeof fallback === "number" ? fallback : 0);
}

/**
 * Parse IDS XML string into typed structure.
 */
export function parseIdsXml(xmlString: string): IdsParsed {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, "text/xml");
  const root = doc.documentElement;
  if (getLocalName(root) !== "ids" && root.nodeName !== "ids") {
    const err = doc.querySelector("parsererror");
    throw new Error(err ? getText(err as Element) : "Neplatný IDS soubor: očekává se kořenový element ids");
  }

  const infoEl = getFirstElement(root, "info");
  const info: IdsInfo = {};
  if (infoEl) {
    const text = (tag: string) => getText(getFirstElement(infoEl, tag));
    info.title = text("title");
    info.copyright = text("copyright") || undefined;
    info.version = text("version") || undefined;
    info.description = text("description") || undefined;
    info.author = text("author") || undefined;
    info.date = text("date") || undefined;
    info.purpose = text("purpose") || undefined;
    info.milestone = text("milestone") || undefined;
  }

  const specsEl = getFirstElement(root, "specifications");
  const specifications: IdsSpecification[] = [];
  if (specsEl) {
    const specEls = getElements(specsEl, "specification");
    for (const se of specEls) {
      const appEl = getFirstElement(se, "applicability");
      const reqEl = getFirstElement(se, "requirements");
      specifications.push({
        name: se.getAttribute("name") ?? "",
        ifcVersion: se.getAttribute("ifcVersion") ?? undefined,
        description: se.getAttribute("description") ?? undefined,
        identifier: se.getAttribute("identifier") ?? undefined,
        instructions: se.getAttribute("instructions") ?? undefined,
        minOccurs: parseOccurs(appEl?.getAttribute("minOccurs"), 0),
        maxOccurs: parseMaxOccurs(appEl?.getAttribute("maxOccurs"), "unbounded"),
        applicability: appEl ? parseApplicability(appEl) : {
          partOf: [], classification: [], attribute: [], property: [], material: [],
        },
        requirements: reqEl ? parseRequirements(reqEl) : undefined,
      });
    }
  }

  return { info, specifications };
}

// --- Map IDS to Project ---

function entityToCodes(entity: IdsEntity): string[] {
  const names = entity.nameAlternatives?.length ? entity.nameAlternatives : [entity.name];
  const predefinedTypes = entity.predefinedTypeAlternatives?.length
    ? entity.predefinedTypeAlternatives
    : entity.predefinedType
      ? [entity.predefinedType]
      : [];
  const codes: string[] = [];
  for (const rawName of names) {
    const name = (rawName || "").trim();
    if (!name) continue;
    const normalized = name.toUpperCase().startsWith("IFC") ? name : `Ifc${name}`;
    if (predefinedTypes.length === 0) {
      codes.push(normalized);
      continue;
    }
    for (const rawPredefinedType of predefinedTypes) {
      const predefinedType = rawPredefinedType.trim();
      if (predefinedType) codes.push(`${normalized}::${predefinedType.toUpperCase()}`);
    }
  }
  return [...new Set(codes)];
}

/** Legacy single-code projection kept only for the old merge implementation below. */
function entityToCode(entity: IdsEntity): string {
  return entityToCodes(entity)[0] ?? "";
}

function normalizeMatchText(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
}

function normalizeUri(value: string | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "").toLocaleLowerCase();
}

function classificationUsageKey(classification: IdsClassification): string {
  const uri = normalizeUri(classification.uri);
  return uri ? `uri:${uri}` : `name:${normalizeMatchText(classification.system)}`;
}

function classificationRuleLabel(classification: IdsClassification): string {
  if (classification.valueRestriction?.pattern) return classification.valueRestriction.pattern;
  if (classification.valueRestriction?.enumerations?.length) {
    return classification.valueRestriction.enumerations.join(" | ");
  }
  return classification.value?.trim() || "(bez omezení hodnoty)";
}

function isCatalogEntry(entry: ClassificationSystemEntry): boolean {
  const kind = entry.systemKind ?? (entry.isIfcSystem ? "ifc" : "classification");
  return kind === "classification" && !entry.isIfcSystem && !entry.isAuxiliaryAspectSystem;
}

/**
 * Předimportní přehled klasifikačních systémů.
 * URI/externalId/explicitní alias jsou jisté shody; samotný název je vždy jen pravděpodobná shoda.
 */
export function analyzeIdsClassificationImport(
  parsed: IdsParsed,
  entries: ClassificationSystemEntry[],
): IdsClassificationImportAnalysis {
  const usages = new Map<string, {
    name: string;
    uris: Set<string>;
    rules: Set<string>;
    facetCount: number;
  }>();
  let entityAlternativeCount = 0;

  for (const spec of parsed.specifications) {
    const entity = spec.applicability.entity;
    entityAlternativeCount += entity?.nameAlternatives?.length ?? (entity?.name ? 1 : 0);
    const facets = [
      ...(spec.applicability.classification ?? []),
      ...(spec.requirements?.classification ?? []),
    ];
    for (const classification of facets) {
      if (!classification.system.trim()) continue;
      const key = classificationUsageKey(classification);
      const usage = usages.get(key) ?? {
        name: classification.system.trim(),
        uris: new Set<string>(),
        rules: new Set<string>(),
        facetCount: 0,
      };
      if (classification.uri?.trim()) usage.uris.add(classification.uri.trim());
      usage.rules.add(classificationRuleLabel(classification));
      usage.facetCount += 1;
      usages.set(key, usage);
    }
  }

  const catalogs = entries.filter(isCatalogEntry);
  const systems = [...usages.entries()].map(([key, usage]): IdsClassificationSystemUsage => {
    const normalizedName = normalizeMatchText(usage.name);
    const normalizedUris = [...usage.uris].map(normalizeUri).filter(Boolean);
    const exactByUri = catalogs.find((entry) => {
      const entryUri = normalizeUri(entry.uri);
      return !!entryUri && normalizedUris.includes(entryUri);
    });
    if (exactByUri) {
      return {
        key,
        name: usage.name,
        uris: [...usage.uris],
        rules: [...usage.rules],
        facetCount: usage.facetCount,
        status: "exact",
        matchedEntryId: exactByUri.id,
        matchReason: "uri",
      };
    }
    const exactByExternalId = catalogs.find((entry) =>
      !!entry.externalId && [...usage.uris].some(
        (uri) => normalizeMatchText(uri) === normalizeMatchText(entry.externalId),
      )
    );
    if (exactByExternalId) {
      return {
        key,
        name: usage.name,
        uris: [...usage.uris],
        rules: [...usage.rules],
        facetCount: usage.facetCount,
        status: "exact",
        matchedEntryId: exactByExternalId.id,
        matchReason: "externalId",
      };
    }
    const exactByAlias = catalogs.find((entry) =>
      (entry.idsAliases ?? []).some((alias) => normalizeMatchText(alias) === normalizedName)
    );
    if (exactByAlias) {
      return {
        key,
        name: usage.name,
        uris: [...usage.uris],
        rules: [...usage.rules],
        facetCount: usage.facetCount,
        status: "exact",
        matchedEntryId: exactByAlias.id,
        matchReason: "explicitAlias",
      };
    }
    const probableByName = catalogs.find((entry) => normalizeMatchText(entry.name) === normalizedName);
    return {
      key,
      name: usage.name,
      uris: [...usage.uris],
      rules: [...usage.rules],
      facetCount: usage.facetCount,
      status: probableByName ? "probable" : "unavailable",
      matchedEntryId: probableByName?.id,
      matchReason: probableByName ? "name" : undefined,
    };
  });

  return {
    systems: systems.sort((a, b) => a.name.localeCompare(b.name)),
    specificationCount: parsed.specifications.length,
    entityAlternativeCount,
  };
}

/**
 * Normalize IDS entity code to schema case so it matches schema keys (e.g. IFCWALL -> IfcWall).
 * Otherwise buildClassificationFromSchemaFiltered won't find the entity and the tree stays empty.
 */
function normalizeCodeToSchema(schema: SchemaIndex, code: string): string {
  const [entityPart, ptPart] = code.includes("::") ? code.split("::") : [code, undefined];
  const entityUpper = (entityPart ?? "").toUpperCase();
  const schemaEntityName = Object.keys(schema.entities).find((e) => e.toUpperCase() === entityUpper);
  if (!schemaEntityName) return code; // keep original if not in schema
  const entity = schema.entities[schemaEntityName];
  if (!ptPart) return schemaEntityName;
  const ptUpper = ptPart.toUpperCase();
  const schemaPt = entity?.predefinedTypeValues?.find((p) => p.toUpperCase() === ptUpper);
  if (schemaPt) return `${schemaEntityName}::${schemaPt}`;
  return `${schemaEntityName}::${ptPart}`;
}

function occurrenceFromCardinality(c?: string): "required" | "prohibited" | "optional" {
  if (c === "prohibited") return "prohibited";
  if (c === "optional") return "optional";
  return "required";
}

/**
 * Determine property source from propertySet name: Pset_ → PSET, Qto_ → QTO, else CUSTOM.
 */
function propertySource(psetName: string, schema: SchemaIndex | null): PropertyRequirement["source"] {
  const p = (psetName || "").trim();
  if (!p) return "CUSTOM";
  const lower = p.toLowerCase();
  if (lower.startsWith("pset_")) return "PSET";
  if (lower.startsWith("qto_")) return "QTO";
  if (schema) {
    if (schema.psets[p]) return "PSET";
    if (schema.qtos[p]) return "QTO";
  }
  return "CUSTOM";
}

function mapIdsPropertyToRequirement(
  p: IdsProperty,
  phaseIds: string[],
  schema: SchemaIndex | null,
): PropertyRequirement {
  const source = propertySource(p.propertySet, schema);
  const fromRestriction = p.valueRestriction
    ? idsValueToConstraint(p.valueRestriction)
    : null;
  const value = fromRestriction?.value ?? (p.value ?? "").trim();
  const constraint = fromRestriction?.constraint ?? (value.includes("|") ? "ENUM" : "FILLED");
  return {
    id: makeId(),
    extensions: {},
    phases: phaseIds,
    useCaseMode: "inherit",
    source,
    psetName: p.propertySet || (source === "CUSTOM" ? "Vlastní" : ""),
    propertyName: p.baseName || "",
    dataType: (p.dataType && p.dataType.trim()) ? p.dataType : "IfcLabel",
    required: p.cardinality === "required",
    occurrence: occurrenceFromCardinality(p.cardinality),
    constraint: constraint as PropertyRequirement["constraint"],
    value: value || undefined,
    allowedValues: fromRestriction?.allowedValues,
    note: p.instructions ?? undefined,
    isApplicability: false,
  };
}

function mapIdsAttributeToRequirement(a: IdsAttribute, phaseIds: string[]): AttributeRequirement {
  const fromRestriction = a.valueRestriction ? idsValueToConstraint(a.valueRestriction) : null;
  const value = fromRestriction?.value ?? a.value ?? undefined;
  const constraint = fromRestriction?.constraint ?? (a.value && a.value.includes("|") ? "ENUM" : "FILLED");
  return {
    id: makeId(),
    extensions: {},
    phases: phaseIds,
    useCaseMode: "inherit",
    attribute: a.name || "",
    required: a.cardinality === "required",
    occurrence: occurrenceFromCardinality(a.cardinality),
    constraint,
    value,
    allowedValues: fromRestriction?.allowedValues,
    note: a.instructions ?? undefined,
    isApplicability: false,
  };
}

function mapIdsClassificationToRequirement(
  c: IdsClassification,
  systemEntryId: string | undefined,
  phaseIds: string[],
): ClassificationRequirement {
  const fromRestriction = c.valueRestriction ? idsValueToConstraint(c.valueRestriction) : null;
  // ClassificationRequirement only supports FILLED | ENUM | PATTERN; RANGE/LENGTH stored as FILLED with value
  const constraintRaw = fromRestriction?.constraint ?? "FILLED";
  const constraint: ClassificationRequirement["constraint"] =
    constraintRaw === "RANGE" || constraintRaw === "LENGTH" ? "FILLED" : constraintRaw;
  const value = fromRestriction?.value ?? c.value ?? undefined;
  return {
    id: makeId(),
    extensions: {},
    phases: phaseIds,
    useCaseMode: "inherit",
    classificationId: systemEntryId ?? makeId(),
    systemEntryId,
    system: c.system || "",
    identification: c.value ?? value ?? "",
    value,
    name: c.value ?? value ?? c.system ?? "",
    occurrence: occurrenceFromCardinality(c.cardinality),
    constraint,
    readOnly: false,
    isApplicability: false,
  };
}

function mapIdsPartOfToRequirement(r: IdsPartOf, phaseIds: string[]): RelationRequirement {
  const relationType = (r.relation?.replace(/\s+/g, " ") as RelationRequirement["relationType"]) ?? "IFCRELCONTAINEDINSPATIALSTRUCTURE";
  return {
    id: makeId(),
    extensions: {},
    phases: phaseIds,
    useCaseMode: "inherit",
    relationType,
    occurrence: occurrenceFromCardinality(r.cardinality),
    entityType: r.entity?.name || undefined,
    entityPredefinedType: r.entity?.predefinedType ?? undefined,
    note: r.instructions ?? undefined,
    isApplicability: false,
  };
}

function mapIdsMaterialToRequirement(m: IdsMaterial, phaseIds: string[]): MaterialRequirement {
  const fromRestriction = m.valueRestriction ? idsValueToConstraint(m.valueRestriction) : null;
  const value = fromRestriction?.value ?? m.value ?? undefined;
  const constraint = fromRestriction?.constraint;
  return {
    id: makeId(),
    extensions: {},
    phases: phaseIds,
    useCaseMode: "inherit",
    required: m.cardinality === "required",
    occurrence: occurrenceFromCardinality(m.cardinality),
    constraint,
    value,
    note: m.instructions ?? undefined,
    isApplicability: false,
  };
}

/**
 * Merge IDS into project: add new objects (by IFC entity), IFC classification, other classifications, properties.
 * Existing objects are never overwritten; only new codes are added.
 */
function mergeIdsIntoProjectLegacy(
  parsed: IdsParsed,
  existingProject: Project | null,
  schemaIndex: SchemaIndex | null,
): Project {
  const phases: Phase[] = existingProject?.phases?.length
    ? existingProject.phases
    : getDefaultPhases();
  const phaseIds = phases.map((p) => p.id);

  // Collect all (entity, predefinedType) from IDS specifications; normalize to schema case so tree matches
  const entityCodes = new Set<string>();
  const specByCode = new Map<string, IdsSpecification>();
  for (const spec of parsed.specifications) {
    const app = spec.applicability;
    const entity = app?.entity;
    if (!entity?.name) continue;
    let code = entityToCode(entity);
    if (!code) continue;
    if (schemaIndex) code = normalizeCodeToSchema(schemaIndex, code);
    entityCodes.add(code);
    if (!specByCode.has(code)) {
      specByCode.set(code, spec);
    } else {
      // Merge requirements from multiple specs with same applicability into first
      const first = specByCode.get(code)!;
      const req = spec.requirements;
      if (req) {
        if (!first.requirements) first.requirements = {
          entity: [], partOf: [], classification: [], attribute: [], property: [], material: [],
        };
        first.requirements!.attribute.push(...req.attribute);
        first.requirements!.property.push(...req.property);
        first.requirements!.classification.push(...req.classification);
        first.requirements!.partOf.push(...req.partOf);
        first.requirements!.material.push(...req.material);
      }
    }
  }

  // IFC classification: strom NEOBSAHUJE nové entity z IDS – ty zůstanou v „Entity mimo hierarchii“ (žluté)
  // až do potvrzení „Přidat do hierarchie“; teprve pak se přidají do stromu
  let ifcEntry: ClassificationSystemEntry | null = existingProject?.classificationSystemEntries?.find((e) => e.isIfcSystem) ?? null;
  if (schemaIndex) {
    const existingCodes = ifcEntry ? new Set(collectLeaves(ifcEntry.nodes ?? []).map((n) => n.code)) : new Set<string>();
    const ifcData = buildClassificationFromSchemaFiltered(schemaIndex, existingCodes);
    if (ifcEntry) {
      ifcEntry = { ...ifcEntry, nodes: ifcData.nodes, hash: ifcData.hash };
    } else {
      ifcEntry = {
        id: makeId(),
        name: "Třídění dle IFC entit",
        sourceName: "Třídění dle IFC entit",
        nodes: ifcData.nodes,
        hash: ifcData.hash,
        isPrimary: !existingProject,
        isIfcSystem: true,
        systemKind: "ifc",
      };
    }
  } else {
    if (!ifcEntry) {
      ifcEntry = {
        id: makeId(),
        name: "Třídění dle IFC entit",
        sourceName: "Třídění dle IFC entit",
        nodes: [],
        hash: "ids-empty",
        isPrimary: !existingProject,
        isIfcSystem: true,
        systemKind: "ifc",
      };
    }
  }

  // Other classifications from IDS (system names)
  const classificationSystems = new Map<string, IdsClassification[]>();
  for (const spec of parsed.specifications) {
    const app = spec.applicability;
    const req = spec.requirements;
    for (const c of [...(app?.classification ?? []), ...(req?.classification ?? [])]) {
      if (!c.system) continue;
      if (!classificationSystems.has(c.system)) {
        classificationSystems.set(c.system, []);
      }
      classificationSystems.get(c.system)!.push(c);
    }
  }

  const entries: ClassificationSystemEntry[] = existingProject?.classificationSystemEntries ?? [];
  const updatedEntries = entries.map((e) => (e.id === ifcEntry?.id ? ifcEntry : { ...e, isPrimary: false }));
  if (ifcEntry && !updatedEntries.some((e) => e.id === ifcEntry!.id)) {
    updatedEntries.push(ifcEntry);
  }
  // Při importu IDS je primární vždy IFC, aby se v hierarchii zobrazily importované entity
  const primaryId = ifcEntry?.id ?? existingProject?.primaryClassificationId ?? makeId();
  const primaryEntry: ClassificationSystemEntry =
    updatedEntries.find((e) => e.id === primaryId) ??
    ifcEntry ??
    {
      id: primaryId,
      name: "Klasifikace",
      sourceName: "Klasifikace",
      nodes: [],
      hash: "",
      isPrimary: true,
      systemKind: "classification",
    };
  const primaryName = primaryEntry.name;
  const updatedEntriesWithPrimary = updatedEntries.map((e) => ({
    ...e,
    isPrimary: e.id === primaryEntry.id,
  }));

  const classificationData: ClassificationData = {
    nodes: primaryEntry.nodes ?? [],
    sourceName: primaryEntry.sourceName ?? primaryEntry.name,
    hash: primaryEntry.hash,
  };

  const objects: Record<string, ProjectObject> = { ...(existingProject?.objects ?? {}) };

  for (const code of entityCodes) {
    if (objects[code]) continue; // never overwrite existing
    const spec = specByCode.get(code);
    const app = spec?.applicability;
    const [entityName, predefinedType] = code.includes("::") ? code.split("::") : [code, undefined];

    const requirements: ObjectRequirements = {
      attributes: [],
      properties: [],
      relations: [],
      classifications: [],
      materials: [],
    };

    // Primary classification (IFC) - link to primary/system
    requirements.classifications.push({
      id: makeId(),
      classificationId: primaryId,
      systemEntryId: ifcEntry?.id,
      system: primaryName,
      identification: code,
      value: code,
      name: code,
      readOnly: true,
      occurrence: "required",
      isApplicability: true,
      extensions: {},
      phases: phaseIds,
    });

    // Applicability classifications (other systems)
    for (const c of app?.classification ?? []) {
      requirements.classifications.push({
        ...mapIdsClassificationToRequirement(c, undefined, phaseIds),
        isApplicability: true,
      });
    }
    // Requirements classifications
    for (const c of spec?.requirements?.classification ?? []) {
      requirements.classifications.push(mapIdsClassificationToRequirement(c, undefined, phaseIds));
    }

    // Attributes (applicability + requirements)
    for (const a of app?.attribute ?? []) {
      requirements.attributes.push({ ...mapIdsAttributeToRequirement(a, phaseIds), isApplicability: true });
    }
    for (const a of spec?.requirements?.attribute ?? []) {
      requirements.attributes.push(mapIdsAttributeToRequirement(a, phaseIds));
    }

    // Properties: group by propertySet; source PSET/QTO/CUSTOM
    for (const p of app?.property ?? []) {
      const req = mapIdsPropertyToRequirement(p, phaseIds, schemaIndex);
      req.isApplicability = true;
      requirements.properties.push(req);
    }
    for (const p of spec?.requirements?.property ?? []) {
      requirements.properties.push(mapIdsPropertyToRequirement(p, phaseIds, schemaIndex));
    }

    // PartOf (relations)
    for (const r of app?.partOf ?? []) {
      requirements.relations.push({ ...mapIdsPartOfToRequirement(r, phaseIds), isApplicability: true });
    }
    for (const r of spec?.requirements?.partOf ?? []) {
      requirements.relations.push(mapIdsPartOfToRequirement(r, phaseIds));
    }

    // Materials
    for (const m of app?.material ?? []) {
      requirements.materials.push({ ...mapIdsMaterialToRequirement(m, phaseIds), isApplicability: true });
    }
    for (const m of spec?.requirements?.material ?? []) {
      requirements.materials.push(mapIdsMaterialToRequirement(m, phaseIds));
    }

    // Název objektu z applicability: IFC entita + typ (predefined type) – zobrazí se v hierarchii
    const fromApplicability = entityName
      ? (predefinedType ? `${entityName} – ${predefinedType}` : entityName).trim()
      : "";
    const description = fromApplicability || spec?.name || code;
    const specMeta = (spec?.name || spec?.identifier || spec?.description || spec?.instructions)
      ? {
          name: spec?.name,
          ifcVersion: (spec?.ifcVersion as "IFC2X3" | "IFC4" | "IFC4X3_ADD2") ?? undefined,
          identifier: spec?.identifier,
          description: spec?.description,
          instructions: spec?.instructions,
        }
      : undefined;
    const idsSpecMetadata = specMeta
      ? { [`all|all`]: specMeta }
      : undefined;
    objects[code] = {
      code,
      description,
      ifcEntity: entityName ?? code,
      predefinedType: predefinedType
        ? { mode: "ENUM", value: predefinedType }
        : { mode: "NONE" },
      ifcEntityPhases: phaseIds,
      predefinedTypePhases: phaseIds,
      idsSpecMetadata,
      requirements,
    };
  }

  const now = new Date().toISOString();
  const info = parsed.info;
  const importedIdsMetadata = (info.title || info.copyright || info.version || info.description || info.author || info.date || info.purpose || info.milestone)
    ? {
        title: info.title,
        copyright: info.copyright,
        version: info.version,
        description: info.description,
        author: info.author,
        date: info.date,
        purpose: info.purpose,
        milestone: info.milestone,
      }
    : undefined;
  // Verze IFC z první specification v IDS (ifcVersion), aby projekt odpovídal importovanému souboru
  const idsVersion = parsed.specifications.find((s) => s.ifcVersion)?.ifcVersion;
  const ifcSchemaVersion = idsIfcVersionToSchemaVersion(idsVersion);
  const ifcSchemaVersionDisplay = getDisplayLabel(ifcSchemaVersion);
  const ifcDocumentationUrl = getIfcDocumentationBaseUrl(ifcSchemaVersion);
  let project: Project;
  if (existingProject) {
    project = ensureProjectPhases({
      ...existingProject,
      idsMetadata: importedIdsMetadata ?? existingProject.idsMetadata,
      classification: classificationData,
      classificationSystemEntries: updatedEntriesWithPrimary,
      primaryClassificationId: primaryId,
      objects,
      ifcSchemaVersion,
      ifcSchemaVersionDisplay,
      ifcDocumentationUrl,
      updatedAt: now,
    });
  } else {
    project = ensureProjectPhases({
      projectId: makeId(),
      name: parsed.info.title || "Projekt z IDS",
      author: parsed.info.author ?? "",
      description: parsed.info.description ?? undefined,
      idsMetadata: importedIdsMetadata,
      createdAt: now,
      updatedAt: now,
      ifcSchemaVersion,
      ifcSchemaVersionDisplay,
      ifcDocumentationUrl,
      classification: classificationData,
      classifications: [],
      primaryClassificationId: primaryId,
      phases,
      objects,
      codeLists: [],
      classificationSystemEntries: updatedEntriesWithPrimary,
    });
  }

  return project;
}

function splitAspectName(systemName: string): { provider: string; aspect: string } {
  const parts = systemName.split(/\s+-\s+/, 2);
  return parts.length === 2
    ? { provider: parts[0]?.trim() || "IDS", aspect: parts[1]?.trim() || systemName }
    : { provider: "IDS", aspect: systemName };
}

function buildAuxiliaryAspectNodes(usages: IdsClassificationSystemUsage[]): ClassificationData["nodes"] {
  const byProvider = new Map<string, IdsClassificationSystemUsage[]>();
  for (const usage of usages) {
    const { provider } = splitAspectName(usage.name);
    const list = byProvider.get(provider) ?? [];
    list.push(usage);
    byProvider.set(provider, list);
  }
  return [...byProvider.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, systems], providerIndex) => ({
      code: `IDS-AUX:${providerIndex + 1}:${provider}`,
      description: `${provider} (organizační skupina aspektů)`,
      level: 1,
      children: systems
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((usage, systemIndex) => {
          const { aspect } = splitAspectName(usage.name);
          return {
            code: `IDS-AUX:${providerIndex + 1}:${systemIndex + 1}:${usage.name}`,
            description: aspect,
            level: 2,
            children: usage.rules.map((rule, ruleIndex) => ({
              code: `IDS-AUX:${providerIndex + 1}:${systemIndex + 1}:${ruleIndex + 1}`,
              description: rule,
              level: 3,
              children: [],
            })),
          };
        }),
    }));
}

function getSpecGroupId(spec: IdsSpecification, index: number): string {
  const stablePart = spec.identifier?.trim() || `${index + 1}:${spec.name.trim()}`;
  return `ids:${stablePart}`;
}

function cloneIdsValue(value: IdsValue): IdsValueConstraint {
  return {
    ...value,
    enumerations: value.enumerations ? [...value.enumerations] : undefined,
  };
}

function canonicalValue(
  restriction: IdsValue | undefined,
  fallback: string | undefined,
  alternatives?: string[],
): IdsValueConstraint | undefined {
  if (restriction && hasIdsValue(restriction)) return cloneIdsValue(restriction);
  const normalizedAlternatives = alternatives?.map((value) => value.trim()).filter(Boolean) ?? [];
  if (normalizedAlternatives.length > 1) return { enumerations: normalizedAlternatives };
  const value = normalizedAlternatives[0] ?? fallback?.trim();
  return value ? { simpleValue: value } : undefined;
}

function canonicalEntityFacet(
  entity: IdsEntity,
  id: string,
  cardinality?: IdsProjectEntityFacet["cardinality"],
  instructions?: string,
): IdsProjectEntityFacet {
  return {
    id,
    kind: "entity",
    name: canonicalValue(
      entity.nameRestriction,
      entity.name,
      entity.nameAlternatives,
    ) ?? {},
    predefinedType: canonicalValue(
      entity.predefinedTypeRestriction,
      entity.predefinedType,
      entity.predefinedTypeAlternatives,
    ),
    cardinality: cardinality ?? entity.cardinality,
    instructions: instructions ?? entity.instructions,
  };
}

function canonicalFacet(
  facet:
    | IdsEntity
    | IdsAttribute
    | IdsClassification
    | IdsProperty
    | IdsMaterial
    | IdsPartOf,
  kind: IdsProjectFacet["kind"],
  id: string,
  systemEntryIdFor: (classification: IdsClassification) => string | undefined,
  unresolvedUsageKeys: Set<string>,
): IdsProjectFacet {
  if (kind === "entity") {
    const entity = facet as IdsEntity;
    return canonicalEntityFacet(entity, id, entity.cardinality, entity.instructions);
  }
  if (kind === "attribute") {
    const attribute = facet as IdsAttribute;
    return {
      id,
      kind,
      name: canonicalValue(attribute.nameRestriction, attribute.name) ?? {},
      value: canonicalValue(attribute.valueRestriction, attribute.value),
      cardinality: attribute.cardinality,
      instructions: attribute.instructions,
    };
  }
  if (kind === "classification") {
    const classification = facet as IdsClassification;
    return {
      id,
      kind,
      system: canonicalValue(
        classification.systemRestriction,
        classification.system,
      ) ?? {},
      value: canonicalValue(classification.valueRestriction, classification.value),
      systemEntryId: systemEntryIdFor(classification),
      unresolved: unresolvedUsageKeys.has(classificationUsageKey(classification)),
      cardinality: classification.cardinality,
      instructions: classification.instructions,
      uri: classification.uri,
    };
  }
  if (kind === "property") {
    const property = facet as IdsProperty;
    return {
      id,
      kind,
      propertySet: canonicalValue(
        property.propertySetRestriction,
        property.propertySet,
      ) ?? {},
      baseName: canonicalValue(property.baseNameRestriction, property.baseName) ?? {},
      value: canonicalValue(property.valueRestriction, property.value),
      dataType: property.dataType,
      cardinality: property.cardinality,
      instructions: property.instructions,
      uri: property.uri,
    };
  }
  if (kind === "material") {
    const material = facet as IdsMaterial;
    return {
      id,
      kind,
      value: canonicalValue(material.valueRestriction, material.value),
      cardinality: material.cardinality,
      instructions: material.instructions,
      uri: material.uri,
    };
  }
  const partOf = facet as IdsPartOf;
  return {
    id,
    kind: "partOf",
    relation: partOf.relation,
    entity: canonicalEntityFacet(partOf.entity, `${id}:entity`),
    cardinality: partOf.cardinality,
    instructions: partOf.instructions,
  };
}

function buildCanonicalSpecifications(
  parsed: IdsParsed,
  systemEntryIdFor: (classification: IdsClassification) => string | undefined,
  unresolvedUsageKeys: Set<string>,
  phaseScope?: { phaseId: string; existingById: Map<string, IdsProjectSpecification> },
): IdsProjectSpecification[] {
  const toFacets = (
    spec: IdsSpecification,
    section: "applicability" | "requirements",
    specId: string,
  ): IdsProjectFacet[] => {
    const source = section === "applicability" ? spec.applicability : spec.requirements;
    if (!source) return [];
    const facets: IdsProjectFacet[] = [];
    const add = (
      kind: IdsProjectFacet["kind"],
      items: Array<IdsEntity | IdsAttribute | IdsClassification | IdsProperty | IdsMaterial | IdsPartOf>,
    ) => {
      items.forEach((facet, index) => {
        facets.push(canonicalFacet(
          facet,
          kind,
          `${specId}:${section}:${kind}:${index + 1}`,
          systemEntryIdFor,
          unresolvedUsageKeys,
        ));
      });
    };
    if (section === "applicability") {
      const applicability = spec.applicability;
      if (applicability.entity) add("entity", [applicability.entity]);
      add("partOf", applicability.partOf);
      add("classification", applicability.classification);
      add("attribute", applicability.attribute);
      add("property", applicability.property);
      add("material", applicability.material);
    } else {
      const requirements = spec.requirements!;
      add("entity", requirements.entity);
      add("partOf", requirements.partOf);
      add("classification", requirements.classification);
      add("attribute", requirements.attribute);
      add("property", requirements.property);
      add("material", requirements.material);
    }
    return facets;
  };

  return parsed.specifications.map((spec, index) => {
    const baseId = getSpecGroupId(spec, index);
    // Stejný identifikátor (01, 02, ...) se v souborech pro různé milníky opakuje.
    // Pokud už v projektu existuje specifikace s tímto klíčem a patří do jiné fáze,
    // dostane specifikace z tohoto souboru vlastní klíč s příponou fáze.
    const existingForBase = phaseScope?.existingById.get(baseId);
    const existingScope = existingForBase?.authoring?.scope?.phaseIds;
    const id = phaseScope && existingScope?.length && !existingScope.includes(phaseScope.phaseId)
      ? `${baseId}@${phaseScope.phaseId}`
      : baseId;
    const specification: IdsProjectSpecification = {
      id,
      name: spec.name,
      ifcVersion: spec.ifcVersion as IdsProjectSpecification["ifcVersion"],
      identifier: spec.identifier,
      description: spec.description,
      instructions: spec.instructions,
      minOccurs: spec.minOccurs ?? 0,
      maxOccurs: spec.maxOccurs ?? "unbounded",
      applicability: toFacets(spec, "applicability", id),
      requirements: toFacets(spec, "requirements", id),
      source: "imported",
      ...(phaseScope ? { authoring: { scope: { phaseIds: [phaseScope.phaseId] } } } : {}),
    };
    const hash = hashIdsStandardSpecification(specification);
    specification.importTracking = {
      sourceKey: id,
      lastAcceptedHash: hash,
      lastSeenHash: hash,
    };
    return specification;
  });
}

/** Odstraní pouze starou materializovanou projekci importovaného IDS; vlastní požadavky zachová. */
function withoutImportedIdsProjection(requirements?: ObjectRequirements): ObjectRequirements {
  const isImported = (requirement: { extensions?: Record<string, unknown> }) =>
    typeof requirement.extensions?.idsSpecificationGroupId === "string";
  return {
    attributes: (requirements?.attributes ?? []).filter((item) => !isImported(item)),
    properties: (requirements?.properties ?? []).filter((item) => !isImported(item)),
    relations: (requirements?.relations ?? []).filter((item) => !isImported(item)),
    classifications: (requirements?.classifications ?? []).filter((item) => !isImported(item)),
    materials: (requirements?.materials ?? []).filter((item) => !isImported(item)),
  };
}

function buildImportedIdsMetadata(info: IdsInfo): Project["idsMetadata"] | undefined {
  return (info.title || info.copyright || info.version || info.description || info.author || info.date || info.purpose || info.milestone)
    ? {
        title: info.title,
        copyright: info.copyright,
        version: info.version,
        description: info.description,
        author: info.author,
        date: info.date,
        purpose: info.purpose,
        milestone: info.milestone,
      }
    : undefined;
}

const normalizePhaseKey = (value: string): string =>
  value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();

/**
 * Převede <ids:milestone> z hlavičky IDS na fázi projektu.
 * - shoda podle názvu nebo kódu (bez diakritiky a velikosti písmen) použije existující fázi,
 * - jinak se fáze vytvoří; u prázdného projektu s nedotčenou výchozí „Fáze1" ji nahradí.
 */
export function applyIdsMilestonePhase(
  basePhases: Phase[],
  milestone: string | undefined,
  existingProject: Pick<Project, "objects" | "idsSpecifications"> | null,
): { phases: Phase[]; phase?: Phase } {
  const label = milestone?.trim();
  if (!label) return { phases: basePhases };
  const key = normalizePhaseKey(label);
  const found = basePhases.find(
    (phase) => normalizePhaseKey(phase.name) === key || normalizePhaseKey(phase.code) === key,
  );
  if (found) return { phases: basePhases, phase: found };
  const phase: Phase = { id: makeId(), code: label, name: label };
  const onlyDefault =
    basePhases.length === 1 &&
    basePhases[0].id === DEFAULT_SINGLE_PHASE.id &&
    basePhases[0].name === DEFAULT_SINGLE_PHASE.name &&
    basePhases[0].code === DEFAULT_SINGLE_PHASE.code;
  const emptyProject =
    !Object.keys(existingProject?.objects ?? {}).length &&
    !(existingProject?.idsSpecifications?.length);
  return { phases: onlyDefault && emptyProject ? [phase] : [...basePhases, phase], phase };
}

/**
 * Import s reportem pro UI. Nové IFC alternativy jsou po potvrzení vloženy do stromu,
 * zatímco nedostupné klasifikační katalogy vytvoří pouze označenou pomocnou strukturu.
 */
export function mergeIdsIntoProjectWithReport(
  parsed: IdsParsed,
  existingProject: Project | null,
  schemaIndex: SchemaIndex | null,
  options: IdsImportOptions = {},
): IdsImportResult {
  const basePhases: Phase[] = existingProject?.phases?.length ? existingProject.phases : getDefaultPhases();
  const { phases, phase: milestonePhase } = applyIdsMilestonePhase(
    basePhases,
    parsed.info.milestone,
    existingProject,
  );
  const phaseIds = milestonePhase ? [milestonePhase.id] : phases.map((phase) => phase.id);
  const existingEntries = existingProject?.classificationSystemEntries ?? [];
  const analysis = analyzeIdsClassificationImport(parsed, existingEntries);
  const requestedResolution = new Map(
    (options.catalogResolutions ?? []).map((resolution) => [resolution.usageKey, resolution]),
  );
  const warnings: string[] = [];

  const entityCodes = new Set<string>();
  parsed.specifications.forEach((spec) => {
    const entity = spec.applicability.entity;
    if (!entity?.name) return;
    const rawCodes = entityToCodes(entity);
    const normalizedCodes = rawCodes.map((code) => schemaIndex ? normalizeCodeToSchema(schemaIndex, code) : code);
    for (const code of normalizedCodes) {
      if (!code) continue;
      entityCodes.add(code);
    }
  });

  let ifcEntry: ClassificationSystemEntry | null =
    existingEntries.find((entry) => entry.isIfcSystem) ?? null;
  if (schemaIndex) {
    const selectedCodes = ifcEntry
      ? new Set(collectLeaves(ifcEntry.nodes ?? []).map((node) => node.code))
      : new Set<string>();
    if (options.addImportedIfcEntitiesToHierarchy !== false) {
      entityCodes.forEach((code) => selectedCodes.add(code));
    }
    const ifcData = buildClassificationFromSchemaFiltered(schemaIndex, selectedCodes);
    const builtCodes = new Set(collectLeaves(ifcData.nodes).map((node) => node.code));
    const unmatched = [...entityCodes].filter((code) => !builtCodes.has(code));
    if (unmatched.length > 0) {
      warnings.push(`${unmatched.length} IFC kódů se nepodařilo zařadit do načteného schématu.`);
    }
    ifcEntry = ifcEntry
      ? { ...ifcEntry, nodes: ifcData.nodes, hash: ifcData.hash }
      : {
          id: makeId(),
          name: "Třídění dle IFC entit",
          sourceName: "Třídění dle IFC entit",
          nodes: ifcData.nodes,
          hash: ifcData.hash,
          isPrimary: true,
          isIfcSystem: true,
          systemKind: "ifc",
        };
  } else {
    warnings.push("IFC schéma nebylo při importu dostupné; IFC objekty zůstaly mimo strom.");
    ifcEntry ??= {
      id: makeId(),
      name: "Třídění dle IFC entit",
      sourceName: "Třídění dle IFC entit",
      nodes: [],
      hash: "ids-empty",
      isPrimary: true,
      isIfcSystem: true,
      systemKind: "ifc",
    };
  }

  const resolvedCatalogIdByUsageKey = new Map<string, string>();
  const linkedSystems: IdsImportReport["linkedSystems"] = [];
  const auxiliaryUsages: IdsClassificationSystemUsage[] = [];
  for (const usage of analysis.systems) {
    const defaultResolution: IdsCatalogResolution =
      usage.status === "exact" && usage.matchedEntryId
        ? { usageKey: usage.key, mode: "catalog", catalogEntryId: usage.matchedEntryId }
        : { usageKey: usage.key, mode: "auxiliary" };
    const resolution = requestedResolution.get(usage.key) ?? defaultResolution;
    const selectedCatalog = resolution.mode === "catalog"
      ? existingEntries.find((entry) => entry.id === resolution.catalogEntryId && isCatalogEntry(entry))
      : undefined;
    if (selectedCatalog) {
      resolvedCatalogIdByUsageKey.set(usage.key, selectedCatalog.id);
      linkedSystems.push({ name: usage.name, catalogName: selectedCatalog.name });
    } else {
      if (resolution.mode === "catalog") {
        warnings.push(`Katalog pro „${usage.name}“ nebyl nalezen; byla použita pomocná struktura.`);
      }
      auxiliaryUsages.push(usage);
    }
  }

  const auxiliarySourceName = `IDS aspekty: ${parsed.info.title || "import"}`;
  let auxiliaryEntry = auxiliaryUsages.length > 0
    ? existingEntries.find((entry) =>
        entry.isAuxiliaryAspectSystem && entry.sourceName === auxiliarySourceName
      )
    : undefined;
  if (auxiliaryUsages.length > 0) {
    const nodes = buildAuxiliaryAspectNodes(auxiliaryUsages);
    auxiliaryEntry = {
      ...(auxiliaryEntry ?? { id: makeId(), name: "Pomocné klasifikační aspekty z IDS" }),
      description:
        "Pomocná organizační struktura z pravidel IDS. Neobsahuje skutečné třídy, názvy ani vztahy katalogu.",
      sourceName: auxiliarySourceName,
      nodes,
      hash: `ids-aux-${auxiliaryUsages.length}-${auxiliaryUsages.reduce((sum, usage) => sum + usage.rules.length, 0)}`,
      isPrimary: false,
      isPure: true,
      systemKind: "classification",
      isAuxiliaryAspectSystem: true,
    };
    auxiliaryUsages.forEach((usage) => resolvedCatalogIdByUsageKey.set(usage.key, auxiliaryEntry!.id));
  }

  const entries = existingEntries.map((entry): ClassificationSystemEntry => {
    if (entry.id === ifcEntry?.id) return { ...ifcEntry, isPrimary: true };
    if (entry.id === auxiliaryEntry?.id) return auxiliaryEntry;
    return { ...entry, isPrimary: false };
  });
  if (ifcEntry && !entries.some((entry) => entry.id === ifcEntry!.id)) entries.push(ifcEntry);
  if (auxiliaryEntry && !entries.some((entry) => entry.id === auxiliaryEntry!.id)) entries.push(auxiliaryEntry);

  const primaryId = ifcEntry?.id ?? existingProject?.primaryClassificationId ?? makeId();
  const primaryEntry = entries.find((entry) => entry.id === primaryId) ?? ifcEntry!;
  const entriesWithPrimary = entries.map((entry) => ({ ...entry, isPrimary: entry.id === primaryId }));
  const classificationData: ClassificationData = {
    nodes: primaryEntry.nodes ?? [],
    sourceName: primaryEntry.sourceName ?? primaryEntry.name,
    hash: primaryEntry.hash,
  };
  const systemEntryIdFor = (classification: IdsClassification): string | undefined =>
    resolvedCatalogIdByUsageKey.get(classificationUsageKey(classification));
  const unresolvedUsageKeys = new Set(
    auxiliaryUsages.map((usage) => usage.key),
  );
  const importedSpecifications = buildCanonicalSpecifications(
    parsed,
    systemEntryIdFor,
    unresolvedUsageKeys,
    milestonePhase
      ? {
          phaseId: milestonePhase.id,
          existingById: new Map(
            (existingProject?.idsSpecifications ?? []).map((specification) => [specification.id, specification]),
          ),
        }
      : undefined,
  );
  const existingSpecifications = existingProject?.idsSpecifications ?? [];
  const specificationsById = new Map(
    existingSpecifications.map((specification) => [specification.id, specification]),
  );
  const existingBySourceKey = new Map(
    existingSpecifications
      .filter((specification) => specification.importTracking?.sourceKey || specification.id.startsWith("ids:"))
      .map((specification) => [
        specification.importTracking?.sourceKey ?? specification.id,
        specification,
      ]),
  );
  const reimportConflicts: IdsReimportConflict[] = [];
  const usedIdentifiers = new Set(
    existingSpecifications.map((specification) => specification.identifier).filter(Boolean),
  );
  const uniqueIncomingIdentifier = (raw: string | undefined): string | undefined => {
    if (!raw) return undefined;
    let candidate = `${raw}-imported`;
    let suffix = 2;
    while (usedIdentifiers.has(candidate)) {
      candidate = `${raw}-imported-${suffix}`;
      suffix += 1;
    }
    usedIdentifiers.add(candidate);
    return candidate;
  };
  const preserveAuthoring = (
    incoming: IdsProjectSpecification,
    existing: IdsProjectSpecification,
  ): IdsProjectSpecification => {
    const facetAuthoring = new Map(
      [...existing.applicability, ...existing.requirements]
        .filter((facet) => facet.authoring)
        .map((facet) => [facet.id, facet.authoring]),
    );
    const withFacetAuthoring = (facet: IdsProjectFacet): IdsProjectFacet => ({
      ...facet,
      authoring: facetAuthoring.get(facet.id) ?? facet.authoring,
    });
    return {
      ...incoming,
      authoring: existing.authoring ?? incoming.authoring,
      applicability: incoming.applicability.map(withFacetAuthoring),
      requirements: incoming.requirements.map(withFacetAuthoring),
    };
  };
  importedSpecifications.forEach((incoming) => {
    const sourceKey = incoming.importTracking?.sourceKey ?? incoming.id;
    const existing = existingBySourceKey.get(sourceKey);
    const incomingHash = hashIdsStandardSpecification(incoming);
    if (!existing) {
      specificationsById.set(incoming.id, incoming);
      return;
    }
    const localHash = hashIdsStandardSpecification(existing);
    const lastAcceptedHash = existing.importTracking?.lastAcceptedHash ?? localHash;
    const localChanged = localHash !== lastAcceptedHash;
    const incomingChanged = incomingHash !== lastAcceptedHash;
    const choice = options.reimportResolutions?.[sourceKey];

    if (localHash === incomingHash || !localChanged) {
      const accepted = preserveAuthoring(incoming, existing);
      accepted.id = existing.id;
      accepted.importTracking = {
        sourceKey,
        lastAcceptedHash: incomingHash,
        lastSeenHash: incomingHash,
      };
      specificationsById.set(existing.id, accepted);
      return;
    }
    if (localChanged && !incomingChanged) {
      specificationsById.set(existing.id, {
        ...existing,
        importTracking: {
          sourceKey,
          lastAcceptedHash,
          lastSeenHash: incomingHash,
        },
      });
      return;
    }

    const conflict: IdsReimportConflict = {
      sourceKey,
      existingId: existing.id,
      incomingId: incoming.id,
      name: incoming.name || existing.name || incoming.identifier || existing.identifier || sourceKey,
      localHash,
      incomingHash,
      lastAcceptedHash,
    };
    reimportConflicts.push(conflict);
    if (choice === "accept-import") {
      const accepted = preserveAuthoring(incoming, existing);
      accepted.id = existing.id;
      accepted.importTracking = {
        sourceKey,
        lastAcceptedHash: incomingHash,
        lastSeenHash: incomingHash,
      };
      specificationsById.set(existing.id, accepted);
    } else if (choice === "duplicate-both") {
      specificationsById.set(existing.id, {
        ...existing,
        importTracking: {
          sourceKey,
          lastAcceptedHash,
          lastSeenHash: incomingHash,
        },
      });
      const duplicateId = makeId();
      specificationsById.set(duplicateId, {
        ...incoming,
        id: duplicateId,
        name: `${incoming.name || "IDS specifikace"} – nová importovaná verze`,
        identifier: uniqueIncomingIdentifier(incoming.identifier),
        importTracking: {
          sourceKey: `${sourceKey}:incoming:${incomingHash}`,
          lastAcceptedHash: incomingHash,
          lastSeenHash: incomingHash,
        },
      });
    } else {
      // Bez explicitní volby se data neztratí: dočasně ponechat lokální verzi
      // a vrátit konflikt UI, které import dokončí druhým voláním.
      specificationsById.set(existing.id, {
        ...existing,
        importTracking: {
          sourceKey,
          lastAcceptedHash,
          lastSeenHash: incomingHash,
        },
      });
    }
  });

  const objects: Record<string, ProjectObject> = { ...(existingProject?.objects ?? {}) };
  // Existující objekt si ponechá své fáze a doplní se fáze z milníku tohoto souboru.
  const withMilestone = (existing: string[] | undefined): string[] =>
    existing
      ? (milestonePhase ? Array.from(new Set([...existing, milestonePhase.id])) : existing)
      : phaseIds;
  for (const code of entityCodes) {
    const existingObject = objects[code];
    const requirements = withoutImportedIdsProjection(existingObject?.requirements);
    const [entityName, predefinedType] = code.includes("::") ? code.split("::") : [code, undefined];
    if (!requirements.classifications.some((item) =>
      item.readOnly && item.systemEntryId === ifcEntry?.id
    )) {
      requirements.classifications.push({
        id: makeId(),
        classificationId: primaryId,
        systemEntryId: ifcEntry?.id,
        system: primaryEntry.name,
        identification: code,
        value: code,
        name: code,
        readOnly: true,
        occurrence: "required",
        isApplicability: true,
        extensions: {},
        phases: phaseIds,
      });
    }

    objects[code] = {
      ...existingObject,
      code,
      description: existingObject?.description ||
        (predefinedType ? `${entityName} – ${predefinedType}` : entityName || code),
      ifcEntity: existingObject?.ifcEntity || entityName || code,
      predefinedType: existingObject?.predefinedType ?? (
        predefinedType ? { mode: "ENUM", value: predefinedType } : { mode: "NONE" }
      ),
      ifcEntityPhases: withMilestone(existingObject?.ifcEntityPhases),
      predefinedTypePhases: withMilestone(existingObject?.predefinedTypePhases),
      idsSpecMetadata: existingObject?.importedIdsSpecificationGroups?.length
        ? undefined
        : existingObject?.idsSpecMetadata,
      importedIdsSpecificationGroups: undefined,
      requirements,
    };
  }

  const now = new Date().toISOString();
  const importedIdsMetadata = buildImportedIdsMetadata(parsed.info);
  const idsVersion = parsed.specifications.find((spec) => spec.ifcVersion)?.ifcVersion;
  const ifcSchemaVersion = idsIfcVersionToSchemaVersion(idsVersion);
  const common = {
    phases,
    idsMetadata: importedIdsMetadata ?? existingProject?.idsMetadata,
    classification: classificationData,
    classificationSystemEntries: entriesWithPrimary,
    primaryClassificationId: primaryId,
    objects,
    idsSpecifications: [...specificationsById.values()],
    ifcSchemaVersion,
    ifcSchemaVersionDisplay: getDisplayLabel(ifcSchemaVersion),
    ifcDocumentationUrl: getIfcDocumentationBaseUrl(ifcSchemaVersion),
    updatedAt: now,
  };
  const project = existingProject
    ? ensureProjectPhases({ ...existingProject, ...common })
    : ensureProjectPhases({
        projectId: makeId(),
        name: parsed.info.title || "Projekt z IDS",
        author: parsed.info.author ?? "",
        description: parsed.info.description ?? undefined,
        createdAt: now,
        classifications: [],
        codeLists: [],
        ...common,
      });

  return {
    project,
    report: {
      linkedSystems,
      auxiliarySystems: auxiliaryUsages.map((usage) => usage.name),
      preservedClassificationRules: analysis.systems.reduce((sum, usage) => sum + usage.rules.length, 0),
      importedIfcCodes: entityCodes.size,
      expandedEntityAlternatives: analysis.entityAlternativeCount,
      warnings,
      reimportConflicts,
    },
  };
}

/** Compatibility wrapper for non-UI callers. */
export function mergeIdsIntoProject(
  parsed: IdsParsed,
  existingProject: Project | null,
  schemaIndex: SchemaIndex | null,
  options: IdsImportOptions = {},
): Project {
  return mergeIdsIntoProjectWithReport(parsed, existingProject, schemaIndex, options).project;
}

// Keep the old implementation type-checked during the transition; it is intentionally not called.
void mergeIdsIntoProjectLegacy;
