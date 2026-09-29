import React from "react";
import type {
  IdsAuthoringMetadata,
  IdsAuthoringScope,
  IdsProjectFacet,
  IdsProjectSpecification,
  IdsValueConstraint,
  Project,
} from "../../project/types";
import { createEmptyIdsFacet, type IdsFacetSection } from "../../ids/authoring";

const inputClass =
  "w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-800 outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100";

type ConstraintMode = "any" | "simple" | "enum" | "pattern" | "range" | "length";

const constraintMode = (value: IdsValueConstraint | undefined): ConstraintMode => {
  if (!value) return "any";
  if (value.enumerations) return "enum";
  if (value.pattern !== undefined) return "pattern";
  if (
    value.minInclusive !== undefined || value.minExclusive !== undefined ||
    value.maxInclusive !== undefined || value.maxExclusive !== undefined
  ) return "range";
  if (value.length !== undefined || value.minLength !== undefined || value.maxLength !== undefined) return "length";
  if (value.simpleValue !== undefined) return "simple";
  return "any";
};

const freshConstraint = (mode: ConstraintMode): IdsValueConstraint | undefined => {
  if (mode === "any") return undefined;
  if (mode === "simple") return { simpleValue: "" };
  if (mode === "enum") return { enumerations: [""] };
  if (mode === "pattern") return { pattern: "" };
  if (mode === "range") return { minInclusive: "", maxInclusive: "" };
  return { minLength: 0 };
};

const ConstraintEditor: React.FC<{
  label: string;
  value?: IdsValueConstraint;
  onChange: (value: IdsValueConstraint | undefined) => void;
  required?: boolean;
  testId?: string;
}> = ({ label, value, onChange, required, testId }) => {
  const mode = constraintMode(value);
  const update = (patch: Partial<IdsValueConstraint>) => onChange({ ...(value ?? {}), ...patch });
  return (
    <div className="min-w-0" data-testid={testId}>
      <div className="mb-1 flex items-center gap-2">
        <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          {label}{required ? " *" : ""}
        </label>
        <select
          value={mode}
          onChange={(event) => onChange(freshConstraint(event.target.value as ConstraintMode))}
          className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[10px]"
        >
          <option value="any">Bez omezení</option>
          <option value="simple">Jedna hodnota</option>
          <option value="enum">Alternativy OR</option>
          <option value="pattern">Vzor (regex)</option>
          <option value="range">Rozsah</option>
          <option value="length">Délka</option>
        </select>
      </div>
      {mode === "simple" && (
        <input
          className={inputClass}
          value={value?.simpleValue ?? ""}
          onChange={(event) => update({ simpleValue: event.target.value })}
        />
      )}
      {mode === "enum" && (
        <textarea
          className={`${inputClass} min-h-[58px]`}
          value={(value?.enumerations ?? []).join("\n")}
          onChange={(event) => update({ enumerations: event.target.value.split(/\r?\n/) })}
          placeholder="Jedna alternativa na řádek (OR)"
        />
      )}
      {mode === "pattern" && (
        <input
          className={inputClass}
          value={value?.pattern ?? ""}
          onChange={(event) => update({ pattern: event.target.value })}
          placeholder="^DB08.*"
        />
      )}
      {mode === "range" && (
        <div className="grid grid-cols-2 gap-1.5">
          <input className={inputClass} placeholder="min ≥" value={value?.minInclusive ?? ""} onChange={(e) => update({ minInclusive: e.target.value, minExclusive: undefined })} />
          <input className={inputClass} placeholder="min >" value={value?.minExclusive ?? ""} onChange={(e) => update({ minExclusive: e.target.value, minInclusive: undefined })} />
          <input className={inputClass} placeholder="max ≤" value={value?.maxInclusive ?? ""} onChange={(e) => update({ maxInclusive: e.target.value, maxExclusive: undefined })} />
          <input className={inputClass} placeholder="max <" value={value?.maxExclusive ?? ""} onChange={(e) => update({ maxExclusive: e.target.value, maxInclusive: undefined })} />
        </div>
      )}
      {mode === "length" && (
        <div className="grid grid-cols-3 gap-1.5">
          <input className={inputClass} type="number" min={0} placeholder="délka" value={value?.length ?? ""} onChange={(e) => update({ length: e.target.value === "" ? undefined : Number(e.target.value) })} />
          <input className={inputClass} type="number" min={0} placeholder="min" value={value?.minLength ?? ""} onChange={(e) => update({ minLength: e.target.value === "" ? undefined : Number(e.target.value) })} />
          <input className={inputClass} type="number" min={0} placeholder="max" value={value?.maxLength ?? ""} onChange={(e) => update({ maxLength: e.target.value === "" ? undefined : Number(e.target.value) })} />
        </div>
      )}
    </div>
  );
};

const ScopeEditor: React.FC<{
  label: string;
  scope?: IdsAuthoringScope;
  project: Project;
  inherited?: boolean;
  onChange: (scope: IdsAuthoringScope | undefined) => void;
}> = ({ label, scope, project, inherited, onChange }) => {
  const enabled = scope !== undefined;
  const next = (patch: Partial<IdsAuthoringScope>) => onChange({ ...(scope ?? {}), ...patch });
  const toggle = (values: string[] | undefined, id: string): string[] => {
    const set = new Set(values ?? []);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    return [...set];
  };
  return (
    <details className="rounded border border-slate-200 bg-slate-50">
      <summary className="cursor-pointer px-2 py-1.5 text-[11px] font-semibold text-slate-600">
        {label}: {enabled ? "vlastní rozsah" : inherited ? "dědí specifikaci" : "platí všude"}
      </summary>
      <div className="space-y-2 border-t border-slate-200 p-2">
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={enabled} onChange={(e) => onChange(e.target.checked ? {} : undefined)} />
          Použít vlastní rozsah
        </label>
        {enabled && (
          <>
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase text-slate-500">Fáze (prázdné = všechny)</div>
              <div className="flex flex-wrap gap-2">
                {project.phases.map((phase) => (
                  <label key={phase.id} className="flex items-center gap-1 text-[11px]">
                    <input
                      type="checkbox"
                      checked={scope?.phaseIds?.includes(phase.id) ?? false}
                      onChange={() => next({ phaseIds: toggle(scope?.phaseIds, phase.id) })}
                    />
                    {phase.name}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase text-slate-500">Účely užití</div>
              <select
                className={inputClass}
                value={scope?.useCaseMode ?? "inherit"}
                onChange={(event) => next({ useCaseMode: event.target.value as IdsAuthoringScope["useCaseMode"] })}
              >
                <option value="inherit">Platí všem / dědit</option>
                <option value="custom">Vlastní výběr</option>
                <option value="excluded">Vyloučeno z exportu pro účel užití</option>
              </select>
              {scope?.useCaseMode === "custom" && (
                <div className="mt-1 flex flex-wrap gap-2">
                  {(project.purposeOfUseEntries ?? []).map((useCase) => (
                    <label key={useCase.id} className="flex items-center gap-1 text-[11px]">
                      <input
                        type="checkbox"
                        checked={scope.useCaseIds?.includes(useCase.id) ?? false}
                        onChange={() => next({ useCaseIds: toggle(scope.useCaseIds, useCase.id) })}
                      />
                      {useCase.name}
                    </label>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </details>
  );
};

const AuthoringFields: React.FC<{
  value?: IdsAuthoringMetadata;
  project: Project;
  inheritedScope?: boolean;
  onChange: (value: IdsAuthoringMetadata | undefined) => void;
}> = ({ value, project, inheritedScope, onChange }) => {
  const update = (patch: Partial<IdsAuthoringMetadata>) => onChange({ ...(value ?? {}), ...patch });
  return (
    <details className="mt-2 rounded border border-slate-200 bg-white">
      <summary className="cursor-pointer px-2 py-1.5 text-[11px] font-medium text-slate-600">
        Interní metadata a scope
      </summary>
      <div className="grid grid-cols-1 gap-2 border-t border-slate-200 p-2 lg:grid-cols-4">
        <input className={inputClass} placeholder="Popis" value={value?.description ?? ""} onChange={(e) => update({ description: e.target.value || undefined })} />
        <input className={inputClass} placeholder="Poznámka" value={value?.note ?? ""} onChange={(e) => update({ note: e.target.value || undefined })} />
        <input className={inputClass} placeholder="Příklady" value={value?.examples ?? ""} onChange={(e) => update({ examples: e.target.value || undefined })} />
        <input className={inputClass} placeholder="Jednotka" value={value?.unit ?? ""} onChange={(e) => update({ unit: e.target.value || undefined })} />
        <div className="lg:col-span-4">
          <ScopeEditor
            label="Rozsah facetu"
            scope={value?.scope}
            project={project}
            inherited={inheritedScope}
            onChange={(scope) => update({ scope })}
          />
        </div>
      </div>
    </details>
  );
};

const FacetEditor: React.FC<{
  facet: IdsProjectFacet;
  project: Project;
  focused?: boolean;
  onChange: (facet: IdsProjectFacet) => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
}> = ({ facet, project, focused, onChange, onRemove, onMove }) => {
  const elementRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!focused) return;
    elementRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focused]);
  const patch = (next: Partial<IdsProjectFacet>) => onChange({ ...facet, ...next } as IdsProjectFacet);
  const changeClassificationSystem = (value: IdsValueConstraint | undefined) => {
    if (facet.kind !== "classification") return;
    const previous = JSON.stringify(facet.system);
    const incoming = JSON.stringify(value);
    onChange({
      ...facet,
      system: value ?? {},
      ...(previous !== incoming ? { systemEntryId: undefined, unresolved: true } : {}),
    });
  };
  return (
    <div
      ref={elementRef}
      data-ids-facet-id={facet.id}
      className={`rounded-lg border bg-violet-50/40 p-2.5 ${
        focused
          ? "border-violet-500 ring-2 ring-violet-200"
          : "border-violet-200"
      }`}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <select
          className="rounded border border-violet-300 bg-white px-2 py-1 text-xs font-semibold text-violet-800"
          value={facet.kind}
          onChange={(event) => onChange(createEmptyIdsFacet(event.target.value as IdsProjectFacet["kind"]))}
        >
          <option value="entity">Entita</option>
          <option value="attribute">Atribut</option>
          <option value="property">Vlastnost / Pset</option>
          <option value="classification">Klasifikace</option>
          <option value="partOf">Součást</option>
          <option value="material">Materiál</option>
        </select>
        {facet.kind !== "entity" && (
          <select
            className="rounded border border-slate-300 bg-white px-2 py-1 text-xs"
            value={facet.cardinality ?? "required"}
            onChange={(event) => patch({ cardinality: event.target.value as IdsProjectFacet["cardinality"] })}
          >
            <option value="required">Požadované</option>
            <option value="optional">Volitelné</option>
            <option value="prohibited">Zakázané</option>
          </select>
        )}
        <span className="text-[10px] text-slate-400">{facet.id}</span>
        <div className="ml-auto flex gap-1">
          <button className="rounded border border-slate-300 bg-white px-2 py-1 text-xs" onClick={() => onMove(-1)} title="Posunout nahoru">↑</button>
          <button className="rounded border border-slate-300 bg-white px-2 py-1 text-xs" onClick={() => onMove(1)} title="Posunout dolů">↓</button>
          <button className="rounded border border-red-200 bg-white px-2 py-1 text-xs text-red-700" onClick={onRemove}>Odebrat</button>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-2 lg:grid-cols-3">
        {facet.kind === "entity" && (
          <>
            <ConstraintEditor label="IFC entita" value={facet.name} required onChange={(name) => onChange({ ...facet, name: name ?? {} })} />
            <ConstraintEditor label="PredefinedType" value={facet.predefinedType} onChange={(predefinedType) => onChange({ ...facet, predefinedType })} />
          </>
        )}
        {facet.kind === "attribute" && (
          <>
            <ConstraintEditor label="Název atributu" value={facet.name} required onChange={(name) => onChange({ ...facet, name: name ?? {} })} />
            <ConstraintEditor label="Hodnota" value={facet.value} onChange={(value) => onChange({ ...facet, value })} />
          </>
        )}
        {facet.kind === "property" && (
          <>
            <ConstraintEditor
              label="Název skupiny vlastností (Pset/Qto)"
              value={facet.propertySet}
              required
              testId={`ids-property-set-editor-${facet.id}`}
              onChange={(propertySet) => onChange({ ...facet, propertySet: propertySet ?? {} })}
            />
            <ConstraintEditor
              label="Název vlastnosti"
              value={facet.baseName}
              required
              onChange={(baseName) => onChange({ ...facet, baseName: baseName ?? {} })}
            />
            <ConstraintEditor label="Hodnota" value={facet.value} onChange={(value) => onChange({ ...facet, value })} />
            <input className={inputClass} placeholder="IDS dataType (např. IFCLABEL)" value={facet.dataType ?? ""} onChange={(e) => onChange({ ...facet, dataType: e.target.value || undefined })} />
          </>
        )}
        {facet.kind === "classification" && (
          <>
            <ConstraintEditor label="Klasifikační systém" value={facet.system} required onChange={changeClassificationSystem} />
            <ConstraintEditor label="Kód / hodnota" value={facet.value} onChange={(value) => onChange({ ...facet, value })} />
            <select
              className={inputClass}
              value={facet.systemEntryId ?? ""}
              onChange={(event) => onChange({
                ...facet,
                systemEntryId: event.target.value || undefined,
                unresolved: !event.target.value,
              })}
            >
              <option value="">Nevyřešený katalog</option>
              {(project.classificationSystemEntries ?? [])
                .filter((entry) => !entry.isIfcSystem && !entry.isAuxiliaryAspectSystem)
                .map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
            </select>
          </>
        )}
        {facet.kind === "partOf" && (
          <>
            <select className={inputClass} value={facet.relation ?? "IFCRELAGGREGATES"} onChange={(e) => onChange({ ...facet, relation: e.target.value })}>
              <option value="IFCRELAGGREGATES">IfcRelAggregates</option>
              <option value="IFCRELASSIGNSTOGROUP">IfcRelAssignsToGroup</option>
              <option value="IFCRELCONTAINEDINSPATIALSTRUCTURE">IfcRelContainedInSpatialStructure</option>
              <option value="IFCRELNESTS">IfcRelNests</option>
              <option value="IFCRELVOIDSELEMENT">IfcRelVoidsElement</option>
              <option value="IFCRELFILLSELEMENT">IfcRelFillsElement</option>
            </select>
            <ConstraintEditor label="Související entita" value={facet.entity.name} required onChange={(name) => onChange({ ...facet, entity: { ...facet.entity, name: name ?? {} } })} />
            <ConstraintEditor label="PredefinedType" value={facet.entity.predefinedType} onChange={(predefinedType) => onChange({ ...facet, entity: { ...facet.entity, predefinedType } })} />
          </>
        )}
        {facet.kind === "material" && (
          <ConstraintEditor label="Materiál" value={facet.value} onChange={(value) => onChange({ ...facet, value })} />
        )}
      </div>
      <div className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-2">
        <input className={inputClass} placeholder="URI" value={facet.uri ?? ""} onChange={(e) => patch({ uri: e.target.value || undefined })} />
        <input className={inputClass} placeholder="IDS instructions" value={facet.instructions ?? ""} onChange={(e) => patch({ instructions: e.target.value || undefined })} />
      </div>
      <AuthoringFields
        value={facet.authoring}
        project={project}
        inheritedScope
        onChange={(authoring) => patch({ authoring })}
      />
    </div>
  );
};

const SectionEditor: React.FC<{
  section: IdsFacetSection;
  facets: IdsProjectFacet[];
  project: Project;
  focusedFacetId?: string | null;
  onChange: (facets: IdsProjectFacet[]) => void;
}> = ({ section, facets, project, focusedFacetId, onChange }) => {
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= facets.length) return;
    const next = [...facets];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <h4 className="text-sm font-bold text-slate-800">
            {section === "applicability" ? "Použitelnost" : "Požadavky"}
          </h4>
          <p className="text-[10px] text-slate-500">Jednotlivé facety jsou AND; alternativy uvnitř hodnoty jsou OR.</p>
        </div>
        <select
          className="rounded border border-violet-300 bg-violet-50 px-2 py-1 text-xs font-semibold text-violet-800"
          value=""
          onChange={(event) => {
            if (!event.target.value) return;
            onChange([...facets, createEmptyIdsFacet(event.target.value as IdsProjectFacet["kind"])]);
          }}
        >
          <option value="">+ Přidat facet</option>
          <option value="entity">Entita</option>
          <option value="attribute">Atribut</option>
          <option value="property">Vlastnost / Pset</option>
          <option value="classification">Klasifikace</option>
          <option value="partOf">Součást</option>
          <option value="material">Materiál</option>
        </select>
      </div>
      <div className="space-y-2">
        {facets.map((facet, index) => (
          <FacetEditor
            key={facet.id}
            facet={facet}
            project={project}
            focused={facet.id === focusedFacetId}
            onChange={(nextFacet) => onChange(facets.map((item, itemIndex) => itemIndex === index ? nextFacet : item))}
            onRemove={() => onChange(facets.filter((_, itemIndex) => itemIndex !== index))}
            onMove={(direction) => move(index, direction)}
          />
        ))}
        {!facets.length && <div className="rounded border border-dashed border-slate-300 p-3 text-xs text-slate-500">Sekce je prázdná.</div>}
      </div>
    </section>
  );
};

export const IdsSpecificationEditor: React.FC<{
  project: Project;
  value: IdsProjectSpecification;
  focusedFacetId?: string | null;
  onChange: (value: IdsProjectSpecification) => void;
}> = ({ project, value, focusedFacetId, onChange }) => {
  const update = (patch: Partial<IdsProjectSpecification>) => onChange({ ...value, ...patch });
  return (
    <div className="space-y-3">
      <section className="rounded-lg border border-slate-200 bg-white p-3">
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <label className="mb-1 block text-[10px] font-semibold uppercase text-slate-500">Název *</label>
            <input className={inputClass} value={value.name ?? ""} onChange={(e) => update({ name: e.target.value })} />
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase text-slate-500">Identifier</label>
            <input className={inputClass} value={value.identifier ?? ""} onChange={(e) => update({ identifier: e.target.value || undefined })} />
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase text-slate-500">IFC verze</label>
            <select className={inputClass} value={value.ifcVersion ?? "IFC4X3_ADD2"} onChange={(e) => update({ ifcVersion: e.target.value as IdsProjectSpecification["ifcVersion"] })}>
              <option value="IFC2X3">IFC2X3</option>
              <option value="IFC4">IFC4</option>
              <option value="IFC4X3_ADD2">IFC4X3_ADD2</option>
            </select>
          </div>
          <textarea className={`${inputClass} min-h-[60px] lg:col-span-2`} placeholder="Popis specifikace" value={value.description ?? ""} onChange={(e) => update({ description: e.target.value || undefined })} />
          <textarea className={`${inputClass} min-h-[60px] lg:col-span-2`} placeholder="IDS instructions" value={value.instructions ?? ""} onChange={(e) => update({ instructions: e.target.value || undefined })} />
          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase text-slate-500">minOccurs</label>
            <input className={inputClass} type="number" min={0} value={value.minOccurs} onChange={(e) => update({ minOccurs: Number(e.target.value) })} />
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase text-slate-500">maxOccurs</label>
            <input
              className={inputClass}
              value={value.maxOccurs}
              onChange={(e) => update({ maxOccurs: e.target.value === "unbounded" ? "unbounded" : Number(e.target.value) })}
              placeholder="unbounded"
            />
          </div>
          <div className="lg:col-span-2">
            <ScopeEditor
              label="Výchozí rozsah specifikace"
              scope={value.authoring?.scope}
              project={project}
              onChange={(scope) => update({ authoring: { ...(value.authoring ?? {}), scope } })}
            />
          </div>
        </div>
      </section>
      <div className="grid grid-cols-1 gap-3 2xl:grid-cols-2">
        <SectionEditor
          section="applicability"
          facets={value.applicability}
          project={project}
          focusedFacetId={focusedFacetId}
          onChange={(applicability) => update({ applicability })}
        />
        <SectionEditor
          section="requirements"
          facets={value.requirements}
          project={project}
          focusedFacetId={focusedFacetId}
          onChange={(requirements) => update({ requirements })}
        />
      </div>
    </div>
  );
};
