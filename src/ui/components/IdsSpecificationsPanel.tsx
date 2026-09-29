import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  ClassificationSystemEntry,
  IdsProjectFacet,
  IdsProjectSpecification,
  Project,
  ProjectObject,
} from "../../project/types";
import {
  buildIdsSpecificationOrdinalIndex,
  formatIdsConstraint,
  getFacetSearchText,
  getSpecificationsForEntity,
} from "../../ids/specifications";
import { validateIdsSpecification } from "../../ids/authoring";
import {
  hasProjectObjectIdsDefinition,
  projectObjectToIdsSpecificationPreview,
  type ProjectDefinitionOccurrence,
} from "../../ids/projectDefinition";
import { IdsSpecificationEditor } from "./IdsSpecificationEditor";

export interface IdsSpecificationEditRequest {
  specificationId: string;
  facetId?: string;
  requestId: number;
}

interface Props {
  project: Project;
  object: ProjectObject;
  ifcEntity: string;
  predefinedType?: string;
  selectedPhaseId: string | null;
  onSelectedPhaseIdChange: (phaseId: string | null) => void;
  selectedUseCaseId: string | null;
  onSelectedUseCaseIdChange: (useCaseId: string | null) => void;
  occurrenceFilter: ProjectDefinitionOccurrence;
  onOccurrenceFilterChange: (occurrence: ProjectDefinitionOccurrence) => void;
  onOpenProjectDefinition?: () => void;
  onFocusSpecification?: (specification: IdsProjectSpecification | null) => void;
  focusedSpecificationId?: string | null;
  editRequest?: IdsSpecificationEditRequest | null;
  onSaveSpecification?: (specification: IdsProjectSpecification) => void;
  onDuplicateSpecification?: (specificationId: string) => void;
  onDeleteSpecification?: (specificationId: string) => void;
}

const FACET_LABELS: Record<IdsProjectFacet["kind"], string> = {
  entity: "Entita",
  attribute: "Atribut",
  classification: "Klasifikace",
  property: "Vlastnost",
  material: "Materiál",
  partOf: "Součást",
};

function occurrenceLabel(specification: IdsProjectSpecification): {
  label: string;
  className: string;
} {
  if (specification.maxOccurs === 0) {
    return { label: "Zakázaný výskyt", className: "bg-red-100 text-red-700" };
  }
  if (specification.minOccurs > 0) {
    return { label: "Požadovaný výskyt", className: "bg-emerald-100 text-emerald-700" };
  }
  return { label: "Kontrola při výskytu", className: "bg-blue-100 text-blue-700" };
}

function occursText(specification: IdsProjectSpecification): string {
  const max = specification.maxOccurs === "unbounded" ? "∞" : specification.maxOccurs;
  return `${specification.minOccurs}…${max}`;
}

const FacetRow: React.FC<{
  facet: IdsProjectFacet;
  catalogsById: Map<string, ClassificationSystemEntry>;
}> = ({ facet, catalogsById }) => {
  let primary = "";
  let secondary: string | undefined;

  switch (facet.kind) {
    case "entity":
      primary = formatIdsConstraint(facet.name);
      if (facet.predefinedType) {
        secondary = `PredefinedType: ${formatIdsConstraint(facet.predefinedType)}`;
      }
      break;
    case "attribute":
      primary = formatIdsConstraint(facet.name);
      secondary = facet.value ? `Hodnota: ${formatIdsConstraint(facet.value)}` : "Existence atributu";
      break;
    case "classification": {
      primary = formatIdsConstraint(facet.system);
      const catalog = facet.systemEntryId ? catalogsById.get(facet.systemEntryId) : undefined;
      const parts = [
        facet.value ? `Hodnota: ${formatIdsConstraint(facet.value)}` : "Existence klasifikace",
        catalog && !facet.unresolved ? `katalog: ${catalog.name}` : undefined,
      ].filter(Boolean);
      secondary = parts.join(" · ");
      break;
    }
    case "property":
      primary = `${formatIdsConstraint(facet.propertySet)} / ${formatIdsConstraint(facet.baseName)}`;
      secondary = [
        facet.dataType,
        facet.value ? `hodnota: ${formatIdsConstraint(facet.value)}` : "existence vlastnosti",
      ].filter(Boolean).join(" · ");
      break;
    case "material":
      primary = facet.value ? formatIdsConstraint(facet.value) : "Existence materiálu";
      break;
    case "partOf":
      primary = formatIdsConstraint(facet.entity.name);
      secondary = [
        facet.relation,
        facet.entity.predefinedType
          ? `PredefinedType: ${formatIdsConstraint(facet.entity.predefinedType)}`
          : undefined,
      ].filter(Boolean).join(" · ");
      break;
  }

  return (
    <div className="rounded-md border border-slate-200 bg-white px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
          {FACET_LABELS[facet.kind]}
        </span>
        <span className="text-sm font-medium text-slate-800">{primary}</span>
        {facet.cardinality && (
          <span className="text-[10px] text-slate-500">{facet.cardinality}</span>
        )}
        {facet.kind === "classification" && facet.unresolved && (
          <span
            className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800"
            title="Konkrétní třídy a hierarchie budou dostupné až po připojení katalogu."
          >
            katalog nedostupný
          </span>
        )}
      </div>
      {secondary && <div className="mt-1 text-xs text-slate-600">{secondary}</div>}
      {facet.instructions && (
        <div className="mt-1 text-xs italic text-slate-500">{facet.instructions}</div>
      )}
    </div>
  );
};

const FacetList: React.FC<{
  title: string;
  facets: IdsProjectFacet[];
  emptyText: string;
  catalogsById: Map<string, ClassificationSystemEntry>;
}> = ({ title, facets, emptyText, catalogsById }) => (
  <section className="min-w-0">
    <div className="mb-2 flex items-center gap-2">
      <h4 className="text-xs font-bold uppercase tracking-wide text-slate-600">{title}</h4>
      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-500">
        AND
      </span>
    </div>
    {facets.length ? (
      <div className="space-y-1.5">
        {facets.map((facet, index) => (
          <React.Fragment key={facet.id}>
            {index > 0 && (
              <div className="pl-4 text-[9px] font-bold uppercase tracking-widest text-slate-400">
                AND
              </div>
            )}
            <FacetRow facet={facet} catalogsById={catalogsById} />
          </React.Fragment>
        ))}
      </div>
    ) : (
      <div className="rounded border border-dashed border-slate-200 px-3 py-2 text-xs text-slate-500">
        {emptyText}
      </div>
    )}
  </section>
);

const ProjectDefinitionCard: React.FC<{
  project: Project;
  object: ProjectObject;
  specification: IdsProjectSpecification | null;
  catalogsById: Map<string, ClassificationSystemEntry>;
  selectedPhaseId: string | null;
  onSelectedPhaseIdChange: (phaseId: string | null) => void;
  selectedUseCaseId: string | null;
  onSelectedUseCaseIdChange: (useCaseId: string | null) => void;
  occurrenceFilter: ProjectDefinitionOccurrence;
  onOccurrenceFilterChange: (occurrence: ProjectDefinitionOccurrence) => void;
  onOpenProjectDefinition?: () => void;
}> = ({
  project,
  object,
  specification,
  catalogsById,
  selectedPhaseId,
  onSelectedPhaseIdChange,
  selectedUseCaseId,
  onSelectedUseCaseIdChange,
  occurrenceFilter,
  onOccurrenceFilterChange,
  onOpenProjectDefinition,
}) => {
  const entityPhaseIds = object.ifcEntityPhases ?? object.entityPhases;
  const availablePhases = entityPhaseIds?.length
    ? project.phases.filter((phase) => entityPhaseIds.includes(phase.id))
    : project.phases;
  const useCases = project.purposeOfUseEntries ?? [];
  const filterClass = (active: boolean, activeClass = "border-red-300 bg-red-50 text-red-700") =>
    `rounded border px-2.5 py-1 text-xs font-semibold ${
      active
        ? activeClass
        : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50"
    }`;

  return (
    <section className="overflow-hidden rounded-lg border border-amber-300 bg-white shadow-sm">
      <div className="border-b border-amber-200 bg-amber-50 px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-bold text-slate-800">
                Projektová IDS definice: {object.description || object.code}
              </span>
              <span className="rounded bg-amber-200 px-2 py-0.5 text-[10px] font-semibold text-amber-900">
                odvozená
              </span>
              <span className="rounded bg-white px-2 py-0.5 text-[10px] text-slate-600">
                {object.ifcEntity}
                {object.predefinedType.mode === "ENUM" && object.predefinedType.value
                  ? `.${object.predefinedType.value}`
                  : ""}
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-600">
              Zdroj je uložený u projektového objektu. Výběr níže pouze skládá efektivní IDS
              náhled; nevytváří druhou kopii v seznamu zdrojových specifikací.
            </p>
          </div>
          {onOpenProjectDefinition && (
            <button
              type="button"
              onClick={onOpenProjectDefinition}
              className="rounded border border-amber-400 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100"
            >
              Otevřít náhled a upravit
            </button>
          )}
        </div>
      </div>

      <div className="space-y-3 border-b border-slate-200 px-4 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="w-24 shrink-0 text-xs font-semibold text-slate-500">Milník:</span>
          <button
            type="button"
            onClick={() => onSelectedPhaseIdChange(null)}
            className={filterClass(selectedPhaseId === null)}
          >
            Vše
          </button>
          {availablePhases.map((phase) => (
            <button
              type="button"
              key={phase.id}
              onClick={() => onSelectedPhaseIdChange(phase.id)}
              className={filterClass(selectedPhaseId === phase.id)}
              title={phase.name}
            >
              {phase.code || phase.name}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="w-24 shrink-0 text-xs font-semibold text-slate-500">Účel užití:</span>
          <button
            type="button"
            onClick={() => onSelectedUseCaseIdChange(null)}
            className={filterClass(selectedUseCaseId === null)}
          >
            Vše
          </button>
          {useCases.map((useCase) => (
            <button
              type="button"
              key={useCase.id}
              onClick={() => onSelectedUseCaseIdChange(useCase.id)}
              className={filterClass(selectedUseCaseId === useCase.id)}
              title={useCase.description ?? useCase.name}
            >
              {useCase.name}
            </button>
          ))}
          {!useCases.length && (
            <span className="ml-1 text-xs text-amber-700">
              Projekt nemá definované účely užití.
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="w-24 shrink-0 text-xs font-semibold text-slate-500">Výskyt:</span>
          {([
            ["all", "Vše", "border-slate-600 bg-slate-700 text-white"],
            ["required", "Požadované", "border-emerald-600 bg-emerald-600 text-white"],
            ["prohibited", "Zakázané", "border-red-600 bg-red-600 text-white"],
            ["optional", "Možné", "border-amber-500 bg-amber-500 text-white"],
          ] as const).map(([value, label, activeClass]) => (
            <button
              type="button"
              key={value}
              onClick={() => onOccurrenceFilterChange(value)}
              className={filterClass(occurrenceFilter === value, activeClass)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="p-4">
        {specification ? (
          <div className="grid gap-4 xl:grid-cols-2">
            <FacetList
              title="Použitelnost"
              facets={specification.applicability}
              emptyText="Chybí použitelnost."
              catalogsById={catalogsById}
            />
            <FacetList
              title="Požadavky"
              facets={specification.requirements}
              emptyText="Pro vybraný rozsah nejsou definované žádné požadavky."
              catalogsById={catalogsById}
            />
          </div>
        ) : (
          <div className="rounded border border-dashed border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
            Objekt v tomto milníku nemá aktivní IFC entitu, proto pro něj nevzniká IDS
            specifikace.
          </div>
        )}
      </div>
    </section>
  );
};

export const IdsSpecificationsPanel: React.FC<Props> = ({
  project,
  object,
  ifcEntity,
  predefinedType,
  selectedPhaseId,
  onSelectedPhaseIdChange,
  selectedUseCaseId,
  onSelectedUseCaseIdChange,
  occurrenceFilter,
  onOccurrenceFilterChange,
  onOpenProjectDefinition,
  onFocusSpecification,
  focusedSpecificationId,
  editRequest,
  onSaveSpecification,
  onDuplicateSpecification,
  onDeleteSpecification,
}) => {
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<"object" | "all">("object");
  const [openSpecificationId, setOpenSpecificationId] = useState<string | null>(null);
  const [draft, setDraft] = useState<IdsProjectSpecification | null>(null);
  const [focusedFacetId, setFocusedFacetId] = useState<string | null>(null);
  const [validationMessages, setValidationMessages] = useState<{ errors: string[]; warnings: string[] } | null>(null);
  const openSpecificationIdRef = useRef<string | null>(null);
  const catalogsById = useMemo(
    () => new Map((project.classificationSystemEntries ?? []).map((entry) => [entry.id, entry])),
    [project.classificationSystemEntries],
  );
  const entitySpecifications = useMemo(
    () => getSpecificationsForEntity(project, ifcEntity, predefinedType),
    [project, ifcEntity, predefinedType],
  );
  const hasProjectDefinition = hasProjectObjectIdsDefinition(project, object);
  const projectDefinition = useMemo(
    () => projectObjectToIdsSpecificationPreview(project, object, {
      phaseId: selectedPhaseId ?? undefined,
      useCaseId: selectedUseCaseId ?? undefined,
      occurrence: occurrenceFilter,
    }),
    [project, object, selectedPhaseId, selectedUseCaseId, occurrenceFilter],
  );
  const allSpecifications = project.idsSpecifications ?? [];
  const specificationOrdinalById = useMemo(
    () => buildIdsSpecificationOrdinalIndex(allSpecifications),
    [allSpecifications],
  );
  const scopedSpecifications = scope === "all" ? allSpecifications : entitySpecifications;
  const visibleSpecifications = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return scopedSpecifications;
    return scopedSpecifications.filter((specification) => {
      const haystack = [
        specification.name,
        specification.identifier,
        specification.description,
        specification.instructions,
        ...specification.applicability.map(getFacetSearchText),
        ...specification.requirements.map(getFacetSearchText),
      ].filter(Boolean).join(" ").toLocaleLowerCase();
      return haystack.includes(query);
    });
  }, [scopedSpecifications, search]);

  useEffect(() => {
    const nextId = focusedSpecificationId ?? null;
    if (nextId === openSpecificationIdRef.current) return;
    openSpecificationIdRef.current = nextId;
    setOpenSpecificationId(nextId);
  }, [focusedSpecificationId]);

  useEffect(() => {
    if (!editRequest) return;
    const source = (project.idsSpecifications ?? []).find(
      (item) => item.id === editRequest.specificationId,
    );
    if (!source) return;
    setScope("all");
    setOpenSpecificationId(source.id);
    openSpecificationIdRef.current = source.id;
    setDraft(structuredClone(source));
    setFocusedFacetId(editRequest.facetId ?? null);
    setValidationMessages(null);
  }, [editRequest?.requestId]);

  useEffect(() => {
    if (
      openSpecificationId &&
      !scopedSpecifications.some((specification) => specification.id === openSpecificationId)
    ) {
      openSpecificationIdRef.current = null;
      setOpenSpecificationId(null);
      onFocusSpecification?.(null);
    }
  }, [openSpecificationId, scopedSpecifications, onFocusSpecification]);

  useEffect(
    () => () => {
      onFocusSpecification?.(null);
    },
    [onFocusSpecification],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-slate-50">
      <div className="border-b border-slate-200 bg-white px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-slate-800">
              {scope === "all"
                ? "Všechny zdrojové IDS specifikace"
                : `IDS pro objekt ${object.description || object.code}`}
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Projektová definice se odvozuje z objektu a zvoleného rozsahu. Zdrojové IDS
              zůstávají samostatné; jednotlivé facety uvnitř specifikace platí současně (AND).
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {scope === "object" && hasProjectDefinition && (
              <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800">
                1 projektová
              </span>
            )}
            <span className="rounded-full bg-violet-100 px-3 py-1 text-xs font-semibold text-violet-800">
              {scopedSpecifications.length} zdrojových
            </span>
          </div>
        </div>
        <div className="mt-3 inline-flex rounded-md border border-slate-300 bg-slate-50 p-0.5">
          <button
            type="button"
            onClick={() => setScope("object")}
            className={`rounded px-3 py-1.5 text-xs font-semibold ${
              scope === "object"
                ? "bg-white text-red-700 shadow-sm"
                : "text-slate-600 hover:text-slate-800"
            }`}
          >
            Vybraný objekt ({hasProjectDefinition ? 1 : 0} projektová · {entitySpecifications.length} zdrojových)
          </button>
          <button
            type="button"
            onClick={() => setScope("all")}
            className={`rounded px-3 py-1.5 text-xs font-semibold ${
              scope === "all"
                ? "bg-white text-red-700 shadow-sm"
                : "text-slate-600 hover:text-slate-800"
            }`}
          >
            Všechny zdrojové IDS ({allSpecifications.length})
          </button>
        </div>
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Hledat ve specifikacích, klasifikacích a požadavcích"
          className="mt-3 w-full max-w-2xl rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-red-400 focus:ring-2 focus:ring-red-100"
        />
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
        {scope === "object" && hasProjectDefinition && (
          <ProjectDefinitionCard
            project={project}
            object={object}
            specification={projectDefinition}
            catalogsById={catalogsById}
            selectedPhaseId={selectedPhaseId}
            onSelectedPhaseIdChange={onSelectedPhaseIdChange}
            selectedUseCaseId={selectedUseCaseId}
            onSelectedUseCaseIdChange={onSelectedUseCaseIdChange}
            occurrenceFilter={occurrenceFilter}
            onOccurrenceFilterChange={onOccurrenceFilterChange}
            onOpenProjectDefinition={onOpenProjectDefinition}
          />
        )}
        {scope === "object" && (
          <div className="flex flex-wrap items-center justify-between gap-2 px-1 pb-1 pt-3">
            <div>
              <h3 className="text-sm font-bold text-slate-800">
                Zdrojové IDS související s entitou
              </h3>
              <p className="text-xs text-slate-500">
                Jde o kandidáty podle IFC entity a PredefinedType. Další applicability facety
                mohou jejich platnost ještě zúžit.
              </p>
            </div>
            <span className="rounded-full bg-violet-100 px-2.5 py-1 text-xs font-semibold text-violet-800">
              {entitySpecifications.length}
            </span>
          </div>
        )}
        {visibleSpecifications.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
            {scopedSpecifications.length
              ? "Filtru neodpovídá žádná specifikace."
              : scope === "all"
                ? "V projektu nejsou uložené žádné zdrojové IDS specifikace."
                : "Pro tuto entitu nejsou uložené žádné zdrojové IDS specifikace. Projektová definice výše je přesto plnohodnotným podkladem pro IDS export."}
          </div>
        ) : (
          visibleSpecifications.map((specification) => {
            const occurrence = occurrenceLabel(specification);
            const ordinal = specificationOrdinalById.get(specification.id);
            const description = specification.description?.trim();
            const hasDistinctDescription = Boolean(
              description && description !== (specification.name ?? "").trim(),
            );
            const unresolvedCount = [
              ...specification.applicability,
              ...specification.requirements,
            ].filter((facet) => facet.kind === "classification" && facet.unresolved).length;
            const isEditing = draft?.id === specification.id;
            const affectedObjects = Object.values(project.objects).filter((object) => {
              const predefined = object.predefinedType.mode === "ENUM" ? object.predefinedType.value : undefined;
              return getSpecificationsForEntity(
                { idsSpecifications: [draft ?? specification] } as Project,
                object.ifcEntity,
                predefined,
              ).length > 0;
            }).length;
            return (
              <details
                key={specification.id}
                open={openSpecificationId === specification.id}
                onToggle={(event) => {
                  if (event.currentTarget.open) {
                    openSpecificationIdRef.current = specification.id;
                    setOpenSpecificationId(specification.id);
                    onFocusSpecification?.(specification);
                  } else if (openSpecificationIdRef.current === specification.id) {
                    openSpecificationIdRef.current = null;
                    setOpenSpecificationId(null);
                    onFocusSpecification?.(null);
                  }
                }}
                className={`group overflow-hidden rounded-lg border bg-white shadow-sm ${
                  openSpecificationId === specification.id
                    ? "border-violet-400 ring-2 ring-violet-100"
                    : "border-slate-200"
                }`}
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      {ordinal !== undefined && (
                        <span className="shrink-0 text-xs font-bold text-violet-700">
                          #{ordinal}
                        </span>
                      )}
                      <span className="text-sm font-semibold text-slate-800">
                        {specification.name || "Specifikace bez názvu"}
                      </span>
                      <span className={`rounded px-2 py-0.5 text-[10px] font-semibold ${occurrence.className}`}>
                        {occurrence.label}
                      </span>
                      <span className="rounded bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">
                        výskyt {occursText(specification)}
                      </span>
                      {unresolvedCount > 0 && (
                        <span className="rounded bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                          {unresolvedCount} nevyřešených klasifikací
                        </span>
                      )}
                      {openSpecificationId === specification.id && (
                        <span className="rounded bg-violet-100 px-2 py-0.5 text-[10px] font-semibold text-violet-800">
                          zobrazeno v levé hierarchii
                        </span>
                      )}
                    </div>
                    {hasDistinctDescription && (
                      <div className="mt-1 truncate text-xs text-slate-500">
                        {description}
                      </div>
                    )}
                  </div>
                  <svg
                    className="h-4 w-4 shrink-0 text-slate-500 transition-transform group-open:rotate-180"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </summary>
                <div className="border-t border-slate-200 bg-slate-50/60 p-4">
                  <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
                    {!isEditing && onSaveSpecification && (
                      <button
                        type="button"
                        className="rounded border border-violet-300 bg-violet-50 px-3 py-1.5 text-xs font-semibold text-violet-800 hover:bg-violet-100"
                        onClick={() => {
                          setDraft(structuredClone(specification));
                          setFocusedFacetId(null);
                          setValidationMessages(null);
                        }}
                      >
                        Upravit zdroj
                      </button>
                    )}
                    {!isEditing && onDuplicateSpecification && (
                      <button
                        type="button"
                        className="rounded border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-100"
                        onClick={() => onDuplicateSpecification(specification.id)}
                      >
                        Duplikovat
                      </button>
                    )}
                    {!isEditing && onDeleteSpecification && (
                      <button
                        type="button"
                        className="rounded border border-red-200 bg-white px-3 py-1.5 text-xs text-red-700 hover:bg-red-50"
                        onClick={() => {
                          if (window.confirm(`Opravdu smazat IDS specifikaci „${specification.name || specification.id}“?`)) {
                            onDeleteSpecification(specification.id);
                          }
                        }}
                      >
                        Smazat
                      </button>
                    )}
                  </div>
                  {isEditing && draft ? (
                    <div className="space-y-3">
                      <div className="sticky top-0 z-20 flex flex-wrap items-center gap-2 rounded-lg border border-violet-300 bg-white/95 p-2 shadow-md backdrop-blur">
                        <span className="mr-auto text-xs text-slate-700">
                          Koncept · dopad odvozený z Entity/PredefinedType: <strong>{affectedObjects} definic objektů</strong>
                        </span>
                        <button
                          type="button"
                          className="rounded border border-slate-300 px-3 py-1.5 text-xs text-slate-700"
                          onClick={() => {
                            setDraft(null);
                            setFocusedFacetId(null);
                            setValidationMessages(null);
                          }}
                        >
                          Zrušit
                        </button>
                        <button
                          type="button"
                          className="rounded bg-violet-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-800"
                          onClick={() => {
                            const result = validateIdsSpecification(project, draft);
                            setValidationMessages(result);
                            if (result.errors.length) return;
                            if (
                              result.warnings.length &&
                              !window.confirm(`${result.warnings.join("\n\n")}\n\nPřesto uložit změnu zdrojové specifikace?`)
                            ) return;
                            onSaveSpecification?.(draft);
                            setDraft(null);
                            setFocusedFacetId(null);
                            setValidationMessages(null);
                          }}
                        >
                          Uložit
                        </button>
                      </div>
                      {validationMessages && (validationMessages.errors.length > 0 || validationMessages.warnings.length > 0) && (
                        <div className={`rounded border px-3 py-2 text-xs ${
                          validationMessages.errors.length ? "border-red-300 bg-red-50 text-red-800" : "border-amber-300 bg-amber-50 text-amber-800"
                        }`}>
                          {validationMessages.errors.map((message) => <div key={`e:${message}`}>Chyba: {message}</div>)}
                          {validationMessages.warnings.map((message) => <div key={`w:${message}`}>Upozornění: {message}</div>)}
                        </div>
                      )}
                      <IdsSpecificationEditor
                        project={project}
                        value={draft}
                        focusedFacetId={focusedFacetId}
                        onChange={setDraft}
                      />
                    </div>
                  ) : (
                  <>
                  {specification.identifier && (
                    <div className="mb-3 text-[11px] text-slate-500">
                      <span className="font-semibold text-slate-600">IDS identifier:</span>{" "}
                      <code className="break-all">{specification.identifier}</code>
                    </div>
                  )}
                  {specification.instructions && (
                    <div className="mb-3 rounded-md border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                      {specification.instructions}
                    </div>
                  )}
                  <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                    <FacetList
                      title="Použitelnost"
                      facets={specification.applicability}
                      emptyText="Bez facetů použitelnosti"
                      catalogsById={catalogsById}
                    />
                    <FacetList
                      title="Požadavky"
                      facets={specification.requirements}
                      emptyText="Specifikace nemá samostatné požadavky"
                      catalogsById={catalogsById}
                    />
                  </div>
                  </>
                  )}
                </div>
              </details>
            );
          })
        )}
      </div>
    </div>
  );
};
