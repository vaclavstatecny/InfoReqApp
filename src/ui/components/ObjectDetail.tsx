import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { ClassificationNode } from "../../classification/types";
import type { ClassificationData } from "../../classification/types";
import { collectLeaves, filterTree } from "../../classification/parser";
import {
  type HierarchyViewMode,
  getHierarchyViewOptions,
  getHierarchyNodesForView,
} from "../../classification/hierarchyView";
import { EMPTY_PLACEHOLDER } from "../../classification/sampleXlsx";
import type { SchemaIndex } from "../../schema/types";
import {
  getIdsIfcVersion,
  getIfcLexicalDocUrl,
  getIfcPropertyDocUrl,
  getIfcPsetDocUrl,
  normalizeIfcSchemaVersion,
} from "../../schema/ifcVersionConfig";
import { makeId } from "../../utils/id";
import { generateHumanReadable, filterObjectByPhase, matchesOccurrenceFilter } from "../../utils/humanReadableIds";
import { getEffectiveUseCaseIds, requirementAppliesToUseCase } from "../../project/useCaseResolve";
import type { ClassificationSystemEntry, CodeList, IdsMetadata, IdsProjectSpecification, IdsSpecMetadata, MaterialRequirement, ObjectRequirements, Phase, Project, ProjectObject, PropertyRequirement, RelationRequirement, RequirementBase } from "../../project/types";
import { ENUM_CODELIST_ID_KEY, formatEnumValues, parseEnumValues } from "../../project/enumeration";
import { DocLink } from "./DocLink";
import { EntitySelect } from "./EntitySelect";
import { RequirementGroupsPanel } from "./RequirementGroupsPanel";
import { groupRequirementsByItem, type RequirementItemKind, type RequirementItemGroup } from "../../project/requirementFingerprint";
import {
  IdsSpecificationsPanel,
  type IdsSpecificationEditRequest,
} from "./IdsSpecificationsPanel";
import {
  buildIdsSpecificationOrdinalIndex,
  formatIdsConstraint,
  getSpecificationsForEntity,
} from "../../ids/specifications";
import { hasProjectObjectIdsDefinition } from "../../ids/projectDefinition";
import {
  getIdsProjectedFacetId,
  getIdsProjectedFacetSection,
  getIdsProjectedPropertyNameConstraint,
  getIdsProjectedPropertySetConstraint,
  getIdsProjectedSpecificationId,
  getIdsProjectedSpecificationName,
  getPropertyRequirementGroupKey,
  isIdsProjectedRequirement,
  projectIdsRequirementsForEntity,
  withoutIdsProjectedRequirements,
} from "../../ids/requirementProjection";
import { fetchPsetOrQtoPropertyDefinitions, fetchSinglePropertyDefinition } from "../../translation/translators/BsddTranslator";
import { getBsddUrl } from "../../translation/getBsddUrl";
import { translate } from "../../translation/TranslationService";
import { useTranslation } from "../../translation/TranslationContext";
import { useSchema } from "../../schema/SchemaProvider";

type TabKey = "attributes" | "properties" | "partOf" | "material" | "classification" | "ids";
type IdsSubTabKey = "schema" | "readable" | "metadata";
type OccurrenceFilter = "all" | "required" | "prohibited" | "optional";

/** Překlad poznámek z CSV (replacement_or_note) do češtiny pro zobrazení v komentáři pod PredefinedType. */
const DEPRECATED_NOTE_TRANSLATIONS: Record<string, string> = {
  "Not used - kept for upward compatibility": "Nepoužívá se – zachováno pro zpětnou kompatibilitu.",
  "Use IfcVirtualElementTypeEnum.PROVISIONFORVOID": "Použijte IfcVirtualElementTypeEnum.PROVISIONFORVOID.",
  "Use IfcVirtualElementTypeEnum.CLEARANCE": "Použijte IfcVirtualElementTypeEnum.CLEARANCE.",
  "Use Pset_SpaceCommon.IsExternal instead": "Použijte místo toho Pset_SpaceCommon.IsExternal.",
  "Deprecated and shall no longer be used": "Zastaralé a již by se nemělo používat.",
  "Use IfcMaterialLayerSet with IfcMaterialLayerSetUsage in occurrences": "Použijte IfcMaterialLayerSet s IfcMaterialLayerSetUsage u výskytů.",
};

function translateDeprecatedNote(note: string): string {
  return DEPRECATED_NOTE_TRANSLATIONS[note] ?? note;
}

type RequirementsTabsProps = {
  /** Aktuální sada požadavků, se kterou uživatel pracuje */
  requirements: ObjectRequirements;
  /** Obecný callback pro změnu požadavků (např. pro skupinový režim) */
  onChangeRequirements: (nextReqs: ObjectRequirements) => void;
  /** Aktivní záložka v rámci požadavků */
  activeTab: TabKey;
  /** Změna aktivní záložky */
  onTabChange: (tab: TabKey) => void;
};

const RequirementsTabs: React.FC<RequirementsTabsProps> = ({ activeTab, onTabChange }) => {
  return (
    <div className="sticky top-0 z-10 flex items-center border-b border-slate-200 bg-white px-4 shadow-sm">
      {(Object.keys(TAB_LABELS) as TabKey[]).map((key) => (
        <button
          key={key}
          className={`px-3 py-2 text-sm ${
            activeTab === key
              ? "border-b-2 border-red-600 font-semibold text-red-700"
              : "text-slate-600 hover:text-slate-800"
          }`}
          onClick={() => onTabChange(key)}
        >
          {TAB_LABELS[key]}
        </button>
      ))}
    </div>
  );
};

const PhaseSelector: React.FC<{ phases: Phase[]; value?: string[]; onChange: (ids: string[]) => void }> = ({ phases, value, onChange }) => {
  const selected = new Set(value ?? []);
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) {
      // Prevent unchecking the last phase - must have at least one
      if (next.size <= 1) return;
      next.delete(id);
    } else {
      next.add(id);
    }
    onChange(Array.from(next));
  };
  return (
    <div className="flex flex-wrap gap-2">
      {phases.map((phase) => {
        const isChecked = selected.has(phase.id);
        const isLastChecked = isChecked && selected.size === 1;
        return (
          <label 
            key={phase.id} 
            className={`inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-xs ${isLastChecked ? "opacity-70 cursor-not-allowed" : ""}`}
            title={isLastChecked ? "Musí být alespoň jedna fáze zaškrtnutá" : ""}
          >
            <input 
              type="checkbox" 
              className={`h-4 w-4 ${isLastChecked ? "cursor-not-allowed" : ""}`} 
              checked={isChecked} 
              onChange={() => toggle(phase.id)} 
              disabled={isLastChecked}
            />
            <span className="font-semibold">{phase.code}</span>
          </label>
        );
      })}
    </div>
  );
};

/** Multi-select pro účely užití (číselník). */
const UseCaseMultiSelect: React.FC<{
  entries: import("../../project/types").PurposeOfUseEntry[];
  value?: string[];
  onChange: (ids: string[]) => void;
  placeholder?: string;
}> = ({ entries, value, onChange, placeholder }) => {
  const selected = new Set(value ?? []);
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(Array.from(next));
  };
  if (!entries.length) return <span className="text-xs text-slate-500">{placeholder ?? "Žádné účely užití v projektu"}</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {entries.map((entry) => (
        <label key={entry.id} className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-0.5 text-xs hover:bg-slate-50">
          <input type="checkbox" className="h-3.5 w-3.5" checked={selected.has(entry.id)} onChange={() => toggle(entry.id)} />
          <span>{entry.name}</span>
        </label>
      ))}
    </div>
  );
};

/** Řádek: režim účelu užití (Dědit / Vlastní / Vyloučeno) a při Vlastní multi-select. */
const UseCaseRowControl: React.FC<{
  entries: import("../../project/types").PurposeOfUseEntry[];
  useCaseMode?: import("../../project/types").UseCaseMode;
  useCaseIds?: string[];
  onChange: (patch: { useCaseMode?: import("../../project/types").UseCaseMode; useCaseIds?: string[] }) => void;
}> = ({ entries, useCaseMode = "inherit", useCaseIds, onChange }) => {
  const mode = useCaseMode ?? "inherit";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={mode}
        onChange={(e) => {
          const v = e.target.value as import("../../project/types").UseCaseMode;
          onChange({ useCaseMode: v, useCaseIds: v === "custom" ? (useCaseIds ?? []) : undefined });
        }}
        className="rounded border border-slate-200 px-2 py-0.5 text-xs"
      >
        <option value="inherit">Dědit</option>
        <option value="custom">Vlastní</option>
        <option value="excluded">Vyloučeno</option>
      </select>
      {mode === "custom" && (
        <UseCaseMultiSelect
          entries={entries}
          value={useCaseIds ?? []}
          onChange={(ids) => onChange({ useCaseIds: ids })}
        />
      )}
    </div>
  );
};

/** Dialog pro úpravu Popis, Poznámka, Příklady (tužka). */
const PropertyRowEditDialog: React.FC<{
  prop: PropertyRequirement;
  onSave: (patch: { popis?: string; note?: string; priklady?: string }) => void;
  onClose: () => void;
}> = ({ prop, onSave, onClose }) => {
  const [popis, setPopis] = useState(prop.popis ?? "");
  const [note, setNote] = useState(prop.note ?? "");
  const [priklady, setPriklady] = useState(prop.priklady ?? "");
  const handleSave = () => {
    onSave({ popis: popis || undefined, note: note || undefined, priklady: priklady || undefined });
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-lg bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-3 text-lg font-semibold text-slate-800">
          Popis, poznámka, příklady {prop.propertyName ? `– ${prop.propertyName}` : ""}
        </h3>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">Popis</label>
            <textarea
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm min-h-[80px]"
              value={popis}
              onChange={(e) => setPopis(e.target.value)}
              placeholder="Popis"
              rows={4}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">Poznámka</label>
            <textarea
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm min-h-[60px]"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Poznámka"
              rows={3}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">Příklady</label>
            <textarea
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm min-h-[60px]"
              value={priklady}
              onChange={(e) => setPriklady(e.target.value)}
              placeholder="Příklady"
              rows={3}
            />
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50" onClick={onClose}>
            Zrušit
          </button>
          <button type="button" className="rounded bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-500" onClick={handleSave}>
            Uložit
          </button>
        </div>
      </div>
    </div>
  );
};

/** Obecný dialog pro výběr cílových objektů při duplikaci požadavků (vlastnosti, atributy, klasifikace, materiál, součásti). */
const SelectObjectsForDuplicateDialog: React.FC<{
  classification: ClassificationData | null;
  classificationSystemEntries: ClassificationSystemEntry[];
  objects: Record<string, ProjectObject>;
  currentObjectCode: string;
  title: string;
  description: string;
  selectedSummary?: string;
  getConflictsForTargets: (targetObjectCodes: string[]) => Array<{ targetCode: string; targetDescription: string; conflictingLabels: string[] }>;
  onConfirm: (targetObjectCodes: string[]) => void;
  onClose: () => void;
}> = ({ classification, classificationSystemEntries, objects, currentObjectCode, title, description, selectedSummary, getConflictsForTargets, onConfirm, onClose }) => {
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<HierarchyViewMode>("classification");
  const [selectedCodes, setSelectedCodes] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [conflictWarning, setConflictWarning] = useState<
    Array<{ targetCode: string; targetDescription: string; conflictingLabels: string[] }> | null
  >(null);

  const primarySystem = useMemo(
    () => classificationSystemEntries.find((s) => s.isPrimary),
    [classificationSystemEntries],
  );
  const hierarchyViewOptions = useMemo(
    () => getHierarchyViewOptions(classification, primarySystem, classificationSystemEntries, objects ?? {}),
    [classification, primarySystem, classificationSystemEntries, objects],
  );
  const nodes = useMemo(
    () =>
      getHierarchyNodesForView(
        viewMode,
        classification,
        primarySystem,
        classificationSystemEntries,
        objects,
      ),
    [viewMode, classification, primarySystem, classificationSystemEntries, objects],
  );

  const filteredNodes = useMemo(
    () => (search.trim() ? filterTree(nodes, search.trim()) : nodes),
    [nodes, search],
  );

  const allObjectCodes = useMemo(
    () => Object.keys(objects).filter((code) => code !== currentObjectCode),
    [objects, currentObjectCode],
  );

  const toggleCode = (code: string) => {
    if (code === currentObjectCode) return;
    setSelectedCodes((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const selectAll = () => setSelectedCodes(new Set(allObjectCodes));
  const deselectAll = () => setSelectedCodes(new Set());

  const handleConfirm = () => {
    const targetCodes = Array.from(selectedCodes);
    const conflicts = getConflictsForTargets(targetCodes);
    if (conflicts.length > 0) {
      setConflictWarning(conflicts);
      return;
    }
    setConflictWarning(null);
    onConfirm(targetCodes);
    onClose();
  };

  const toggleExpanded = (code: string) => {
    setExpanded((e) => ({ ...e, [code]: !e[code] }));
  };

  const renderNode = (node: ClassificationNode, depth: number, pathKey: string): React.ReactNode => {
    const isLeaf = node.children.length === 0;
    const isCurrent = node.code === currentObjectCode;
    const canSelect = isLeaf && !isCurrent;
    const nodeId = `dup-${pathKey}`;
    const isExp = expanded[nodeId] ?? true;
    const inputId = `dup-cb-${pathKey}`;

    return (
      <div key={pathKey} className="border-l border-slate-200 pl-2" style={{ marginLeft: depth * 8 }}>
        <div className="flex items-center gap-2 py-1">
          {!isLeaf ? (
            <button
              type="button"
              className="h-5 w-5 shrink-0 rounded text-xs text-slate-500 hover:bg-slate-200"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                toggleExpanded(nodeId);
              }}
              aria-label={isExp ? "Sbalit" : "Rozbalit"}
            >
              {isExp ? "−" : "+"}
            </button>
          ) : (
            <span className="w-5 shrink-0" />
          )}
          {canSelect ? (
            <label
              htmlFor={inputId}
              className="flex flex-1 cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-slate-50"
            >
              <input
                id={inputId}
                type="checkbox"
                className="h-4 w-4 shrink-0 rounded border-slate-300 text-red-600 focus:ring-red-500"
                checked={selectedCodes.has(node.code)}
                onChange={(e) => {
                  e.stopPropagation();
                  toggleCode(node.code);
                }}
                onClick={(e) => e.stopPropagation()}
              />
              <span className="text-sm text-slate-800">
                {objects[node.code]?.description ?? node.description ?? node.code}
              </span>
              <span className="text-xs text-slate-500">{node.code}</span>
            </label>
          ) : (
            <div
              role="button"
              tabIndex={0}
              className="flex flex-1 cursor-pointer items-center rounded px-2 py-1 text-sm font-medium text-slate-700 hover:bg-slate-50"
              onClick={(e) => {
                e.preventDefault();
                if (!isLeaf) toggleExpanded(nodeId);
              }}
              onKeyDown={(e) => {
                if (!isLeaf && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  toggleExpanded(nodeId);
                }
              }}
            >
              {(node.description || node.code).replace(/::/g, ".")}
            </div>
          )}
        </div>
        {!isLeaf && isExp && node.children.map((child, idx) => renderNode(child, depth + 1, `${pathKey}-${idx}-${child.code}`))}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-slate-200 p-4">
          <h3 className="text-lg font-semibold text-slate-800">{title}</h3>
          <p className="mt-1 text-sm text-slate-600">{description}</p>
          {selectedSummary && (
            <p className="mt-1 text-xs text-slate-500">{selectedSummary}</p>
          )}
        </div>
        <div className="flex flex-none flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-2">
          {hierarchyViewOptions.length > 1 && (
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-slate-600">Pohled:</label>
              <select
                className="rounded border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-800"
                value={viewMode}
                onChange={(e) => setViewMode(e.target.value as HierarchyViewMode)}
              >
                {hierarchyViewOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <input
            type="text"
            className="flex-1 min-w-[140px] rounded border border-slate-300 px-3 py-1.5 text-sm placeholder:text-slate-400"
            placeholder="Filtrovat / vyhledat (kód, popis)..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button
            type="button"
            className="rounded border border-slate-300 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
            onClick={selectAll}
          >
            Označit vše
          </button>
          <button
            type="button"
            className="rounded border border-slate-300 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
            onClick={deselectAll}
          >
            Zrušit výběr
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {nodes.length === 0 ? (
            allObjectCodes.length === 0 ? (
              <div className="text-sm text-slate-500">V projektu nejsou žádné další objekty.</div>
            ) : (
              <div className="space-y-1">
                <p className="mb-2 text-xs font-medium text-slate-500">Vyberte objekty (zaškrtnutím):</p>
                {allObjectCodes
                  .filter(
                    (code) =>
                      !search.trim() ||
                      (objects[code]?.description ?? code).toLowerCase().includes(search.trim().toLowerCase()) ||
                      code.toLowerCase().includes(search.trim().toLowerCase()),
                  )
                  .map((code) => (
                    <label
                      key={code}
                      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-slate-50"
                    >
                      <input
                        id={`dup-flat-${code}`}
                        type="checkbox"
                        className="h-4 w-4 shrink-0 rounded border-slate-300 text-red-600 focus:ring-red-500"
                        checked={selectedCodes.has(code)}
                        onChange={() => toggleCode(code)}
                      />
                      <span className="text-sm text-slate-800">{objects[code]?.description ?? code}</span>
                      <span className="text-xs text-slate-500">{code}</span>
                    </label>
                  ))}
              </div>
            )
          ) : (
            <>
              {filteredNodes.length === 0 ? (
                <div className="text-sm text-slate-500">Žádné položky ve stromu nevyhovují filtru.</div>
              ) : (
                <div className="mb-4">
                  <p className="mb-2 text-xs font-medium text-slate-500">Hierarchie – zaškrtněte objekty (listy stromu):</p>
                  <div className="space-y-0.5">
                    {filteredNodes.map((n, idx) => renderNode(n, 0, `r-${idx}-${n.code}`))}
                  </div>
                </div>
              )}
              <div className="border-t border-slate-200 pt-4">
                <p className="mb-2 text-xs font-medium text-slate-500">Všechny objekty – výběr zaškrtnutím:</p>
                <div className="max-h-48 space-y-1 overflow-y-auto">
                  {allObjectCodes
                    .filter(
                      (code) =>
                        !search.trim() ||
                        (objects[code]?.description ?? code).toLowerCase().includes(search.trim().toLowerCase()) ||
                        code.toLowerCase().includes(search.trim().toLowerCase()),
                    )
                    .map((code) => (
                      <label
                        key={code}
                        className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-slate-50"
                      >
                        <input
                          id={`dup-list-${code}`}
                          type="checkbox"
                          className="h-4 w-4 shrink-0 rounded border-slate-300 text-red-600 focus:ring-red-500"
                          checked={selectedCodes.has(code)}
                          onChange={() => toggleCode(code)}
                        />
                        <span className="text-sm text-slate-800">{objects[code]?.description ?? code}</span>
                        <span className="text-xs text-slate-500">{code}</span>
                      </label>
                    ))}
                </div>
              </div>
            </>
          )}
        </div>
        {conflictWarning && conflictWarning.length > 0 && (
          <div className="border-t border-amber-200 bg-amber-50 px-4 py-3">
            <p className="text-sm font-semibold text-amber-800">
              Kopírování není možné: v některých vybraných objektech již existují položky se stejným názvem.
            </p>
            <p className="mt-1 text-xs text-amber-700">
              Odznačte tyto objekty nebo zrušte výběr položek s konfliktním názvem.
            </p>
            <ul className="mt-2 list-inside list-disc space-y-1 text-xs text-amber-800">
              {conflictWarning.map((c) => (
                <li key={c.targetCode}>
                  <span className="font-medium">{c.targetDescription}</span> ({c.targetCode}):{" "}
                  {c.conflictingLabels.join(", ")}
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="mt-3 rounded border border-amber-400 bg-amber-100 px-3 py-1.5 text-sm font-medium text-amber-800 hover:bg-amber-200"
              onClick={() => setConflictWarning(null)}
            >
              Rozumím
            </button>
          </div>
        )}
        <div className="flex justify-end gap-2 border-t border-slate-200 p-4">
          <button
            type="button"
            className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
            onClick={onClose}
          >
            Zrušit
          </button>
          <button
            type="button"
            className="rounded bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-50"
            onClick={handleConfirm}
            disabled={selectedCodes.size === 0}
          >
            Zkopírovat do vybraných ({selectedCodes.size})
          </button>
        </div>
      </div>
    </div>
  );
};

/** Dialog pro duplikaci skupin vlastností do jiných objektů – používá SelectObjectsForDuplicateDialog s kontrolou konfliktů skupin. */
const DuplicatePropertyGroupsDialog: React.FC<{
  classification: ClassificationData | null;
  classificationSystemEntries: ClassificationSystemEntry[];
  objects: Record<string, ProjectObject>;
  currentObjectCode: string;
  selectedGroupKeys: string[];
  groupLabels: Record<string, string>;
  onConfirm: (targetObjectCodes: string[]) => void;
  onClose: () => void;
}> = (props) => {
  const getGroupKey = (source: string, psetName?: string) => `${source}:${psetName || "(custom)"}`;
  const getConflictsForTargets = useCallback(
    (targetObjectCodes: string[]) => {
      const conflicts: Array<{ targetCode: string; targetDescription: string; conflictingLabels: string[] }> = [];
      for (const code of targetObjectCodes) {
        const obj = props.objects[code];
        if (!obj?.requirements?.properties) continue;
        const existingKeys = new Set(
          obj.requirements.properties.map((p) => getGroupKey(p.source, p.psetName)),
        );
        const conflicting = props.selectedGroupKeys.filter((k) => existingKeys.has(k));
        if (conflicting.length > 0) {
          conflicts.push({
            targetCode: code,
            targetDescription: obj.description ?? code,
            conflictingLabels: conflicting.map((k) => props.groupLabels[k] ?? k),
          });
        }
      }
      return conflicts;
    },
    [props.objects, props.selectedGroupKeys, props.groupLabels],
  );
  return (
    <SelectObjectsForDuplicateDialog
      classification={props.classification}
      classificationSystemEntries={props.classificationSystemEntries}
      objects={props.objects}
      currentObjectCode={props.currentObjectCode}
      title="Duplikovat skupiny vlastností do objektů"
      description="Vyberte objekty, do kterých se zkopírují vybrané skupiny vlastností (vždy jako nezávislé kopie)."
      selectedSummary={
        props.selectedGroupKeys.length > 0
          ? `Skupiny: ${props.selectedGroupKeys.map((k) => props.groupLabels[k] ?? k).join(", ")}`
          : undefined
      }
      getConflictsForTargets={getConflictsForTargets}
      onConfirm={props.onConfirm}
      onClose={props.onClose}
    />
  );
};

/** Sekce s možností sbalení a přesunutí nahoru/dolů */
const CollapsibleSection: React.FC<{
  title: string;
  isExpanded: boolean;
  onToggle: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  /** Sekce roste a má vlastní scroll (např. Požadavky) */
  flexGrow?: boolean;
  /** Max výška s overflow scroll (např. Identifikační údaje) */
  maxHeightScroll?: boolean;
}> = ({ title, isExpanded, onToggle, onMoveUp, onMoveDown, canMoveUp, canMoveDown, children, className = "", style, flexGrow, maxHeightScroll }) => (
  <div className={`border-b border-slate-200 ${className}`} style={style}>
    <div className="flex items-center gap-2 bg-slate-50 px-4 py-2 flex-shrink-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-600 hover:text-slate-800"
        aria-expanded={isExpanded}
      >
        <svg
          className={`h-4 w-4 transition-transform ${isExpanded ? "rotate-90" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        {title}
      </button>
      <div className="flex items-center gap-0.5 ml-2">
        <button
          type="button"
          onClick={onMoveUp}
          disabled={!canMoveUp}
          className="rounded p-1 text-slate-500 hover:bg-slate-200 hover:text-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
          title="Posunout nahoru"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onMoveDown}
          disabled={!canMoveDown}
          className="rounded p-1 text-slate-500 hover:bg-slate-200 hover:text-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
          title="Posunout dolů"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>
      <div className="h-px flex-1 bg-slate-200" />
    </div>
    {isExpanded && (
      <div
        className={`bg-white ${flexGrow ? "flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden" : ""} ${maxHeightScroll ? "max-h-[45vh] overflow-y-auto" : ""}`}
      >
        {children}
      </div>
    )}
  </div>
);

interface Props {
  node: ClassificationNode;
  object: ProjectObject;
  schema: SchemaIndex | null;
  onChange: (obj: ProjectObject) => void;
  phases: Phase[];
  codeLists: CodeList[];
  classificationSystemEntries: ClassificationSystemEntry[];
  /** Projekt – pro metadata při exportu IDS z náhledu */
  project?: Project | null;
  /** Otevřená canonical IDS specifikace řídí dočasný kontext levé hierarchie. */
  onFocusIdsSpecification?: (specification: IdsProjectSpecification | null) => void;
  onFocusRequirementGroup?: (group: RequirementItemGroup | null) => void;
  focusedIdsSpecificationId?: string;
  onSaveIdsSpecification?: (specification: IdsProjectSpecification) => void;
  onDuplicateIdsSpecification?: (specificationId: string) => void;
  onDeleteIdsSpecification?: (specificationId: string) => void;
  onConvertProjectGroupToIds?: (group: RequirementItemGroup) => void;
  onAssignIdsGroup?: (
    group: RequirementItemGroup,
    objectCodes: string[],
    mode: "new-specification" | "reassign-source",
  ) => void;
  onSaveEnumAsCodeList: (opts: { objectCode: string; propertyId: string; name: string; values: string[]; link: boolean }) => void;
  /** Přidat vybranou entitu/PredefinedType do IFC hierarchie projektu (když není v hierarchii) */
  /** Přidá objekt (podle object.code) do IFC hierarchie – bez duplikátu, zůstane stejný objekt. */
  onAddToIfcHierarchy?: (objectCode: string) => void;
  /** Zkopírovat objekt (včetně hierarchie a klasifikací) */
  onCopyObject?: (objectCode: string) => void;
  /** Odstranit objekt z hierarchie, klasifikace a mapování */
  onDeleteObject?: (code: string) => void;
  /** Zamknout/odemknout objekt (zamčený nelze upravovat ani mazat) */
  onToggleLock?: (obj: ProjectObject) => void;
  /** Duplikovat vybrané skupiny vlastností (s vlastnostmi) do jiných objektů – nezávislé kopie */
  onDuplicatePropertyGroupsToObjects?: (
    sourceObjectCode: string,
    groups: { groupKey: string; properties: PropertyRequirement[] }[],
    targetObjectCodes: string[],
  ) => void;
  /** Duplikovat vybrané atributy do jiných objektů */
  onDuplicateAttributesToObjects?: (sourceObjectCode: string, attributes: import("../../project/types").AttributeRequirement[], targetObjectCodes: string[]) => void;
  /** Duplikovat vybrané klasifikace do jiných objektů */
  onDuplicateClassificationsToObjects?: (sourceObjectCode: string, classifications: import("../../project/types").ClassificationRequirement[], targetObjectCodes: string[]) => void;
  /** Duplikovat vybrané materiálové požadavky do jiných objektů */
  onDuplicateMaterialsToObjects?: (sourceObjectCode: string, materials: MaterialRequirement[], targetObjectCodes: string[]) => void;
  /** Duplikovat vybrané součásti (vztahy) do jiných objektů */
  onDuplicateRelationsToObjects?: (sourceObjectCode: string, relations: RelationRequirement[], targetObjectCodes: string[]) => void;
  /** Per-item aktualizace požadavků (pset/atribut/klasifikace/materiál/relace) */
  onUpdateRequirementItemGroup?: (
    kind: import("../../project/requirementFingerprint").RequirementItemKind,
    fingerprint: string,
    updatedItems: import("../../project/types").PropertyRequirement[]
      | [import("../../project/types").AttributeRequirement]
      | [import("../../project/types").ClassificationRequirement]
      | [import("../../project/types").MaterialRequirement]
      | [import("../../project/types").RelationRequirement],
  ) => void;
  /** Přiřadit skupinu požadavků k vybraným objektům (změna množiny objektů) */
  onAssignGroupToObjects?: (
    kind: import("../../project/requirementFingerprint").RequirementItemKind,
    fingerprint: string,
    objectCodes: string[],
    representativeItems: import("../../project/requirementFingerprint").RequirementItemGroup["representativeItems"],
  ) => void;
  onMoveGroupToKind?: (
    sourceKind: import("../../project/requirementFingerprint").RequirementItemKind,
    fingerprint: string,
    targetKind: import("../../project/requirementFingerprint").RequirementItemKind,
    representativeItems: import("../../project/requirementFingerprint").RequirementItemGroup["representativeItems"],
  ) => void;
}

const TAB_LABELS: Record<TabKey, string> = {
  attributes: "Atributy",
  properties: "Vlastnosti",
  partOf: "Součásti",
  material: "Materiál",
  classification: "Klasifikace",
  ids: "IDS náhled",
};

const relationTypeOptions: RelationRequirement["relationType"][] = [
  "IFCRELAGGREGATES",
  "IFCRELASSIGNSTOGROUP",
  "IFCRELCONTAINEDINSPATIALSTRUCTURE",
  "IFCRELNESTS",
  "IFCRELVOIDSELEMENT",
  "IFCRELFILLSELEMENT",
];

/** Výchozí šířky sloupců tabulky vlastností (px): checkbox, Výskyt, Vlastnost, ..., Fáze, Účel užití, Použitelnost, Akce */
const DEFAULT_PROPERTY_COL_WIDTHS = [40, 90, 150, 100, 95, 120, 85, 120, 180, 180, 180, 140, 100, 50, 110];

/** Všechny sloupce tabulky vlastností, které lze skrýt (index → label) */
const PROPERTY_COLUMNS_HIDEABLE: Record<number, string> = {
  0: "Checkbox",
  1: "Výskyt",
  2: "Vlastnost",
  3: "Datový typ",
  4: "Omezení",
  5: "Hodnota",
  6: "Jednotka",
  7: "URI",
  8: "Popis · Poznámka · Příklady",
  9: "Fáze",
  10: "Účel užití",
  11: "Použitelnost",
  12: "Akce",
};

/** Výchozí šířky sloupců: Atributy (14), Součásti (12), Materiál (12), Klasifikace (13) */
const DEFAULT_ATTRIBUTE_COL_WIDTHS = [40, 90, 150, 100, 95, 120, 120, 100, 100, 100, 100, 140, 50, 80];
const DEFAULT_PARTOF_COL_WIDTHS = [40, 90, 180, 160, 120, 120, 100, 100, 100, 140, 50, 80];
const DEFAULT_MATERIAL_COL_WIDTHS = [40, 90, 95, 150, 100, 120, 100, 100, 100, 140, 50, 80];
const DEFAULT_CLASSIFICATION_COL_WIDTHS = [40, 100, 180, 95, 150, 100, 120, 100, 100, 100, 140, 50, 80];

/** Sloupce tabulky atributů (index → label) */
const ATTRIBUTE_COLUMNS_HIDEABLE: Record<number, string> = {
  0: "Checkbox",
  1: "Výskyt",
  2: "Atribut",
  3: "Datový typ",
  4: "Omezení",
  5: "Hodnota",
  6: "URI",
  7: "Popis",
  8: "Poznámka",
  9: "Příklady",
  10: "Fáze",
  11: "Účel užití",
  12: "Použitelnost",
  13: "Akce",
};

/** Sloupce tabulky Součásti (index → label) */
const PARTOF_COLUMNS_HIDEABLE: Record<number, string> = {
  0: "Checkbox",
  1: "Výskyt",
  2: "Součást entity",
  3: "Vztah",
  4: "URI",
  5: "Popis",
  6: "Poznámka",
  7: "Příklady",
  8: "Fáze",
  9: "Účel užití",
  10: "Použitelnost",
  11: "Akce",
};

/** Sloupce tabulky Materiál (index → label) */
const MATERIAL_COLUMNS_HIDEABLE: Record<number, string> = {
  0: "Checkbox",
  1: "Výskyt",
  2: "Omezení",
  3: "Hodnota",
  4: "URI",
  5: "Popis",
  6: "Poznámka",
  7: "Příklady",
  8: "Fáze",
  9: "Účel užití",
  10: "Použitelnost",
  11: "Akce",
};

/** Sloupce tabulky Klasifikace (index → label) */
const CLASSIFICATION_COLUMNS_HIDEABLE: Record<number, string> = {
  0: "Checkbox",
  1: "Výskyt",
  2: "Klasifikační systém",
  3: "Omezení",
  4: "Hodnota",
  5: "URI",
  6: "Popis",
  7: "Poznámka",
  8: "Příklady",
  9: "Fáze",
  10: "Účel užití",
  11: "Použitelnost",
  12: "Akce",
};

/** Načte skryté sloupce z localStorage */
const loadHiddenColumns = (key: string, maxIndex: number): Set<number> => {
  try {
    const stored = localStorage.getItem(key);
    if (stored) {
      const arr = JSON.parse(stored) as number[];
      return new Set(arr.filter((i) => typeof i === "number" && i >= 0 && i <= maxIndex));
    }
  } catch {
    /* ignore */
  }
  return new Set();
};

/** Uloží skryté sloupce do localStorage */
const saveHiddenColumns = (key: string, hidden: Set<number>) => {
  if (hidden.size > 0) {
    localStorage.setItem(key, JSON.stringify(Array.from(hidden)));
  } else {
    localStorage.removeItem(key);
  }
};

// Czech help text for relation types (displayed in modal)
const RELATION_TYPES_HELP_TEXT = `Vztah IFCRELAGGREGATES popisuje, jak lze více menších dílčích objektů agregovat do jednoho většího objektu. Například několik podlaží budovy tvoří jednu budovu. Jiným příkladem je deska, kterou tvoří nosníky, podlahové desky a spoje. Nebo sestava, kterou tvoří konzoly, sloupky (mullions) a ocelové plechy.

Vztah IFCRELASSIGNSTOGROUP popisuje, jak lze více objektů seskupit do jedné kolekce objektů pro libovolný účel užití. Například potrubí, vzduchotechnické jednotky (AHU), ventilátory a žaluzie mohou být seskupeny do jednoho distribučního systému. Jiným příkladem je seskupení kabelů, rozvaděčů a zásuvek do jednoho elektrického okruhu. Případně mohou být prostory seskupeny do zón nebo udržovatelná aktiva seskupena do inventáře.

Vztah IFCRELCONTAINEDINSPATIALSTRUCTURE popisuje, jak jsou jednotlivé objekty umístěny v určitém prostoru nebo lokalitě. Například čerpadlo může být umístěno v prostoru, sloup může být umístěn v podlaží budovy (např. 2. NP) nebo prvky městského mobiliáře mohou být umístěny na stavebním pozemku. Každý objekt musí mít v IFC právě jeden primární kontejner prostorové struktury, i když může být zároveň odkazován z více umístění (například sloup procházející více podlažími). Tento vztah se vždy vztahuje pouze k primárnímu umístění.

Vztah IFCRELNESTS popisuje, jak může být fyzický objekt připojen k většímu „hostitelskému" objektu, typicky prostřednictvím fyzického spojení, jako je předvrtaný otvor nebo připojovací svorka. Při pohybu hostitelského objektu se s ním pohybují i všechny vnořené (připojené) objekty.

Vztah IFCRELVOIDSELEMENT popisuje, že otvor (void) náleží určitému prvku.

Vztah IFCRELFILLSELEMENT popisuje, jak prvek vyplňuje otvor a stává se jeho součástí.`;

const CONSTRAINT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "FILLED", label: "Jednoduchá hodnota" },
  { value: "ENUM", label: "Výčet" },
  { value: "PATTERN", label: "Vzor" },
  { value: "RANGE", label: "Ohraničení" },
  { value: "LENGTH", label: "Délka" },
];

// Záložní mapování IFC atributů (používá se pokud schema nemá definici)
const ATTRIBUTE_DATA_TYPES_FALLBACK: Record<string, string> = {
  Name: "IfcLabel",
  Description: "IfcText",
  Tag: "IfcIdentifier",
  ObjectType: "IfcLabel",
  GlobalId: "IfcGloballyUniqueId",
  PredefinedType: "IfcLabel",
  OperationType: "IfcDoorTypeOperationEnum",
  OverallHeight: "IfcPositiveLengthMeasure",
  OverallWidth: "IfcPositiveLengthMeasure",
  UserDefinedOperationType: "IfcLabel",
};

// Omezení pro atributy - stejné jako u vlastností
const ATTRIBUTE_CONSTRAINT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "FILLED", label: "Jednoduchá hodnota" },
  { value: "ENUM", label: "Výčet" },
  { value: "PATTERN", label: "Vzor" },
  { value: "RANGE", label: "Ohraničení" },
  { value: "LENGTH", label: "Délka" },
];

// Omezení pro materiály - stejná jako u ostatních karet
const MATERIAL_CONSTRAINT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "FILLED", label: "Jednoduchá hodnota" },
  { value: "ENUM", label: "Výčet" },
  { value: "PATTERN", label: "Vzor" },
  { value: "RANGE", label: "Ohraničení" },
  { value: "LENGTH", label: "Délka" },
];

// Funkce pro zjištění, zda je omezení povoleno pro datový typ atributu
const isAttributeConstraintAllowed = (attribute: string, constraint: string, dataType?: string) => {
  const dt = dataType ?? ATTRIBUTE_DATA_TYPES_FALLBACK[attribute] ?? "IfcLabel";
  return isConstraintAllowedForDataType(dt, constraint);
};

const isIfcBooleanType = (dataType?: string) => (dataType ?? "").trim().toLowerCase() === "ifcboolean";

const isIfcTextLikeType = (dataType?: string) => {
  const dt = (dataType ?? "").trim().toLowerCase();
  return (
    dt === "ifclabel" ||
    dt === "ifctext" ||
    dt === "ifcidentifier" ||
    dt === "ifcurireference" ||
    dt === "ifcgloballyuniqueid"
  );
};

const isIfcNumericLikeType = (dataType?: string) => {
  const dt = (dataType ?? "").trim().toLowerCase();
  if (!dt) return false;
  if (dt === "ifcinteger" || dt === "ifcreal" || dt === "ifccountmeasure") return true;
  // common IFC measure types
  if (dt.endsWith("measure")) return true;
  // common IFC numeric types
  if (dt.includes("integer") || dt.includes("real") || dt.includes("number")) return true;
  return false;
};

const isConstraintAllowedForDataType = (dataType: string | undefined, constraint: string) => {
  const c = (constraint ?? "").trim().toUpperCase();
  // Always allow "none"
  if (c === "FILLED") return true;
  // IfcBoolean: only "ENUM" makes sense (besides "FILLED")
  if (isIfcBooleanType(dataType)) return c === "ENUM";
  // Text-like: RANGE doesn't make sense
  if (isIfcTextLikeType(dataType)) return c !== "RANGE";
  // Numeric-like: LENGTH doesn't make sense
  if (isIfcNumericLikeType(dataType)) return c !== "LENGTH";
  // Other/sporné typy neomezujeme
  return true;
};

const UNIT_PRESETS: Array<{ value: string; label?: string }> = [
  { value: "", label: "—" },
  { value: "mm" },
  { value: "cm" },
  { value: "m" },
  { value: "m2" },
  { value: "m3" },
  { value: "kg" },
  { value: "t" },
  { value: "N" },
  { value: "kN" },
  { value: "Pa" },
  { value: "kPa" },
  { value: "MPa" },
  { value: "%" },
  { value: "°C" },
  { value: "s" },
  { value: "min" },
  { value: "h" },
  { value: "d" },
];

const isPresetUnit = (unit?: string) => {
  const u = (unit ?? "").trim();
  return UNIT_PRESETS.some((p) => p.value === u);
};

// Escape special XML characters
const escapeXml = (str: string): string => {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
};

// Valid IFC versions according to IDS schema
const VALID_IFC_VERSIONS = ["IFC2X3", "IFC4", "IFC4X3_ADD2"] as const;
type IdsIfcVersion = typeof VALID_IFC_VERSIONS[number];

// Valid cardinality values
type ConditionalCardinality = "required" | "prohibited" | "optional";
type SimpleCardinality = "required" | "prohibited";

// Helper to normalize entity name to uppercase (IDS requires uppercase)
const normalizeEntityName = (name: string): string => {
  if (!name) return "IFCBUILDINGELEMENT";
  // Convert IfcWall to IFCWALL
  return name.toUpperCase();
};

// Valid IDS data types from DataTypes.md (IFC4X3)
// These are the exact type names that can be used in the dataType attribute
const VALID_IDS_DATA_TYPES = new Set([
  // Common simple types
  "IFCBOOLEAN", "IFCLOGICAL", "IFCINTEGER", "IFCREAL", "IFCTEXT", "IFCLABEL", "IFCIDENTIFIER",
  // Measure types
  "IFCLENGTHMEASURE", "IFCAREAMEASURE", "IFCVOLUMEMEASURE", "IFCMASSMEASURE", "IFCTIMEMEASURE",
  "IFCTHERMODYNAMICTEMPERATUREMEASURE", "IFCELECTRICCURRENTMEASURE", "IFCLUMINOUSINTENSITYMEASURE",
  "IFCAMOUNTOFSUBSTANCEMEASURE", "IFCPLANEANGLEMEASURE", "IFCSOLIDANGLEMEASURE", "IFCPRESSUREMEASURE",
  "IFCFORCEMEASURE", "IFCENERGYMEASURE", "IFCPOWERMEASURE", "IFCFREQUENCYMEASURE", "IFCELECTRICVOLTAGEMEASURE",
  "IFCELECTRICRESISTANCEMEASURE", "IFCELECTRICCONDUCTANCEMEASURE", "IFCELECTRICCAPACITANCEMEASURE",
  "IFCMAGNETICFLUXMEASURE", "IFCMAGNETICFLUXDENSITYMEASURE", "IFCINDUCTANCEMEASURE", "IFCLUMINOUSFLUXMEASURE",
  "IFCILLUMINANCEMEASURE", "IFCRADIOACTIVITYMEASURE", "IFCMONETARYMEASURE", "IFCCOUNTMEASURE",
  "IFCPOSITIVELENGTHENTHMEASURE", "IFCNONNEGATIVELENGTHMEASURE", "IFCPOSITIVELENGTHMEASURE",
  "IFCPOSITIVEPLANEANGLEMEASURE", "IFCRATIOMEASURE", "IFCNORMALISEDRATIOMEASURE", "IFCPOSITIVERATIOMEASURE",
  "IFCCONTEXTDEPENDENTMEASURE", "IFCDESCRIPTIVEMEASURE", "IFCPARAMETERVALUE", "IFCNUMERICMEASURE",
  "IFCTHERMALCONDUCTIVITYMEASURE", "IFCTHERMALTRANSMITTANCEMEASURE", "IFCTHERMALRESISTANCEMEASURE",
  "IFCTHERMALADMITTANCEMEASURE", "IFCSPECIFICHEATCAPACITYMEASURE", "IFCHEATINGVALUEMEASURE",
  "IFCHEATFLUXDENSITYMEASURE", "IFCISOTHERMALMOISTURECAPACITYMEASURE", "IFCVAPORPERMEABILITYMEASURE",
  "IFCMOISTURECREDITRYMEASURE", "IFCDYNAMICVISCOSITYMEASURE", "IFCKINEMATICVISCOSITYMEASURE",
  "IFCMODULUSOFELASTICITYMEASURE", "IFCMODULUSOFSUBGRADEREACTIONMEASURE", "IFCSHEARMODULUSMEASURE",
  "IFCLINEARFORCEMEASURE", "IFCPLANARFORCEMEASURE", "IFCLINEARSTIFFNESSMEASURE", "IFCROTATIONALSTIFFNESSMEASURE",
  "IFCMOMENTOFINERTIAMEASURE", "IFCSECTIONALAREAINTEGRALMEASURE", "IFCSECTIONMODULUSMEASURE",
  "IFCWARPINGCONSTANTMEASURE", "IFCWARPINGMOMENTMEASURE", "IFCMASSDENSITYMEASURE", "IFCMASSFLOWRATEMEASURE",
  "IFCMASSPERLENGTHMEASURE", "IFCVOLUMETRICFLOWRATEMEASURE", "IFCROTATIONALFREQUENCYMEASURE",
  "IFCROTATIONALMASSMEASURE", "IFCSOUNDPOWERMEASURE", "IFCSOUNDPRESSUREMEASURE", "IFCSOUNDPOWERLEVELMEASURE",
  "IFCSOUNDPRESSURELEVELMEASURE", "IFCACCELERATIONMEASURE", "IFCANGULARVELOCITYMEASURE", "IFCLINEARVELOCITYMEASURE",
  "IFCCURVATUREMEASURE", "IFCTORQUEMEASURE", "IFCABSORBEDDOSEMEASURE", "IFCDOSEEQUIVALENTMEASURE",
  "IFCIONCONCENTRATIONMEASURE", "IFCTEMPERATUREGRADIENTMEASURE", "IFCTEMPERATURERATEOFCHANGEMEASURE",
  "IFCAREADENSITYMEASURE",
  // Date/time types
  "IFCDATE", "IFCDATETIME", "IFCTIME", "IFCDURATION", "IFCTIMESTAMP",
  // Other types
  "IFCGLOBALLYUNIQUEID", "IFCURIREFERENCE",
  // Common ENUM types from DataTypes.md (for PEnum_ mapping)
  "IFCASSEMBLYPLACEENUM", "IFCACTIONREQUESTTYPEENUM", "IFCACTIONSOURCETYPEENUM", "IFCACTIONTYPEENUM",
  "IFCACTUATORTYPEENUM", "IFCADDRESSTYPEENUM", "IFCAIRTERMINALBOXTYPEENUM", "IFCAIRTERMINALTYPEENUM",
  "IFCAIRTOAIRHEATRECOVERYTYPEENUM", "IFCALARMTYPEENUM", "IFCANALYSISMODELTYPEENUM", "IFCANALYSISTHEORYTYPEENUM",
  "IFCBEAMTYPEENUM", "IFCBENCHMARKENUM", "IFCBOILERTYPEENUM", "IFCBUILDINGELEMENTPROXYTYPEENUM",
  "IFCBUILDINGSYSTEMTYPEENUM", "IFCBURNERTYPEENUM", "IFCCABLECARRIERFITTINGTYPEENUM", "IFCCABLECARRIERSEGMENTTYPEENUM",
  "IFCCABLEFITTINGTYPEENUM", "IFCCABLESEGMENTTYPEENUM", "IFCCHANGEACTIONENUM", "IFCCHILLERTYPEENUM",
  "IFCCHIMNEYTYPEENUM", "IFCCOILTYPEENUM", "IFCCOLUMNTYPEENUM", "IFCCOMMUNICATIONSAPPLIANCETYPEENUM",
  "IFCCOMPRESSORTYPEENUM", "IFCCONDENSERTYPEENUM", "IFCCONNECTIONTYPEENUM", "IFCCONSTRAINTENUM",
  "IFCCONTROLLERTYPEENUM", "IFCCOOLEDBEAMTYPEENUM", "IFCCOOLINGTOWERTYPEENUM", "IFCCOSTSCHEDULETYPEENUM",
  "IFCCOVERINGTYPEENUM", "IFCCURTAINWALLTYPEENUM", "IFCDAMPERTYPEENUM", "IFCDATAORIGINENUM",
  "IFCDIRECTIONSENSEENUM", "IFCDISTRIBUTIONCHAMBERELEMENTTYPEENUM", "IFCDISTRIBUTIONPORTTYPEENUM",
  "IFCDISTRIBUTIONSYSTEMENUM", "IFCDOCUMENTCONFIDENTIALITYENUM", "IFCDOCUMENTSTATUSENUM",
  "IFCDOORPANELOPERATIONENUM", "IFCDOORPANELPOSITIONENUM", "IFCDOORTYPEENUM", "IFCDOORTYPEOPERATIONENUM",
  "IFCDUCTFITTINGTYPEENUM", "IFCDUCTSEGMENTTYPEENUM", "IFCDUCTSILENCERTYPEENUM",
  "IFCELECTRICAPPLIANCETYPEENUM", "IFCELECTRICDISTRIBUTIONBOARDTYPEENUM", "IFCELECTRICFLOWSTORAGEDEVICETYPEENUM",
  "IFCELECTRICGENERATORTYPEENUM", "IFCELECTRICMOTORTYPEENUM", "IFCELECTRICTIMECONTROLTYPEENUM",
  "IFCELEMENTASSEMBLYTYPEENUM", "IFCELEMENTCOMPOSITIONENUM", "IFCENGINETYPEENUM",
  "IFCEVAPORATIVECOOLERTYPEENUM", "IFCEVAPORATORTYPEENUM", "IFCEVENTTRIGGERTYPEENUM", "IFCEVENTTYPEENUM",
  "IFCEXTERNALSPATIALELEMENTTYPEENUM", "IFCFACILITYPARTCOMMONTYPEENUM", "IFCFACILITYUSAGEENUM",
  "IFCFANTYPEENUM", "IFCFASTENERTYPEENUM", "IFCFILTERTYPEENUM", "IFCFIRESUPPRESSIONTERMINALTYPEENUM",
  "IFCFLOWDIRECTIONENUM", "IFCFLOWINSTRUMENTTYPEENUM", "IFCFLOWMETERTYPEENUM",
  "IFCFOOTINGTYPEENUM", "IFCFURNITURETYPEENUM", "IFCGEOGRAPHICELEMENTTYPEENUM", "IFCGEOMETRICPROJECTIONENUM",
  "IFCGLOBALORLOCALENUM", "IFCGRIDTYPEENUM", "IFCHEATEXCHANGERTYPEENUM", "IFCHUMIDIFIERTYPEENUM",
  "IFCINTERCEPTORTYPEENUM", "IFCINTERNALOREXTERNALENUM", "IFCINVENTORYTYPEENUM",
  "IFCJUNCTIONBOXTYPEENUM", "IFCLAMPTYPEENUM", "IFCLAYERSETDIRECTIONENUM",
  "IFCLIGHTDISTRIBUTIONCURVEENUM", "IFCLIGHTEMISSIONSOURCEENUM", "IFCLIGHTFIXTURETYPEENUM",
  "IFCLOADGROUPTYPEENUM", "IFCLOGICALOPERATORENUM", "IFCMECHANICALFASTENERTYPEENUM", "IFCMEDICALDEVICETYPEENUM",
  "IFCMEMBERTYPEENUM", "IFCMOTORCONNECTIONTYPEENUM", "IFCOBJECTIVEENUM", "IFCOCCUPANTTYPEENUM",
  "IFCOPENINGELEMENTTYPEENUM", "IFCOUTLETTYPEENUM", "IFCPERFORMANCEHISTORYTYPEENUM",
  "IFCPERMEABLECOVERINGOPERATIONENUM", "IFCPERMITTYPEENUM", "IFCPHYSICALORVIRTUALENUM",
  "IFCPILECONSTRUCTIONENUM", "IFCPILETYPEENUM", "IFCPIPEFITTINGTYPEENUM", "IFCPIPESEGMENTTYPEENUM",
  "IFCPLATETYPEENUM", "IFCPROCEDURETYPEENUM", "IFCPROFILETYPEENUM", "IFCPROJECTEDORTRUELENGTHENUM",
  "IFCPROJECTIONELEMENTTYPEENUM", "IFCPROJECTORDERTYPEENUM", "IFCPROPERTYSETTEMPLATETYPEENUM",
  "IFCPROTECTIVEDEVICETRIPPINGUNITTYPEENUM", "IFCPROTECTIVEDEVICETYPEENUM", "IFCPUMPTYPEENUM",
  "IFCRAILINGTYPEENUM", "IFCRAMPFLIGHTTYPEENUM", "IFCRAMPTYPEENUM", "IFCRECURRENCETYPEENUM",
  "IFCREFERENTTYPEENUM", "IFCREFLECTANCEMETHODENUM", "IFCREINFORCINGBARROLEENUM", "IFCREINFORCINGBARSURFACEENUM",
  "IFCREINFORCINGBARTYPEENUM", "IFCREINFORCINGMESHTYPEENUM", "IFCROLEENUM", "IFCROOFTYPEENUM",
  "IFCSANITARYTERMINALTYPEENUM", "IFCSECTIONTYPEENUM", "IFCSENSORTYPEENUM", "IFCSEQUENCEENUM",
  "IFCSHADINGDEVICETYPEENUM", "IFCSIMPLEPROPERTYTEMPLATETYPEENUM", "IFCSLABTYPEENUM", "IFCSOLARDEVICETYPEENUM",
  "IFCSPACEHEATERTYPEENUM", "IFCSPACETYPEENUM", "IFCSPATIALZONETYPEENUM", "IFCSTACKTERMINALTYPEENUM",
  "IFCSTAIRFLIGHTTYPEENUM", "IFCSTAIRTYPEENUM", "IFCSTATEENUM", "IFCSTRUCTURALCURVEACTIVITYTYPEENUM",
  "IFCSTRUCTURALCURVEMEMBERTYPEENUM", "IFCSTRUCTURALSURFACEACTIVITYTYPEENUM", "IFCSTRUCTURALSURFACEMEMBERTYPEENUM",
  "IFCSUBCONTRACTRESOURCETYPEENUM", "IFCSURFACEFEATURETYPEENUM", "IFCSWITCHINGDEVICETYPEENUM",
  "IFCSYSTEMFURNITUREELEMENTTYPEENUM", "IFCTANKTYPEENUM", "IFCTASKDURATIONENUM", "IFCTASKTYPEENUM",
  "IFCTENDONANCHORTYPEENUM", "IFCTENDONTYPEENUM", "IFCTIMESERIESDATATYPEENUM", "IFCTRANSFORMERTYPEENUM",
  "IFCTRANSPORTELEMENTTYPEENUM", "IFCTUBEBUNDLETYPEENUM", "IFCUNITARYCONTROLELEMENTTYPEENUM",
  "IFCUNITARYEQUIPMENTTYPEENUM", "IFCUNITENUM", "IFCVALVETYPEENUM", "IFCVIBRATIONISOLATORTYPEENUM",
  "IFCVOIDINGFEATURETYPEENUM", "IFCWALLTYPEENUM", "IFCWASTETERMINALTYPEENUM",
  "IFCWINDOWPANELOPERATIONENUM", "IFCWINDOWPANELPOSITIONENUM", "IFCWINDOWTYPEENUM", "IFCWINDOWTYPEPARTITIONINGENUM",
  "IFCWORKCALENDARTYPEENUM", "IFCWORKPLANTYPEENUM", "IFCWORKSCHEDULETYPEENUM",
]);

// Mapping from common schema data types to valid IDS data types
const DATA_TYPE_MAPPING: Record<string, string> = {
  // Direct IFC types (case-insensitive)
  "ifcboolean": "IFCBOOLEAN",
  "ifclogical": "IFCLOGICAL",
  "ifcinteger": "IFCINTEGER",
  "ifcreal": "IFCREAL",
  "ifctext": "IFCTEXT",
  "ifclabel": "IFCLABEL",
  "ifcidentifier": "IFCIDENTIFIER",
  "ifclengthmeasure": "IFCLENGTHMEASURE",
  "ifcareameasure": "IFCAREAMEASURE",
  "ifcvolumemeasure": "IFCVOLUMEMEASURE",
  "ifcmassmeasure": "IFCMASSMEASURE",
  "ifctimemeasure": "IFCTIMEMEASURE",
  "ifccountmeasure": "IFCCOUNTMEASURE",
  "ifcthermodynamictemperaturemeasure": "IFCTHERMODYNAMICTEMPERATUREMEASURE",
  "ifcpressuremeasure": "IFCPRESSUREMEASURE",
  "ifcpowermeasure": "IFCPOWERMEASURE",
  "ifcenergymeasure": "IFCENERGYMEASURE",
  "ifcelectricvoltagemeasure": "IFCELECTRICVOLTAGEMEASURE",
  "ifcelectriccurrentmeasure": "IFCELECTRICCURRENTMEASURE",
  "ifcpositivelengthenthmeasure": "IFCPOSITIVELENGTHMEASURE",
  "ifcnonnegativelengthmeasure": "IFCNONNEGATIVELENGTHMEASURE",
  "ifcplaneanglemeasure": "IFCPLANEANGLEMEASURE",
  "ifcratiomeasure": "IFCRATIOMEASURE",
  "ifcnormalisedratiomeasure": "IFCNORMALISEDRATIOMEASURE",
  "ifcmonetarymeasure": "IFCMONETARYMEASURE",
  "ifcthermalconductivitymeasure": "IFCTHERMALCONDUCTIVITYMEASURE",
  "ifcthermaltransmittancemeasure": "IFCTHERMALTRANSMITTANCEMEASURE",
  "ifcmassdensitymeasure": "IFCMASSDENSITYMEASURE",
  "ifcdate": "IFCDATE",
  "ifcdatetime": "IFCDATETIME",
  "ifctime": "IFCTIME",
  "ifcduration": "IFCDURATION",
  "ifcgloballyuniqueid": "IFCGLOBALLYUNIQUEID",
  "ifcurireference": "IFCURIREFERENCE",
  
  // IFC Quantity types → OMIT dataType (let IDS infer from Qto_ definition)
  // These return empty string to signal "don't include dataType attribute"
  // IfcQuantityWeight, IfcQuantityLength, etc. are not valid IDS dataTypes
  // The actual value types (IFCMASSMEASURE, IFCLENGTHMEASURE) will be inferred by validator
  
  // Additional IFC property value types - also omit for complex types
  // These are container types, not actual data types
  
  // Common string/text types
  "string": "IFCLABEL",
  "text": "IFCTEXT",
  
  // Common numeric types
  "number": "IFCREAL",
  "integer": "IFCINTEGER",
  "real": "IFCREAL",
  "double": "IFCREAL",
  "float": "IFCREAL",
  
  // Boolean
  "boolean": "IFCBOOLEAN",
  "bool": "IFCBOOLEAN",
  
  // Datové typy z bSDD / ComBIMe exportu (sloupec IFC_datový_typ)
  "booleantype": "IFCBOOLEAN",
  "integerdatatype": "IFCINTEGER",
  "realdatatype": "IFCREAL",
  "stringtype": "IFCLABEL",
  "datestringtype": "IFCDATE",
  // Positive/non-negative length measures
  "ifcpositivelengthmeasure": "IFCPOSITIVELENGTHMEASURE",
};

// Types that should NOT have dataType attribute in IDS output
// These are IFC container/quantity types that are not valid IDS dataTypes
// The IDS validator will infer the correct type from Qto_/Pset_ definitions
const OMIT_DATATYPE_PATTERNS = [
  "ifcquantity",        // IfcQuantityWeight, IfcQuantityLength, IfcQuantityArea, etc.
  "ifcproperty",        // IfcPropertySingleValue, IfcPropertyEnumeratedValue, etc.
];

// Helper to map IFC data types to valid IDS data types
// Returns undefined if dataType should be omitted from IDS output
const mapDataTypeToIds = (dataType?: string): string | undefined => {
  if (!dataType) return undefined;
  
  const dt = dataType.trim();
  const dtLower = dt.toLowerCase();
  
  // FIRST: Check if this type should be OMITTED from IDS output
  // IFC Quantity types (IfcQuantityWeight, etc.) and Property types are NOT valid IDS dataTypes
  // The IDS validator will infer the correct measure type from the Qto_ definition
  for (const pattern of OMIT_DATATYPE_PATTERNS) {
    if (dtLower.startsWith(pattern)) {
      return undefined; // Omit dataType attribute entirely
    }
  }
  
  // Check direct mapping
  if (DATA_TYPE_MAPPING[dtLower]) {
    return DATA_TYPE_MAPPING[dtLower];
  }
  
  // Handle PEnum_ types - these are Property Enumerations stored as IfcLabel in IFC
  // PEnum_AssemblyPlace → IFCLABEL (not IFCASSEMBLYPLACEENUM!)
  if (dtLower.startsWith("penum_") || dtLower.startsWith("penum")) {
    return "IFCLABEL";
  }
  
  // Try to find in valid types (case-insensitive)
  const dtUpper = dt.toUpperCase();
  if (VALID_IDS_DATA_TYPES.has(dtUpper)) {
    return dtUpper;
  }
  
  // Handle Ifc prefix - normalize to uppercase and check
  if (dtLower.startsWith("ifc")) {
    const normalized = dtUpper;
    if (VALID_IDS_DATA_TYPES.has(normalized)) {
      return normalized;
    }
    // If ends with MEASURE and is in valid types, use it
    if (normalized.endsWith("MEASURE") && VALID_IDS_DATA_TYPES.has(normalized)) {
      return normalized;
    }
    // If ends with ENUM and is in valid types, use it
    if (normalized.endsWith("ENUM") && VALID_IDS_DATA_TYPES.has(normalized)) {
      return normalized;
    }
  }
  
  // Default fallback for unknown types
  // If it looks like an enum type, use IFCLABEL
  if (dtLower.includes("enum") || dtLower.includes("type")) {
    return "IFCLABEL";
  }
  
  // For other unknown types, return IFCLABEL as safe default for strings
  return "IFCLABEL";
};

// Generate constraint XML for IDS. For ENUM uses allowedValues (vyčet) when present.
const generateConstraintXml = (
  constraint?: string,
  value?: string,
  indent: string = "          ",
  allowedValues?: string[]
): string => {
  const c = (constraint ?? "FILLED").toUpperCase();
  const val = value ?? "";
  
  if (c === "ENUM") {
    const enumList = (allowedValues && allowedValues.length > 0)
      ? allowedValues.filter(Boolean)
      : val.split("|").map((v) => v.trim()).filter(Boolean);
    if (enumList.length === 0) return "";
    if (enumList.length === 1) {
      return `${indent}<ids:value>\n${indent}  <ids:simpleValue>${escapeXml(enumList[0])}</ids:simpleValue>\n${indent}</ids:value>`;
    }
    let xml = `${indent}<ids:value>\n${indent}  <xs:restriction base="xs:string">`;
    enumList.forEach((v) => {
      xml += `\n${indent}    <xs:enumeration value="${escapeXml(v)}" />`;
    });
    xml += `\n${indent}  </xs:restriction>\n${indent}</ids:value>`;
    return xml;
  }
  
  // If no value specified, no restriction (except ENUM handled above)
  if (!val) return "";
  
  // FILLED constraint with value = simple value requirement
  if (c === "FILLED") {
    return `${indent}<ids:value>\n${indent}  <ids:simpleValue>${escapeXml(val)}</ids:simpleValue>\n${indent}</ids:value>`;
  }
  
  if (c === "PATTERN") {
    return `${indent}<ids:value>\n${indent}  <xs:restriction base="xs:string">\n${indent}    <xs:pattern value="${escapeXml(val)}" />\n${indent}  </xs:restriction>\n${indent}</ids:value>`;
  }
  
  if (c === "RANGE") {
    let xml = `${indent}<ids:value>\n${indent}  <xs:restriction base="xs:double">`;
    const rangeParts = val.split("|").map((p) => p.trim()).filter(Boolean);
    rangeParts.forEach((part) => {
      if (part.startsWith("min:")) {
        const rest = part.slice(4);
        const [num, kind] = rest.split(":");
        const v = (num ?? "").trim();
        if (v) xml += `\n${indent}    <xs:min${(kind ?? "").trim() === "exclusive" ? "Exclusive" : "Inclusive"} value="${escapeXml(v)}" />`;
      } else if (part.startsWith("max:")) {
        const rest = part.slice(4);
        const [num, kind] = rest.split(":");
        const v = (num ?? "").trim();
        if (v) xml += `\n${indent}    <xs:max${(kind ?? "").trim() === "exclusive" ? "Exclusive" : "Inclusive"} value="${escapeXml(v)}" />`;
      }
    });
    if (rangeParts.length === 0) {
      const parts = val.split(/\s*(?:AND|,|;)\s*/i);
      parts.forEach((part) => {
        const trimmed = part.trim();
        if (trimmed.startsWith(">=")) {
          xml += `\n${indent}    <xs:minInclusive value="${escapeXml(trimmed.slice(2).trim())}" />`;
        } else if (trimmed.startsWith(">")) {
          xml += `\n${indent}    <xs:minExclusive value="${escapeXml(trimmed.slice(1).trim())}" />`;
        } else if (trimmed.startsWith("<=")) {
          xml += `\n${indent}    <xs:maxInclusive value="${escapeXml(trimmed.slice(2).trim())}" />`;
        } else if (trimmed.startsWith("<")) {
          xml += `\n${indent}    <xs:maxExclusive value="${escapeXml(trimmed.slice(1).trim())}" />`;
        }
      });
    }
    xml += `\n${indent}  </xs:restriction>\n${indent}</ids:value>`;
    return xml;
  }
  
  if (c === "LENGTH") {
    // Parse length constraints like "min:5" or "max:100" or "5-100"
    const parts = val.split(/\s*(?:AND|,|;|-)\s*/i);
    let xml = `${indent}<ids:value>\n${indent}  <xs:restriction base="xs:string">`;
    parts.forEach((part, idx) => {
      const trimmed = part.trim();
      if (trimmed.startsWith("min:")) {
        xml += `\n${indent}    <xs:minLength value="${escapeXml(trimmed.slice(4).trim())}" />`;
      } else if (trimmed.startsWith("max:")) {
        xml += `\n${indent}    <xs:maxLength value="${escapeXml(trimmed.slice(4).trim())}" />`;
      } else if (!isNaN(Number(trimmed))) {
        // Simple number - if first, treat as min, if second, treat as max
        if (idx === 0) {
          xml += `\n${indent}    <xs:minLength value="${escapeXml(trimmed)}" />`;
        } else {
          xml += `\n${indent}    <xs:maxLength value="${escapeXml(trimmed)}" />`;
        }
      }
    });
    xml += `\n${indent}  </xs:restriction>\n${indent}</ids:value>`;
    return xml;
  }
  
  // Default: simple value
  return `${indent}<ids:value>\n${indent}  <ids:simpleValue>${escapeXml(val)}</ids:simpleValue>\n${indent}</ids:value>`;
};

// IDS Validation errors interface
interface IdsValidationError {
  type: "error" | "warning";
  message: string;
  field?: string;
}

// Validate IDS compliance
const validateIdsCompliance = (obj: import("../../project/types").ProjectObject): IdsValidationError[] => {
  const errors: IdsValidationError[] = [];
  
  // Check entity
  if (!obj.ifcEntity) {
    errors.push({ type: "error", message: "IFC entita není vybrána", field: "entity" });
  } else {
    const normalized = normalizeEntityName(obj.ifcEntity);
    if (!/^IFC[A-Z]+$/.test(normalized)) {
      errors.push({ type: "warning", message: `Název entity "${obj.ifcEntity}" bude převeden na "${normalized}"`, field: "entity" });
    }
  }
  
  // Check classifications - system is required
  obj.requirements.classifications.forEach((cls, idx) => {
    const hasSystem = cls.systemEntryId || cls.system || cls.name;
    if (!hasSystem) {
      errors.push({ type: "error", message: `Klasifikace #${idx + 1}: Systém je povinný`, field: `classification.${idx}` });
    }
  });
  
  // Check properties - dataType mapping and validation
  obj.requirements.properties.forEach((prop, idx) => {
    if (prop.dataType) {
      const mapped = mapDataTypeToIds(prop.dataType);
      const dtLower = prop.dataType.toLowerCase();
      const dtUpper = prop.dataType.toUpperCase().replace(/[^A-Z]/g, "");
      
      // Check if this is a known/expected mapping (in DATA_TYPE_MAPPING)
      const isKnownMapping = DATA_TYPE_MAPPING[dtLower] !== undefined;
      
      // Only show warning for unknown types that get fallback mapping
      // Don't show warning for:
      // - Types that are already valid IDS types (mapped === dtUpper)
      // - PEnum types (handled correctly)
      // - Known mappings in DATA_TYPE_MAPPING (e.g., IfcQuantityWeight → IFCMASSMEASURE)
      if (mapped && mapped !== dtUpper && !dtLower.startsWith("penum") && !isKnownMapping) {
        errors.push({ 
          type: "warning", 
          message: `Vlastnost "${prop.propertyName}": "${prop.dataType}" → ${mapped}`, 
          field: `property.${idx}` 
        });
      }
    }
    if (!prop.psetName) {
      errors.push({ type: "error", message: `Vlastnost #${idx + 1}: PropertySet je povinný`, field: `property.${idx}` });
    }
    if (!prop.propertyName) {
      errors.push({ type: "error", message: `Vlastnost #${idx + 1}: Název vlastnosti je povinný`, field: `property.${idx}` });
    }
  });
  
  // Check relations - entityType must be uppercase
  obj.requirements.relations.forEach((rel, idx) => {
    if (rel.entityType) {
      const normalized = normalizeEntityName(rel.entityType);
      if (!/^IFC[A-Z]+$/.test(normalized)) {
        errors.push({ type: "warning", message: `Relace #${idx + 1}: Entita "${rel.entityType}" bude převedena na "${normalized}"`, field: `relation.${idx}` });
      }
    }
  });
  
  return errors;
};

/** Get metadata for phase+occurrence. Supports legacy single-object format. */
const getIdsSpecMetadataForPhaseOccurrence = (
  obj: import("../../project/types").ProjectObject,
  phaseId: string | null,
  occurrence: string
): IdsSpecMetadata | undefined => {
  const map = obj.idsSpecMetadata;
  if (!map || typeof map !== "object") return undefined;
  const keys = Object.keys(map);
  if (keys.length === 0) return undefined;
  const isLegacy = !keys.some((k) => k.includes("|"));
  if (isLegacy) return map as unknown as IdsSpecMetadata;
  const key = `${phaseId ?? "all"}|${occurrence}`;
  return (map as Record<string, IdsSpecMetadata>)[key];
};

/** Build one specification block (applicability + requirements) for given occurrence. Returns null if no requirements. */
const buildOneSpecificationXml = (
  filteredObj: import("../../project/types").ProjectObject,
  obj: import("../../project/types").ProjectObject,
  phaseId: string | null,
  classificationSystemEntries: import("../../project/types").ClassificationSystemEntry[],
  occurrenceFilter: "required" | "prohibited" | "optional",
  ifcVersion: IdsIfcVersion,
  phaseName?: string,
  useCaseId?: string | null
): string | null => {
  let objForSpec = filteredObj;
  if (useCaseId != null && useCaseId !== "") {
    const appliesUseCase = (r: { useCaseMode?: string }, effective: string[]) =>
      r.useCaseMode !== "excluded" && requirementAppliesToUseCase(effective, useCaseId);
    objForSpec = {
      ...filteredObj,
      requirements: {
        attributes: filteredObj.requirements.attributes.filter((r) => appliesUseCase(r, getEffectiveUseCaseIds(r, obj, "attributes"))),
        properties: filteredObj.requirements.properties.filter((r) => appliesUseCase(r, getEffectiveUseCaseIds(r, obj, "properties", r.psetName))),
        relations: filteredObj.requirements.relations.filter((r) => appliesUseCase(r, getEffectiveUseCaseIds(r, obj, "relations"))),
        classifications: filteredObj.requirements.classifications.filter((r) => appliesUseCase(r, getEffectiveUseCaseIds(r, obj, "classifications"))),
        materials: filteredObj.requirements.materials.filter((r) => appliesUseCase(r, getEffectiveUseCaseIds(r, obj, "materials"))),
      },
    };
  }
  const entityName = normalizeEntityName(objForSpec.ifcEntity);
  const meta = getIdsSpecMetadataForPhaseOccurrence(obj, phaseId, occurrenceFilter);
  const sanitizeForSpec = (s: string) => (s || "").replace(/[^\p{L}\p{N}_\-]/gu, "_").replace(/_+/g, "_") || "export";
  const occurrenceLabel = occurrenceFilter === "required" ? "Požadované" : occurrenceFilter === "prohibited" ? "Zakázané" : "Možné";
  const derivedSpecName = [
    sanitizeForSpec((filteredObj.code || filteredObj.description || "").replace(/::/g, ".")),
    phaseName ? sanitizeForSpec(phaseName.split(" - ")[0] ?? "") : "",
    occurrenceLabel,
  ].filter(Boolean).join("_");
  const finalSpecName = meta?.name ?? derivedSpecName;
  const specAttrs = [
    `ifcVersion="${ifcVersion}"`,
    `name="${escapeXml(finalSpecName)}"`,
    meta?.identifier ? `identifier="${escapeXml(meta.identifier)}"` : "",
    meta?.description ? `description="${escapeXml(meta.description)}"` : "",
    meta?.instructions ? `instructions="${escapeXml(meta.instructions)}"` : "",
  ].filter(Boolean).join(" ");

  // Check if we have any requirements for this occurrence
  const hasReqAttr = objForSpec.requirements.attributes.some((a) => !a.isApplicability && a.attribute !== "PredefinedType" && matchesOccurrenceFilter(a.occurrence, occurrenceFilter));
  const hasReqProp = objForSpec.requirements.properties.some((p) => !p.isApplicability && p.psetName && !p.psetName.startsWith("_NEW_") && p.propertyName && matchesOccurrenceFilter(p.occurrence, occurrenceFilter));
  const hasReqRel = objForSpec.requirements.relations.some((r) => !r.isApplicability && matchesOccurrenceFilter(r.occurrence, occurrenceFilter));
  const requirementClassifications = objForSpec.requirements.classifications.filter((cls) => {
    if (cls.isApplicability || cls.readOnly) return false;
    const entry = cls.systemEntryId ? classificationSystemEntries.find((e) => e.id === cls.systemEntryId) : undefined;
    if (entry?.isIfcSystem) return false;
    return true;
  });
  const hasReqCls = requirementClassifications.some((c) => matchesOccurrenceFilter(c.occurrence ?? "required", occurrenceFilter));
  const hasReqMat = objForSpec.requirements.materials.some((m) => !m.isApplicability && matchesOccurrenceFilter(m.occurrence, occurrenceFilter));
  if (!hasReqAttr && !hasReqProp && !hasReqRel && !hasReqCls && !hasReqMat) return null;

  let spec = `    <ids:specification ${specAttrs}>
      <ids:applicability minOccurs="1" maxOccurs="unbounded">
        <ids:entity>
          <ids:name>
            <ids:simpleValue>${escapeXml(entityName)}</ids:simpleValue>
          </ids:name>`;

  const predefinedTypePhases = obj.predefinedTypePhases ?? obj.entityPhases ?? (phaseId === null ? [] : [phaseId]);
  const ptVal = (objForSpec.predefinedType.value ?? "").trim();
  const predefinedTypeApplies = objForSpec.predefinedType.mode !== "NONE" && !!ptVal && ptVal !== EMPTY_PLACEHOLDER && (!phaseId ? (predefinedTypePhases.length > 0) : (predefinedTypePhases.length === 0 || predefinedTypePhases.includes(phaseId)));
  if (predefinedTypeApplies) {
    spec += `
          <ids:predefinedType>
            <ids:simpleValue>${escapeXml(ptVal.toUpperCase())}</ids:simpleValue>
          </ids:predefinedType>`;
  }
  spec += `
        </ids:entity>`;

  const applicabilityClassifications = objForSpec.requirements.classifications.filter((cls) => {
    if (!cls.isApplicability && !cls.readOnly) return false;
    const entry = cls.systemEntryId ? classificationSystemEntries.find((e) => e.id === cls.systemEntryId) : undefined;
    if (entry?.isIfcSystem) return false;
    return true;
  });
  applicabilityClassifications.forEach((cls) => {
    const entryName = cls.systemEntryId ? classificationSystemEntries.find((e) => e.id === cls.systemEntryId)?.name : undefined;
    const system = entryName || cls.system || cls.name;
    if (!system) return;
    const uriAttr = cls.uri ? ` uri="${escapeXml(cls.uri)}"` : "";
    const instructionsAttr = cls.note ? ` instructions="${escapeXml(cls.note)}"` : "";
    spec += `
        <ids:classification${uriAttr}${instructionsAttr}>`;
    if (cls.value) {
      const constraint = cls.constraint ?? "FILLED";
      if (constraint === "ENUM") {
        const values = cls.value.split("|").map((v) => v.trim()).filter(Boolean);
        spec += `
          <ids:value>
            <xs:restriction base="xs:string">`;
        values.forEach((v) => { spec += `
              <xs:enumeration value="${escapeXml(v)}" />`; });
        spec += `
            </xs:restriction>
          </ids:value>`;
      } else if (constraint === "PATTERN") {
        spec += `
          <ids:value>
            <xs:restriction base="xs:string">
              <xs:pattern value="${escapeXml(cls.value)}" />
            </xs:restriction>
          </ids:value>`;
      } else {
        spec += `
          <ids:value>
            <ids:simpleValue>${escapeXml(cls.value)}</ids:simpleValue>
          </ids:value>`;
      }
    }
    spec += `
          <ids:system>
            <ids:simpleValue>${escapeXml(system)}</ids:simpleValue>
          </ids:system>
        </ids:classification>`;
  });

  objForSpec.requirements.attributes.forEach((attr) => {
    if (!attr.isApplicability || attr.attribute === "PredefinedType") return;
    const instructionsAttr = attr.note ? ` instructions="${escapeXml(attr.note)}"` : "";
    spec += `
        <ids:attribute${instructionsAttr}>
          <ids:name>
            <ids:simpleValue>${escapeXml(attr.attribute)}</ids:simpleValue>
          </ids:name>`;
    const hasValue = attr.value || (attr.constraint === "ENUM" && attr.allowedValues?.length);
    if (hasValue) {
      const constraintXml = generateConstraintXml(attr.constraint, attr.value, "          ", attr.allowedValues);
      if (constraintXml) spec += `\n${constraintXml}`;
    }
    spec += `
        </ids:attribute>`;
  });
  objForSpec.requirements.properties.forEach((prop) => {
    if (!prop.isApplicability || !prop.psetName || prop.psetName.startsWith("_NEW_") || !prop.propertyName) return;
    const dataType = mapDataTypeToIds(prop.dataType);
    const dataTypeAttr = dataType ? ` dataType="${escapeXml(dataType)}"` : "";
    const instructionsAttr = prop.note ? ` instructions="${escapeXml(prop.note)}"` : "";
    spec += `
        <ids:property${dataTypeAttr}${instructionsAttr}>
          <ids:propertySet>
            <ids:simpleValue>${escapeXml(prop.psetName)}</ids:simpleValue>
          </ids:propertySet>
          <ids:baseName>
            <ids:simpleValue>${escapeXml(prop.propertyName)}</ids:simpleValue>
          </ids:baseName>`;
    const hasValue = prop.value || (prop.constraint === "ENUM" && prop.allowedValues?.length);
    if (hasValue) {
      const constraintXml = generateConstraintXml(prop.constraint, prop.value, "          ", prop.allowedValues);
      if (constraintXml) spec += `\n${constraintXml}`;
    }
    spec += `
        </ids:property>`;
  });
  objForSpec.requirements.relations.forEach((rel) => {
    if (!rel.isApplicability) return;
    const relationAttr = rel.relationType ? ` relation="${escapeXml(rel.relationType)}"` : "";
    const relatedEntityName = normalizeEntityName(rel.entityType || "IFCBUILDINGELEMENT");
    spec += `
        <ids:partOf${relationAttr}>
          <ids:entity>
            <ids:name>
              <ids:simpleValue>${escapeXml(relatedEntityName)}</ids:simpleValue>
            </ids:name>`;
    if (rel.entityPredefinedType) {
      spec += `
            <ids:predefinedType>
              <ids:simpleValue>${escapeXml(rel.entityPredefinedType.toUpperCase())}</ids:simpleValue>
            </ids:predefinedType>`;
    }
    spec += `
          </ids:entity>
        </ids:partOf>`;
  });
  objForSpec.requirements.materials.forEach((mat) => {
    if (!mat.isApplicability) return;
    const uriAttr = mat.uri ? ` uri="${escapeXml(mat.uri)}"` : "";
    const instructionsAttr = mat.note ? ` instructions="${escapeXml(mat.note)}"` : "";
    spec += `
        <ids:material${uriAttr}${instructionsAttr}>`;
    if (mat.value || (mat.category && mat.categoryMode !== "NONE")) {
      const val = mat.value || mat.category || "";
      const constraint = mat.constraint ?? "FILLED";
      const constraintXml = generateConstraintXml(constraint, val, "          ");
      if (constraintXml) spec += `\n${constraintXml}`;
    }
    spec += `
        </ids:material>`;
  });

  spec += `
      </ids:applicability>
      <ids:requirements>`;

  objForSpec.requirements.attributes.forEach((attr) => {
    if (attr.attribute === "PredefinedType" || attr.isApplicability) return;
    if (!matchesOccurrenceFilter(attr.occurrence, occurrenceFilter)) return;
    const cardinality: ConditionalCardinality = attr.occurrence === "prohibited" ? "prohibited" : attr.occurrence === "optional" ? "optional" : "required";
    const instructionsAttr = attr.note ? ` instructions="${escapeXml(attr.note)}"` : "";
    spec += `
        <ids:attribute cardinality="${cardinality}"${instructionsAttr}>
          <ids:name>
            <ids:simpleValue>${escapeXml(attr.attribute)}</ids:simpleValue>
          </ids:name>`;
    const hasValue = attr.value || (attr.constraint === "ENUM" && attr.allowedValues?.length);
    if (hasValue) {
      const constraintXml = generateConstraintXml(attr.constraint, attr.value, "          ", attr.allowedValues);
      if (constraintXml) spec += `\n${constraintXml}`;
    }
    spec += `
        </ids:attribute>`;
  });
  objForSpec.requirements.properties.forEach((prop) => {
    if (!prop.psetName || prop.psetName.startsWith("_NEW_") || !prop.propertyName || prop.isApplicability) return;
    if (!matchesOccurrenceFilter(prop.occurrence, occurrenceFilter)) return;
    const cardinality: ConditionalCardinality = prop.occurrence === "prohibited" ? "prohibited" : prop.occurrence === "optional" ? "optional" : "required";
    const dataType = mapDataTypeToIds(prop.dataType);
    const dataTypeAttr = dataType ? ` dataType="${escapeXml(dataType)}"` : "";
    const instructionsAttr = prop.note ? ` instructions="${escapeXml(prop.note)}"` : "";
    spec += `
        <ids:property cardinality="${cardinality}"${dataTypeAttr}${instructionsAttr}>
          <ids:propertySet>
            <ids:simpleValue>${escapeXml(prop.psetName)}</ids:simpleValue>
          </ids:propertySet>
          <ids:baseName>
            <ids:simpleValue>${escapeXml(prop.propertyName)}</ids:simpleValue>
          </ids:baseName>`;
    const hasValue = prop.value || (prop.constraint === "ENUM" && prop.allowedValues?.length);
    if (hasValue) {
      const constraintXml = generateConstraintXml(prop.constraint, prop.value, "          ", prop.allowedValues);
      if (constraintXml) spec += `\n${constraintXml}`;
    }
    spec += `
        </ids:property>`;
  });
  objForSpec.requirements.relations.forEach((rel) => {
    if (rel.isApplicability) return;
    if (!matchesOccurrenceFilter(rel.occurrence, occurrenceFilter)) return;
    const cardinality: SimpleCardinality = rel.occurrence === "prohibited" ? "prohibited" : "required";
    const relationAttr = rel.relationType ? ` relation="${escapeXml(rel.relationType)}"` : "";
    const relatedEntityName = normalizeEntityName(rel.entityType || "IFCBUILDINGELEMENT");
    spec += `
        <ids:partOf${relationAttr} cardinality="${cardinality}">
          <ids:entity>
            <ids:name>
              <ids:simpleValue>${escapeXml(relatedEntityName)}</ids:simpleValue>
            </ids:name>`;
    if (rel.entityPredefinedType) {
      spec += `
            <ids:predefinedType>
              <ids:simpleValue>${escapeXml(rel.entityPredefinedType.toUpperCase())}</ids:simpleValue>
            </ids:predefinedType>`;
    }
    spec += `
          </ids:entity>
        </ids:partOf>`;
  });
  requirementClassifications.forEach((cls) => {
    if (!matchesOccurrenceFilter(cls.occurrence ?? "required", occurrenceFilter)) return;
    const entryName = cls.systemEntryId ? classificationSystemEntries.find((e) => e.id === cls.systemEntryId)?.name : undefined;
    const system = entryName || cls.system || cls.name;
    if (!system) return;
    const cardinality: ConditionalCardinality = cls.occurrence === "prohibited" ? "prohibited" : cls.occurrence === "optional" ? "optional" : "required";
    const uriAttr = cls.uri ? ` uri="${escapeXml(cls.uri)}"` : "";
    const instructionsAttr = cls.note ? ` instructions="${escapeXml(cls.note)}"` : "";
    spec += `
        <ids:classification cardinality="${cardinality}"${uriAttr}${instructionsAttr}>`;
    if (cls.value) {
      const constraint = cls.constraint ?? "FILLED";
      if (constraint === "ENUM") {
        const values = cls.value.split("|").map((v) => v.trim()).filter(Boolean);
        spec += `
          <ids:value>
            <xs:restriction base="xs:string">`;
        values.forEach((v) => { spec += `
              <xs:enumeration value="${escapeXml(v)}" />`; });
        spec += `
            </xs:restriction>
          </ids:value>`;
      } else if (constraint === "PATTERN") {
        spec += `
          <ids:value>
            <xs:restriction base="xs:string">
              <xs:pattern value="${escapeXml(cls.value)}" />
            </xs:restriction>
          </ids:value>`;
      } else {
        spec += `
          <ids:value>
            <ids:simpleValue>${escapeXml(cls.value)}</ids:simpleValue>
          </ids:value>`;
      }
    }
    spec += `
          <ids:system>
            <ids:simpleValue>${escapeXml(system)}</ids:simpleValue>
          </ids:system>
        </ids:classification>`;
  });
  objForSpec.requirements.materials.forEach((mat) => {
    if (mat.isApplicability) return;
    if (!matchesOccurrenceFilter(mat.occurrence, occurrenceFilter)) return;
    const cardinality: ConditionalCardinality = mat.occurrence === "prohibited" ? "prohibited" : mat.occurrence === "optional" ? "optional" : "required";
    const uriAttr = mat.uri ? ` uri="${escapeXml(mat.uri)}"` : "";
    const instructionsAttr = mat.note ? ` instructions="${escapeXml(mat.note)}"` : "";
    spec += `
        <ids:material cardinality="${cardinality}"${uriAttr}${instructionsAttr}>`;
    const matVal = mat.value ?? (mat.category && mat.categoryMode !== "NONE" ? mat.category : "");
    const matConstraint = mat.value != null ? (mat.constraint ?? "FILLED") : (mat.categoryMode === "ENUM" ? "ENUM" : "FILLED");
    if (matVal) {
      const constraintXml = generateConstraintXml(matConstraint, matVal, "          ");
      if (constraintXml) spec += `\n${constraintXml}`;
    }
    spec += `
        </ids:material>`;
  });

  spec += `
      </ids:requirements>
    </ids:specification>`;
  return spec;
};

// Generate IDS XML from ProjectObject - compliant with IDS 1.0 XSD schema
// When occurrenceFilter is "all", creates separate specifications for required, prohibited, optional
const generateIdsXml = (
  obj: import("../../project/types").ProjectObject, 
  ifcVersion: IdsIfcVersion = "IFC4X3_ADD2", 
  phaseId: string | null = null, 
  classificationSystemEntries: import("../../project/types").ClassificationSystemEntry[] = [],
  occurrenceFilter: "all" | "required" | "prohibited" | "optional" = "all",
  phaseName?: string, 
  idsMetadata?: Partial<IdsMetadata>,
  useCaseId?: string | null
): string => {
  const filteredObj = filterObjectByPhase(obj, phaseId);
  const today = new Date().toISOString().split("T")[0];
  const infoTitle = idsMetadata?.title ?? "";
  const infoCopyright = idsMetadata?.copyright;
  const infoVersion = idsMetadata?.version ?? "";
  const infoDescription = idsMetadata?.description;
  const infoAuthor = idsMetadata?.author;
  const infoDate = idsMetadata?.date ?? today;
  const infoPurpose = idsMetadata?.purpose;
  const infoMilestone = idsMetadata?.milestone;
  const infoLines = [
    `    <ids:title>${escapeXml(infoTitle)}</ids:title>`,
    infoCopyright ? `    <ids:copyright>${escapeXml(infoCopyright)}</ids:copyright>` : "",
    `    <ids:version>${escapeXml(infoVersion)}</ids:version>`,
    infoDescription ? `    <ids:description>${escapeXml(infoDescription)}</ids:description>` : "",
    infoAuthor ? `    <ids:author>${escapeXml(infoAuthor)}</ids:author>` : "",
    `    <ids:date>${escapeXml(infoDate)}</ids:date>`,
    infoPurpose ? `    <ids:purpose>${escapeXml(infoPurpose)}</ids:purpose>` : "",
    infoMilestone ? `    <ids:milestone>${escapeXml(infoMilestone)}</ids:milestone>` : "",
  ].filter(Boolean);

  const occurrenceTypes: ("required" | "prohibited" | "optional")[] =
    occurrenceFilter === "all" ? ["required", "prohibited", "optional"] : [occurrenceFilter];

  const specifications: string[] = [];
  for (const occ of occurrenceTypes) {
    const spec = buildOneSpecificationXml(filteredObj, obj, phaseId, classificationSystemEntries, occ, ifcVersion, phaseName, useCaseId);
    if (spec) specifications.push(spec);
  }

  if (specifications.length === 0) {
    throw new Error("Žádné požadavky pro export");
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<ids:ids xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://standards.buildingsmart.org/IDS http://standards.buildingsmart.org/IDS/1.0/ids.xsd" xmlns:ids="http://standards.buildingsmart.org/IDS">
  <ids:info>
${infoLines.join("\n")}
  </ids:info>
  <ids:specifications>
${specifications.join("\n")}
  </ids:specifications>
</ids:ids>`;
};

/** Dialog pro export jednoho objektu do IDS – výběr fáze, výskytu a metadata */
const IdsSingleExportDialog: React.FC<{
  object: ProjectObject;
  phases: Phase[];
  entityPhaseIds?: string[];
  classificationSystemEntries: ClassificationSystemEntry[];
  project?: Project | null;
  selectedIfcVersion: "IFC2X3" | "IFC4" | "IFC4X3_ADD2";
  generateIdsXml: (
    obj: ProjectObject,
    ifcVersion: "IFC2X3" | "IFC4" | "IFC4X3_ADD2",
    phaseId: string | null,
    classificationSystemEntries: ClassificationSystemEntry[],
    occurrenceFilter: "all" | "required" | "prohibited" | "optional",
    phaseName?: string,
    idsMetadata?: Partial<IdsMetadata>
  ) => string;
  onClose: () => void;
}> = ({ object, phases, entityPhaseIds, classificationSystemEntries, project, selectedIfcVersion, generateIdsXml, onClose }) => {
  const phasesForExport = entityPhaseIds?.length ? phases.filter((p) => entityPhaseIds.includes(p.id)) : phases;
  const [exportPhaseId, setExportPhaseId] = useState<string>(() => phasesForExport[0]?.id ?? phases[0]?.id ?? "");
  const [exportOccurrence, setExportOccurrence] = useState<"all" | "required" | "prohibited" | "optional">("all");
  const [metadataExpanded, setMetadataExpanded] = useState(false);
  const [idsMetadata, setIdsMetadata] = useState<Partial<IdsMetadata>>(() => {
    const base = { ...project?.idsMetadata };
    if (project?.name && base.title === undefined) base.title = project.name;
    if (project?.author && base.author === undefined) base.author = project.author;
    if (project?.description && base.description === undefined) base.description = project.description;
    return base;
  });
  const [customExportFileName, setCustomExportFileName] = useState<string>("");

  const currentPhase = phases.find((p) => p.id === exportPhaseId);
  const phaseName = currentPhase ? `${currentPhase.code} - ${currentPhase.name}` : undefined;
  const specName = phaseName ? `${object.description || object.code} - ${phaseName}` : (object.description || object.code);
  const occurrenceLabel = exportOccurrence === "all" ? "Vše" : exportOccurrence === "required" ? "Požadované" : exportOccurrence === "prohibited" ? "Zakázané" : "Možné";

  const sanitize = (s: string) => (s || "").replace(/[^\p{L}\p{N}_\-]/gu, "_").replace(/_+/g, "_") || "export";

  const isAuthorValid = (v: string) => (v.trim().length > 0 && /@[^@]*\.[^@]+/.test(v.trim()));
  const effectiveAuthor = idsMetadata.author ?? project?.author ?? "";
  const objectNameForFile = (object.code || object.description || "").replace(/::/g, ".");
  const generatedFileName = [
    sanitize(project?.name ?? "Projekt"),
    sanitize(objectNameForFile),
    currentPhase?.code ? sanitize(currentPhase.code) : "",
    occurrenceLabel,
  ].filter(Boolean).join("_");

  const handleExport = () => {
    try {
      const metaWithMilestone: Partial<IdsMetadata> = {
        ...idsMetadata,
        milestone: idsMetadata.milestone ?? currentPhase?.code,
      };
      const xml = generateIdsXml(
        object,
        selectedIfcVersion,
        exportPhaseId || null,
        classificationSystemEntries,
        exportOccurrence,
        phaseName,
        metaWithMilestone
      );
      const blob = new Blob([xml], { type: "application/xml" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const fileName = (customExportFileName.trim() || generatedFileName).replace(/\.ids$/i, "");
      a.download = `${fileName}.ids`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      onClose();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Export se nezdařil");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex-shrink-0 border-b border-slate-200 px-5 py-4">
          <h3 className="text-lg font-semibold text-slate-800">Export IDS</h3>
          <p className="text-sm text-slate-500">Vyberte fázi a výskyt. Metadata se doplní z údajů projektu (levý horní roh), milník z vybrané fáze.</p>
        </div>
        <div className="flex-1 overflow-auto px-5 py-4 space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">Fáze</label>
            <select
              value={exportPhaseId}
              onChange={(e) => setExportPhaseId(e.target.value)}
              className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
              disabled={phasesForExport.length === 0}
            >
              {phasesForExport.length === 0 ? (
                <option value="">Žádné fáze</option>
              ) : (
                phasesForExport.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} - {p.name}
                  </option>
                ))
              )}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">Výskyt</label>
            <div className="flex gap-2 flex-wrap">
              {(["all", "required", "prohibited", "optional"] as const).map((occ) => (
                <button
                  key={occ}
                  type="button"
                  className={`px-3 py-1.5 text-xs font-medium rounded ${
                    exportOccurrence === occ
                      ? occ === "all"
                        ? "bg-slate-700 text-white"
                        : occ === "required"
                          ? "bg-green-600 text-white"
                          : occ === "prohibited"
                            ? "bg-red-600 text-white"
                            : "bg-amber-600 text-white"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                  onClick={() => setExportOccurrence(occ)}
                >
                  {occ === "all" ? "Vše" : occ === "required" ? "Požadované" : occ === "prohibited" ? "Zakázané" : "Možné"}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">Název exportovaného souboru</label>
            <input
              type="text"
              value={customExportFileName || generatedFileName}
              onChange={(e) => setCustomExportFileName(e.target.value)}
              placeholder={generatedFileName}
              className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
              title="Přípona .ids se doplní automaticky"
            />
            <p className="mt-0.5 text-xs text-slate-500">Formát: Název projektu_Název objektu_Kód fáze_Výskyt</p>
          </div>
          <div>
            <button
              type="button"
              className="flex items-center gap-2 text-sm font-medium text-slate-700 hover:text-red-600"
              onClick={() => setMetadataExpanded((v) => !v)}
            >
              <span className={metadataExpanded ? "rotate-90" : ""}>▶</span>
              Metadata souboru IDS
            </button>
            {metadataExpanded && (
              <div className="mt-3 grid gap-3 text-sm">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-0.5">Název (title)</label>
                  <input
                    type="text"
                    value={idsMetadata.title ?? project?.name ?? ""}
                    onChange={(e) => setIdsMetadata((m) => ({ ...m, title: e.target.value || undefined }))}
                    placeholder={project?.name ?? specName}
                    className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-0.5">Copyright</label>
                  <input
                    type="text"
                    value={idsMetadata.copyright ?? ""}
                    onChange={(e) => setIdsMetadata((m) => ({ ...m, copyright: e.target.value || undefined }))}
                    className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-0.5">Verze (version)</label>
                  <input
                    type="text"
                    value={idsMetadata.version ?? "1.0"}
                    onChange={(e) => setIdsMetadata((m) => ({ ...m, version: e.target.value || undefined }))}
                    className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-0.5">Autor (author, e-mail) <span className="text-red-500">*</span></label>
                  <input
                    type="email"
                    value={idsMetadata.author ?? project?.author ?? ""}
                    onChange={(e) => setIdsMetadata((m) => ({ ...m, author: e.target.value || undefined }))}
                    placeholder="email@example.com"
                    className={`w-full rounded border px-2 py-1 text-sm ${effectiveAuthor && !isAuthorValid(effectiveAuthor) ? "border-red-400" : "border-slate-300"}`}
                    title="Z údajů projektu (levý horní roh). Musí být e-mail (např. jmeno@domena.cz)"
                  />
                  {effectiveAuthor && !isAuthorValid(effectiveAuthor) && (
                    <p className="text-[10px] text-red-600 mt-0.5">Autor musí být e-mail (např. jmeno@domena.cz)</p>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-0.5">Datum (date)</label>
                  <input
                    type="date"
                    value={idsMetadata.date ?? new Date().toISOString().split("T")[0]}
                    onChange={(e) => setIdsMetadata((m) => ({ ...m, date: e.target.value || undefined }))}
                    className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-0.5">Účel (purpose)</label>
                  <input
                    type="text"
                    value={idsMetadata.purpose ?? ""}
                    onChange={(e) => setIdsMetadata((m) => ({ ...m, purpose: e.target.value || undefined }))}
                    placeholder="quantity take off, clash detection..."
                    className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-0.5">Popis (description)</label>
                  <textarea
                    value={idsMetadata.description ?? project?.description ?? ""}
                    onChange={(e) => setIdsMetadata((m) => ({ ...m, description: e.target.value || undefined }))}
                    className="w-full rounded border border-slate-300 px-2 py-1 text-sm min-h-[60px]"
                    rows={2}
                    title="Z údajů projektu (levý horní roh)"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-0.5">Milník (milestone)</label>
                  <input
                    type="text"
                    value={idsMetadata.milestone ?? currentPhase?.code ?? ""}
                    onChange={(e) => setIdsMetadata((m) => ({ ...m, milestone: e.target.value || undefined }))}
                    placeholder={currentPhase?.code ?? "Schematic Design, Construction..."}
                    className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                    title="Automaticky z vybrané fáze, lze přepsat"
                  />
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="flex-shrink-0 flex justify-end gap-2 border-t border-slate-200 px-5 py-4">
          <button
            type="button"
            className="rounded border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            onClick={onClose}
          >
            Zrušit
          </button>
          <button
            type="button"
            className="rounded bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleExport}
            disabled={phasesForExport.length === 0 || !isAuthorValid(effectiveAuthor)}
          >
            Exportovat .ids
          </button>
        </div>
      </div>
    </div>
  );
};

export const ObjectDetail: React.FC<Props> = ({
  node,
  object,
  schema,
  onChange,
  phases,
  codeLists,
  classificationSystemEntries,
  project,
  onFocusIdsSpecification,
  onFocusRequirementGroup,
  focusedIdsSpecificationId,
  onSaveIdsSpecification,
  onDuplicateIdsSpecification,
  onDeleteIdsSpecification,
  onConvertProjectGroupToIds,
  onAssignIdsGroup,
  onSaveEnumAsCodeList,
  onAddToIfcHierarchy,
  onCopyObject,
  onDeleteObject,
  onToggleLock,
  onDuplicatePropertyGroupsToObjects,
  onDuplicateAttributesToObjects,
  onDuplicateClassificationsToObjects,
  onDuplicateMaterialsToObjects,
  onDuplicateRelationsToObjects,
  onUpdateRequirementItemGroup,
  onAssignGroupToObjects,
  onMoveGroupToKind,
}) => {
  const isLocked = object.locked === true;
  const { deprecatedEntities, deprecatedPredefinedByEnum, deprecatedPredefinedNotesByEnum } = useSchema();
  /** Zvýraznění červeně: zkopírovaný objekt má stále stejnou entitu a predefinedType jako zdroj */
  const isIncompleteCopy = useMemo(() => {
    if (!object.copiedFrom || !project?.objects[object.copiedFrom]) return false;
    const src = project.objects[object.copiedFrom];
    const srcPt = src.predefinedType?.mode === "ENUM" || src.predefinedType?.mode === "USERDEFINED" ? src.predefinedType?.value : undefined;
    const objPt = object.predefinedType?.mode === "ENUM" || object.predefinedType?.mode === "USERDEFINED" ? object.predefinedType?.value : undefined;
    return object.ifcEntity === src.ifcEntity && objPt === srcPt;
  }, [object.copiedFrom, object.ifcEntity, object.predefinedType, project?.objects]);
  const [activeTab, setActiveTab] = useState<TabKey>("properties");
  const [idsSubTab, setIdsSubTab] = useState<IdsSubTabKey>("readable");
  const [isExportIdsDialogOpen, setIsExportIdsDialogOpen] = useState(false);
  const [selectedUseCaseId, setSelectedUseCaseId] = useState<string | null>(null); // null = "Vše"
  const [selectedPhaseId, setSelectedPhaseId] = useState<string | null>(null); // null = "Vše"
  const [occurrenceFilter, setOccurrenceFilter] = useState<OccurrenceFilter>("all");
  const ifcSchemaVersion = normalizeIfcSchemaVersion(project?.ifcSchemaVersion);
  const selectedIfcVersion: IdsIfcVersion = getIdsIfcVersion(ifcSchemaVersion);
  const [enumDraftByPropId, setEnumDraftByPropId] = useState<Record<string, string>>({});
  const [enumSaveDialog, setEnumSaveDialog] = useState<null | { propertyId: string; name: string; values: string[]; type?: "property" | "attribute" }>(null);
  const [unitModeByPropId, setUnitModeByPropId] = useState<Record<string, string>>({});
  const [enumDraftByAttrId, setEnumDraftByAttrId] = useState<Record<string, string>>({});
  const [enumDraftByMatId, setEnumDraftByMatId] = useState<Record<string, string>>({});
  const [showRelationHelpModal, setShowRelationHelpModal] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(object.description ?? node.description ?? node.code);
  /** Počet prázdných slotů pro třídění autorských nástrojů (přidáno přes +) – klíč = systemEntryId */
  const [extraAuthoringSlots, setExtraAuthoringSlots] = useState<Record<string, number>>({});
  const [predefinedTypeDropdownOpen, setPredefinedTypeDropdownOpen] = useState(false);
  const predefinedTypeButtonRef = useRef<HTMLButtonElement>(null);
  const predefinedTypeContainerRef = useRef<HTMLDivElement>(null);
  const [predefinedTypePanelAnchor, setPredefinedTypePanelAnchor] = useState<{ top: number; left: number; width: number } | null>(null);

  const [requirementsViewMode, setRequirementsViewMode] = useState<"object" | "specifications" | "groups">(() => {
    try {
      const stored = localStorage.getItem("infoReqApp_requirementsViewMode");
      if (stored === "groups" || stored === "object" || stored === "specifications") return stored;
    } catch {
      /* ignore */
    }
    return "object";
  });
  const editIdsRequestSequenceRef = useRef(0);
  const [editIdsRequest, setEditIdsRequest] = useState<IdsSpecificationEditRequest | null>(null);
  const selectedPredefinedType = object.predefinedType.mode === "ENUM"
    ? object.predefinedType.value
    : undefined;
  const entityIdsSpecifications = useMemo(
    () => getSpecificationsForEntity(project, object.ifcEntity, selectedPredefinedType),
    [project, object.ifcEntity, selectedPredefinedType],
  );
  const idsSpecificationOrdinalById = useMemo(
    () => buildIdsSpecificationOrdinalIndex(project?.idsSpecifications ?? []),
    [project?.idsSpecifications],
  );
  const openIdsSpecificationEditor = useCallback(
    (specification: IdsProjectSpecification, facetId?: string) => {
      editIdsRequestSequenceRef.current += 1;
      setEditIdsRequest({
        specificationId: specification.id,
        facetId,
        requestId: editIdsRequestSequenceRef.current,
      });
      setRequirementsViewMode("specifications");
      onFocusIdsSpecification?.(specification);
    },
    [onFocusIdsSpecification],
  );
  const renderIdsEditAction = (requirement: RequirementBase) => {
    const specificationId = getIdsProjectedSpecificationId(requirement);
    if (!specificationId) return null;
    const specification = project?.idsSpecifications?.find(
      (item) => item.id === specificationId,
    );
    if (!specification) return null;
    const ordinal = idsSpecificationOrdinalById.get(specificationId);
    const openEditor = () => openIdsSpecificationEditor(
      specification,
      getIdsProjectedFacetId(requirement),
    );
    return (
      <a
        role="button"
        tabIndex={0}
        className="pointer-events-auto rounded border border-violet-300 bg-white px-2 py-1 text-[10px] font-semibold text-violet-800 hover:bg-violet-100"
        onClick={openEditor}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          openEditor();
        }}
      >
        Upravit IDS{ordinal ? ` #${ordinal}` : ""}
      </a>
    );
  };
  const projectIdsDefinitionCount = hasProjectObjectIdsDefinition(project, object) ? 1 : 0;
  const [selectedItemGroup, setSelectedItemGroup] = useState<{ kind: RequirementItemKind; fingerprint: string } | null>(null);
  /** Stabilní identifikátor vybrané skupiny (kind + id reprezentativního požadavku), aby po uložení změn (změna fingerprintu) zůstal záznam otevřený. */
  const selectedGroupStableRef = useRef<{ kind: RequirementItemKind; representativeId: string } | null>(null);

  const selectedItemGroupData = useMemo<RequirementItemGroup | null>(() => {
    if (!project || !selectedItemGroup) return null;
    const groups = groupRequirementsByItem(project);
    return groups.find((g) => g.fingerprint === selectedItemGroup.fingerprint && g.kind === selectedItemGroup.kind) ?? null;
  }, [project, selectedItemGroup]);

  const predefinedEnumType = useMemo(() => {
    if (!schema || !object.ifcEntity) return null;
    const ent = schema.entities[object.ifcEntity];
    if (!ent) return null;
    const attr = ent.attributes.find((a) => a.name === "PredefinedType");
    if (!attr?.dataType || !attr.dataType.endsWith("Enum")) return null;
    return attr.dataType;
  }, [schema, object.ifcEntity]);

  const isCurrentPredefinedDeprecated = useMemo(() => {
    if (!predefinedEnumType) return false;
    const set = deprecatedPredefinedByEnum[predefinedEnumType];
    if (!set) return false;
    const mode = object.predefinedType.mode;
    const rawVal =
      mode === "ENUM" || mode === "USERDEFINED"
        ? object.predefinedType.value?.trim().toUpperCase()
        : undefined;
    if (!rawVal) return false;
    return set.has(rawVal);
  }, [deprecatedPredefinedByEnum, object.predefinedType.mode, object.predefinedType.value, predefinedEnumType]);

  const currentDeprecatedPredefinedNote = useMemo(() => {
    if (!predefinedEnumType || !isCurrentPredefinedDeprecated) return null;
    const rawVal =
      object.predefinedType.mode === "ENUM" || object.predefinedType.mode === "USERDEFINED"
        ? object.predefinedType.value?.trim().toUpperCase()
        : undefined;
    if (!rawVal) return null;
    const note = deprecatedPredefinedNotesByEnum[predefinedEnumType]?.[rawVal];
    return note ? translateDeprecatedNote(note) : null;
  }, [deprecatedPredefinedNotesByEnum, isCurrentPredefinedDeprecated, object.predefinedType.mode, object.predefinedType.value, predefinedEnumType]);

  // Při vybrané skupině uložit stabilní klíč (id reprezentativního požadavku); při zrušení výběru smazat.
  useEffect(() => {
    if (selectedItemGroupData && selectedItemGroup) {
      const items = selectedItemGroupData.representativeItems;
      const representativeId =
        selectedItemGroupData.kind === "pset"
          ? (items as import("../../project/types").PropertyRequirement[])[0]?.id
          : (items as [import("../../project/types").AttributeRequirement | import("../../project/types").ClassificationRequirement | import("../../project/types").MaterialRequirement | import("../../project/types").RelationRequirement])[0]?.id;
      selectedGroupStableRef.current = representativeId ? { kind: selectedItemGroupData.kind, representativeId } : null;
    } else if (!selectedItemGroup) {
      selectedGroupStableRef.current = null;
    }
  }, [selectedItemGroupData, selectedItemGroup]);

  // Po uložení změn se fingerprint skupiny změní – znovu vybrat stejnou skupinu podle stabilního id požadavku, aby záznam zůstal otevřený.
  useEffect(() => {
    if (!project || requirementsViewMode !== "groups" || !selectedItemGroup || selectedItemGroupData !== null) return;
    const stable = selectedGroupStableRef.current;
    if (!stable) return;
    const groups = groupRequirementsByItem(project);
    const found = groups.find((g) => {
      if (g.kind !== stable.kind) return false;
      const items = g.representativeItems;
      if (g.kind === "pset") {
        return (items as import("../../project/types").PropertyRequirement[]).some((p) => p.id === stable.representativeId);
      }
      const first = (items as [import("../../project/types").AttributeRequirement | import("../../project/types").ClassificationRequirement | import("../../project/types").MaterialRequirement | import("../../project/types").RelationRequirement])[0];
      return first?.id === stable.representativeId;
    });
    if (found) {
      setSelectedItemGroup({ kind: found.kind, fingerprint: found.fingerprint });
    }
  }, [project, requirementsViewMode, selectedItemGroup, selectedItemGroupData]);

  const updatePredefinedTypePanelAnchor = useCallback(() => {
    const el = predefinedTypeButtonRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPredefinedTypePanelAnchor({
      top: rect.bottom + 4,
      left: rect.left,
      width: Math.max(rect.width, 180),
    });
  }, []);
  useEffect(() => {
    if (!predefinedTypeDropdownOpen) {
      setPredefinedTypePanelAnchor(null);
      return;
    }
    updatePredefinedTypePanelAnchor();
    const onScrollOrResize = () => updatePredefinedTypePanelAnchor();
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [predefinedTypeDropdownOpen, updatePredefinedTypePanelAnchor]);
  useEffect(() => {
    if (!predefinedTypeDropdownOpen) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        predefinedTypeContainerRef.current?.contains(target) ||
        (e.target as Element).closest?.("[data-predefined-type-dropdown-panel]")
      ) return;
      setPredefinedTypeDropdownOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPredefinedTypeDropdownOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [predefinedTypeDropdownOpen]);

  useEffect(() => {
    if (isEditingTitle) return;
    setTitleDraft(object.description ?? node.description ?? node.code);
  }, [isEditingTitle, object.code, object.description, node.code, node.description]);

  const submitTitleChange = useCallback(() => {
    if (isLocked) return;
    const trimmed = titleDraft.trim();
    if (!trimmed || trimmed === object.description) {
      setIsEditingTitle(false);
      setTitleDraft(object.description ?? node.description ?? node.code);
      return;
    }
    onChange({ ...object, description: trimmed });
    setIsEditingTitle(false);
  }, [isLocked, node.code, node.description, object, onChange, titleDraft]);

  const effectiveRequirements: ObjectRequirements = useMemo(() => {
    if (requirementsViewMode === "object") {
      const predefinedType =
        (object.predefinedType.mode === "ENUM" || object.predefinedType.mode === "USERDEFINED") &&
        object.predefinedType.value &&
        object.predefinedType.value !== "NOTDEFINED"
          ? object.predefinedType.value
          : undefined;
      const projected = projectIdsRequirementsForEntity(
        project,
        object.ifcEntity,
        predefinedType,
        schema,
      );
      return {
        attributes: [...object.requirements.attributes, ...projected.attributes],
        properties: [...object.requirements.properties, ...projected.properties],
        relations: [...object.requirements.relations, ...projected.relations],
        classifications: [...object.requirements.classifications, ...projected.classifications],
        materials: [...object.requirements.materials, ...projected.materials],
      };
    }
    if (requirementsViewMode !== "groups" || !selectedItemGroupData) return object.requirements;
    const empty: ObjectRequirements = { attributes: [], properties: [], relations: [], classifications: [], materials: [] };
    const items = selectedItemGroupData.representativeItems;
    switch (selectedItemGroupData.kind) {
      case "pset":
        return { ...empty, properties: items as import("../../project/types").PropertyRequirement[] };
      case "attribute":
        return { ...empty, attributes: items as import("../../project/types").AttributeRequirement[] };
      case "classification":
        return { ...empty, classifications: items as import("../../project/types").ClassificationRequirement[] };
      case "material":
        return { ...empty, materials: items as import("../../project/types").MaterialRequirement[] };
      case "relation":
        return { ...empty, relations: items as import("../../project/types").RelationRequirement[] };
      default:
        return object.requirements;
    }
  }, [
    requirementsViewMode,
    selectedItemGroupData,
    object.requirements,
    object.ifcEntity,
    object.predefinedType.mode,
    object.predefinedType.value,
    project,
    schema,
  ]);
  const idsProjectedRequirementCount = useMemo(
    () =>
      [
        ...effectiveRequirements.attributes,
        ...effectiveRequirements.properties,
        ...effectiveRequirements.relations,
        ...effectiveRequirements.classifications,
        ...effectiveRequirements.materials,
      ].filter(isIdsProjectedRequirement).length,
    [effectiveRequirements],
  );

  // Při rozbalení skupiny v režimu „všechny požadavky“ nastavit kartu na první s obsahem (vlastnosti → atributy → …).
  useEffect(() => {
    if (requirementsViewMode !== "groups" || !selectedItemGroup) return;
    const kindToTab: Record<RequirementItemKind, TabKey> = {
      pset: "properties",
      attribute: "attributes",
      classification: "classification",
      material: "material",
      relation: "partOf",
    };
    setActiveTab(kindToTab[selectedItemGroup.kind]);
  }, [requirementsViewMode, selectedItemGroup?.fingerprint]);

  const selectedEntity = object.ifcEntity ? schema?.entities[object.ifcEntity] : undefined;
  const selectedPredefinedValue =
    object.predefinedType.mode === "ENUM" || object.predefinedType.mode === "USERDEFINED"
      ? object.predefinedType.value ?? ""
      : undefined;
  const predefinedOptions = useMemo(() => {
    const values = selectedEntity?.predefinedTypeValues ?? [];
    const withNotDefined = values.length ? ["NOTDEFINED", ...values] : [];
    const ensureUserDefined = withNotDefined.includes("USERDEFINED") ? withNotDefined : [...withNotDefined, "USERDEFINED"];
    return ensureUserDefined.length ? ensureUserDefined : ["NOTDEFINED", "USERDEFINED"];
  }, [selectedEntity]);

  // Třídění dle IFC entit (isIfcSystem) se v sekci Klasifikace nezobrazuje – entita a typ jsou v Identifikačních údajích
  const primaryEntry = useMemo(
    () => classificationSystemEntries.find((e) => e.isPrimary),
    [classificationSystemEntries],
  );
  const isIfcPrimary = primaryEntry?.isIfcSystem === true;
  const classificationsWithoutIfc = useMemo(
    () =>
      effectiveRequirements.classifications.filter((cls) => {
        const entry = classificationSystemEntries.find((e) => e.id === cls.systemEntryId);
        return !entry?.isIfcSystem;
      }),
    [effectiveRequirements.classifications, classificationSystemEntries],
  );
  /** Pouze systémy typu „Klasifikační systém“ – zobrazují se v požadavcích na klasifikaci (ne IFC, ne autorský nástroj). */
  const classificationSystemEntriesForRequirements = useMemo(() => {
    return classificationSystemEntries.filter((e) => {
      const kind = e.systemKind ?? (e.isIfcSystem ? "ifc" : "classification");
      return kind === "classification";
    });
  }, [classificationSystemEntries]);

  /** Kódy listů v IFC hierarchii (entita nebo entity::predefinedType) – pro kontrolu, zda je výběr v hierarchii */
  const ifcHierarchyCodes = useMemo(() => {
    if (!primaryEntry?.isIfcSystem || !primaryEntry.nodes) return new Set<string>();
    return new Set(collectLeaves(primaryEntry.nodes).map((n) => n.code));
  }, [primaryEntry]);

  /** Je vybraný objekt už v IFC hierarchii? Kontrola podle object.code (stejný klíč jako ve stromu). */
  const isCurrentSelectionInHierarchy = useMemo(
    () => !!object.code && ifcHierarchyCodes.has(object.code),
    [object.code, ifcHierarchyCodes],
  );

  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [customGroupNames, setCustomGroupNames] = useState<Record<string, string>>({});
  const [customGroupErrors, setCustomGroupErrors] = useState<Record<string, string>>({});
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [selectedProperties, setSelectedProperties] = useState<Set<string>>(new Set());
  const [selectedAttributes, setSelectedAttributes] = useState<Set<string>>(new Set());
  const [selectedRelations, setSelectedRelations] = useState<Set<string>>(new Set());
  const [selectedMaterials, setSelectedMaterials] = useState<Set<string>>(new Set());
  const [selectedClassifications, setSelectedClassifications] = useState<Set<string>>(new Set());
  /** Klíč skupiny, pro kterou se právě načítají popisy z bSDD (zobrazí se loading na tlačítku) */
  const [fillingDescriptionsGroupKey, setFillingDescriptionsGroupKey] = useState<string | null>(null);
  /** Dialog pro úpravu řádku vlastnosti (tužka) – zobrazí celý Popis, Poznámka, Příklady */
  const [propertyRowEditDialog, setPropertyRowEditDialog] = useState<{ prop: PropertyRequirement; groupKey: string } | null>(null);
  /** Dialog pro duplikaci skupin vlastností do jiných objektů */
  const [duplicatePropertyGroupsDialogOpen, setDuplicatePropertyGroupsDialogOpen] = useState(false);
  /** Typ dialogu pro duplikaci požadavků do jiných objektů (atributy, klasifikace, materiál, součásti) */
  const [duplicateToObjectsDialogType, setDuplicateToObjectsDialogType] = useState<"attributes" | "classification" | "material" | "partOf" | null>(null);
  /** Šířky sloupců tabulek (index → px) */
  const [propertyTableColWidths, setPropertyTableColWidths] = useState<Record<number, number>>(() => {
    try {
      const s = localStorage.getItem("infoReqApp_propertyTableColWidths");
      return s ? JSON.parse(s) : {};
    } catch { return {}; }
  });
  const [attributeTableColWidths, setAttributeTableColWidths] = useState<Record<number, number>>(() => {
    try {
      const s = localStorage.getItem("infoReqApp_attributeTableColWidths");
      return s ? JSON.parse(s) : {};
    } catch { return {}; }
  });
  const [partOfTableColWidths, setPartOfTableColWidths] = useState<Record<number, number>>(() => {
    try {
      const s = localStorage.getItem("infoReqApp_partOfTableColWidths");
      return s ? JSON.parse(s) : {};
    } catch { return {}; }
  });
  const [materialTableColWidths, setMaterialTableColWidths] = useState<Record<number, number>>(() => {
    try {
      const s = localStorage.getItem("infoReqApp_materialTableColWidths");
      return s ? JSON.parse(s) : {};
    } catch { return {}; }
  });
  const [classificationTableColWidths, setClassificationTableColWidths] = useState<Record<number, number>>(() => {
    try {
      const s = localStorage.getItem("infoReqApp_classificationTableColWidths");
      return s ? JSON.parse(s) : {};
    } catch { return {}; }
  });
  /** Skryté sloupce tabulky vlastností (index) – perspektivně v localStorage */
  const [hiddenPropertyColumns, setHiddenPropertyColumns] = useState<Set<number>>(() => {
    try {
      const stored = localStorage.getItem("infoReqApp_hiddenPropertyColumns");
      if (stored) {
        const arr = JSON.parse(stored) as number[];
        return new Set(arr.filter((i) => typeof i === "number" && i >= 0 && i <= 11));
      }
    } catch {
      /* ignore */
    }
    return new Set();
  });
  const [propertyColumnMenuOpen, setPropertyColumnMenuOpen] = useState(false);
  /** Skryté sloupce pro Atributy, Součásti, Materiál, Klasifikace */
  const [hiddenAttributeColumns, setHiddenAttributeColumns] = useState<Set<number>>(() =>
    loadHiddenColumns("infoReqApp_hiddenAttributeColumns", 13)
  );
  const [hiddenPartOfColumns, setHiddenPartOfColumns] = useState<Set<number>>(() =>
    loadHiddenColumns("infoReqApp_hiddenPartOfColumns", 12)
  );
  const [hiddenMaterialColumns, setHiddenMaterialColumns] = useState<Set<number>>(() =>
    loadHiddenColumns("infoReqApp_hiddenMaterialColumns", 11)
  );
  const [hiddenClassificationColumns, setHiddenClassificationColumns] = useState<Set<number>>(() =>
    loadHiddenColumns("infoReqApp_hiddenClassificationColumns", 12)
  );
  const [attributeColumnMenuOpen, setAttributeColumnMenuOpen] = useState(false);
  const [partOfColumnMenuOpen, setPartOfColumnMenuOpen] = useState(false);
  const [materialColumnMenuOpen, setMaterialColumnMenuOpen] = useState(false);
  const [classificationColumnMenuOpen, setClassificationColumnMenuOpen] = useState(false);
  const { showCzTranslations, czTranslationSource } = useTranslation();
  /** Kontext roztahování: tabulka + index sloupce */
  const [resizingContext, setResizingContext] = useState<{ table: "attribute" | "partOf" | "material" | "classification" | "property"; col: number } | null>(null);
  const resizingStartX = useRef(0);
  const resizingStartW = useRef(0);

  /** Viditelnost a pořadí sekcí: Popis/poznámky/příklady, Identifikační údaje, Požadavky */
  type SectionKey = "popis" | "identifikacni" | "pozadavky";
  const SECTION_LABELS: Record<SectionKey, string> = {
    popis: "Popis, poznámka, příklady",
    identifikacni: "Identifikační údaje",
    pozadavky: "Požadavky",
  };
  const [sectionVisibility, setSectionVisibility] = useState<Record<SectionKey, boolean>>(() => {
    try {
      const s = localStorage.getItem("infoReqApp_sectionVisibility");
      if (s) {
        const parsed = JSON.parse(s) as Record<string, boolean>;
        return {
          popis: parsed.popis ?? true,
          identifikacni: parsed.identifikacni ?? true,
          pozadavky: parsed.pozadavky ?? true,
        };
      }
    } catch { /* ignore */ }
    return { popis: true, identifikacni: true, pozadavky: true };
  });
  const [sectionOrder, setSectionOrder] = useState<SectionKey[]>(() => {
    try {
      const s = localStorage.getItem("infoReqApp_sectionOrder");
      if (s) {
        const parsed = JSON.parse(s) as string[];
        const valid = parsed.filter((k): k is SectionKey => ["popis", "identifikacni", "pozadavky"].includes(k));
        if (valid.length === 3) return valid;
      }
    } catch { /* ignore */ }
    return ["popis", "identifikacni", "pozadavky"];
  });

  const toggleSectionVisibility = useCallback((key: SectionKey) => {
    setSectionVisibility((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      localStorage.setItem("infoReqApp_sectionVisibility", JSON.stringify(next));
      return next;
    });
  }, []);

  const moveSection = useCallback((key: SectionKey, direction: "up" | "down") => {
    setSectionOrder((prev) => {
      const idx = prev.indexOf(key);
      if (idx < 0) return prev;
      const newIdx = direction === "up" ? idx - 1 : idx + 1;
      if (newIdx < 0 || newIdx >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
      localStorage.setItem("infoReqApp_sectionOrder", JSON.stringify(next));
      return next;
    });
  }, []);

  // Ref pro uložení aktuálních hodnot selectedGroups a selectedProperties pro mazání
  const selectedGroupsRef = useRef<Set<string>>(new Set());
  const selectedPropertiesRef = useRef<Set<string>>(new Set());
  
  // Synchronizovat ref s state
  useEffect(() => {
    selectedGroupsRef.current = selectedGroups;
  }, [selectedGroups]);
  
  useEffect(() => {
    selectedPropertiesRef.current = selectedProperties;
  }, [selectedProperties]);

  useEffect(() => {
    const clearSelections = () => {
      setSelectedGroups(new Set());
      setSelectedProperties(new Set());
      setSelectedAttributes(new Set());
      setSelectedRelations(new Set());
      setSelectedMaterials(new Set());
      setSelectedClassifications(new Set());
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const hasSelection =
        selectedGroupsRef.current.size > 0 ||
        selectedPropertiesRef.current.size > 0 ||
        selectedAttributes.size > 0 ||
        selectedRelations.size > 0 ||
        selectedMaterials.size > 0 ||
        selectedClassifications.size > 0;
      if (!hasSelection) return;
      e.preventDefault();
      clearSelections();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedAttributes, selectedRelations, selectedMaterials, selectedClassifications]);

  // Persistovat skryté sloupce do localStorage
  useEffect(() => {
    saveHiddenColumns("infoReqApp_hiddenPropertyColumns", hiddenPropertyColumns);
  }, [hiddenPropertyColumns]);
  useEffect(() => {
    saveHiddenColumns("infoReqApp_hiddenAttributeColumns", hiddenAttributeColumns);
  }, [hiddenAttributeColumns]);
  useEffect(() => {
    saveHiddenColumns("infoReqApp_hiddenPartOfColumns", hiddenPartOfColumns);
  }, [hiddenPartOfColumns]);
  useEffect(() => {
    saveHiddenColumns("infoReqApp_hiddenMaterialColumns", hiddenMaterialColumns);
  }, [hiddenMaterialColumns]);
  useEffect(() => {
    saveHiddenColumns("infoReqApp_hiddenClassificationColumns", hiddenClassificationColumns);
  }, [hiddenClassificationColumns]);

  // Roztahování sloupců všech tabulek
  useEffect(() => {
    if (resizingContext === null) return;
    const { table, col } = resizingContext;
    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (e: MouseEvent) => {
      const delta = e.clientX - resizingStartX.current;
      const newW = Math.max(40, resizingStartW.current + delta);
      if (table === "property") setPropertyTableColWidths((prev) => ({ ...prev, [col]: newW }));
      else if (table === "attribute") setAttributeTableColWidths((prev) => ({ ...prev, [col]: newW }));
      else if (table === "partOf") setPartOfTableColWidths((prev) => ({ ...prev, [col]: newW }));
      else if (table === "material") setMaterialTableColWidths((prev) => ({ ...prev, [col]: newW }));
      else if (table === "classification") setClassificationTableColWidths((prev) => ({ ...prev, [col]: newW }));
    };
    const onUp = () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
      setResizingContext(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [resizingContext]);

  // Persistovat šířky sloupců při změně (pro property už máme v onUp, pro ostatní ukládáme zde)
  useEffect(() => {
    if (Object.keys(propertyTableColWidths).length > 0) localStorage.setItem("infoReqApp_propertyTableColWidths", JSON.stringify(propertyTableColWidths));
  }, [propertyTableColWidths]);
  useEffect(() => {
    if (Object.keys(attributeTableColWidths).length > 0) localStorage.setItem("infoReqApp_attributeTableColWidths", JSON.stringify(attributeTableColWidths));
  }, [attributeTableColWidths]);
  useEffect(() => {
    if (Object.keys(partOfTableColWidths).length > 0) localStorage.setItem("infoReqApp_partOfTableColWidths", JSON.stringify(partOfTableColWidths));
  }, [partOfTableColWidths]);
  useEffect(() => {
    if (Object.keys(materialTableColWidths).length > 0) localStorage.setItem("infoReqApp_materialTableColWidths", JSON.stringify(materialTableColWidths));
  }, [materialTableColWidths]);
  useEffect(() => {
    if (Object.keys(classificationTableColWidths).length > 0) localStorage.setItem("infoReqApp_classificationTableColWidths", JSON.stringify(classificationTableColWidths));
  }, [classificationTableColWidths]);

  // Ref pro uložení onChange callbacku, aby se nemusel přidávat do závislostí
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const objectRef = useRef(object);
  useEffect(() => {
    objectRef.current = object;
  }, [object]);

  const pendingUpdatesRef = useRef<Partial<ProjectObject>>({});
  useEffect(() => {
    pendingUpdatesRef.current = {};
  }, [object]);

  const updateObject = useCallback((partial: Partial<ProjectObject>) => {
    if (isLocked) return;
    const safePartial = partial.requirements
      ? { ...partial, requirements: withoutIdsProjectedRequirements(partial.requirements) }
      : partial;
    pendingUpdatesRef.current = { ...pendingUpdatesRef.current, ...safePartial };
    onChangeRef.current({ ...objectRef.current, ...pendingUpdatesRef.current });
  }, [isLocked]);

  // Vyčistit propertyName, které obsahují _NEW_ nebo se shodují s psetName.
  // Vždy operuje nad object.requirements (plná data), nikoli nad effectiveRequirements,
  // protože v režimu skupin je effectiveRequirements pouze výřez jedné skupiny.
  useEffect(() => {
    const needsCleanup = object.requirements.properties.some((prop) => {
      const propPropertyName = prop.propertyName || "";
      const propPsetName = prop.psetName || "";
      return propPropertyName.startsWith("_NEW_") || propPropertyName === propPsetName;
    });

    if (needsCleanup) {
      const next = {
        ...object.requirements,
        attributes: [...object.requirements.attributes],
        properties: object.requirements.properties.map((prop) => {
          const propPropertyName = prop.propertyName || "";
          const propPsetName = prop.psetName || "";
          if (propPropertyName.startsWith("_NEW_") || propPropertyName === propPsetName) {
            return { ...prop, propertyName: "" };
          }
          return prop;
        }),
        relations: [...object.requirements.relations],
        classifications: [...object.requirements.classifications],
        materials: [...object.requirements.materials],
      };
      updateObject({ requirements: next });
    }
  }, [object]);

  // Odstranit PredefinedType z atributů – řeší se pouze v identifikačních údajích (entita).
  // Vždy operuje nad object.requirements, aby v režimu skupin nedošlo k přepsání plných dat.
  useEffect(() => {
    const hasPredefinedTypeAttr = object.requirements.attributes.some((a) => a.attribute === "PredefinedType");
    if (hasPredefinedTypeAttr) {
      const nextAttrs = object.requirements.attributes.filter((a) => a.attribute !== "PredefinedType");
      updateObject({
        requirements: { ...object.requirements, attributes: nextAttrs },
      });
    }
  }, [object]);

  const groupKey = (source: PropertyRequirement["source"], psetName?: string) => `${source}:${psetName || "(custom)"}`;

  const isGroupAllowed = (source: PropertyRequirement["source"], psetName?: string) => {
    if (source === "CUSTOM") return true;
    if (!psetName || !selectedEntity) return false;
    const list = source === "PSET" ? allowedPsets : allowedQtos;
    return list.some((p) => p.name === psetName);
  };

  const getSchemaDefs = (source: PropertyRequirement["source"], psetName: string | undefined) => {
    if (!schema || !isGroupAllowed(source, psetName)) return [];
    const rawDefs =
      source === "PSET"
        ? schema.psets[psetName ?? ""]?.properties ?? []
        : source === "QTO"
          ? schema.qtos[psetName ?? ""]?.quantities ?? []
          : [];
    const seen = new Set<string>();
    return rawDefs.filter((d) => {
      if (seen.has(d.name)) return false;
      seen.add(d.name);
      return true;
    });
  };

  const propertyGroups = useMemo(() => {
    const map = new Map<string, { key: string; source: PropertyRequirement["source"]; psetName?: string; properties: PropertyRequirement[] }>();
    effectiveRequirements.properties.forEach((prop) => {
      const key = getPropertyRequirementGroupKey(prop);
      if (!map.has(key)) {
        map.set(key, { key, source: prop.source, psetName: prop.psetName, properties: [] });
      }
      map.get(key)!.properties.push(prop);
    });
    return Array.from(map.values());
  }, [effectiveRequirements.properties]);

  const isPropertyGroupLocked = useCallback(
    (groupKeyValue: string) => {
      const group = propertyGroups.find((g) => g.key === groupKeyValue);
      if (!group) return false;
      return group.properties.some(
        (p) => !isIdsProjectedRequirement(p) && p.groupLocked === true,
      );
    },
    [propertyGroups],
  );

  const propertyOptionsForGroup = (
    source: PropertyRequirement["source"],
    psetName: string | undefined,
    currentId?: string,
  ) => {
    const defs = getSchemaDefs(source, psetName);
    if (!defs.length) return defs;
    const used = new Set(
      effectiveRequirements.properties
        .filter((p) => p.id !== currentId && p.source === source && (p.psetName || "") === (psetName || ""))
        .map((p) => p.propertyName),
    );
    return defs.filter((d) => !used.has(d.name));
  };

  /** Normalizace pro porovnání: "není definováno" a "NOTDEFINED" jsou ekvivalentní (dropdown byl změněn z českého na IFC) */
  const normalizePredefinedForCompare = (v: string | undefined): string | undefined => {
    if (!v) return v;
    const s = (v ?? "").trim();
    return s.toLowerCase() === "není definováno" ? "NOTDEFINED" : s;
  };

  const normalizeAssignment = (item: any) => {
    if (!item) return { name: "" };
    if (typeof item === "string") return { name: item as string, forPredefinedType: undefined as string | undefined };
    return { name: item.name as string, forPredefinedType: item.forPredefinedType as string | undefined };
  };

  const mergeAssignmentsByName = (items: Array<{ name: string; forPredefinedType?: string }>) => {
    const map = new Map<string, { name: string; hasGeneric: boolean; predefinedTypes: Set<string> }>();
    items.forEach((it) => {
      const name = (it?.name ?? "").trim();
      if (!name) return;
      if (!map.has(name)) {
        map.set(name, { name, hasGeneric: false, predefinedTypes: new Set<string>() });
      }
      const row = map.get(name)!;
      if (!it.forPredefinedType) row.hasGeneric = true;
      else row.predefinedTypes.add(normalizePredefinedForCompare(it.forPredefinedType) ?? it.forPredefinedType);
    });
    return Array.from(map.values())
      .map((v) => ({
        name: v.name,
        hasGeneric: v.hasGeneric,
        predefinedTypes: Array.from(v.predefinedTypes.values()).sort(),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  };

  const allPsets = useMemo(() => {
    if (!selectedEntity) return [];
    return (selectedEntity.standardPsets || []).map((p) => normalizeAssignment(p));
  }, [selectedEntity]);

  const allQtos = useMemo(() => {
    if (!selectedEntity) return [];
    return (selectedEntity.standardQtoSets || []).map((q) => normalizeAssignment(q));
  }, [selectedEntity]);

  /** Při režimu NONE dropdown zobrazuje NOTDEFINED – pro filtrování Pset/Qto ho takto chápeme */
  const effectivePredefinedValue = selectedPredefinedValue ?? (object.predefinedType.mode === "NONE" ? "NOTDEFINED" : undefined);

  const allowedPsets = useMemo(() => {
    return allPsets.filter(
      (p) =>
        !p.forPredefinedType ||
        (effectivePredefinedValue && normalizePredefinedForCompare(p.forPredefinedType) === normalizePredefinedForCompare(effectivePredefinedValue)),
    );
  }, [allPsets, effectivePredefinedValue]);

  const allowedQtos = useMemo(() => {
    return allQtos.filter(
      (q) =>
        !q.forPredefinedType ||
        (effectivePredefinedValue && normalizePredefinedForCompare(q.forPredefinedType) === normalizePredefinedForCompare(effectivePredefinedValue)),
    );
  }, [allQtos, effectivePredefinedValue]);

  const invalidSchemaGroups = useMemo(() => {
    return propertyGroups
      .filter((g) => !g.properties.every(isIdsProjectedRequirement))
      .filter((g) => g.source !== "CUSTOM")
      .filter((g) => !!g.psetName && !g.psetName!.startsWith("_NEW_"))
      .filter((g) => !isGroupAllowed(g.source, g.psetName))
      .map((g) => ({ key: g.key, source: g.source, name: g.psetName as string }));
  }, [propertyGroups, selectedEntity, effectivePredefinedValue, allowedPsets, allowedQtos]);

  const updateRequirements = useCallback(
    (updater: (requirements: ProjectObject["requirements"]) => void) => {
      const baseRequirements = effectiveRequirements;

      const next: ProjectObject["requirements"] = {
        ...baseRequirements,
        attributes: [...baseRequirements.attributes],
        properties: [...baseRequirements.properties],
        relations: [...baseRequirements.relations],
        classifications: [...baseRequirements.classifications],
        materials: [...baseRequirements.materials],
      };

      updater(next);
      next.properties = [...next.properties];

      if (requirementsViewMode === "groups" && selectedItemGroup && onUpdateRequirementItemGroup && selectedItemGroupData) {
        const { kind, fingerprint } = selectedItemGroup;
        if (kind === "pset") {
          // V režimu skupin obsahuje effectiveRequirements.properties pouze položky dané skupiny,
          // takže můžeme předat všechny aktuálně upravené vlastnosti, i když se změní název Psetu.
          const updatedProps = next.properties as import("../../project/types").PropertyRequirement[];
          onUpdateRequirementItemGroup(kind, fingerprint, updatedProps);
        } else if (kind === "attribute") {
          const orig = (selectedItemGroupData.representativeItems as [import("../../project/types").AttributeRequirement])[0];
          const updated = next.attributes.find((a) => a.id === orig.id) ?? orig;
          onUpdateRequirementItemGroup(kind, fingerprint, [updated]);
        } else if (kind === "classification") {
          const orig = (selectedItemGroupData.representativeItems as [import("../../project/types").ClassificationRequirement])[0];
          const updated = next.classifications.find((c) => c.id === orig.id) ?? orig;
          onUpdateRequirementItemGroup(kind, fingerprint, [updated]);
        } else if (kind === "material") {
          const orig = (selectedItemGroupData.representativeItems as [import("../../project/types").MaterialRequirement])[0];
          const updated = next.materials.find((m) => m.id === orig.id) ?? orig;
          onUpdateRequirementItemGroup(kind, fingerprint, [updated]);
        } else if (kind === "relation") {
          const orig = (selectedItemGroupData.representativeItems as [import("../../project/types").RelationRequirement])[0];
          const updated = next.relations.find((r) => r.id === orig.id) ?? orig;
          onUpdateRequirementItemGroup(kind, fingerprint, [updated]);
        }
      } else {
        updateObject({ requirements: next });
      }
    },
    [effectiveRequirements, updateObject, requirementsViewMode, selectedItemGroup, onUpdateRequirementItemGroup, selectedItemGroupData],
  );

  const togglePropertyGroupLock = useCallback(
    (groupKeyValue: string) => {
      if (isLocked) return;
      const shouldLock = !isPropertyGroupLocked(groupKeyValue);
      updateRequirements((reqs) => {
        reqs.properties = reqs.properties.map((p) =>
          groupKey(p.source, p.psetName) === groupKeyValue ? { ...p, groupLocked: shouldLock } : p,
        );
      });
    },
    [isLocked, isPropertyGroupLocked, updateRequirements],
  );

  const handlePredefinedChange = (value: string) => {
    if (!value || value === "NOTDEFINED") {
      updateObject({ predefinedType: { mode: "ENUM", value: "NOTDEFINED" } });
      return;
    }
    if (value === "USERDEFINED") {
      updateObject({ predefinedType: { mode: "USERDEFINED", value: "" } });
    } else {
      updateObject({ predefinedType: { mode: "ENUM", value } });
    }
  };

  const handleIfcEntityChange = (value: string) => {
    if (isLocked) return;
    const baseUpdate: Partial<ProjectObject> = { 
      ifcEntity: value,
      predefinedType: { mode: "NONE" }
    };
    // Odstraníme neplatné hodnoty výčtu u atributů (atribut může mít jiný enum pro jinou entitu)
    const newEntityAttrs = schema?.entities[value]?.attributes;
    if (Array.isArray(newEntityAttrs)) {
      const attrDefs = new Map(newEntityAttrs.map((a: { name: string; allowedValues?: string[] }) => [a.name, a]));
      const cleanedAttrs = effectiveRequirements.attributes.map((attr) => {
        if (attr.constraint !== "ENUM" || !attr.value) return attr;
        const def = attrDefs.get(attr.attribute);
        if (!def?.allowedValues?.length) return { ...attr, value: "" }; // atribut bez výčtu pro novou entitu -> vyčistit
        const currentValues = parseEnumValues(attr.value);
        const validValues = currentValues.filter((v) => def.allowedValues!.includes(v));
        return { ...attr, value: formatEnumValues(validValues) };
      });
      updateObject({
        ...baseUpdate,
        requirements: { ...effectiveRequirements, attributes: cleanedAttrs },
      });
    } else {
      updateObject(baseUpdate);
    }
  };

  /** Automatické vyplnění prázdných políček CZ z nastaveného zdroje překladu */
  const shouldAutoFillCz = showCzTranslations && (czTranslationSource === "BSDD" || czTranslationSource === "CUSTOM");
  const projectCustomTranslations = project?.customTranslations;

  /** Při změně entity nebo predefined type vyplní obě CZ políčka v jednom updateObject. Odloženo do dalšího tiku, aby přepnutí entity neblokovalo hlavní vlákno. */
  useEffect(() => {
    if (!shouldAutoFillCz || !object.ifcEntity?.trim()) return;
    const pt = object.predefinedType?.mode === "ENUM" || object.predefinedType?.mode === "USERDEFINED" ? object.predefinedType?.value?.trim() : "";
    const cancelled = { current: false };
    const run = () => {
      const entityPromise = translate(czTranslationSource, { type: "entity", officialName: object.ifcEntity }, project);
      const ptPromise = pt
        ? translate(czTranslationSource, { type: "predefinedType", officialName: pt, context: { entity: object.ifcEntity } }, project)
        : Promise.resolve({ translated: null, source: null });
      Promise.all([entityPromise, ptPromise]).then(([entityRes, ptRes]) => {
        if (cancelled.current) return;
        const ifcEntityCz = entityRes.translated?.trim() || undefined;
        const predefinedTypeCz = pt ? (ptRes.translated?.trim() || undefined) : undefined;
        updateObject({ ifcEntityCz, predefinedTypeCz });
      });
    };
    const id = setTimeout(run, 0);
    return () => {
      cancelled.current = true;
      clearTimeout(id);
    };
  }, [shouldAutoFillCz, object.ifcEntity, object.predefinedType?.mode, object.predefinedType?.value, czTranslationSource, projectCustomTranslations, updateObject]);

  /** Automatické doplnění popisu dle IFC (pokud je pole prázdné a je to zapnuté v nastavení) */
  const fillDescCz = !!project?.fillDescriptionCz;
  const fillDescEn = !!project?.fillDescriptionEn;
  const fillDescSource = project?.czTranslationSource;

  const lastAutoDescRef = useRef<string | null>(null);

  useEffect(() => {
    if (!fillDescCz && !fillDescEn) return;
    if (!fillDescSource || fillDescSource === "OFF") return;
    if (!object.ifcEntity) return;

    const cancelled = { current: false };
    const run = async () => {
      try {
        const { getObjectDescription } = await import("../../translation/descriptionFiller");
        const desc = await getObjectDescription(object, {
          source: fillDescSource,
          fillCz: fillDescCz,
          fillEn: fillDescEn,
          project: project!,
        });
        if (cancelled.current) return;

        // Je bezpečné přepsat popis?
        // Ano, pokud je prázdný, nebo pokud se přesně shoduje s tím, co jsme vygenerovali naposledy.
        // Nebo pokud jsme zrovna načetli projekt a popis se shoduje s aktuálním auto-generovaným (pak si ho přivlastníme).
        const currentPopis = object.popis?.trim() || "";
        const isSafeToOverwrite = currentPopis === "" || currentPopis === lastAutoDescRef.current || currentPopis === desc;

        lastAutoDescRef.current = desc;

        if (desc && isSafeToOverwrite && object.popis !== desc) {
          updateObject({ popis: desc });
        }
      } catch (err) {
        console.error("Doplnění popisu selhalo:", err);
      }
    };
    const id = setTimeout(run, 100);
    return () => {
      cancelled.current = true;
      clearTimeout(id);
    };
  }, [fillDescCz, fillDescEn, fillDescSource, object.ifcEntity, object.predefinedType?.mode, object.predefinedType?.value]); // záměrně bez object.popis a updateObject

  const getAttributeDefinition = (attrName: string) => {
    const attrs = object.ifcEntity && schema?.entities[object.ifcEntity]?.attributes;
    if (!Array.isArray(attrs)) return undefined;
    return attrs.find((a: { name: string }) => a.name === attrName);
  };

  const getEnumAllowedValuesForAttribute = (attrName: string): string[] | undefined => {
    const def = getAttributeDefinition(attrName);
    if (def?.allowedValues && def.allowedValues.length > 0) return def.allowedValues;
    return undefined;
  };

  const getAvailableAttributes = (currentId?: string) => {
    const entityAttrs = object.ifcEntity && schema?.entities[object.ifcEntity]?.attributes;
    const attrsArray = Array.isArray(entityAttrs) ? entityAttrs : [];
    const allAttributes = attrsArray.length > 0 ? attrsArray.map((a: { name: string }) => a.name) : ["Name", "Description", "Tag", "ObjectType", "GlobalId"];
    const used = new Set(
      effectiveRequirements.attributes
        .filter((a) => a.id !== currentId && a.attribute !== "PredefinedType")
        .map((a) => a.attribute),
    );
    return allAttributes.filter((attr: string) => !used.has(attr) && attr !== "PredefinedType");
  };

  const addAttribute = () => {
    const availableAttributes = getAvailableAttributes();
    if (availableAttributes.length === 0) return; // Všechny atributy jsou již použité

    const firstUnused = availableAttributes[0];
    const attrDef = getAttributeDefinition(firstUnused);
    const dataType = attrDef?.dataType ?? ATTRIBUTE_DATA_TYPES_FALLBACK[firstUnused] ?? "IfcLabel";
    const allowedValues = attrDef?.allowedValues;
    const useEnum = allowedValues && allowedValues.length > 0;

    updateRequirements((reqs) => {
      reqs.attributes.push({
        id: makeId(),
        attribute: firstUnused,
        dataType,
        required: true,
        occurrence: "optional",
        constraint: useEnum ? "ENUM" : "FILLED",
        value: useEnum ? formatEnumValues(allowedValues) : "",
        unit: "",
        popis: "",
        note: "",
        priklady: "",
        extensions: {},
        phases: phases.map((p) => p.id), // All phases by default
        useCaseMode: "inherit",
      });
    });
  };

  const addPropertyGroup = (source: PropertyRequirement["source"]) => {
    // Pro novou skupinu vytvoříme vlastnost s dočasným unikátním identifikátorem v psetName
    // Tím zajistíme, že každá nová skupina bude samostatná
    // Uživatel pak vybere název ze selectu, což nahradí tento dočasný identifikátor
    const tempId = `_NEW_${makeId()}`;
    updateRequirements((reqs) => {
      reqs.properties.push({
        id: makeId(),
        source,
        psetName: tempId,
        groupLocked: false,
        propertyName: "",
        dataType: schema?.dataTypes?.[0] ?? "IfcText",
        required: true,
        occurrence: "optional",
        constraint: "FILLED",
        value: "",
        unit: "",
        extensions: {},
        phases: phases.map((p) => p.id), // All phases by default
        useCaseMode: "inherit",
      });
    });
  };

  const addPropertyToGroup = (groupKeyValue: string) => {
    const group = propertyGroups.find((g) => g.key === groupKeyValue);
    if (!group) return;
    if (isPropertyGroupLocked(groupKeyValue)) return;
    // Pro custom skupiny a dočasné skupiny vždy povolíme přidání vlastnosti
    const isTempGroup = group.psetName?.startsWith("_NEW_");
    if (group.source !== "CUSTOM" && !isTempGroup && !isGroupAllowed(group.source, group.psetName)) return;
    const options = propertyOptionsForGroup(group.source, group.psetName);
    const firstUnused = options[0];
    // Pro PSET/QTO skupiny, které ještě nemají vybraný název (dočasné), povolíme přidání vlastnosti s prázdným propertyName
    if (group.source !== "CUSTOM" && !isTempGroup && !firstUnused) return;
    updateRequirements((reqs) => {
      // Pokud už ve skupině existuje prázdný řádek (typicky první po přidání Pset/Qto),
      // využij ho místo přidání nové vlastnosti.
      if (group.source !== "CUSTOM" && !isTempGroup && firstUnused) {
        const emptyIdx = reqs.properties.findIndex(
          (p) => groupKey(p.source, p.psetName) === groupKeyValue && (!p.propertyName || p.propertyName === ""),
        );
        if (emptyIdx >= 0) {
          const prev = reqs.properties[emptyIdx];
          reqs.properties[emptyIdx] = {
            ...prev,
            propertyName: firstUnused.name,
            dataType: firstUnused.dataType ?? prev.dataType ?? schema?.dataTypes?.[0] ?? "IfcText",
            unit: firstUnused.unit ?? "",
            propertyNameCz: undefined,
          };
          return;
        }
      }

      // Pro CUSTOM a dočasné skupiny vždy nastavíme prázdný propertyName
      const newPropertyName = group.source === "CUSTOM" || isTempGroup ? "" : firstUnused?.name ?? "";
      
      reqs.properties.push({
        id: makeId(),
        source: group.source,
        psetName: group.psetName ?? "",
        groupLocked: isPropertyGroupLocked(groupKeyValue),
        propertyName: newPropertyName,
        dataType: group.source === "CUSTOM" || isTempGroup ? schema?.dataTypes?.[0] ?? "IfcText" : firstUnused?.dataType ?? schema?.dataTypes?.[0] ?? "IfcText",
        required: true,
        occurrence: "optional",
        constraint: "FILLED",
        value: "",
        unit: group.source === "CUSTOM" || isTempGroup ? "" : firstUnused?.unit ?? "",
        extensions: {},
        phases: phases.map((p) => p.id), // All phases by default
        useCaseMode: "inherit",
      });
    });
  };

  /** Načte z bSDD Definition pro všechny vlastnosti v Pset/Qto a propíše je do sloupce Popis. Při režimu AUTO se nepřeložený (angl.) text přeloží do češtiny. */
  const fillDescriptionsFromBsdd = useCallback(
    async (groupKeyValue: string) => {
      const group = propertyGroups.find((g) => g.key === groupKeyValue);
      if (!group?.psetName || group.source === "CUSTOM" || group.psetName.startsWith("_NEW_")) return;
      if (isPropertyGroupLocked(groupKeyValue)) return;
      setFillingDescriptionsGroupKey(groupKeyValue);
      try {
        let definitions: Record<string, string> = await fetchPsetOrQtoPropertyDefinitions(group.psetName);
        if (!definitions || typeof definitions !== "object") definitions = {};
        const updates = new Map<string, string>();
        for (const prop of group.properties) {
          const pn = (prop.propertyName ?? "").trim();
          if (!pn) continue;
          let def = definitions[pn] ?? definitions[prop.propertyName ?? ""];
          if (def == null || typeof def !== "string") {
            const single = await fetchSinglePropertyDefinition(pn);
            if (single) def = single;
          }
          if (def != null && typeof def === "string") {
            updates.set(prop.id, def);
          }
        }
        if (updates.size === 0) return;
        updateRequirements((reqs) => {
          reqs.properties = reqs.properties.map((p) => {
            const popis = p.id ? updates.get(p.id) : undefined;
            if (popis === undefined) return p;
            return { ...p, popis };
          });
        });
      } catch (err) {
        console.warn("[ObjectDetail] fillDescriptionsFromBsdd:", err);
      } finally {
        setFillingDescriptionsGroupKey(null);
      }
    },
    [isPropertyGroupLocked, propertyGroups, updateRequirements]
  );

  const addAllFromSchema = (groupKeyValue: string) => {
    const group = propertyGroups.find((g) => g.key === groupKeyValue);
    if (!group || group.source === "CUSTOM" || !group.psetName) return;
    if (isPropertyGroupLocked(groupKeyValue)) return;
    // Kontrola, že nejde o dočasnou skupinu
    if (group.psetName.startsWith("_NEW_")) return;
    if (!isGroupAllowed(group.source, group.psetName)) return;
    const defs = propertyOptionsForGroup(group.source, group.psetName);
    if (!defs.length) return;
    updateRequirements((reqs) => {
      // Nejdřív vyplň existující prázdné řádky ve skupině, aby po akci nezůstaly viset.
      const emptyIdxs: number[] = [];
      reqs.properties.forEach((p, idx) => {
        if (groupKey(p.source, p.psetName) !== groupKeyValue) return;
        if (!p.propertyName || p.propertyName === "") emptyIdxs.push(idx);
      });

      const remaining = [...defs];
      emptyIdxs.forEach((idx) => {
        const def = remaining.shift();
        if (!def) return;
        const prev = reqs.properties[idx];
        reqs.properties[idx] = {
          ...prev,
          propertyName: def.name,
          dataType: def.dataType ?? prev.dataType ?? schema?.dataTypes?.[0] ?? "IfcText",
          unit: def.unit ?? "",
          propertyNameCz: undefined,
        };
      });

      // Pak přidej zbytek vlastností dle IFC.
      remaining.forEach((def) => {
        reqs.properties.push({
          id: makeId(),
          source: group.source,
          psetName: group.psetName ?? "",
          groupLocked: isPropertyGroupLocked(groupKeyValue),
          propertyName: def.name,
          dataType: def.dataType ?? schema?.dataTypes?.[0] ?? "IfcText",
          required: true,
          occurrence: "optional",
          constraint: "FILLED",
          value: "",
          unit: def.unit ?? "",
          extensions: {},
          phases: phases.map((p) => p.id), // All phases by default
          useCaseMode: "inherit",
        });
      });
    });
  };

  const deleteGroup = (groupKeyValue: string) => {
    if (isPropertyGroupLocked(groupKeyValue)) return;
    updateRequirements((reqs) => {
      // Vytvořit nové pole s filtrovanými vlastnostmi
      const filteredProperties = reqs.properties.filter((p) => groupKey(p.source, p.psetName) !== groupKeyValue);
      reqs.properties = filteredProperties;
    });
  };

  const renameGroup = (groupKeyValue: string, newName: string, isCustomInput = false) => {
    if (isPropertyGroupLocked(groupKeyValue)) return;
    const guessedSource = groupKeyValue.startsWith("PSET")
      ? "PSET"
      : groupKeyValue.startsWith("QTO")
        ? "QTO"
        : "CUSTOM";
    
    // Pro custom input - ulož lokální hodnotu, ale neaktualizuj globální state okamžitě
    if (isCustomInput && guessedSource === "CUSTOM") {
      // Validace: vlastní název nesmí začínat "Qto_" nebo "Pset_"
      const trimmedLower = newName.trim().toLowerCase();
      if (trimmedLower.startsWith("qto_") || trimmedLower.startsWith("pset_")) {
        setCustomGroupErrors((prev) => ({
          ...prev,
          [groupKeyValue]: "Takovýto název není ve vlastní skupině vlastností povolen",
        }));
        return; // Neuložit, pokud začíná zakázaným prefixem
      }
      // Vymazat chybu, pokud je hodnota validní
      setCustomGroupErrors((prev) => {
        const next = { ...prev };
        delete next[groupKeyValue];
        return next;
      });
      setCustomGroupNames((prev) => ({ ...prev, [groupKeyValue]: newName }));
      return;
    }
    
    const trimmed = newName.trim();
    
    // Validace pro custom: nesmí začínat "Qto_" nebo "Pset_"
    if (guessedSource === "CUSTOM") {
      if (trimmed.toLowerCase().startsWith("qto_") || trimmed.toLowerCase().startsWith("pset_")) {
        return; // Neuložit
      }
    }
    
    // Umožnit přepnutí na libovolnou skupinu – při neplatné volbě se zobrazí varování (isInvalidGroup)
    updateRequirements((reqs) => {
      reqs.properties = reqs.properties.map((p) => {
        if (groupKey(p.source, p.psetName) !== groupKeyValue) return p;
        const updated = { ...p, psetName: trimmed };
        // Při změně názvu skupiny vymazat psetNameCz – auto-fill doplní překlad nového názvu
        if (p.psetName !== trimmed) {
          updated.psetNameCz = undefined;
        }
        if (p.source === "CUSTOM") {
          // Vymazat lokální hodnotu a chybu po úspěšné aktualizaci
          setCustomGroupNames((prev) => {
            const next = { ...prev };
            delete next[groupKeyValue];
            return next;
          });
          setCustomGroupErrors((prev) => {
            const next = { ...prev };
            delete next[groupKeyValue];
            return next;
          });
          return updated;
        }
        const options = propertyOptionsForGroup(p.source, trimmed, p.id);
        // Pokud je propertyName prázdný, ponecháme ho prázdný - uživatel si vybere sám
        if (!updated.propertyName || updated.propertyName === "") {
          return { ...updated, propertyNameCz: undefined };
        }
        // Pouze pokud propertyName není prázdný a není validní, nastavíme první dostupnou hodnotu
        const stillValid = options.some((d) => d.name === updated.propertyName);
        if (!stillValid) {
          const first = options[0];
          return {
            ...updated,
            propertyName: first?.name ?? "",
            dataType: first?.dataType ?? updated.dataType,
            unit: first?.unit ?? updated.unit,
            propertyNameCz: undefined,
          };
        }
        return updated;
      });
    });
  };

  const handleCustomGroupBlur = (groupKeyValue: string) => {
    const localValue = customGroupNames[groupKeyValue];
    if (localValue !== undefined) {
      renameGroup(groupKeyValue, localValue, false); // Uložit trimnutou hodnotu při blur
    }
  };

  const toggleGroupSelection = (groupKey: string) => {
    const group = propertyGroups.find((g) => g.key === groupKey);
    const propertyIds = group?.properties.map((p) => p.id) ?? [];
    const isSelected = selectedGroups.has(groupKey);

    setSelectedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
    setSelectedProperties((prev) => {
      const next = new Set(prev);
      if (isSelected) propertyIds.forEach((id) => next.delete(id));
      else propertyIds.forEach((id) => next.add(id));
      return next;
    });
  };

  const togglePropertySelection = (propertyId: string) => {
    setSelectedProperties((prev) => {
      const next = new Set(prev);
      if (next.has(propertyId)) {
        next.delete(propertyId);
      } else {
        next.add(propertyId);
      }
      return next;
    });
  };

  const selectAllGroups = () => {
    const allGroupKeys = propertyGroups.map((g) => g.key);
    const allPropertyIds = propertyGroups.flatMap((g) => g.properties.map((p) => p.id));
    setSelectedGroups(new Set(allGroupKeys));
    setSelectedProperties(new Set(allPropertyIds));
  };

  const deleteSelectedItems = () => {
    // Získat aktuální hodnoty z ref (vždy aktuální)
    const groupKeysToDelete = Array.from(selectedGroupsRef.current);
    const propertyIdsToDelete = Array.from(selectedPropertiesRef.current);
    const lockedGroupKeys = new Set(
      propertyGroups.filter((group) => isPropertyGroupLocked(group.key)).map((group) => group.key),
    );
    const lockedPropertyIds = new Set(
      propertyGroups
        .filter((group) => lockedGroupKeys.has(group.key))
        .flatMap((group) => group.properties.map((p) => p.id)),
    );
    
    // Smazat vlastnosti
    updateRequirements((reqs) => {
      // Vytvořit nové pole s filtrovanými vlastnostmi (smazat označené skupiny i jednotlivé vlastnosti)
      const filteredProperties = reqs.properties.filter(
        (p) =>
          !(
            groupKeysToDelete.includes(groupKey(p.source, p.psetName)) &&
            !lockedGroupKeys.has(groupKey(p.source, p.psetName))
          ) &&
          !(propertyIdsToDelete.includes(p.id) && !lockedPropertyIds.has(p.id)),
      );
      reqs.properties = filteredProperties;
    });
    
    // Vyčistit označení
    setSelectedGroups(new Set());
    setSelectedProperties(new Set());
  };

  /** Zkopírovat označené skupiny a vlastnosti v rámci prvku (do stejného objektu). */
  const copySelectedWithinElement = () => {
    const selectedGroupsSet = selectedGroupsRef.current;
    const selectedPropertiesSet = selectedPropertiesRef.current;
    if (selectedGroupsSet.size === 0 && selectedPropertiesSet.size === 0) return;

    updateRequirements((reqs) => {
      const toAppend: PropertyRequirement[] = [];
      const insertAfterIdx: { index: number; props: PropertyRequirement[] }[] = [];

      for (const gkey of selectedGroupsSet) {
        if (isPropertyGroupLocked(gkey)) continue;
        const first = reqs.properties.find((p) => groupKey(p.source, p.psetName) === gkey);
        if (!first) continue;
        const groupProps = reqs.properties.filter((p) => groupKey(p.source, p.psetName) === gkey);
        const copies = groupProps.map((p) => ({ ...p, id: makeId() }));
        if (first.source === "CUSTOM" || (first.psetName || "").startsWith("_NEW_")) {
          const newPsetName = `_NEW_${makeId()}`;
          copies.forEach((c) => {
            c.psetName = newPsetName;
          });
          toAppend.push(...copies);
        } else {
          const lastIdx = reqs.properties.reduce(
            (idx, p, i) => (groupKey(p.source, p.psetName) === gkey ? i : idx),
            -1
          );
          if (lastIdx >= 0) insertAfterIdx.push({ index: lastIdx, props: copies });
        }
      }

      for (const propId of selectedPropertiesSet) {
        const prop = reqs.properties.find((p) => p.id === propId);
        if (!prop) continue;
        if (prop.groupLocked) continue;
        const gk = groupKey(prop.source, prop.psetName);
        if (selectedGroupsSet.has(gk)) continue;
        const copy = { ...prop, id: makeId() };
        const idx = reqs.properties.findIndex((p) => p.id === propId);
        insertAfterIdx.push({ index: idx, props: [copy] });
      }

      insertAfterIdx.sort((a, b) => b.index - a.index);
      let arr = [...reqs.properties];
      for (const { index, props } of insertAfterIdx) {
        arr = [...arr.slice(0, index + 1), ...props, ...arr.slice(index + 1)];
      }
      reqs.properties = [...arr, ...toAppend];
    });
  };

  // === ATRIBUTY - výběr a mazání ===
  const toggleAttributeSelection = (attrId: string) => {
    setSelectedAttributes((prev) => {
      const next = new Set(prev);
      if (next.has(attrId)) next.delete(attrId);
      else next.add(attrId);
      return next;
    });
  };


  const selectAllAttributes = () => {
    const visibleAttrs = effectiveRequirements.attributes.filter((a) => a.attribute !== "PredefinedType");
    setSelectedAttributes(new Set(visibleAttrs.map((a) => a.id)));
  };

  const deleteSelectedAttributes = () => {
    const idsToDelete = Array.from(selectedAttributes);
    updateRequirements((reqs) => {
      reqs.attributes = reqs.attributes.filter((a) => !idsToDelete.includes(a.id));
    });
    setSelectedAttributes(new Set());
  };

  const updateSelectedAttributes = (patch: Partial<import("../../project/types").AttributeRequirement>) => {
    if (selectedAttributes.size === 0) return;
    updateRequirements((reqs) => {
      reqs.attributes = reqs.attributes.map((a) =>
        selectedAttributes.has(a.id) ? { ...a, ...patch } : a
      );
    });
  };

  // === RELACE (PartOf) - výběr a mazání ===
  const toggleRelationSelection = (relId: string) => {
    setSelectedRelations((prev) => {
      const next = new Set(prev);
      if (next.has(relId)) next.delete(relId);
      else next.add(relId);
      return next;
    });
  };

  const selectAllRelations = () => {
    const allIds = effectiveRequirements.relations.map((r) => r.id);
    setSelectedRelations(new Set(allIds));
  };

  const deleteSelectedRelations = () => {
    const idsToDelete = Array.from(selectedRelations);
    updateRequirements((reqs) => {
      reqs.relations = reqs.relations.filter((r) => !idsToDelete.includes(r.id));
    });
    setSelectedRelations(new Set());
  };

  const updateSelectedRelations = (patch: Partial<RelationRequirement>) => {
    if (selectedRelations.size === 0) return;
    updateRequirements((reqs) => {
      reqs.relations = reqs.relations.map((r) =>
        selectedRelations.has(r.id) ? { ...r, ...patch } : r
      );
    });
  };

  // === MATERIÁLY - výběr a mazání ===
  const toggleMaterialSelection = (matId: string) => {
    setSelectedMaterials((prev) => {
      const next = new Set(prev);
      if (next.has(matId)) next.delete(matId);
      else next.add(matId);
      return next;
    });
  };

  const selectAllMaterials = () => {
    const allIds = effectiveRequirements.materials.map((m) => m.id);
    setSelectedMaterials(new Set(allIds));
  };

  const deleteSelectedMaterials = () => {
    const idsToDelete = Array.from(selectedMaterials);
    updateRequirements((reqs) => {
      reqs.materials = reqs.materials.filter((m) => !idsToDelete.includes(m.id));
    });
    setSelectedMaterials(new Set());
  };

  const updateSelectedMaterials = (patch: Partial<MaterialRequirement>) => {
    if (selectedMaterials.size === 0) return;
    updateRequirements((reqs) => {
      reqs.materials = reqs.materials.map((m) =>
        selectedMaterials.has(m.id) ? { ...m, ...patch } : m
      );
    });
  };

  // === KLASIFIKACE - výběr a mazání ===
  const toggleClassificationSelection = (clsId: string) => {
    // Nenechat vybrat chráněné klasifikace (readOnly)
    const cls = effectiveRequirements.classifications.find((c) => c.id === clsId);
    if (cls?.readOnly) return;
    
    setSelectedClassifications((prev) => {
      const next = new Set(prev);
      if (next.has(clsId)) next.delete(clsId);
      else next.add(clsId);
      return next;
    });
  };

  const selectAllClassifications = () => {
    // Nevybírat chráněné klasifikace (readOnly); pouze zobrazené (bez IFC primárního)
    const selectableIds = classificationsWithoutIfc
      .filter((c) => !c.readOnly)
      .map((c) => c.id);
    setSelectedClassifications(new Set(selectableIds));
  };

  const deleteSelectedClassifications = () => {
    const idsToDelete = Array.from(selectedClassifications);
    updateRequirements((reqs) => {
      // Nemazat chráněné klasifikace (readOnly)
      reqs.classifications = reqs.classifications.filter((c) => 
        !idsToDelete.includes(c.id) || c.readOnly
      );
    });
    setSelectedClassifications(new Set());
  };

  const toggleGroup = (groupKeyValue: string) => {
    setExpandedGroups((prev) => ({ ...prev, [groupKeyValue]: !(prev[groupKeyValue] ?? true) }));
  };

  const collapseAllGroups = () => {
    setExpandedGroups((prev) => {
      const next = { ...prev };
      propertyGroups.forEach((g) => { next[g.key] = false; });
      return next;
    });
  };

  const expandAllGroups = () => {
    setExpandedGroups((prev) => {
      const next = { ...prev };
      propertyGroups.forEach((g) => { next[g.key] = true; });
      return next;
    });
  };

  const togglePropertyColumn = (colIndex: number) => {
    setHiddenPropertyColumns((prev) => {
      const next = new Set(prev);
      if (next.has(colIndex)) next.delete(colIndex);
      else next.add(colIndex);
      return next;
    });
  };
  const toggleAttributeColumn = (colIndex: number) => {
    setHiddenAttributeColumns((prev) => {
      const next = new Set(prev);
      if (next.has(colIndex)) next.delete(colIndex);
      else next.add(colIndex);
      return next;
    });
  };
  const togglePartOfColumn = (colIndex: number) => {
    setHiddenPartOfColumns((prev) => {
      const next = new Set(prev);
      if (next.has(colIndex)) next.delete(colIndex);
      else next.add(colIndex);
      return next;
    });
  };
  const toggleMaterialColumn = (colIndex: number) => {
    setHiddenMaterialColumns((prev) => {
      const next = new Set(prev);
      if (next.has(colIndex)) next.delete(colIndex);
      else next.add(colIndex);
      return next;
    });
  };
  const toggleClassificationColumn = (colIndex: number) => {
    setHiddenClassificationColumns((prev) => {
      const next = new Set(prev);
      if (next.has(colIndex)) next.delete(colIndex);
      else next.add(colIndex);
      return next;
    });
  };

  const addRelation = () => {
    updateRequirements((reqs) => {
      reqs.relations.push({
        id: makeId(),
        relationType: "IFCRELAGGREGATES",
        occurrence: "optional",
        entityType: "",
        targetType: "", // legacy field for backwards compatibility
        minCardinality: 0,
        maxCardinality: 1,
        popis: "",
        note: "",
        priklady: "",
        extensions: {},
        phases: phases.map((p) => p.id), // All phases by default
        useCaseMode: "inherit",
      });
    });
  };

  const addClassification = () => {
    updateRequirements((reqs) => {
      reqs.classifications.push({
        id: makeId(),
        classificationId: "",
        system: "",
        identification: "",
        name: "",
        readOnly: false,
        occurrence: "required",
        description: "",
        note: "",
        priklady: "",
        extensions: {},
        phases: phases.map((p) => p.id), // All phases by default
        useCaseMode: "inherit",
      });
    });
  };

  const addMaterial = () => {
    updateRequirements((reqs) => {
      reqs.materials.push({
        id: makeId(),
        occurrence: "optional",
        categoryMode: "NONE",
        category: "",
        uri: "",
        constraint: "FILLED",
        value: "",
        required: false, // legacy field for backwards compatibility
        materialType: undefined, // legacy field for backwards compatibility
        popis: "",
        note: "",
        priklady: "",
        extensions: {},
        phases: phases.map((p) => p.id), // All phases by default
        useCaseMode: "inherit",
      });
    });
  };

  const updateMaterialField = (id: string, patch: Partial<MaterialRequirement>) => {
    const targetIds = selectedMaterials.has(id) ? selectedMaterials : new Set([id]);
    updateRequirements((reqs) => {
      reqs.materials = reqs.materials.map((m) => (targetIds.has(m.id) ? { ...m, ...patch } : m));
    });
  };

  const updatePropertyField = (id: string, patch: Partial<PropertyRequirement>) => {
    const targetIds = selectedProperties.has(id) ? selectedProperties : new Set([id]);
    updateRequirements((reqs) => {
      for (const targetId of targetIds) {
        const idx = reqs.properties.findIndex((p) => p.id === targetId);
        if (idx < 0) continue;
        const prev = reqs.properties[idx];
        if (prev.groupLocked) continue;
        let next = { ...prev, ...patch };
        
        // Zajistíme, že propertyName nikdy nebude obsahovat psetName (zejména pro dočasné skupiny)
        const isTempPsetName = next.psetName?.startsWith("_NEW_");
        
        // Pokud propertyName obsahuje _NEW_ nebo se shoduje s psetName, vždy nastav prázdný string
        if (next.propertyName?.startsWith("_NEW_") || next.propertyName === next.psetName) {
          next.propertyName = "";
        }
        
        // Pokud je to dočasná skupina a propertyName není prázdné, ale obsahuje něco divného, vyčisti to
        if (isTempPsetName && next.propertyName && next.propertyName !== "" && next.propertyName === next.psetName) {
          next.propertyName = "";
        }
        
        const isSchemaBound = next.source === "PSET" || next.source === "QTO";
        const key = groupKey(next.source, next.psetName);

        // If type changes from IfcBoolean -> anything else, clear TRUE/FALSE leftovers
        if (isIfcBooleanType(prev.dataType) && !isIfcBooleanType(next.dataType)) {
          const v = (next.value ?? "").trim().toUpperCase();
          if (next.constraint === "ENUM" && (v === "TRUE" || v === "FALSE")) {
            next = { ...next, value: "" };
          }
        }

        // Enforce meaningful constraints for common data types
        if (next.constraint && !isConstraintAllowedForDataType(next.dataType, next.constraint)) {
          next = { ...next, constraint: "FILLED", value: "" };
        }

        if (isSchemaBound && (patch.psetName !== undefined || patch.propertyName !== undefined)) {
          const duplicateName =
            patch.propertyName !== undefined &&
            reqs.properties.some(
              (p) =>
                p.id !== targetId &&
                groupKey(p.source, p.psetName) === key &&
                p.propertyName === patch.propertyName,
            );
          if (duplicateName) return;

          if (patch.psetName !== undefined) {
            const options = propertyOptionsForGroup(next.source, next.psetName, targetId);
            // Pokud je propertyName prázdný, ponecháme ho prázdný - uživatel si vybere sám
            if (!next.propertyName || next.propertyName === "") {
              // Pouze aktualizujeme dataType a unit, pokud je to vhodné, ale propertyName zůstane prázdný
            } else {
              // Pouze pokud propertyName není prázdný a není validní, nastavíme první dostupnou hodnotu
              const stillValid = options.some((d) => d.name === next.propertyName);
              if (!stillValid) {
                const first = options[0];
                next = {
                  ...next,
                  propertyName: first?.name ?? "",
                  dataType: first?.dataType ?? next.dataType,
                  unit: first?.unit ?? next.unit,
                };
              }
            }
          }

          if (patch.propertyName !== undefined) {
            const def = getSchemaDefs(next.source, next.psetName).find((d) => d.name === patch.propertyName);
            if (def) {
              next = { ...next, dataType: def.dataType ?? next.dataType, unit: def.unit ?? "" };
            }
          }
        }

        const psetNameChanged = (prev.psetName ?? "") !== (next.psetName ?? "");
        const propertyNameChanged = (prev.propertyName ?? "") !== (next.propertyName ?? "");
        if (psetNameChanged) {
          if (patch.psetNameCz === undefined) next.psetNameCz = undefined;
          if (patch.propertyNameCz === undefined) next.propertyNameCz = undefined;
        } else if (propertyNameChanged && patch.propertyNameCz === undefined) {
          next.propertyNameCz = undefined;
        }

        reqs.properties[idx] = next;
      }
    });
  };

  const updateAttributeField = (id: string, patch: Partial<import("../../project/types").AttributeRequirement>) => {
    // Některá pole musí být unikátní v rámci objektu (název atributu a jeho překlad),
    // takže se nesmí hromadně přepsat na všechny vybrané řádky – jinak by všechny dostaly stejný název
    // a uživatel by ztratil data (typicky pozorováno po duplikaci atributů do více objektů).
    const isUniquePerRowField = patch.attribute !== undefined || patch.attributeCz !== undefined;
    const targetIds =
      !isUniquePerRowField && selectedAttributes.has(id) ? selectedAttributes : new Set([id]);
    updateRequirements((reqs) => {
      // Při změně názvu atributu zabráníme vytvoření duplicitního názvu v rámci objektu
      // (každá entita má v IFC každý atribut maximálně jednou).
      if (patch.attribute !== undefined) {
        const newName = patch.attribute;
        const wouldDuplicate = reqs.attributes.some(
          (a) => a.id !== id && (a.attribute ?? "") === newName,
        );
        if (wouldDuplicate) return;
      }
      for (const targetId of targetIds) {
        const idx = reqs.attributes.findIndex((a) => a.id === targetId);
        if (idx < 0) continue;
        const prev = reqs.attributes[idx];
        let next = { ...prev, ...patch };
        
        // Pokud se změní atribut, aktualizujeme datový typ a případně constraint+value z IFC schématu
        if (patch.attribute !== undefined) {
          const attrDef = getAttributeDefinition(patch.attribute);
          next.dataType = attrDef?.dataType ?? ATTRIBUTE_DATA_TYPES_FALLBACK[patch.attribute] ?? "IfcLabel";
          if (attrDef?.allowedValues?.length) {
            next.constraint = "ENUM";
            next.value = formatEnumValues(attrDef.allowedValues);
          }
        }
        
        // Zajistíme, že omezení je platné pro daný atribut
        if (next.constraint && !isAttributeConstraintAllowed(next.attribute, next.constraint, next.dataType)) {
          next = { ...next, constraint: "FILLED", value: "" };
        }

        if (
          patch.attribute !== undefined &&
          (prev.attribute ?? "") !== (next.attribute ?? "") &&
          patch.attributeCz === undefined
        ) {
          next.attributeCz = undefined;
        }

        reqs.attributes[idx] = next;
      }
    });
  };

  const updateRelationField = (id: string, patch: Partial<RelationRequirement>) => {
    const targetIds = selectedRelations.has(id) ? selectedRelations : new Set([id]);
    updateRequirements((reqs) => {
      reqs.relations = reqs.relations.map((r) => (targetIds.has(r.id) ? { ...r, ...patch } : r));
    });
  };

  /** Zda vypadá jako placeholder překlad (např. "NOVÝ 29A76920-0" z překladu _NEW_uuid) */
  const looksLikePlaceholderCz = useCallback((s: string | undefined) =>
    !!s?.trim() && /^NOVÝ\s+[0-9a-fA-F-]+/i.test(s.trim()), []);

  /**
   * Podpis „co je potřeba doplnit“ – bez editace CZ v jiných řádcích (aby se efekt nespouštěl při každém stisku klávesy).
   * Zároveň se změní po přidání Psetu/vlastnosti za již zapnuté překlady (dříve měl efekt prázdné deps a nespustil se znovu).
   */
  const czAutofillNeedsKey = useMemo(() => {
    const ent = object.ifcEntity ?? "";
    const attrs = effectiveRequirements.attributes;
    const props = effectiveRequirements.properties;
    const rels = effectiveRequirements.relations;
    const needAttr = attrs
      .filter((a) => a.attribute?.trim() && (!a.attributeCz?.trim() || looksLikePlaceholderCz(a.attributeCz)))
      .map((a) => `${a.id}:${a.attribute}`)
      .sort()
      .join(",");
    const needPset = props
      .filter((p) => p.psetName?.trim() && !p.psetName.startsWith("_NEW_") && (!p.psetNameCz?.trim() || looksLikePlaceholderCz(p.psetNameCz)))
      .map((p) => `${p.id}:${p.psetName}`)
      .sort()
      .join(",");
    const needPropName = props
      .filter(
        (p) =>
          p.propertyName?.trim() &&
          !p.propertyName.startsWith("_NEW_") &&
          (!p.propertyNameCz?.trim() || looksLikePlaceholderCz(p.propertyNameCz)),
      )
      .map((p) => `${p.id}:${p.propertyName}:${p.psetName ?? ""}`)
      .sort()
      .join(",");
    const needRel = rels
      .filter((r) => r.entityType?.trim() && !r.entityTypeCz?.trim())
      .map((r) => `${r.id}:${r.entityType}`)
      .sort()
      .join(",");
    return [ent, needAttr, needPset, needPropName, needRel].join("\x1f");
  }, [
    object.ifcEntity,
    effectiveRequirements.attributes,
    effectiveRequirements.properties,
    effectiveRequirements.relations,
    looksLikePlaceholderCz,
  ]);

  /** Jednorázové vyplnění prázdných CZ políček u požadavků – jedna dávková aktualizace, aby nedošlo k zavěšení (RESULT_CODE_HUNG). */
  useEffect(() => {
    if (!shouldAutoFillCz) return;
    const cancelled = { current: false };
    const run = async () => {
      const reqs = effectiveRequirements;
      const attrUpdates = new Map<string, string>();
      const propPsetUpdates = new Map<string, string>();
      const propNameUpdates = new Map<string, string>();
      const relUpdates = new Map<string, string>();

      for (const attr of reqs.attributes) {
        if (cancelled.current) return;
        if (attr.attribute?.trim() && (!attr.attributeCz?.trim() || looksLikePlaceholderCz(attr.attributeCz))) {
          const r = await translate(czTranslationSource, { type: "property", officialName: attr.attribute, context: { entity: object.ifcEntity } }, project);
          if (r.translated?.trim()) attrUpdates.set(attr.id, r.translated.trim());
        }
      }
      for (const prop of reqs.properties) {
        if (cancelled.current) return;
        const needsPsetCz = prop.psetName?.trim() && !prop.psetName.startsWith("_NEW_") && (!prop.psetNameCz?.trim() || looksLikePlaceholderCz(prop.psetNameCz));
        if (needsPsetCz) {
          const type = prop.source === "CUSTOM" ? "property" : prop.psetName!.startsWith("Qto_") ? "qto" : "pset";
          const r = await translate(czTranslationSource, { type, officialName: prop.psetName!, context: { entity: object.ifcEntity, psetName: prop.psetName } }, project);
          if (r.translated?.trim()) propPsetUpdates.set(prop.id, r.translated.trim());
        }
        const needsPropCz = prop.propertyName?.trim() && !prop.propertyName.startsWith("_NEW_") && (!prop.propertyNameCz?.trim() || looksLikePlaceholderCz(prop.propertyNameCz));
        if (needsPropCz) {
          const r = await translate(czTranslationSource, { type: "property", officialName: prop.propertyName, context: { entity: object.ifcEntity, psetName: prop.psetName } }, project);
          if (r.translated?.trim()) propNameUpdates.set(prop.id, r.translated.trim());
        }
      }
      for (const rel of reqs.relations) {
        if (cancelled.current) return;
        if (rel.entityType?.trim() && !rel.entityTypeCz?.trim()) {
          const r = await translate(czTranslationSource, { type: "entity", officialName: rel.entityType }, project);
          if (r.translated?.trim()) relUpdates.set(rel.id, r.translated.trim());
        }
      }

      if (cancelled.current) return;
      if (attrUpdates.size === 0 && propPsetUpdates.size === 0 && propNameUpdates.size === 0 && relUpdates.size === 0) return;

      updateRequirements((next) => {
        next.attributes = next.attributes.map((a) => (attrUpdates.has(a.id) ? { ...a, attributeCz: attrUpdates.get(a.id) } : a));
        next.properties = next.properties.map((p) => {
          const psetCz = propPsetUpdates.get(p.id);
          const nameCz = propNameUpdates.get(p.id);
          if (!psetCz && !nameCz) return p;
          return { ...p, ...(psetCz && { psetNameCz: psetCz }), ...(nameCz && { propertyNameCz: nameCz }) };
        });
        next.relations = next.relations.map((r) => (relUpdates.has(r.id) ? { ...r, entityTypeCz: relUpdates.get(r.id) } : r));
      });
    };
    void run();
    return () => {
      cancelled.current = true;
    };
  }, [shouldAutoFillCz, czTranslationSource, projectCustomTranslations, czAutofillNeedsKey, updateRequirements, project]);

  const removeRequirement = (type: keyof ProjectObject["requirements"], id: string) => {
    updateRequirements((reqs) => {
      reqs[type] = reqs[type].filter((item) => item.id !== id) as any;
    });
  };

  // Filtrovat pouze IFC datové typy (začínají na "Ifc")
  const baseDataTypes = useMemo(() => {
    const allTypes = schema?.dataTypes ?? ["IfcLabel", "IfcText", "IfcIdentifier", "IfcBoolean", "IfcInteger", "IfcReal", "IfcDate", "IfcDateTime", "IfcTime", "IfcDuration"];
    return allTypes.filter((dt) => dt.startsWith("Ifc"));
  }, [schema?.dataTypes]);
  
  const getDataTypeOptionsForProp = (prop: PropertyRequirement) => {
    // Pokud má vlastnost datový typ, který není v seznamu, přidat ho (ale pouze pokud začíná na "Ifc")
    if (prop.dataType && !baseDataTypes.includes(prop.dataType)) {
      // Pokud typ začíná na "Ifc", přidat ho, jinak ignorovat
      if (prop.dataType.startsWith("Ifc")) {
        return [prop.dataType, ...baseDataTypes];
      }
    }
    return baseDataTypes;
  };

  const getPropertyDefinition = (prop: PropertyRequirement) => {
    if (prop.source === "CUSTOM" || !prop.psetName || !prop.propertyName) return undefined;
    const defs = getSchemaDefs(prop.source, prop.psetName);
    return defs.find((d) => d.name === prop.propertyName);
  };

  const getEnumAllowedValues = (prop: PropertyRequirement): string[] | undefined => {
    // Only restrict values for properties from IFC schema (PSET/QTO), not CUSTOM
    if (prop.source === "CUSTOM") return undefined;
    
    const def = getPropertyDefinition(prop);
    // If property definition has allowedValues from IFC XML schema, use them
    if (def?.allowedValues && def.allowedValues.length > 0) {
      return def.allowedValues;
    }
    
    return undefined;
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto overflow-x-hidden">
      {/* Globální přepínač režimu zobrazení požadavků.
          - „Zobrazení po objektech“: standardní detail objektu (Popis, Identifikační údaje, Požadavky).
          - „Zobrazení všech požadavků“: pouze sekce Požadavky, vhodná pro práci se skupinami. */}
      <div className="flex items-center border-b border-slate-200 bg-slate-50 px-4 py-2">
        <div className="inline-flex rounded-full bg-slate-100 p-0.5 text-xs">
          <button
            type="button"
            className={`px-3 py-1 rounded-full ${
              requirementsViewMode === "object"
                ? "bg-white text-red-700 shadow-sm border border-red-200"
                : "text-slate-600 hover:text-slate-800"
            }`}
            onClick={() => {
              setRequirementsViewMode("object");
              onFocusRequirementGroup?.(null);
              try {
                localStorage.setItem("infoReqApp_requirementsViewMode", "object");
              } catch {
                /* ignore */
              }
            }}
          >
            Detail entity
          </button>
          <button
            type="button"
            className={`px-3 py-1 rounded-full ${
              requirementsViewMode === "specifications"
                ? "bg-white text-red-700 shadow-sm border border-red-200"
                : "text-slate-600 hover:text-slate-800"
            }`}
            onClick={() => {
              setRequirementsViewMode("specifications");
              onFocusRequirementGroup?.(null);
              try {
                localStorage.setItem("infoReqApp_requirementsViewMode", "specifications");
              } catch {
                /* ignore */
              }
            }}
          >
            IDS ({projectIdsDefinitionCount} projektová · {entityIdsSpecifications.length} zdrojových)
          </button>
          <button
            type="button"
            className={`px-3 py-1 rounded-full ${
              requirementsViewMode === "groups"
                ? "bg-white text-red-700 shadow-sm border border-red-200"
                : "text-slate-600 hover:text-slate-800"
            }`}
            onClick={() => {
              setRequirementsViewMode("groups");
              try {
                localStorage.setItem("infoReqApp_requirementsViewMode", "groups");
              } catch {
                /* ignore */
              }
            }}
          >
            Skupiny požadavků
          </button>
        </div>
      </div>

      {/* V režimu „Zobrazení všech požadavků“ nezobrazovat hlavičku jednoho objektu; místo toho neutrální nadpis. */}
      {requirementsViewMode === "object" && (
      <div className={`border-b px-4 py-3 min-h-[3.5rem] flex items-center ${isIncompleteCopy ? "border-red-300 bg-red-50" : "border-red-200 bg-gradient-to-r from-red-50 to-white"}`}>
        <div className="flex flex-1 items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="h-8 w-1 flex-shrink-0 rounded-full bg-red-500"></div>
            <div className="min-w-0 flex items-center flex-wrap gap-2 text-xl font-bold text-slate-800">
              {isEditingTitle ? (
                <input
                  type="text"
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onBlur={submitTitleChange}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      submitTitleChange();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setIsEditingTitle(false);
                      setTitleDraft(object.description ?? node.description ?? node.code);
                    }
                  }}
                  autoFocus
                  disabled={isLocked}
                  className="h-9 min-w-[14rem] max-w-full rounded border border-slate-300 px-2 text-base font-semibold text-slate-800 focus:border-red-400 focus:outline-none focus:ring-2 focus:ring-red-100"
                />
              ) : (
                <span className="truncate">
                  {isIfcPrimary && object.ifcEntity
                    ? `${object.ifcEntity}${object.predefinedType.mode === "ENUM" && object.predefinedType.value ? `.${object.predefinedType.value}` : ""}`
                    : (object.description || node.description || node.code)}
                </span>
              )}
              {showCzTranslations && isIfcPrimary && object.ifcEntity && (object.ifcEntityCz || object.predefinedTypeCz) && (
                <span className="shrink-0 text-sm font-normal text-slate-700 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded-md">
                  {object.ifcEntityCz}{object.ifcEntityCz && object.predefinedTypeCz ? " - " : ""}{object.predefinedTypeCz}
                </span>
              )}
            </div>
            {isLocked && (
              <span className="flex-shrink-0 rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                Zamčeno
              </span>
            )}
            {isIncompleteCopy && (
              <span className="flex-shrink-0 rounded bg-red-200 px-2 py-0.5 text-xs font-medium text-red-800">
                Neúplná kopie – změňte entitu nebo typ
              </span>
            )}
          </div>
          <div className="flex flex-shrink-0 items-center gap-1">
            {onCopyObject && !isLocked && (
              <button
                type="button"
                onClick={() => onCopyObject(object.code)}
                className="rounded p-2 text-slate-500 hover:bg-slate-200 hover:text-slate-700"
                title="Zkopírovat objekt (včetně hierarchie a klasifikací)"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </button>
            )}
            {onToggleLock && (
              <button
                type="button"
                onClick={() => onToggleLock(object)}
                className={`rounded p-2 transition-colors ${
                  isLocked
                    ? "bg-amber-200/80 text-amber-800 hover:bg-amber-300/80"
                    : "text-slate-500 hover:bg-slate-200 hover:text-slate-700"
                }`}
                title={isLocked ? "Odemknout objekt" : "Zamknout objekt (nelze upravovat ani mazat)"}
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  {isLocked ? (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  ) : (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
                  )}
                </svg>
              </button>
            )}
            {!isLocked && (
              <button
                type="button"
                onClick={() => {
                  setTitleDraft(object.description || node.description || node.code);
                  setIsEditingTitle(true);
                }}
                className="rounded p-2 text-slate-500 hover:bg-slate-200 hover:text-slate-700"
                title="Přejmenovat prvek"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536M9 11l6.232-6.232a2.5 2.5 0 013.536 3.536L12.536 14.536A4 4 0 0110.95 15.5L7 17l1.5-3.95A4 4 0 019 11z" />
                </svg>
              </button>
            )}
            {onDeleteObject && (
              <button
                type="button"
                onClick={() => onDeleteObject(object.code)}
                disabled={isLocked}
                className="rounded p-2 text-slate-500 hover:bg-red-100 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
                title={isLocked ? "Zamčený objekt nelze odstranit" : "Odstranit objekt"}
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
      )}
      {requirementsViewMode === "groups" && (
        <div className="border-b border-red-200 bg-gradient-to-r from-red-50 to-white px-4 py-3 flex items-center min-h-[3.5rem]">
          <div className="flex items-center gap-3">
            <div className="h-8 w-1 flex-shrink-0 rounded-full bg-red-500"></div>
            <span className="text-xl font-bold text-slate-800">Všechny požadavky podle skupin</span>
            <span className="text-sm text-slate-400 font-normal">— úpravy se aplikují na všechny objekty ve skupině</span>
          </div>
        </div>
      )}
      {requirementsViewMode === "specifications" && project && (
        <IdsSpecificationsPanel
          project={project}
          object={object}
          ifcEntity={object.ifcEntity}
          predefinedType={selectedPredefinedType}
          selectedPhaseId={selectedPhaseId}
          onSelectedPhaseIdChange={setSelectedPhaseId}
          selectedUseCaseId={selectedUseCaseId}
          onSelectedUseCaseIdChange={setSelectedUseCaseId}
          occurrenceFilter={occurrenceFilter}
          onOccurrenceFilterChange={setOccurrenceFilter}
          onOpenProjectDefinition={() => {
            setRequirementsViewMode("object");
            setActiveTab("ids");
            onFocusIdsSpecification?.(null);
          }}
          onFocusSpecification={onFocusIdsSpecification}
          focusedSpecificationId={focusedIdsSpecificationId}
          editRequest={editIdsRequest}
          onSaveSpecification={onSaveIdsSpecification}
          onDuplicateSpecification={onDuplicateIdsSpecification}
          onDeleteSpecification={onDeleteIdsSpecification}
        />
      )}

      {/* Sekce v pořadí dle sectionOrder (flex order).
          V režimu „Zobrazení všech požadavků“ (groups) zobrazujeme pouze sekci Požadavky,
          ostatní (Popis, Identifikační údaje) skryjeme. */}
      {requirementsViewMode === "object" && (
        <CollapsibleSection
          title={SECTION_LABELS.popis}
          isExpanded={sectionVisibility.popis}
          onToggle={() => toggleSectionVisibility("popis")}
          onMoveUp={() => moveSection("popis", "up")}
          onMoveDown={() => moveSection("popis", "down")}
          canMoveUp={sectionOrder.indexOf("popis") > 0}
          canMoveDown={sectionOrder.indexOf("popis") < sectionOrder.length - 1}
          className="min-w-0"
          style={{ order: sectionOrder.indexOf("popis") }}
        >
        <div className="min-w-0 px-4 py-3">
          <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="min-w-0">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <label className="text-xs font-semibold text-slate-600">Popis</label>
              </div>
              <textarea
                className="w-full min-h-[72px] rounded border border-slate-300 px-2 py-1.5 text-sm placeholder:text-slate-400 focus:border-red-500 focus:ring-1 focus:ring-red-500"
                placeholder="Popis objektu"
                value={object.popis ?? ""}
                onChange={(e) => updateObject({ popis: e.target.value || undefined })}
                disabled={isLocked}
                rows={3}
              />
            </div>
            <div className="min-w-0">
              <label className="mb-1 block text-xs font-semibold text-slate-600">Poznámka</label>
              <textarea
                className="w-full min-h-[72px] rounded border border-slate-300 px-2 py-1.5 text-sm placeholder:text-slate-400 focus:border-red-500 focus:ring-1 focus:ring-red-500"
                placeholder="Poznámka k objektu"
                value={object.poznamka ?? ""}
                onChange={(e) => updateObject({ poznamka: e.target.value || undefined })}
                disabled={isLocked}
                rows={3}
              />
            </div>
            <div className="min-w-0">
              <label className="mb-1 block text-xs font-semibold text-slate-600">Příklady</label>
              <textarea
                className="w-full min-h-[72px] rounded border border-slate-300 px-2 py-1.5 text-sm placeholder:text-slate-400 focus:border-red-500 focus:ring-1 focus:ring-red-500"
                placeholder="Příklady"
                value={object.priklady ?? ""}
                onChange={(e) => updateObject({ priklady: e.target.value || undefined })}
                disabled={isLocked}
                rows={3}
              />
            </div>
          </div>
        </div>
        </CollapsibleSection>
      )}

      {requirementsViewMode === "object" && (
      <CollapsibleSection
          title={SECTION_LABELS.identifikacni}
          isExpanded={sectionVisibility.identifikacni}
          onToggle={() => toggleSectionVisibility("identifikacni")}
          onMoveUp={() => moveSection("identifikacni", "up")}
          onMoveDown={() => moveSection("identifikacni", "down")}
          canMoveUp={sectionOrder.indexOf("identifikacni") > 0}
          canMoveDown={sectionOrder.indexOf("identifikacni") < sectionOrder.length - 1}
          className="min-w-0"
          style={{ order: sectionOrder.indexOf("identifikacni") }}
          maxHeightScroll
        >
      <div className="min-w-0 px-4 py-3">
        {isIfcPrimary && object.ifcEntity && !isCurrentSelectionInHierarchy && onAddToIfcHierarchy && !isLocked && (
          <div className="mb-2 flex items-center justify-between gap-2 rounded border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-800">
            <span>Vybraná entita <strong>{object.ifcEntity}</strong>
              {object.predefinedType.mode === "ENUM" && object.predefinedType.value ? (
                <> a typ <strong>{object.predefinedType.value}</strong></>
              ) : null}
              {" "}není v hierarchii projektu. Můžete ji přidat do hierarchie.
            </span>
            <button
              type="button"
              className="flex-shrink-0 rounded border border-red-300 bg-red-100 px-2 py-1 text-xs font-medium text-red-900 hover:bg-red-200"
              onClick={() => onAddToIfcHierarchy(object.code)}
            >
              Přidat do hierarchie
            </button>
          </div>
        )}
        <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="min-w-0 rounded border border-slate-200 bg-slate-50 p-3">
            <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-800">
              Entita
              <DocLink 
                href="https://github.com/buildingSMART/IDS/blob/development/Documentation/UserManual/entity-facet.md"
                label="Entity Facet"
                type="ids"
              />
              <DocLink href={getIfcLexicalDocUrl(ifcSchemaVersion, object.ifcEntity)} label="IFC" type="ifc" />
            </div>
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-xs text-slate-600 shrink-0">IfcEntity</label>
                <EntitySelect
                  schemaIndex={schema}
                  value={object.ifcEntity ?? ""}
                  onChange={handleIfcEntityChange}
                  placeholder="-- Vyberte entitu --"
                />
                {showCzTranslations && object.ifcEntity && (
                  <>
                    <input
                      className="min-w-[100px] max-w-[140px] bg-slate-100 border border-slate-200 text-slate-700 not-italic font-medium rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-slate-400 focus:border-slate-400 placeholder:text-slate-400 placeholder:font-normal"
                      placeholder="CZ"
                      value={object.ifcEntityCz ?? ""}
                      onChange={(e) => updateObject({ ifcEntityCz: e.target.value || undefined })}
                      title="Překlad entity do češtiny"
                    />
                    {ifcSchemaVersion === "IFC4X3" && getBsddUrl("entity", object.ifcEntity, undefined, ifcSchemaVersion) && (
                      <a
                        href={getBsddUrl("entity", object.ifcEntity, undefined, ifcSchemaVersion)!}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center shrink-0 rounded px-2 py-1 text-xs font-semibold uppercase tracking-wide bg-slate-200 text-slate-600 hover:bg-red-700 hover:text-white transition-colors"
                        title="Otevřít v buildingSMART Data Dictionary"
                      >
                        bSDD
                      </a>
                    )}
                  </>
                )}
                <span className="text-xs text-slate-600 shrink-0">Fáze</span>
                <PhaseSelector
                  phases={phases}
                  value={object.ifcEntityPhases ?? object.entityPhases ?? phases.map((p) => p.id)}
                  onChange={(ids) => updateObject({ ifcEntityPhases: ids })}
                />
              </div>
              {object.ifcEntity && deprecatedEntities.has(object.ifcEntity) && (
                <div className="text-xs text-amber-700">
                  Tato IFC entita je <span className="font-semibold">zastaralá</span> a bude v budoucí verzi IFC odstraněna.
                  Zvažte použití doporučené náhrady uvedené v dokumentaci IFC.
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-xs text-slate-600 shrink-0">PredefinedType</label>
                <div ref={predefinedTypeContainerRef} className="relative inline-block">
                  <button
                    ref={predefinedTypeButtonRef}
                    type="button"
                    className="min-w-[120px] max-w-[180px] rounded border border-slate-300 bg-white px-2 py-1 text-left text-sm hover:border-slate-400 focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500"
                    onClick={() => setPredefinedTypeDropdownOpen((o) => !o)}
                  >
                    {object.predefinedType.mode === "NONE"
                      ? "NOTDEFINED"
                      : object.predefinedType.mode === "USERDEFINED"
                        ? "USERDEFINED"
                        : object.predefinedType.value ?? "NOTDEFINED"}
                  </button>
                  {predefinedTypeDropdownOpen &&
                    predefinedTypePanelAnchor &&
                    createPortal(
                      <div
                        data-predefined-type-dropdown-panel
                        className="min-w-[180px] max-h-[280px] overflow-auto rounded-lg border-2 border-slate-300 bg-white py-1 shadow-xl ring-2 ring-slate-200/60"
                        style={{
                          position: "fixed",
                          top: predefinedTypePanelAnchor.top,
                          left: predefinedTypePanelAnchor.left,
                          width: predefinedTypePanelAnchor.width,
                          zIndex: 9999,
                        }}
                      >
                        {predefinedOptions.map((opt) => {
                          const isDeprecated =
                            predefinedEnumType &&
                            !!deprecatedPredefinedByEnum[predefinedEnumType]?.has(opt.trim().toUpperCase());
                          const isSelected =
                            (object.predefinedType.mode === "NONE" && opt === "NOTDEFINED") ||
                            (object.predefinedType.mode === "USERDEFINED" && opt === "USERDEFINED") ||
                            (object.predefinedType.mode === "ENUM" && (object.predefinedType.value ?? "NOTDEFINED") === opt);
                          return (
                            <button
                              key={opt}
                              type="button"
                              className={`w-full px-3 py-1.5 text-left text-sm text-slate-800 hover:bg-slate-100 ${
                                isSelected ? "bg-red-50 text-red-800" : ""
                              }`}
                              onClick={() => {
                                handlePredefinedChange(opt);
                                setPredefinedTypeDropdownOpen(false);
                              }}
                            >
                              {opt}
                              {isDeprecated && (
                                <span className="text-amber-700 font-normal"> (zastaralé - bude odstraněno)</span>
                              )}
                            </button>
                          );
                        })}
                      </div>,
                      document.body,
                    )}
                </div>
                {object.predefinedType.mode === "USERDEFINED" && (
                  <input
                    className="min-w-[100px] max-w-[160px] rounded border border-slate-300 px-2 py-1 text-sm"
                    placeholder="Vlastní typ"
                    value={object.predefinedType.value ?? ""}
                    onChange={(e) => updateObject({ predefinedType: { mode: "USERDEFINED", value: e.target.value }, popis: "" })}
                  />
                )}
                {showCzTranslations && object.predefinedType.mode === "ENUM" && object.predefinedType.value && (
                  <>
                    <input
                      className="min-w-[80px] max-w-[120px] bg-slate-100 border border-slate-200 text-slate-700 not-italic font-medium rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-slate-400 focus:border-slate-400 placeholder:text-slate-400 placeholder:font-normal"
                      placeholder="CZ"
                      value={object.predefinedTypeCz ?? ""}
                      onChange={(e) => updateObject({ predefinedTypeCz: e.target.value || undefined })}
                      title="Překlad PredefinedType do češtiny"
                    />
                    {ifcSchemaVersion === "IFC4X3" && getBsddUrl("predefinedType", object.predefinedType.value, { entity: object.ifcEntity }, ifcSchemaVersion) && (
                      <a
                        href={getBsddUrl("predefinedType", object.predefinedType.value, { entity: object.ifcEntity }, ifcSchemaVersion)!}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center shrink-0 rounded px-2 py-1 text-xs font-semibold uppercase tracking-wide bg-slate-200 text-slate-600 hover:bg-red-700 hover:text-white transition-colors"
                        title="Otevřít v buildingSMART Data Dictionary"
                      >
                        bSDD
                      </a>
                    )}
                  </>
                )}
                <span className="text-xs text-slate-600 shrink-0">Fáze</span>
                <PhaseSelector
                  phases={phases}
                  value={object.predefinedTypePhases ?? object.entityPhases ?? phases.map((p) => p.id)}
                  onChange={(ids) => updateObject({ predefinedTypePhases: ids })}
                />
              </div>
              {isCurrentPredefinedDeprecated && (
                <div className="text-xs text-amber-700">
                  Tento <span className="font-semibold">PredefinedType</span> je zastaralý a bude v budoucí verzi IFC odstraněn nebo nahrazen.
                  {currentDeprecatedPredefinedNote ? (
                    <> Doporučení: {currentDeprecatedPredefinedNote}</>
                  ) : (
                    <> Zvažte použití doporučené náhrady uvedené v dokumentaci IFC.</>
                  )}
                </div>
              )}
            </div>
          </div>

          {(() => {
            const primaryEntry = classificationSystemEntries.find((e) => e.isPrimary);
            const authoringSystemIds = (primaryEntry?.authoringToolSystemIds?.length
              ? primaryEntry.authoringToolSystemIds
              : primaryEntry?.mappedSystemIds) ?? [];
            const effectiveKind = (e: ClassificationSystemEntry) =>
              e.systemKind ?? (e.isIfcSystem ? "ifc" : "classification");
            const authoringEntries = authoringSystemIds
              .map((id) => classificationSystemEntries.find((e) => e.id === id))
              .filter((e): e is ClassificationSystemEntry => !!e && effectiveKind(e) === "authoring");
            const getAuthoringCodes = (systemEntryId: string): string[] => {
              const fromObject = (object.authoringClassifications ?? []).filter((a) => a.systemEntryId === systemEntryId).map((a) => a.code).filter((c) => c?.trim());
              if (fromObject.length > 0) return fromObject;
              const fromNode = node.mappedValues?.[systemEntryId]?.trim();
              return fromNode ? [fromNode] : [];
            };
            const setAuthoringCodes = (systemEntryId: string, newCodes: string[]) => {
              const current = object.authoringClassifications ?? [];
              const rest = current.filter((a) => a.systemEntryId !== systemEntryId);
              const next = [...rest, ...newCodes.filter((c) => c?.trim()).map((code) => ({ systemEntryId, code }))];
              updateObject({ authoringClassifications: next.length ? next : undefined });
            };
            const setAuthoringCodeAt = (systemEntryId: string, index: number, code: string) => {
              const codes = getAuthoringCodes(systemEntryId);
              const newCodes = [...codes];
              if (code.trim()) {
                if (index < newCodes.length) newCodes[index] = code;
                else newCodes.push(code);
              } else if (index < newCodes.length) {
                newCodes.splice(index, 1);
              }
              setAuthoringCodes(systemEntryId, newCodes);
            };
            const removeAuthoringCodeAt = (systemEntryId: string, index: number) => {
              const codes = getAuthoringCodes(systemEntryId);
              const newCodes = codes.filter((_, i) => i !== index);
              setAuthoringCodes(systemEntryId, newCodes);
            };
            const addAuthoringSlot = (systemEntryId: string) => {
              setExtraAuthoringSlots((prev) => ({ ...prev, [systemEntryId]: (prev[systemEntryId] ?? 0) + 1 }));
            };
            const removeExtraAuthoringSlot = (systemEntryId: string) => {
              setExtraAuthoringSlots((prev) => ({ ...prev, [systemEntryId]: Math.max(0, (prev[systemEntryId] ?? 0) - 1) }));
            };
            const handleAuthoringChange = (systemEntryId: string, idx: number, code: string) => {
              const values = getAuthoringCodes(systemEntryId);
              const extraCount = extraAuthoringSlots[systemEntryId] ?? 0;
              if (idx >= values.length && idx < values.length + extraCount) {
                if (code.trim()) {
                  setAuthoringCodes(systemEntryId, [...values, code]);
                  removeExtraAuthoringSlot(systemEntryId);
                } else {
                  removeExtraAuthoringSlot(systemEntryId);
                }
              } else {
                setAuthoringCodeAt(systemEntryId, idx, code);
              }
            };
            return (
              <div className="min-w-0 rounded border border-slate-200 bg-slate-50 p-3">
                <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-800">
                  Třídění autorských nástrojů
                </div>
                <p className="mb-2 text-xs text-slate-500">
                  Klasifikace dle autorského nástroje (např. Kategorie RVT). Nepoužívá se v IFC/IDS. Můžete přiřadit více hodnot.
                </p>
                {authoringEntries.length > 0 ? (
                  <div className="space-y-3">
                    {authoringEntries.map((entry) => {
                      const codes = entry.nodes ? collectLeaves(entry.nodes).map((n) => n.code) : [];
                      const values = getAuthoringCodes(entry.id);
                      const extraCount = extraAuthoringSlots[entry.id] ?? 0;
                      const slots = [...values, ...Array(extraCount).fill("")];
                      return (
                        <div key={entry.id} className="space-y-1.5">
                          <label className="block text-xs font-medium text-slate-600">{entry.name}</label>
                          <div className="flex flex-wrap items-center gap-2">
                            {slots.map((value, idx) => (
                              <div key={idx} className="flex items-center gap-1">
                                <select
                                  className="min-w-[140px] max-w-[220px] rounded border border-slate-300 px-2 py-1 text-sm"
                                  value={value}
                                  onChange={(e) => handleAuthoringChange(entry.id, idx, e.target.value)}
                                >
                                  <option value="">— Nevybráno</option>
                                  {codes.map((c) => (
                                    <option key={c} value={c}>
                                      {c}
                                    </option>
                                  ))}
                                </select>
                                <button
                                  type="button"
                                  className="rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-600"
                                  onClick={() => (idx < values.length ? removeAuthoringCodeAt(entry.id, idx) : removeExtraAuthoringSlot(entry.id))}
                                  title="Odebrat hodnotu"
                                >
                                  ×
                                </button>
                              </div>
                            ))}
                            <button
                              type="button"
                              className="flex h-8 min-w-[2rem] items-center justify-center rounded border border-dashed border-slate-300 text-slate-500 hover:border-slate-400 hover:bg-slate-100 hover:text-slate-600"
                              onClick={() => addAuthoringSlot(entry.id)}
                              title="Přidat hodnotu"
                            >
                              +
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-xs italic text-slate-500">
                    V záložce „Klasifikační systémy a mapování“ připojte k primárnímu systému další systém (např. Kategorie RVT) tlačítkem Mapovat.
                  </p>
                )}
              </div>
            );
          })()}
        </div>

        <div className="mt-4 grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
          {!isIfcPrimary && (
          <div className="min-w-0 rounded border border-slate-200 bg-slate-50 p-3">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
                Klasifikace
                <DocLink 
                  href="https://github.com/buildingSMART/IDS/blob/development/Documentation/UserManual/classification-facet.md"
                  label="Classification Facet"
                  type="ids"
                />
              </div>
            </div>
            {classificationsWithoutIfc.length > 0 ? (
              <div className="space-y-2">
                {classificationsWithoutIfc.map((cls, idx) => {
                  // Look up system name from entries first, fall back to stored value
                  const displaySystemName = cls.systemEntryId 
                    ? classificationSystemEntries.find((e) => e.id === cls.systemEntryId)?.name 
                    : cls.system;
                  return (
                  <div key={cls.id || idx} className={`rounded px-2 py-1.5 text-xs ${cls.readOnly ? "bg-red-100 border border-red-200" : "bg-white border border-slate-200"}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-slate-800">{cls.value || cls.identification || cls.code || "—"}</span>
                      {cls.readOnly && <span className="rounded bg-red-500 px-1.5 py-0.5 text-[10px] font-medium text-white">Primární</span>}
                    </div>
                    <div className="mt-0.5 text-slate-500">
                      {displaySystemName && <span>{displaySystemName}</span>}
                      {cls.name && cls.name !== cls.value && <span className="ml-1">• {cls.name}</span>}
                    </div>
                  </div>
                )})}
              </div>
            ) : (
              <div className="text-xs text-slate-500 italic">Žádná klasifikace</div>
            )}
            <button 
              className="mt-2 text-xs text-red-600 hover:underline" 
              onClick={() => setActiveTab("classification")}
            >
              Upravit klasifikace →
            </button>
          </div>
          )}

          {/* Karty v použitelnosti – stejná mřížka jako Klasifikace */}
          {/* Atributy v použitelnosti – kompaktní zobrazení */}
          {effectiveRequirements.attributes.some((a) => a.isApplicability && a.attribute !== "PredefinedType") && (
            <div className="min-w-0 rounded border border-slate-200 bg-slate-50 p-3">
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
                  Atributy
                  <DocLink 
                    href="https://github.com/buildingSMART/IDS/blob/development/Documentation/UserManual/attribute-facet.md"
                    label="Attribute Facet"
                    type="ids"
                  />
                </div>
              </div>
              {effectiveRequirements.attributes.filter((a) => a.isApplicability && a.attribute !== "PredefinedType").length > 0 ? (
                <div className="space-y-2">
                  {effectiveRequirements.attributes
                    .filter((a) => a.isApplicability && a.attribute !== "PredefinedType")
                    .map((attr) => {
                      const constraintLabel = ATTRIBUTE_CONSTRAINT_OPTIONS.find(opt => opt.value === (attr.constraint ?? "FILLED"))?.label ?? "Jednoduchá hodnota";
                      const attrPhases = attr.phases ?? phases.map(p => p.id);
                      return (
                        <div key={attr.id} className="rounded px-2 py-1.5 text-xs bg-white border border-slate-200">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold text-slate-800">{attr.attribute}</span>
                          </div>
                          <div className="mt-0.5 text-slate-500">
                            <span>{constraintLabel}</span>
                            {attr.value && <span className="ml-1">• {attr.value}</span>}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-1">
                            <span className="text-[10px] text-slate-500">Fáze:</span>
                            {phases.filter(p => attrPhases.includes(p.id)).map(phase => (
                              <span key={phase.id} className="inline-flex items-center rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">
                                {phase.code}
                              </span>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                </div>
              ) : (
                <div className="text-xs text-slate-500 italic">Žádné atributy</div>
              )}
              <button 
                className="mt-2 text-xs text-red-600 hover:underline" 
                onClick={() => setActiveTab("attributes")}
              >
                Upravit atributy →
              </button>
            </div>
          )}

          {/* Vlastnosti v použitelnosti – kompaktní zobrazení */}
          {effectiveRequirements.properties.some((p) => p.isApplicability && (p.psetName || p.propertyName)) && (
            <div className="min-w-0 rounded border border-slate-200 bg-slate-50 p-3">
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
                  Vlastnosti
                  <DocLink 
                    href="https://github.com/buildingSMART/IDS/blob/development/Documentation/UserManual/property-facet.md"
                    label="Property Facet"
                    type="ids"
                  />
                </div>
              </div>
              {effectiveRequirements.properties.filter((p) => p.isApplicability && (p.psetName || p.propertyName)).length > 0 ? (
                <div className="space-y-2">
                  {effectiveRequirements.properties
                    .filter((p) => p.isApplicability && (p.psetName || p.propertyName))
                    .map((prop) => {
                      const propPhases = prop.phases ?? phases.map(p => p.id);
                      return (
                        <div key={prop.id} className="rounded px-2 py-1.5 text-xs bg-white border border-slate-200">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold text-slate-800">{prop.propertyName || "—"}</span>
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-1 text-slate-500">
                            {prop.psetName ? <span>{prop.psetName}</span> : null}
                            {prop.value && <span>• {prop.value}</span>}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-1">
                            <span className="text-[10px] text-slate-500">Fáze:</span>
                            {phases.filter(p => propPhases.includes(p.id)).map(phase => (
                              <span key={phase.id} className="inline-flex items-center rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">
                                {phase.code}
                              </span>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                </div>
              ) : (
                <div className="text-xs text-slate-500 italic">Žádné vlastnosti</div>
              )}
              <button 
                className="mt-2 text-xs text-red-600 hover:underline" 
                onClick={() => setActiveTab("properties")}
              >
                Upravit vlastnosti →
              </button>
            </div>
          )}

          {/* Součásti v použitelnosti – kompaktní zobrazení */}
          {effectiveRequirements.relations.some((r) => r.isApplicability) && (
            <div className="min-w-0 rounded border border-slate-200 bg-slate-50 p-3">
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
                  Součásti
                  <DocLink 
                    href="https://github.com/buildingSMART/IDS/blob/development/Documentation/UserManual/partof-facet.md"
                    label="PartOf Facet"
                    type="ids"
                  />
                </div>
              </div>
              {effectiveRequirements.relations.filter((r) => r.isApplicability).length > 0 ? (
                <div className="space-y-2">
                  {effectiveRequirements.relations
                    .filter((r) => r.isApplicability)
                    .map((rel) => {
                      const relPhases = rel.phases ?? phases.map(p => p.id);
                      return (
                        <div key={rel.id} className="rounded px-2 py-1.5 text-xs bg-white border border-slate-200">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold text-slate-800">{rel.entityType || "—"}</span>
                          </div>
                          <div className="mt-0.5 text-slate-500">
                            <span>{rel.relationType}</span>
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-1">
                            <span className="text-[10px] text-slate-500">Fáze:</span>
                            {phases.filter(p => relPhases.includes(p.id)).map(phase => (
                              <span key={phase.id} className="inline-flex items-center rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">
                                {phase.code}
                              </span>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                </div>
              ) : (
                <div className="text-xs text-slate-500 italic">Žádné součásti</div>
              )}
              <button 
                className="mt-2 text-xs text-red-600 hover:underline" 
                onClick={() => setActiveTab("partOf")}
              >
                Upravit součásti →
              </button>
            </div>
          )}

          {/* Materiál v použitelnosti – kompaktní zobrazení */}
          {effectiveRequirements.materials.some((m) => m.isApplicability) && (
            <div className="min-w-0 rounded border border-slate-200 bg-slate-50 p-3">
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
                  Materiál
                  <DocLink 
                    href="https://github.com/buildingSMART/IDS/blob/development/Documentation/UserManual/material-facet.md"
                    label="Material Facet"
                    type="ids"
                  />
                </div>
              </div>
              {effectiveRequirements.materials.filter((m) => m.isApplicability).length > 0 ? (
                <div className="space-y-2">
                  {effectiveRequirements.materials
                    .filter((m) => m.isApplicability)
                    .map((mat) => {
                      const matPhases = mat.phases ?? phases.map(p => p.id);
                      return (
                        <div key={mat.id} className="rounded px-2 py-1.5 text-xs bg-white border border-slate-200">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold text-slate-800">{mat.value || "—"}</span>
                          </div>
                          <div className="mt-0.5 text-slate-500">
                            {mat.category && <span>{mat.category}</span>}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-1">
                            <span className="text-[10px] text-slate-500">Fáze:</span>
                            {phases.filter(p => matPhases.includes(p.id)).map(phase => (
                              <span key={phase.id} className="inline-flex items-center rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">
                                {phase.code}
                              </span>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                </div>
              ) : (
                <div className="text-xs text-slate-500 italic">Žádný materiál</div>
              )}
              <button 
                className="mt-2 text-xs text-red-600 hover:underline" 
                onClick={() => setActiveTab("material")}
              >
                Upravit materiál →
              </button>
            </div>
          )}
        </div>
      </div>
      </CollapsibleSection>
      )}

      {requirementsViewMode !== "specifications" && (
      <CollapsibleSection
        title={SECTION_LABELS.pozadavky}
        isExpanded={sectionVisibility.pozadavky}
        onToggle={() => toggleSectionVisibility("pozadavky")}
        onMoveUp={() => moveSection("pozadavky", "up")}
        onMoveDown={() => moveSection("pozadavky", "down")}
        canMoveUp={sectionOrder.indexOf("pozadavky") > 0}
        canMoveDown={sectionOrder.indexOf("pozadavky") < sectionOrder.length - 1}
        className="flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden"
        style={{ order: sectionOrder.indexOf("pozadavky") }}
        flexGrow
      >
      <div className="flex flex-1 flex-col min-w-0 overflow-hidden">

        {/* Editor content blok – použijeme IIFE pro extrakci do proměnné */}
        {(() => {
          const showEditor = requirementsViewMode === "object" || (requirementsViewMode === "groups" && selectedItemGroup && selectedItemGroupData);
          const editorBlock = !showEditor ? null : (
        <div className={requirementsViewMode === "groups" ? "overflow-auto p-4" : "flex-1 min-h-0 overflow-auto p-4"} style={requirementsViewMode === "groups" ? { maxHeight: "60vh" } : undefined}>
          {activeTab === "attributes" && (() => {
            const visibleAttributes = effectiveRequirements.attributes.filter((a) => a.attribute !== "PredefinedType");
            return (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <DocLink 
                  href="https://github.com/buildingSMART/IDS/blob/development/Documentation/UserManual/attribute-facet.md"
                  label="Attribute Facet"
                  type="ids"
                />
                <button className="rounded bg-red-600 px-3 py-1 text-xs font-semibold text-white hover:bg-red-500" onClick={addAttribute}>
                  Přidat atribut
                </button>
                {visibleAttributes.length > 0 && (
                  <>
                    <div className="relative">
                      <button
                        className="rounded border border-slate-300 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 flex items-center gap-1"
                        onClick={() => setAttributeColumnMenuOpen((o) => !o)}
                        title="Zobrazit nebo skrýt sloupce"
                      >
                        Sloupce
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </button>
                      {attributeColumnMenuOpen && (
                        <>
                          <div className="fixed inset-0 z-40" onClick={() => setAttributeColumnMenuOpen(false)} aria-hidden />
                          <div className="absolute left-0 top-full mt-1 z-50 min-w-[200px] rounded-md border border-slate-200 bg-white py-2 shadow-lg">
                            <div className="flex items-center justify-between gap-2 px-3 py-1">
                              <span className="text-[11px] font-semibold uppercase text-slate-500">Sloupce</span>
                              <div className="flex gap-1">
                                <button type="button" className="text-[10px] text-red-600 hover:underline" onClick={() => setHiddenAttributeColumns(new Set())}>Zobrazit vše</button>
                                <span className="text-slate-300">|</span>
                                <button type="button" className="text-[10px] text-slate-600 hover:underline" onClick={() => setHiddenAttributeColumns(new Set([0,1,2,3,4,5,6,7,8,9,10,11,12,13]))}>Skrýt vše</button>
                              </div>
                            </div>
                            {Object.entries(ATTRIBUTE_COLUMNS_HIDEABLE).map(([k, label]) => {
                              const idx = Number(k);
                              return (
                                <label key={idx} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
                                  <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-red-600" checked={hiddenAttributeColumns.has(idx)} onChange={() => toggleAttributeColumn(idx)} />
                                  {label}
                                </label>
                              );
                            })}
                          </div>
                        </>
                      )}
                    </div>
                    <div className="h-4 w-px bg-slate-300" />
                    <button
                      className="rounded border border-slate-300 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                      onClick={selectAllAttributes}
                    >
                      Označit všechny
                    </button>
                    {selectedAttributes.size > 0 && onDuplicateAttributesToObjects && (
                      <button
                        className="rounded border border-red-300 bg-red-50 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
                        onClick={() => setDuplicateToObjectsDialogType("attributes")}
                      >
                        Duplikovat do…
                      </button>
                    )}
                    {selectedAttributes.size > 0 && (
                      <button
                        className="rounded border border-red-300 bg-red-50 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
                        onClick={deleteSelectedAttributes}
                      >
                        Smazat označené ({selectedAttributes.size})
                      </button>
                    )}
                  </>
                )}
              </div>
              {visibleAttributes.length === 0 ? (
                <div className="rounded border border-dashed border-slate-300 p-3 text-sm text-slate-600">
                  Žádné atributy. Přidejte atribut.
                </div>
              ) : (
                <>
              <div className="text-xs text-slate-500">Ifc attributes (Name, Description, Tag ...)</div>
              <div className="overflow-x-auto overflow-y-visible rounded border border-slate-200" style={{ maxWidth: "100%" }}>
                <table className="text-sm table-fixed" style={{ tableLayout: "fixed", minWidth: Math.max(400, [0,1,2,3,4,5,6,7,8,9,10,11,12,13].filter((i) => !hiddenAttributeColumns.has(i)).reduce((s, i) => s + (attributeTableColWidths[i] ?? DEFAULT_ATTRIBUTE_COL_WIDTHS[i]), 0)) }}>
                  <colgroup>
                    {[0,1,2,3,4,5,6,7,8,9,10,11,12,13].filter((i) => !hiddenAttributeColumns.has(i)).map((i) => (
                      <col key={i} style={{ width: attributeTableColWidths[i] ?? DEFAULT_ATTRIBUTE_COL_WIDTHS[i] }} />
                    ))}
                  </colgroup>
                  <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                    <tr>
                      {!hiddenAttributeColumns.has(0) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1" />
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "attribute", col: 0 }); resizingStartX.current = e.clientX; resizingStartW.current = attributeTableColWidths[0] ?? DEFAULT_ATTRIBUTE_COL_WIDTHS[0]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenAttributeColumns.has(1) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1">Výskyt</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "attribute", col: 1 }); resizingStartX.current = e.clientX; resizingStartW.current = attributeTableColWidths[1] ?? DEFAULT_ATTRIBUTE_COL_WIDTHS[1]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenAttributeColumns.has(2) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1">Atribut</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "attribute", col: 2 }); resizingStartX.current = e.clientX; resizingStartW.current = attributeTableColWidths[2] ?? DEFAULT_ATTRIBUTE_COL_WIDTHS[2]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenAttributeColumns.has(3) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1">Datový typ</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "attribute", col: 3 }); resizingStartX.current = e.clientX; resizingStartW.current = attributeTableColWidths[3] ?? DEFAULT_ATTRIBUTE_COL_WIDTHS[3]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenAttributeColumns.has(4) && (
                        <th className="px-2 py-2 relative select-none">
                          <div className="flex items-center gap-1 pr-1">
                            <span>Omezení</span>
                            <DocLink href="https://github.com/buildingSMART/IDS/blob/development/Documentation/UserManual/restrictions.md" label="Restrictions" type="ids" />
                          </div>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "attribute", col: 4 }); resizingStartX.current = e.clientX; resizingStartW.current = attributeTableColWidths[4] ?? DEFAULT_ATTRIBUTE_COL_WIDTHS[4]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenAttributeColumns.has(5) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1">Hodnota</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "attribute", col: 5 }); resizingStartX.current = e.clientX; resizingStartW.current = attributeTableColWidths[5] ?? DEFAULT_ATTRIBUTE_COL_WIDTHS[5]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenAttributeColumns.has(6) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1">URI</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "attribute", col: 6 }); resizingStartX.current = e.clientX; resizingStartW.current = attributeTableColWidths[6] ?? DEFAULT_ATTRIBUTE_COL_WIDTHS[6]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenAttributeColumns.has(7) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1">Popis</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "attribute", col: 7 }); resizingStartX.current = e.clientX; resizingStartW.current = attributeTableColWidths[7] ?? DEFAULT_ATTRIBUTE_COL_WIDTHS[7]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenAttributeColumns.has(8) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1">Poznámka</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "attribute", col: 8 }); resizingStartX.current = e.clientX; resizingStartW.current = attributeTableColWidths[8] ?? DEFAULT_ATTRIBUTE_COL_WIDTHS[8]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenAttributeColumns.has(9) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1">Příklady</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "attribute", col: 9 }); resizingStartX.current = e.clientX; resizingStartW.current = attributeTableColWidths[9] ?? DEFAULT_ATTRIBUTE_COL_WIDTHS[9]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenAttributeColumns.has(10) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1">Fáze</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "attribute", col: 10 }); resizingStartX.current = e.clientX; resizingStartW.current = attributeTableColWidths[10] ?? DEFAULT_ATTRIBUTE_COL_WIDTHS[10]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenAttributeColumns.has(11) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1">Účel užití</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "attribute", col: 11 }); resizingStartX.current = e.clientX; resizingStartW.current = attributeTableColWidths[11] ?? DEFAULT_ATTRIBUTE_COL_WIDTHS[11]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenAttributeColumns.has(12) && (
                        <th className="px-2 py-2 text-center relative select-none">
                          <div className="flex items-center justify-center gap-1 pr-1">
                            <span>Použitelnost</span>
                            <button type="button" className="flex items-center justify-center w-5 h-5 rounded-full bg-slate-200 text-slate-600 hover:bg-red-100 hover:text-red-600 text-xs font-bold flex-shrink-0" title="Použitelnost indikuje, jestli se daný požadavek vnímá dle IDS jako identifikační údaj.">?</button>
                          </div>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "attribute", col: 12 }); resizingStartX.current = e.clientX; resizingStartW.current = attributeTableColWidths[12] ?? DEFAULT_ATTRIBUTE_COL_WIDTHS[12]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenAttributeColumns.has(13) && (
                        <th className="px-2 py-2 text-right relative select-none">
                          <span className="block pr-1">Akce</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "attribute", col: 13 }); resizingStartX.current = e.clientX; resizingStartW.current = attributeTableColWidths[13] ?? DEFAULT_ATTRIBUTE_COL_WIDTHS[13]; }} aria-hidden />
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleAttributes.map((attr) => {
                      const isIdsProjected = isIdsProjectedRequirement(attr);
                      const dataType = attr.dataType ?? getAttributeDefinition(attr.attribute)?.dataType ?? ATTRIBUTE_DATA_TYPES_FALLBACK[attr.attribute] ?? "IfcLabel";
                      const isDisabled = attr.constraint === "FILLED" || attr.constraint === undefined;
                      const isPattern = attr.constraint === "PATTERN";
                      const isEnum = attr.constraint === "ENUM";
                      const attrDefForEntity = getAttributeDefinition(attr.attribute);
                      const attrNotForEntity = !!object.ifcEntity && !attrDefForEntity;
                      const hasInvalidEnumValues = isEnum && !!object.ifcEntity && (() => {
                        if (attrNotForEntity) return (attr.value ?? "").trim().length > 0;
                        const schemaVals = getEnumAllowedValuesForAttribute(attr.attribute);
                        if (!schemaVals?.length) return false;
                        const vals = parseEnumValues(attr.value ?? "");
                        return vals.some((v) => !schemaVals.includes(v));
                      })();
                      const showAttrWarning = attrNotForEntity || hasInvalidEnumValues;
                      
                      return (
                        <tr
                          key={attr.id}
                          className={`border-t border-slate-200 ${
                            isIdsProjected
                              ? "pointer-events-none bg-violet-50/70"
                              : showAttrWarning
                                ? "bg-red-50/50"
                                : ""
                          }`}
                          title={
                            isIdsProjected
                              ? `Odvozeno z IDS specifikace: ${getIdsProjectedSpecificationName(attr) ?? ""}`
                              : undefined
                          }
                        >
                          {!hiddenAttributeColumns.has(0) && (
                            <td className="px-2 py-2">
                              <input type="checkbox" className="h-4 w-4 cursor-pointer rounded border-slate-300 text-red-600 focus:ring-red-500" checked={selectedAttributes.has(attr.id)} onChange={() => toggleAttributeSelection(attr.id)} />
                            </td>
                          )}
                          {!hiddenAttributeColumns.has(1) && (
                            <td className="px-2 py-2">
                            <select 
                              className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                              value={attr.occurrence ?? "optional"} 
                              onChange={(e) => {
                                const newValue = e.target.value as "required" | "prohibited" | "optional";
                                if (selectedAttributes.has(attr.id) && selectedAttributes.size > 0) {
                                  updateSelectedAttributes({ occurrence: newValue });
                                } else {
                                  updateAttributeField(attr.id, { occurrence: newValue });
                                }
                              }}
                            >
                              <option value="required">Požadováno (required)</option>
                              <option value="prohibited">Zakázáno (prohibited)</option>
                              <option value="optional">Možné (optional)</option>
                            </select>
                            </td>
                          )}
                          {!hiddenAttributeColumns.has(2) && (
                            <td className="px-2 py-2" title={attrNotForEntity ? `Atribut ${attr.attribute} nepatří k entitě ${object.ifcEntity ?? ""}` : undefined}>
                            <div className="flex flex-col gap-0.5">
                              <select
                                className={`w-full rounded border px-2 py-1 text-sm ${showAttrWarning ? "border-red-400 bg-red-50 ring-1 ring-red-200" : "border-slate-300"}`}
                                value={attr.attribute}
                                onChange={(e) => updateAttributeField(attr.id, { attribute: e.target.value })}
                              >
                                {(() => {
                                  const opts = getAvailableAttributes(attr.id);
                                  const finalOpts =
                                    attr.attribute && !opts.includes(attr.attribute)
                                      ? [attr.attribute, ...opts]
                                      : opts;
                                  return finalOpts.map((opt: string) => (
                                    <option key={opt} value={opt}>{opt}</option>
                                  ));
                                })()}
                              </select>
                              {showCzTranslations && (
                                <input
                                  className="w-full rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-700 not-italic placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-400 focus:border-slate-400"
                                  placeholder="CZ"
                                  value={attr.attributeCz ?? ""}
                                  onChange={(e) => updateAttributeField(attr.id, { attributeCz: e.target.value || undefined })}
                                />
                              )}
                            </div>
                            </td>
                          )}
                          {!hiddenAttributeColumns.has(3) && (
                            <td className="px-2 py-2">
                            <select
                              className="w-full rounded border border-slate-300 bg-slate-50 px-2 py-1 text-sm text-slate-600"
                              value={dataType}
                              disabled
                            >
                              <option value={dataType}>{dataType}</option>
                            </select>
                            </td>
                          )}
                          {!hiddenAttributeColumns.has(4) && (
                            <td className="px-2 py-2">
                            <select 
                              className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                              value={attr.constraint ?? "FILLED"} 
                              onChange={(e) => updateAttributeField(attr.id, { constraint: e.target.value as any })}
                            >
                              {ATTRIBUTE_CONSTRAINT_OPTIONS.map((opt) => {
                                const allowed = isAttributeConstraintAllowed(attr.attribute, opt.value, dataType);
                                return (
                                  <option key={opt.value} value={opt.value} disabled={!allowed}>
                                    {opt.label}
                                  </option>
                                );
                              })}
                            </select>
                            </td>
                          )}
                          {!hiddenAttributeColumns.has(5) && (
                            <td className="px-2 py-2">
                            {(() => {
                              // Pro PATTERN zobrazit speciální UI + odkazy
                              if (isPattern && !isDisabled) {
                                return (
                                  <div className="flex items-center gap-1">
                                    <input
                                      className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                                      value={attr.value ?? ""}
                                      onChange={(e) => updateAttributeField(attr.id, { value: e.target.value })}
                                      placeholder='Regex pattern (např. ^DT[0-9]{2}$)'
                                    />
                                    <a
                                      href="https://regex101.com/"
                                      target="_blank"
                                      rel="noreferrer"
                                      className="flex items-center text-slate-500 hover:text-red-600"
                                      title="Otevřít regex tester (regex101)"
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <svg aria-hidden xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
                                        <path d="M14 3h7v7h-2V6.41l-9.29 9.3-1.42-1.42 9.3-9.29H14V3ZM5 5h5v2H7v10h10v-3h2v5H5V5Z" />
                                      </svg>
                                    </a>
                                  </div>
                                );
                              }

                              // Pro ENUM (výčet) – inline hodnoty nebo číselník + badges + nabídka uložení
                              if (isEnum && !isDisabled) {
                                const linkedCodeListId = (attr.extensions?.[ENUM_CODELIST_ID_KEY] as string | undefined) ?? undefined;
                                const linkedCodeList = linkedCodeListId ? codeLists.find((c) => c.id === linkedCodeListId) : undefined;
                                const values = linkedCodeList ? (linkedCodeList.values ?? []) : parseEnumValues(attr.value ?? "");
                                const schemaEnumValues = getEnumAllowedValuesForAttribute(attr.attribute);
                                const displayValues = values.slice(0, 24);
                                const remaining = values.length - displayValues.length;

                                const detachFromCodeList = () => {
                                  const nextExtensions = { ...(attr.extensions ?? {}) } as Record<string, unknown>;
                                  delete (nextExtensions as any)[ENUM_CODELIST_ID_KEY];
                                  updateAttributeField(attr.id, { extensions: nextExtensions });
                                };

                                const linkToCodeList = (id: string) => {
                                  const list = codeLists.find((c) => c.id === id);
                                  if (!list) return;
                                  const nextExtensions = { ...(attr.extensions ?? {}) } as Record<string, unknown>;
                                  nextExtensions[ENUM_CODELIST_ID_KEY] = list.id;
                                  updateAttributeField(attr.id, { extensions: nextExtensions, value: formatEnumValues(list.values ?? []) });
                                };

                                return (
                                  <div className={`flex flex-col gap-1 ${showAttrWarning ? "rounded ring-1 ring-red-300 bg-red-50/30 p-1" : ""}`}>
                                    <div className="flex items-center gap-1">
                                      <select
                                        className="rounded border border-slate-300 px-2 py-1 text-xs"
                                        value={linkedCodeListId ? `codelist:${linkedCodeListId}` : "inline"}
                                        onChange={(e) => {
                                          const v = e.target.value;
                                          if (v === "inline") {
                                            detachFromCodeList();
                                            return;
                                          }
                                          if (v.startsWith("codelist:")) {
                                            linkToCodeList(v.replace("codelist:", ""));
                                          }
                                        }}
                                      >
                                        <option value="inline">Vlastní</option>
                                        {codeLists.length > 0 && <option disabled>— Číselníky —</option>}
                                        {codeLists.map((cl) => (
                                          <option key={cl.id} value={`codelist:${cl.id}`}>
                                            {cl.name}
                                          </option>
                                        ))}
                                      </select>
                                      {linkedCodeListId && (
                                        <button
                                          className="rounded border border-slate-300 px-2 py-1 text-[11px] hover:bg-slate-50"
                                          onClick={detachFromCodeList}
                                          title="Odpojit od číselníku (ponechat hodnoty jako inline)"
                                        >
                                          Odpojit
                                        </button>
                                      )}
                                      {schemaEnumValues && schemaEnumValues.length > 0 && !linkedCodeListId && (
                                        <button
                                          className="rounded border border-slate-300 px-2 py-1 text-[11px] hover:bg-slate-50"
                                          onClick={() => updateAttributeField(attr.id, { value: formatEnumValues(schemaEnumValues) })}
                                          title="Zkopírovat IFC předdefinované hodnoty do výčtu"
                                        >
                                          Použít IFC hodnoty
                                        </button>
                                      )}
                                    </div>

                                    {!linkedCodeListId ? (
                                      <div className="flex items-center gap-1">
                                        <input
                                          className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                                          placeholder="Napiš hodnotu a stiskni Enter"
                                          value={enumDraftByAttrId[attr.id] ?? ""}
                                          onChange={(e) =>
                                            setEnumDraftByAttrId((prev) => ({ ...prev, [attr.id]: e.target.value }))
                                          }
                                          onKeyDown={(e) => {
                                            if (e.key !== "Enter") return;
                                            e.preventDefault();
                                            const raw = (enumDraftByAttrId[attr.id] ?? "").trim();
                                            if (!raw) return;
                                            const nextValues = Array.from(new Set([...values, raw]));
                                            updateAttributeField(attr.id, { value: formatEnumValues(nextValues) });
                                            setEnumDraftByAttrId((prev) => ({ ...prev, [attr.id]: "" }));
                                          }}
                                        />
                                        <button
                                          className={`flex items-center rounded border px-2 py-1 text-[11px] ${
                                            values.length === 0
                                              ? "border-slate-200 text-slate-400 cursor-not-allowed"
                                              : "border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 hover:border-emerald-400"
                                          }`}
                                          disabled={values.length === 0}
                                          title="Uložit jako číselník a přiřadit"
                                          onClick={() => {
                                            const suggestedName = (attr.attribute || "").trim() || "Výčet";
                                            setEnumSaveDialog({
                                              propertyId: attr.id,
                                              name: suggestedName,
                                              values,
                                              type: "attribute",
                                            });
                                          }}
                                        >
                                          <svg
                                            aria-hidden
                                            xmlns="http://www.w3.org/2000/svg"
                                            viewBox="0 0 24 24"
                                            fill="currentColor"
                                            className="h-4 w-4"
                                          >
                                            <path d="M6 2h11l3 3v17H4V4a2 2 0 0 1 2-2Zm12 8V6.5L16.5 5H6v5h12ZM6 20h12v-8H6v8Zm2-6h8v4H8v-4Z" />
                                          </svg>
                                        </button>
                                      </div>
                                    ) : (
                                      <div className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-600">
                                        Používá číselník: <span className="font-semibold text-slate-800">{linkedCodeList?.name ?? linkedCodeListId}</span>
                                      </div>
                                    )}

                                    <div className="flex flex-wrap gap-1">
                                      {displayValues.map((v) => {
                                        const attrDef = getAttributeDefinition(attr.attribute);
                                        const attrNotForEntity = !!object.ifcEntity && !attrDef;
                                        const valueNotInAllowed = schemaEnumValues && schemaEnumValues.length > 0 && !schemaEnumValues.includes(v);
                                        const isInvalid = valueNotInAllowed || attrNotForEntity;
                                        return (
                                        <span
                                          key={v}
                                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${isInvalid ? "bg-red-100 text-red-700 ring-1 ring-red-300" : "bg-slate-100 text-slate-700"}`}
                                          title={isInvalid ? (attrNotForEntity ? `${v} – atribut ${attr.attribute} nepatří k entitě ${object.ifcEntity ?? ""}` : `${v} – neplatná hodnota pro entitu ${object.ifcEntity ?? ""}`) : v}
                                        >
                                          <span>{v}</span>
                                          {!linkedCodeListId && (
                                            <button
                                              className={isInvalid ? "text-red-500 hover:text-red-800" : "text-slate-400 hover:text-slate-700"}
                                              title={isInvalid ? "Odebrat neplatnou hodnotu" : "Odebrat hodnotu"}
                                              onClick={() => {
                                                const nextValues = values.filter((x) => x !== v);
                                                updateAttributeField(attr.id, { value: formatEnumValues(nextValues) });
                                              }}
                                            >
                                              ×
                                            </button>
                                          )}
                                        </span>
                                        );
                                      })}
                                      {remaining > 0 && (
                                        <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] text-slate-700">
                                          +{remaining}
                                        </span>
                                      )}
                                      {values.length === 0 && (
                                        <span className="text-[11px] text-slate-400">Žádné hodnoty výčtu.</span>
                                      )}
                                    </div>
                                  </div>
                                );
                              }
                              
                              // Pro FILLED (Žádné) - editovatelné pole s respektováním datového typu
                              if (isDisabled) {
                                const isBool = isIfcBooleanType(dataType);
                                const isNumeric = isIfcNumericLikeType(dataType);
                                
                                if (isBool) {
                                  return (
                                    <select
                                      className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                                      value={attr.value ?? ""}
                                      onChange={(e) => updateAttributeField(attr.id, { value: e.target.value })}
                                    >
                                      <option value="">Bez požadavku</option>
                                      <option value="TRUE">TRUE</option>
                                      <option value="FALSE">FALSE</option>
                                    </select>
                                  );
                                }
                                
                                if (isNumeric) {
                                  return (
                                    <input
                                      type="number"
                                      className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                                      value={attr.value ?? ""}
                                      onChange={(e) => updateAttributeField(attr.id, { value: e.target.value })}
                                      placeholder="Bez požadavku"
                                    />
                                  );
                                }
                                
                                return (
                                  <input
                                    className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                                    value={attr.value ?? ""}
                                    onChange={(e) => updateAttributeField(attr.id, { value: e.target.value })}
                                    placeholder="Bez požadavku"
                                  />
                                );
                              }
                              
                              // Standardní input
                              return (
                                <input
                                  className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                                  value={attr.value ?? ""}
                                  onChange={(e) => updateAttributeField(attr.id, { value: e.target.value })}
                                  placeholder="Hodnota"
                                />
                              );
                            })()}
                            {showCzTranslations && (attr.constraint !== "ENUM" || !attr.extensions?.[ENUM_CODELIST_ID_KEY]) && (
                              <input
                                className="mt-1 w-full rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-700 not-italic placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-400 focus:border-slate-400"
                                placeholder={attr.constraint === "ENUM" ? "Výčet CZ (oddělte ;)" : "CZ"}
                                value={attr.valueCz ?? ""}
                                onChange={(e) => updateAttributeField(attr.id, { valueCz: e.target.value || undefined })}
                              />
                            )}
                          </td>
                          )}
                          {!hiddenAttributeColumns.has(6) && (
                            <td className="px-2 py-2">
                              <input type="text" className="w-full rounded border border-slate-300 px-2 py-1 text-sm" value={attr.uri ?? ""} onChange={(e) => updateAttributeField(attr.id, { uri: e.target.value })} placeholder="URI" />
                            </td>
                          )}
                          {!hiddenAttributeColumns.has(7) && (
                            <td className="px-2 py-2">
                              <input className="w-full rounded border border-slate-300 px-2 py-1 text-sm" value={attr.popis ?? ""} onChange={(e) => updateAttributeField(attr.id, { popis: e.target.value })} placeholder="Popis" />
                            </td>
                          )}
                          {!hiddenAttributeColumns.has(8) && (
                            <td className="px-2 py-2">
                              <input className="w-full rounded border border-slate-300 px-2 py-1 text-sm" value={attr.note ?? ""} onChange={(e) => updateAttributeField(attr.id, { note: e.target.value })} placeholder="Poznámka" />
                            </td>
                          )}
                          {!hiddenAttributeColumns.has(9) && (
                            <td className="px-2 py-2">
                              <input className="w-full rounded border border-slate-300 px-2 py-1 text-sm" value={attr.priklady ?? ""} onChange={(e) => updateAttributeField(attr.id, { priklady: e.target.value })} placeholder="Příklady" />
                            </td>
                          )}
                          {!hiddenAttributeColumns.has(10) && (
                            <td className="px-2 py-2">
                            <PhaseSelector
                              phases={phases}
                              value={attr.phases}
                              onChange={(ids) => updateAttributeField(attr.id, { phases: ids })}
                            />
                            </td>
                          )}
                          {!hiddenAttributeColumns.has(11) && (
                            <td className="px-2 py-2">
                            <UseCaseMultiSelect
                              entries={project?.purposeOfUseEntries ?? []}
                              value={attr.useCaseIds ?? []}
                              onChange={(ids) => updateAttributeField(attr.id, { useCaseMode: "custom", useCaseIds: ids })}
                            />
                            </td>
                          )}
                          {!hiddenAttributeColumns.has(12) && (
                            <td className="px-2 py-2 text-center">
                              <input type="checkbox" className="h-4 w-4 cursor-pointer rounded border-slate-300 text-green-600 focus:ring-green-500" checked={attr.isApplicability ?? false} onChange={(e) => updateAttributeField(attr.id, { isApplicability: e.target.checked })} title="Pokud je zaškrtnuto, požadavek bude v části Použitelnost (applicability)" />
                            </td>
                          )}
                          {!hiddenAttributeColumns.has(13) && (
                            <td className="px-2 py-2 text-right">
                              {isIdsProjected
                                ? renderIdsEditAction(attr)
                                : (
                                  <button className="text-xs text-red-600 hover:underline" onClick={() => removeRequirement("attributes", attr.id)}>
                                    Odebrat
                                  </button>
                                )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
                </>
              )}
            </div>
            );
          })()}

          {activeTab === "properties" && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <DocLink 
                  href="https://github.com/buildingSMART/IDS/blob/development/Documentation/UserManual/property-facet.md"
                  label="Property Facet"
                  type="ids"
                />
                <button className="rounded border border-blue-300 bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100" onClick={() => addPropertyGroup("PSET")}>
                  Přidat skupinu vlastností Pset
                </button>
                {propertyGroups.length >= 3 && (
                  <>
                    <div className="h-4 w-px bg-slate-300" />
                    <button
                      className="rounded border border-slate-300 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                      onClick={collapseAllGroups}
                      title="Sbalit všechny skupiny"
                    >
                      Sbalit vše
                    </button>
                    <button
                      className="rounded border border-slate-300 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                      onClick={expandAllGroups}
                      title="Rozbalit všechny skupiny"
                    >
                      Rozbalit vše
                    </button>
                  </>
                )}
                <button className="rounded border border-emerald-300 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100" onClick={() => addPropertyGroup("QTO")}>
                  Přidat skupinu vlastností Qto
                </button>
                <button className="rounded border border-amber-300 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700 hover:bg-amber-100" onClick={() => addPropertyGroup("CUSTOM")}>
                  Přidat vlastní skupinu vlastností
                </button>
                {propertyGroups.length > 0 && (
                  <>
                    <div className="h-4 w-px bg-slate-300" />
                    <div className="relative">
                      <button
                        className="rounded border border-slate-300 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 flex items-center gap-1"
                        onClick={() => setPropertyColumnMenuOpen((o) => !o)}
                        title="Zobrazit nebo skrýt sloupce tabulky"
                      >
                        Sloupce
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </button>
                      {propertyColumnMenuOpen && (
                        <>
                          <div className="fixed inset-0 z-40" onClick={() => setPropertyColumnMenuOpen(false)} aria-hidden />
                          <div className="absolute left-0 top-full mt-1 z-50 min-w-[200px] rounded-md border border-slate-200 bg-white py-2 shadow-lg">
                            <div className="flex items-center justify-between gap-2 px-3 py-1">
                              <span className="text-[11px] font-semibold uppercase text-slate-500">Sloupce</span>
                              <div className="flex gap-1">
                                <button type="button" className="text-[10px] text-red-600 hover:underline" onClick={() => setHiddenPropertyColumns(new Set())}>Zobrazit vše</button>
                                <span className="text-slate-300">|</span>
                                <button type="button" className="text-[10px] text-slate-600 hover:underline" onClick={() => setHiddenPropertyColumns(new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))}>Skrýt vše</button>
                              </div>
                            </div>
                            {Object.entries(PROPERTY_COLUMNS_HIDEABLE).map(([k, label]) => {
                              const idx = Number(k);
                              return (
                              <label key={idx} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
                                <input
                                  type="checkbox"
                                  className="h-4 w-4 rounded border-slate-300 text-red-600"
                                  checked={hiddenPropertyColumns.has(idx)}
                                  onChange={() => togglePropertyColumn(idx)}
                                />
                                {label}
                              </label>
                            );
                            })}
                          </div>
                        </>
                      )}
                    </div>
                    <button
                      className="rounded border border-slate-300 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                      onClick={selectAllGroups}
                    >
                      Označit všechny skupiny
                    </button>
                    {selectedGroups.size > 0 && onDuplicatePropertyGroupsToObjects && (
                      <button
                        className="rounded border border-red-300 bg-red-50 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
                        onClick={() => setDuplicatePropertyGroupsDialogOpen(true)}
                      >
                        Duplikovat do…
                      </button>
                    )}
                    {(selectedGroups.size > 0 || selectedProperties.size > 0) && (
                      <button
                        className="rounded border border-slate-300 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                        onClick={copySelectedWithinElement}
                        title="Zkopírovat označené skupiny nebo vlastnosti v rámci tohoto prvku"
                      >
                        Kopírovat v rámci prvku
                      </button>
                    )}
                    {(selectedGroups.size > 0 || selectedProperties.size > 0) && (
                      <button
                        className="rounded border border-red-300 bg-red-50 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
                        onClick={deleteSelectedItems}
                      >
                        Smazat označené ({selectedGroups.size + selectedProperties.size})
                      </button>
                    )}
                  </>
                )}
              </div>

              {invalidSchemaGroups.length > 0 && (
                <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
                  <div className="font-semibold">Některé skupiny neodpovídají zvolenému PredefinedType</div>
                  <div className="mt-1 text-xs text-red-700">
                    PredefinedType: <span className="font-semibold">{effectivePredefinedValue ?? "není vybrán"}</span>
                  </div>
                  <div className="mt-2 text-xs">
                    {invalidSchemaGroups.map((g) => (
                      <div key={g.key}>
                        - {g.source}: <span className="font-semibold">{g.name}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {propertyGroups.length === 0 ? (
                <div className="rounded border border-dashed border-slate-300 p-3 text-sm text-slate-600">
                  Žádné vlastnosti. Přidejte skupinu Pset/Qto nebo vlastní.
                </div>
              ) : (
              <div className="space-y-3 pr-1">
                {propertyGroups.map((group) => {
                const expanded = expandedGroups[group.key] ?? true;
                const isIdsOnlyGroup = group.properties.every(isIdsProjectedRequirement);
                const idsSourceProperty = isIdsOnlyGroup ? group.properties[0] : undefined;
                const idsSpecificationId = getIdsProjectedSpecificationId(idsSourceProperty);
                const idsFacetId = getIdsProjectedFacetId(idsSourceProperty);
                const idsFacetSection = getIdsProjectedFacetSection(idsSourceProperty);
                const idsSpecification = idsSpecificationId
                  ? project?.idsSpecifications?.find((item) => item.id === idsSpecificationId)
                  : undefined;
                const idsSpecificationOrdinal = idsSpecificationId
                  ? idsSpecificationOrdinalById.get(idsSpecificationId)
                  : undefined;
                const idsPropertySetConstraint =
                  getIdsProjectedPropertySetConstraint(idsSourceProperty);
                const idsSpecificationName = isIdsOnlyGroup
                  ? getIdsProjectedSpecificationName(group.properties[0])
                  : undefined;
                const isGroupLocked = isIdsOnlyGroup || isPropertyGroupLocked(group.key);
                const isSchemaBound = group.source !== "CUSTOM";
                const schemaOptionsRaw = group.source === "PSET" ? allPsets : allQtos;
                const schemaOptions = mergeAssignmentsByName(schemaOptionsRaw);
                const usedSchemaGroupNames = new Set(
                  propertyGroups
                    .filter(
                      (g) =>
                        g.key !== group.key &&
                        g.source === group.source &&
                        g.source !== "CUSTOM" &&
                        g.psetName &&
                        !g.psetName.startsWith("_NEW_"),
                    )
                    .map((g) => g.psetName as string),
                );
                const schemaOptionsFiltered = schemaOptions.filter(
                  (item) => item.name === group.psetName || !usedSchemaGroupNames.has(item.name),
                );
                const propertyOptions = (currentId?: string) =>
                  isSchemaBound ? propertyOptionsForGroup(group.source, group.psetName, currentId) : [];
                const isTempGroup = group.psetName?.startsWith("_NEW_");
                const displayPsetName = isTempGroup ? "" : (group.psetName ?? "");
                const displayedIdsPsetName = idsPropertySetConstraint
                  ? formatIdsConstraint(idsPropertySetConstraint)
                  : displayPsetName;
                const isInvalidGroup =
                  isSchemaBound && !!group.psetName && !isTempGroup && !isGroupAllowed(group.source, group.psetName);
                  const docHref =
                    isSchemaBound && group.psetName && !isTempGroup
                      ? getIfcPsetDocUrl(ifcSchemaVersion, group.psetName)
                      : undefined;

                const groupColors = {
                  PSET: {
                    border: "border-blue-300",
                    badge: "bg-blue-100 text-blue-800",
                    rowBorder: "border-l-4 border-blue-400",
                  },
                  QTO: {
                    border: "border-emerald-300",
                    badge: "bg-emerald-100 text-emerald-800",
                    rowBorder: "border-l-4 border-emerald-400",
                  },
                  CUSTOM: {
                    border: "border-amber-300",
                    badge: "bg-amber-100 text-amber-800",
                    rowBorder: "border-l-4 border-amber-400",
                  },
                };
                const colors = groupColors[group.source] || groupColors.CUSTOM;
                const cardBorder = isInvalidGroup ? "border-red-400" : colors.border;
                const badgeClass = isInvalidGroup ? "bg-red-100 text-red-800" : colors.badge;

                return (
                  <div key={group.key} className={`rounded border-2 ${cardBorder} bg-white shadow-sm`}>
                    <div
                      className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b ${cardBorder} px-3 py-2`}
                    >
                      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                        <input
                          type="checkbox"
                          className="h-4 w-4 shrink-0 cursor-pointer rounded border-slate-300 text-red-600 focus:ring-red-500 disabled:cursor-not-allowed disabled:opacity-50"
                          checked={selectedGroups.has(group.key)}
                          onChange={() => toggleGroupSelection(group.key)}
                          onClick={(e) => e.stopPropagation()}
                          disabled={isIdsOnlyGroup}
                        />
                        <button
                          className="flex shrink-0 items-center justify-center rounded border border-slate-300 p-1.5 hover:bg-slate-50"
                          onClick={() => toggleGroup(group.key)}
                          title={expanded ? "Skrýt" : "Zobrazit"}
                        >
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className={`h-4 w-4 text-slate-600 transition-transform ${expanded ? "rotate-180" : ""}`}
                          >
                            <path d="m6 9 6 6 6-6" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className={`flex shrink-0 items-center justify-center rounded border p-1.5 ${
                            isGroupLocked
                              ? "border-amber-400 bg-amber-50 text-amber-800 hover:bg-amber-100"
                              : "border-slate-300 text-slate-600 hover:bg-slate-50"
                          }`}
                          onClick={() => togglePropertyGroupLock(group.key)}
                          disabled={isLocked || isIdsOnlyGroup}
                          title={isIdsOnlyGroup ? "Odvozeno z canonical IDS specifikace" : isGroupLocked ? "Odemknout skupinu vlastností" : "Zamknout skupinu vlastností"}
                          aria-label={isGroupLocked ? "Odemknout skupinu vlastností" : "Zamknout skupinu vlastností"}
                        >
                          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            {isGroupLocked ? (
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                            ) : (
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
                            )}
                          </svg>
                        </button>
                        <span className={`shrink-0 rounded px-2 py-1 text-[11px] font-semibold uppercase ${badgeClass}`}>
                          {group.source === "PSET" ? "Pset dle IFC" : group.source === "QTO" ? "Qto dle IFC" : "Vlastní"}
                        </span>
                        {isIdsOnlyGroup && (
                          <span
                            className="shrink-0 rounded bg-violet-100 px-2 py-1 text-[11px] font-semibold text-violet-800"
                            title={idsSpecificationName}
                          >
                            IDS · {idsSpecificationName}
                          </span>
                        )}
                        {isIdsOnlyGroup && idsSpecification && (
                          <button
                            type="button"
                            data-testid={`edit-ids-property-group-${idsFacetId ?? idsSpecification.id}`}
                            className="shrink-0 rounded border border-violet-300 bg-white px-2 py-1 text-[11px] font-semibold text-violet-800 hover:bg-violet-100"
                            onClick={() => openIdsSpecificationEditor(idsSpecification, idsFacetId)}
                            title={`Otevřít zdrojový facet v ${
                              idsFacetSection === "applicability" ? "Použitelnosti" : "Požadavcích"
                            }`}
                          >
                            Upravit IDS{idsSpecificationOrdinal ? ` #${idsSpecificationOrdinal}` : ""}
                            {" · "}
                            název skupiny
                          </button>
                        )}
                        {isInvalidGroup && (
                          <span className="shrink-0 rounded bg-red-100 px-2 py-1 text-[11px] font-semibold uppercase text-red-800">
                            Neplatné pro PredefinedType
                          </span>
                        )}
                        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                          Název skupiny vlastností
                        </span>
                        {isIdsOnlyGroup ? (
                          <input
                            data-testid={`ids-projected-property-set-${idsFacetId ?? group.key}`}
                            aria-label="Název skupiny vlastností z IDS"
                            className="h-8 w-[min(24rem,45vw)] min-w-[11rem] max-w-full shrink-0 rounded border border-violet-200 bg-violet-50 px-2 py-1 text-sm text-violet-950"
                            value={displayedIdsPsetName}
                            readOnly
                            title="Hodnota je projekcí kanonického IDS facetu. Upravte ji přes tlačítko Upravit IDS."
                          />
                        ) : group.source === "CUSTOM" ? (
                          <>
                            <input
                              aria-label="Název skupiny vlastností"
                              className={`h-8 w-[min(18rem,40vw)] min-w-[8rem] max-w-full shrink-0 rounded border px-2 py-1 text-sm ${
                                customGroupErrors[group.key] ? "border-red-300 bg-red-50" : "border-slate-300"
                              }`}
                              value={customGroupNames[group.key] !== undefined ? customGroupNames[group.key] : (group.psetName && !group.psetName.startsWith("_NEW_") ? group.psetName : "")}
                              onChange={(e) => renameGroup(group.key, e.target.value, true)}
                              onBlur={() => handleCustomGroupBlur(group.key)}
                              placeholder="Vyplnit název"
                              disabled={isGroupLocked}
                            />
                            {customGroupErrors[group.key] && (
                              <span className="shrink-0 text-xs text-red-600 whitespace-nowrap">{customGroupErrors[group.key]}</span>
                            )}
                            {showCzTranslations && group.psetName && !group.psetName.startsWith("_NEW_") && (
                              <input
                                className="h-8 min-w-[7rem] flex-1 basis-[10rem] rounded-md border border-slate-200 bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700 not-italic placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-400 focus:border-slate-400"
                                placeholder="Skupina CZ"
                                value={group.properties[0]?.psetNameCz ?? ""}
                                onChange={(e) => {
                                  const v = e.target.value || undefined;
                                  const groupKeyVal = group.key;
                                  updateRequirements((reqs) => {
                                    reqs.properties = reqs.properties.map((p) =>
                                      groupKey(p.source, p.psetName) === groupKeyVal ? { ...p, psetNameCz: v } : p
                                    );
                                  });
                                }}
                                title="Překlad skupiny do češtiny"
                                disabled={isGroupLocked}
                              />
                            )}
                          </>
                        ) : (
                          <>
                            {docHref && (
                              <DocLink href={docHref} label={(displayPsetName || group.psetName) ?? "IFC"} type="ifc" />
                            )}
                            <select
                              aria-label="Název skupiny vlastností"
                              className={`h-8 w-auto min-w-[11rem] max-w-[min(24rem,40vw)] shrink-0 rounded border px-2 py-1 text-sm ${
                                isInvalidGroup ? "border-red-400 bg-red-50 text-red-900" : "border-slate-300"
                              }`}
                              value={displayPsetName}
                              onChange={(e) => renameGroup(group.key, e.target.value)}
                              disabled={isGroupLocked}
                            >
                              <option value="">Vyplnit název</option>
                              {!schemaOptions.some((o) => o.name === group.psetName) && group.psetName && !isTempGroup && (
                                <option value={group.psetName}>{group.psetName}</option>
                              )}
                              {schemaOptionsFiltered.map((item) => (
                                <option
                                  key={`${item.name}`}
                                  value={item.name}
                                  disabled={
                                    !item.hasGeneric &&
                                    (!effectivePredefinedValue ||
                                      !item.predefinedTypes.includes(normalizePredefinedForCompare(effectivePredefinedValue) ?? effectivePredefinedValue))
                                  }
                                >
                                  {item.name}
                                </option>
                              ))}
                            </select>
                            {displayPsetName ? <DocLink href={docHref} label={group.psetName ?? ""} /> : null}
                            {showCzTranslations && displayPsetName && (
                              <input
                                className="h-8 min-w-[7rem] flex-1 basis-0 rounded-md border border-slate-200 bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700 not-italic placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-400 focus:border-slate-400"
                                placeholder="Skupina CZ"
                                value={group.properties[0]?.psetNameCz ?? ""}
                                onChange={(e) => {
                                  const v = e.target.value || undefined;
                                  const groupKeyVal = group.key;
                                  updateRequirements((reqs) => {
                                    reqs.properties = reqs.properties.map((p) =>
                                      groupKey(p.source, p.psetName) === groupKeyVal ? { ...p, psetNameCz: v } : p
                                    );
                                  });
                                }}
                                title="Překlad skupiny do češtiny"
                                disabled={isGroupLocked}
                              />
                            )}
                            {isInvalidGroup && (
                              <div className="basis-full text-xs text-red-700 sm:basis-auto sm:max-w-md">
                                Skupina nepatří k aktuálnímu PredefinedType{" "}
                                <span className="font-semibold">{effectivePredefinedValue ?? "(není vybrán)"}</span>. Vyberte jiný
                                Pset/Qto nebo změňte PredefinedType.
                              </div>
                            )}
                          </>
                        )}
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-2">
                        <button className="rounded border border-slate-300 px-2 py-1 text-[11px] hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed" onClick={() => addPropertyToGroup(group.key)} disabled={isGroupLocked}>
                          Přidat vlastnost
                        </button>
                        {isSchemaBound && displayPsetName && displayPsetName.length > 0 && isGroupAllowed(group.source, group.psetName) && (
                          <button className="rounded border border-slate-300 px-2 py-1 text-[11px] hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed" onClick={() => addAllFromSchema(group.key)} disabled={isGroupLocked}>
                            Přidat všechny dle IFC
                          </button>
                        )}
                        <button className="rounded border border-red-300 px-2 py-1 text-[11px] text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed" onClick={() => deleteGroup(group.key)} disabled={isGroupLocked}>
                          Smazat skupinu
                        </button>
                      </div>
                    </div>

                    {expanded && (
                      <fieldset disabled={isGroupLocked} className="m-0 min-w-0 border-0 p-0">
                      <div className="overflow-x-auto overflow-y-visible px-3 py-2" style={{ maxWidth: "100%" }}>
                        {isGroupLocked && (
                          <div className="mb-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800">
                            {isIdsOnlyGroup
                              ? "Tato skupina je odvozená z kanonického IDS. Upravte zdrojový facet tlačítkem Upravit IDS v záhlaví skupiny."
                              : "Tato skupina je zamčená. Pro úpravy ji nejprve odemkněte."}
                          </div>
                        )}
                        {!isIdsOnlyGroup && group.psetName && !group.psetName.startsWith("_NEW_") && (
                          <div className="mb-2 flex flex-wrap items-center gap-2 rounded border border-slate-200 bg-slate-50/50 px-2 py-1.5">
                            <span className="text-xs font-medium text-slate-600">Výchozí účely užití pro tuto skupinu (dědi se na všechny vlastnosti):</span>
                            <UseCaseMultiSelect
                              entries={project?.purposeOfUseEntries ?? []}
                              value={object.psetUseCaseDefaults?.[group.psetName]}
                              onChange={(ids) => updateObject({ psetUseCaseDefaults: { ...object.psetUseCaseDefaults, [group.psetName as string]: ids } })}
                            />
                          </div>
                        )}
                        {group.properties.length === 0 && (
                          <div className="rounded border border-dashed border-slate-200 p-2 text-xs text-slate-600">
                            Skupina je prázdná. Přidejte vlastnost.
                          </div>
                        )}
                        {group.properties.length > 0 && (
                          <table
                            className="text-sm table-fixed"
                            style={{
                              tableLayout: "fixed",
                              minWidth: Math.max(120, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]
                                .filter((i) => !hiddenPropertyColumns.has(i))
                                .reduce((sum, i) => sum + (propertyTableColWidths[i] ?? DEFAULT_PROPERTY_COL_WIDTHS[i]), 0)),
                            }}
                          >
                            <colgroup>
                              {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]
                                .filter((i) => !hiddenPropertyColumns.has(i))
                                .map((i) => (
                                  <col key={i} style={{ width: propertyTableColWidths[i] ?? DEFAULT_PROPERTY_COL_WIDTHS[i] }} />
                                ))}
                            </colgroup>
                            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                              <tr>
                                {!hiddenPropertyColumns.has(0) && (
                                  <th className="px-2 py-2 relative select-none">
                                    {(selectedGroups.size > 0 || selectedProperties.size > 0) && (
                                      <button
                                        type="button"
                                        className="mb-1 flex items-center justify-center gap-1 rounded border border-slate-300 bg-slate-50 px-1.5 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
                                        onClick={copySelectedWithinElement}
                                        title="Zkopírovat označené v rámci prvku"
                                      >
                                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 shrink-0">
                                          <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                                          <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                                        </svg>
                                        Kopírovat
                                      </button>
                                    )}
                                    <span className="block pr-1" />
                                    <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "property", col: 0 }); resizingStartX.current = e.clientX; resizingStartW.current = propertyTableColWidths[0] ?? DEFAULT_PROPERTY_COL_WIDTHS[0]; }} aria-hidden />
                                  </th>
                                )}
                                {!hiddenPropertyColumns.has(1) && (
                                  <th className="px-2 py-2 relative select-none">
                                    <span className="block pr-1">Výskyt</span>
                                    <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "property", col: 1 }); resizingStartX.current = e.clientX; resizingStartW.current = propertyTableColWidths[1] ?? DEFAULT_PROPERTY_COL_WIDTHS[1]; }} aria-hidden />
                                  </th>
                                )}
                                {!hiddenPropertyColumns.has(2) && (
                                  <th className="px-2 py-2 relative select-none">
                                    <span className="block pr-1">Vlastnost</span>
                                    <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "property", col: 2 }); resizingStartX.current = e.clientX; resizingStartW.current = propertyTableColWidths[2] ?? DEFAULT_PROPERTY_COL_WIDTHS[2]; }} aria-hidden />
                                  </th>
                                )}
                                {!hiddenPropertyColumns.has(3) && (
                                  <th className="px-2 py-2 relative select-none">
                                    <span className="block pr-1">Datový typ</span>
                                    <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "property", col: 3 }); resizingStartX.current = e.clientX; resizingStartW.current = propertyTableColWidths[3] ?? DEFAULT_PROPERTY_COL_WIDTHS[3]; }} aria-hidden />
                                  </th>
                                )}
                                {!hiddenPropertyColumns.has(4) && (
                                  <th className="px-2 py-2 relative select-none">
                                    <div className="flex items-center gap-1 pr-1">
                                      <span>Omezení</span>
                                      <DocLink href="https://github.com/buildingSMART/IDS/blob/development/Documentation/UserManual/restrictions.md" label="Restrictions" type="ids" />
                                    </div>
                                    <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "property", col: 4 }); resizingStartX.current = e.clientX; resizingStartW.current = propertyTableColWidths[4] ?? DEFAULT_PROPERTY_COL_WIDTHS[4]; }} aria-hidden />
                                  </th>
                                )}
                                {!hiddenPropertyColumns.has(5) && (
                                  <th className="px-2 py-2 relative select-none">
                                    <span className="block pr-1">Hodnota</span>
                                    <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "property", col: 5 }); resizingStartX.current = e.clientX; resizingStartW.current = propertyTableColWidths[5] ?? DEFAULT_PROPERTY_COL_WIDTHS[5]; }} aria-hidden />
                                  </th>
                                )}
                                {!hiddenPropertyColumns.has(6) && (
                                  <th className="px-2 py-2 relative select-none">
                                    <span className="block pr-1">Jednotka</span>
                                    <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "property", col: 6 }); resizingStartX.current = e.clientX; resizingStartW.current = propertyTableColWidths[6] ?? DEFAULT_PROPERTY_COL_WIDTHS[6]; }} aria-hidden />
                                  </th>
                                )}
                                {!hiddenPropertyColumns.has(7) && (
                                  <th className="px-2 py-2 relative select-none">
                                    <span className="block pr-1">URI</span>
                                    <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "property", col: 7 }); resizingStartX.current = e.clientX; resizingStartW.current = propertyTableColWidths[7] ?? DEFAULT_PROPERTY_COL_WIDTHS[7]; }} aria-hidden />
                                  </th>
                                )}
                                {!hiddenPropertyColumns.has(8) && (
                                  <th className="px-2 py-2 relative select-none" colSpan={3}>
                                    <div className="flex items-center gap-1 pr-1">
                                      <span>Popis</span>
                                      {(group.source === "PSET" || group.source === "QTO") && group.psetName && !isTempGroup && (
                                        <button type="button" className="flex items-center gap-1 rounded border border-slate-300 bg-slate-50 px-1.5 py-0.5 text-slate-600 hover:bg-red-50 hover:text-red-600 hover:border-red-300 disabled:opacity-50 disabled:cursor-not-allowed text-xs font-medium" title="Propíš z bSDD Definition do sloupce Popis u všech vlastností v této skupině" onClick={() => fillDescriptionsFromBsdd(group.key)} disabled={fillingDescriptionsGroupKey === group.key || isGroupLocked}>
                                          {fillingDescriptionsGroupKey === group.key ? <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-red-600" /> : <><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 shrink-0"><path d="m6 9 6 6 6-6" /></svg><span>bSDD</span></>}
                                        </button>
                                      )}
                                      <span>· Poznámka · Příklady</span>
                                    </div>
                                    <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "property", col: 8 }); resizingStartX.current = e.clientX; resizingStartW.current = propertyTableColWidths[8] ?? DEFAULT_PROPERTY_COL_WIDTHS[8]; }} aria-hidden />
                                  </th>
                                )}
                                {!hiddenPropertyColumns.has(9) && (
                                  <th className="px-2 py-2 relative select-none">
                                    <span className="block pr-1">Fáze</span>
                                    <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "property", col: 9 }); resizingStartX.current = e.clientX; resizingStartW.current = propertyTableColWidths[9] ?? DEFAULT_PROPERTY_COL_WIDTHS[9]; }} aria-hidden />
                                  </th>
                                )}
                                {!hiddenPropertyColumns.has(10) && (
                                  <th className="px-2 py-2 relative select-none">
                                    <span className="block pr-1">Účel užití</span>
                                    <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "property", col: 10 }); resizingStartX.current = e.clientX; resizingStartW.current = propertyTableColWidths[10] ?? DEFAULT_PROPERTY_COL_WIDTHS[10]; }} aria-hidden />
                                  </th>
                                )}
                                {!hiddenPropertyColumns.has(11) && (
                                  <th className="px-2 py-2 text-center relative select-none">
                                    <div className="flex items-center justify-center gap-1 pr-1">
                                      <span>Použitelnost</span>
                                      <button type="button" className="flex items-center justify-center w-5 h-5 rounded-full bg-slate-200 text-slate-600 hover:bg-red-100 hover:text-red-600 text-xs font-bold flex-shrink-0" title="Použitelnost indikuje, jestli se daný požadavek vnímá dle IDS jako identifikační údaj.">?</button>
                                    </div>
                                    <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "property", col: 11 }); resizingStartX.current = e.clientX; resizingStartW.current = propertyTableColWidths[11] ?? DEFAULT_PROPERTY_COL_WIDTHS[11]; }} aria-hidden />
                                  </th>
                                )}
                                {!hiddenPropertyColumns.has(12) && (
                                  <th className="px-2 py-2 text-right relative select-none">
                                    <span className="block pr-1">Akce</span>
                                    <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "property", col: 12 }); resizingStartX.current = e.clientX; resizingStartW.current = propertyTableColWidths[12] ?? DEFAULT_PROPERTY_COL_WIDTHS[12]; }} aria-hidden />
                                  </th>
                                )}
                              </tr>
                            </thead>
                            <tbody>
                              {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].every((i) => hiddenPropertyColumns.has(i)) ? (
                                <tr>
                                  <td colSpan={15} className="px-4 py-6 text-center text-sm text-slate-500">
                                    Všechny sloupce jsou skryté. Zobrazte alespoň jeden v menu „Sloupce“.
                                  </td>
                                </tr>
                              ) : (
                              group.properties.map((prop) => (
                                <tr
                                  key={prop.id}
                                  className={`border-t border-slate-200 ${colors.rowBorder} ${
                                    isIdsProjectedRequirement(prop)
                                      ? "pointer-events-none bg-violet-50/70"
                                      : ""
                                  }`}
                                  title={
                                    isIdsProjectedRequirement(prop)
                                      ? `Odvozeno z IDS specifikace: ${getIdsProjectedSpecificationName(prop) ?? ""}`
                                      : undefined
                                  }
                                >
                                  {!hiddenPropertyColumns.has(0) && (
                                    <td className="px-2 py-2">
                                      <input
                                        type="checkbox"
                                        className="h-4 w-4 cursor-pointer rounded border-slate-300 text-red-600 focus:ring-red-500"
                                        checked={selectedProperties.has(prop.id)}
                                        onChange={() => togglePropertySelection(prop.id)}
                                      />
                                    </td>
                                  )}
                                  {!hiddenPropertyColumns.has(1) && (
                                    <td className="px-2 py-2">
                                      <select 
                                        className="w-full rounded border border-slate-300 px-2 py-1 text-sm" 
                                        value={prop.occurrence ?? "optional"} 
                                        onChange={(e) => updatePropertyField(prop.id, { occurrence: e.target.value as "required" | "prohibited" | "optional" })}
                                      >
                                        <option value="required">Požadováno (required)</option>
                                        <option value="prohibited">Zakázáno (prohibited)</option>
                                        <option value="optional">Možné (optional)</option>
                                      </select>
                                    </td>
                                  )}
                                  {!hiddenPropertyColumns.has(2) && (
                                    <td className="px-2 py-2">
                                    {isIdsProjectedRequirement(prop) ? (
                                      <input
                                        data-testid={`ids-projected-property-name-${getIdsProjectedFacetId(prop) ?? prop.id}`}
                                        aria-label="Název vlastnosti z IDS"
                                        className="w-full rounded border border-violet-200 bg-violet-50 px-2 py-1 text-sm text-violet-950"
                                        value={
                                          getIdsProjectedPropertyNameConstraint(prop)
                                            ? formatIdsConstraint(getIdsProjectedPropertyNameConstraint(prop)!)
                                            : prop.propertyName
                                        }
                                        readOnly
                                      />
                                    ) : group.source === "CUSTOM" || isTempGroup ? (
                                      <div className="flex flex-col gap-0.5">
                                        <input
                                          className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                                          value={(() => {
                                            const propPropertyName = prop.propertyName || "";
                                            const propPsetName = prop.psetName || "";
                                            
                                            // Vždy zobraz prázdný string, pokud propertyName obsahuje _NEW_ nebo se shoduje s psetName
                                            if (propPropertyName.startsWith("_NEW_") || propPropertyName === propPsetName) {
                                              return "";
                                            }
                                            return propPropertyName;
                                          })()}
                                          onChange={(e) => {
                                            const newValue = e.target.value;
                                            // Pokud uživatel zadá text začínající na _NEW_, ignoruj to a nastav prázdný string
                                            if (newValue.startsWith("_NEW_")) {
                                              updatePropertyField(prop.id, { propertyName: "", popis: "" });
                                            } else {
                                              updatePropertyField(prop.id, { propertyName: newValue });
                                            }
                                          }}
                                          placeholder="Vlastnost"
                                        />
                                        {showCzTranslations && (
                                          <input
                                            className="w-full rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-700 not-italic placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-400 focus:border-slate-400"
                                            placeholder="CZ"
                                            value={prop.propertyNameCz ?? ""}
                                            onChange={(e) => updatePropertyField(prop.id, { propertyNameCz: e.target.value || undefined })}
                                          />
                                        )}
                                      </div>
                                    ) : (
                                      <div className="flex flex-col gap-0.5">
                                        <div className="flex items-center gap-2">
                                          {prop.propertyName && (
                                            <DocLink
                                              href={getIfcPropertyDocUrl(ifcSchemaVersion, prop.propertyName)}
                                              label={prop.propertyName}
                                              type="ifc"
                                            />
                                          )}
                                          <select
                                            className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 text-sm"
                                            value={prop.propertyName}
                                            onChange={(e) => updatePropertyField(prop.id, { propertyName: e.target.value, popis: "" })}
                                            disabled={!group.psetName}
                                          >
                                            <option value="">— vybrat —</option>
                                            {propertyOptions(prop.id).map((pdef) => (
                                              <option key={pdef.name} value={pdef.name}>
                                                {pdef.name}
                                              </option>
                                            ))}
                                          </select>
                                        </div>
                                        {showCzTranslations && (
                                          <input
                                            className="mt-0.5 w-full rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-700 not-italic placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-400 focus:border-slate-400"
                                            placeholder="CZ"
                                            value={prop.propertyNameCz ?? ""}
                                            onChange={(e) => updatePropertyField(prop.id, { propertyNameCz: e.target.value || undefined })}
                                          />
                                        )}
                                      </div>
                                    )}
                                    </td>
                                  )}
                                  {!hiddenPropertyColumns.has(3) && (
                                    <td className="px-2 py-2">
                                      <select
                                        className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                                        value={prop.dataType}
                                        onChange={(e) => updatePropertyField(prop.id, { dataType: e.target.value })}
                                        disabled={group.source !== "CUSTOM"}
                                      >
                                        {getDataTypeOptionsForProp(prop).map((dt) => (
                                          <option key={dt} value={dt}>
                                            {dt}
                                          </option>
                                        ))}
                                      </select>
                                    </td>
                                  )}
                                  {!hiddenPropertyColumns.has(4) && (
                                    <td className="px-2 py-2">
                                      <select 
                                        className="w-full rounded border border-slate-300 px-2 py-1 text-sm" 
                                        value={prop.constraint ?? "FILLED"} 
                                        onChange={(e) => updatePropertyField(prop.id, { constraint: e.target.value as any })}
                                      >
                                      {CONSTRAINT_OPTIONS.map((opt) => {
                                        const allowed = isConstraintAllowedForDataType(prop.dataType, opt.value);
                                        return (
                                        <option key={opt.value} value={opt.value} disabled={!allowed}>
                                          {opt.label}
                                        </option>
                                      );})}
                                    </select>
                                  </td>
                                  )}
                                  {!hiddenPropertyColumns.has(5) && (
                                    <td className="px-2 py-2">
                                    {(() => {
                                      const isDisabled = prop.constraint === "FILLED" || prop.constraint === undefined;
                                      const isLength = prop.constraint === "LENGTH";
                                      const isPattern = prop.constraint === "PATTERN";
                                      const isEnum = prop.constraint === "ENUM";
                                      const enumValues = getEnumAllowedValues(prop);
                                      const linkedCodeListId = (prop.extensions?.[ENUM_CODELIST_ID_KEY] as string | undefined) ?? undefined;
                                      const linkedCodeList = linkedCodeListId ? codeLists.find((c) => c.id === linkedCodeListId) : undefined;
                                      const isBool = isIfcBooleanType(prop.dataType);
                                      
                                      // Pro PATTERN zobrazit speciální UI + odkazy (IDS + tester)
                                      if (isPattern && !isDisabled) {
                                        return (
                                          <div className="flex items-center gap-1">
                                            <input
                                              className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                                              value={prop.value ?? ""}
                                              onChange={(e) => updatePropertyField(prop.id, { value: e.target.value })}
                                              placeholder='Regex pattern (např. ^DT[0-9]{2}$)'
                                            />
                                            <a
                                              href="https://regex101.com/"
                                              target="_blank"
                                              rel="noreferrer"
                                              className="flex items-center text-slate-500 hover:text-red-600"
                                              title="Otevřít regex tester (regex101)"
                                              onClick={(e) => e.stopPropagation()}
                                            >
                                              <svg aria-hidden xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
                                                <path d="M14 3h7v7h-2V6.41l-9.29 9.3-1.42-1.42 9.3-9.29H14V3ZM5 5h5v2H7v10h10v-3h2v5H5V5Z" />
                                              </svg>
                                            </a>
                                          </div>
                                        );
                                      }

                                      // IfcBoolean + ENUM: only TRUE/FALSE
                                      if (isBool && isEnum && !isDisabled) {
                                        return (
                                          <select
                                            className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                                            value={(prop.value ?? "").toUpperCase() === "FALSE" ? "FALSE" : "TRUE"}
                                            onChange={(e) => updatePropertyField(prop.id, { value: e.target.value })}
                                          >
                                            <option value="TRUE">TRUE</option>
                                            <option value="FALSE">FALSE</option>
                                          </select>
                                        );
                                      }

                                      // Pro ENUM (výčet) – inline hodnoty nebo číselník + badges + nabídka uložení
                                      if (isEnum && !isDisabled) {
                                        const values = linkedCodeList ? (linkedCodeList.values ?? []) : parseEnumValues(prop.value ?? "");
                                        const displayValues = values.slice(0, 24);
                                        const remaining = values.length - displayValues.length;

                                        const detachFromCodeList = () => {
                                          const nextExtensions = { ...(prop.extensions ?? {}) } as Record<string, unknown>;
                                          delete (nextExtensions as any)[ENUM_CODELIST_ID_KEY];
                                          updatePropertyField(prop.id, { extensions: nextExtensions });
                                        };

                                        const linkToCodeList = (id: string) => {
                                          const list = codeLists.find((c) => c.id === id);
                                          if (!list) return;
                                          const nextExtensions = { ...(prop.extensions ?? {}) } as Record<string, unknown>;
                                          nextExtensions[ENUM_CODELIST_ID_KEY] = list.id;
                                          updatePropertyField(prop.id, { extensions: nextExtensions, value: formatEnumValues(list.values ?? []) });
                                        };

                                        return (
                                          <div className="flex flex-col gap-1">
                                            <div className="flex items-center gap-1">
                                              <select
                                                className="rounded border border-slate-300 px-2 py-1 text-xs"
                                                value={linkedCodeListId ? `codelist:${linkedCodeListId}` : "inline"}
                                                onChange={(e) => {
                                                  const v = e.target.value;
                                                  if (v === "inline") {
                                                    detachFromCodeList();
                                                    return;
                                                  }
                                                  if (v.startsWith("codelist:")) {
                                                    linkToCodeList(v.replace("codelist:", ""));
                                                  }
                                                }}
                                              >
                                                <option value="inline">Vlastní</option>
                                                {codeLists.length > 0 && <option disabled>— Číselníky —</option>}
                                                {codeLists.map((cl) => (
                                                  <option key={cl.id} value={`codelist:${cl.id}`}>
                                                    {cl.name}
                                                  </option>
                                                ))}
                                              </select>
                                              {linkedCodeListId && (
                                                <button
                                                  className="rounded border border-slate-300 px-2 py-1 text-[11px] hover:bg-slate-50"
                                                  onClick={detachFromCodeList}
                                                  title="Odpojit od číselníku (ponechat hodnoty jako inline)"
                                                >
                                                  Odpojit
                                                </button>
                                              )}
                                              {enumValues && enumValues.length > 0 && !linkedCodeListId && (
                                                <button
                                                  className="rounded border border-slate-300 px-2 py-1 text-[11px] hover:bg-slate-50"
                                                  onClick={() => updatePropertyField(prop.id, { value: formatEnumValues(enumValues) })}
                                                  title="Zkopírovat IFC předdefinované hodnoty do výčtu"
                                                >
                                                  Použít IFC hodnoty
                                                </button>
                                              )}
                                            </div>

                                            {!linkedCodeListId ? (
                                              <div className="flex items-center gap-1">
                                                <input
                                                  className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                                                  placeholder="Napiš hodnotu a stiskni Enter"
                                                  value={enumDraftByPropId[prop.id] ?? ""}
                                                  onChange={(e) =>
                                                    setEnumDraftByPropId((prev) => ({ ...prev, [prop.id]: e.target.value }))
                                                  }
                                                  onKeyDown={(e) => {
                                                    if (e.key !== "Enter") return;
                                                    e.preventDefault();
                                                    const raw = (enumDraftByPropId[prop.id] ?? "").trim();
                                                    if (!raw) return;
                                                    const nextValues = Array.from(new Set([...values, raw]));
                                                    updatePropertyField(prop.id, { value: formatEnumValues(nextValues) });
                                                    setEnumDraftByPropId((prev) => ({ ...prev, [prop.id]: "" }));
                                                  }}
                                                />
                                                <button
                                                  className={`flex items-center rounded border px-2 py-1 text-[11px] ${
                                                    values.length === 0
                                                      ? "border-slate-200 text-slate-400 cursor-not-allowed"
                                                      : "border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 hover:border-emerald-400"
                                                  }`}
                                                  disabled={values.length === 0}
                                                  title="Uložit jako číselník a přiřadit"
                                                  onClick={() => {
                                                    const suggestedName =
                                                      (prop.propertyName || "").trim() ||
                                                      (prop.psetName ? `${prop.psetName}` : "") ||
                                                      "Výčet";
                                                    setEnumSaveDialog({
                                                      propertyId: prop.id,
                                                      name: suggestedName,
                                                      values,
                                                      type: "property",
                                                    });
                                                  }}
                                                >
                                                  <svg
                                                    aria-hidden
                                                    xmlns="http://www.w3.org/2000/svg"
                                                    viewBox="0 0 24 24"
                                                    fill="currentColor"
                                                    className="h-4 w-4"
                                                  >
                                                    <path d="M6 2h11l3 3v17H4V4a2 2 0 0 1 2-2Zm12 8V6.5L16.5 5H6v5h12ZM6 20h12v-8H6v8Zm2-6h8v4H8v-4Z" />
                                                  </svg>
                                                </button>
                                              </div>
                                            ) : (
                                              <div className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-600">
                                                Používá číselník: <span className="font-semibold text-slate-800">{linkedCodeList?.name ?? linkedCodeListId}</span>
                                              </div>
                                            )}

                                            <div className="flex flex-wrap gap-1">
                                              {displayValues.map((v) => (
                                                <span key={v} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-700" title={v}>
                                                  <span>{v}</span>
                                                  {!linkedCodeListId && (
                                                    <button
                                                      className="text-slate-400 hover:text-slate-700"
                                                      title="Odebrat hodnotu"
                                                      onClick={() => {
                                                        const nextValues = values.filter((x) => x !== v);
                                                        updatePropertyField(prop.id, { value: formatEnumValues(nextValues) });
                                                      }}
                                                    >
                                                      ×
                                                    </button>
                                                  )}
                                                </span>
                                              ))}
                                              {remaining > 0 && (
                                                <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] text-slate-700">
                                                  +{remaining}
                                                </span>
                                              )}
                                              {values.length === 0 && (
                                                <span className="text-[11px] text-slate-400">Žádné hodnoty výčtu.</span>
                                              )}
                                            </div>
                                          </div>
                                        );
                                      }

                                      // Pro LENGTH zobrazit speciální UI pro zadávání délky
                                      if (isLength && !isDisabled) {
                                        // Parsování hodnoty délky
                                        const lengthValue = prop.value ?? "";
                                        const parseLengthValue = (val: string) => {
                                          if (!val) return { type: "exact", exact: "", min: "", max: "" };
                                          if (val.startsWith("min:")) {
                                            return { type: "min", exact: "", min: val.replace("min:", ""), max: "" };
                                          }
                                          if (val.startsWith("max:")) {
                                            return { type: "max", exact: "", min: "", max: val.replace("max:", "") };
                                          }
                                          // Pokud je to jen číslo, je to přesná délka
                                          if (/^\d+$/.test(val)) {
                                            return { type: "exact", exact: val, min: "", max: "" };
                                          }
                                          return { type: "exact", exact: val, min: "", max: "" };
                                        };
                                        
                                        const parsed = parseLengthValue(lengthValue);
                                        // Použít parsed.type jako výchozí, ale při změně selectu se aktualizuje přes prop.value
                                        const currentType = parsed.type;
                                        
                                        // Získat aktuální hodnotu podle typu
                                        const getCurrentValue = () => {
                                          if (currentType === "exact") return parsed.exact;
                                          if (currentType === "min") return parsed.min;
                                          if (currentType === "max") return parsed.max;
                                          return "";
                                        };
                                        
                                        const handleTypeChange = (newType: string) => {
                                          // Při změně typu zachovat číselnou hodnotu pokud existuje, jinak nastavit na 1
                                          const currentValue = getCurrentValue();
                                          const valueToUse = currentValue || "1";
                                          let newValue = "";
                                          if (newType === "exact") {
                                            newValue = valueToUse;
                                          } else if (newType === "min") {
                                            newValue = `min:${valueToUse}`;
                                          } else if (newType === "max") {
                                            newValue = `max:${valueToUse}`;
                                          }
                                          updatePropertyField(prop.id, { value: newValue });
                                        };
                                        
                                        const handleValueChange = (newValue: string) => {
                                          // Pokud je hodnota prázdná, použít 1
                                          const valueToUse = newValue || "1";
                                          let valueToSave = "";
                                          if (currentType === "exact") {
                                            valueToSave = valueToUse;
                                          } else if (currentType === "min") {
                                            valueToSave = `min:${valueToUse}`;
                                          } else if (currentType === "max") {
                                            valueToSave = `max:${valueToUse}`;
                                          }
                                          updatePropertyField(prop.id, { value: valueToSave });
                                        };
                                        
                                        return (
                                          <div className="flex flex-col gap-1">
                                            <select
                                              className="w-full rounded border border-slate-300 px-2 py-1 text-xs"
                                              value={currentType}
                                              onChange={(e) => handleTypeChange(e.target.value)}
                                            >
                                              <option value="exact">Přesná délka</option>
                                              <option value="min">Minimální délka</option>
                                              <option value="max">Maximální délka</option>
                                            </select>
                                            <input
                                              type="number"
                                              min="1"
                                              className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                                              value={getCurrentValue() || "1"}
                                              onChange={(e) => handleValueChange(e.target.value)}
                                              placeholder="Počet znaků"
                                            />
                                          </div>
                                        );
                                      }
                                      
                                      // Pro RANGE/Bounds zobrazit speciální UI pro zadávání ohraničení
                                      const isRange = prop.constraint === "RANGE";
                                      if (isRange && !isDisabled) {
                                        // Parsování hodnoty bounds - formát: "min:3:inclusive" nebo "max:10:exclusive" nebo "min:3:inclusive|max:10:inclusive"
                                        const rangeValue = prop.value ?? "";
                                        const parseRangeValue = (val: string) => {
                                          if (!val) return { hasMin: false, min: "", minInclusive: true, hasMax: false, max: "", maxInclusive: true };
                                          
                                          const parts = val.split("|").map((p) => p.trim()).filter(Boolean);
                                          let result = { hasMin: false, min: "", minInclusive: true, hasMax: false, max: "", maxInclusive: true };
                                          
                                          parts.forEach(part => {
                                            if (part.startsWith("min:")) {
                                              const minPart = part.replace("min:", "");
                                              const [minVal, inclusive] = minPart.split(":");
                                              result.hasMin = true;
                                              result.min = (minVal ?? "").trim();
                                              result.minInclusive = (inclusive ?? "").trim() !== "exclusive";
                                            } else if (part.startsWith("max:")) {
                                              const maxPart = part.replace("max:", "");
                                              const [maxVal, inclusive] = maxPart.split(":");
                                              result.hasMax = true;
                                              result.max = (maxVal ?? "").trim();
                                              result.maxInclusive = (inclusive ?? "").trim() !== "exclusive";
                                            }
                                          });
                                          
                                          if (!result.hasMin && !result.hasMax && parts.length > 0) {
                                            if (parts.length === 1) {
                                              result.hasMin = true;
                                              result.min = parts[0];
                                              result.minInclusive = true;
                                            } else {
                                              result.hasMin = true;
                                              result.min = parts[0];
                                              result.hasMax = true;
                                              result.max = parts[1];
                                              result.minInclusive = true;
                                              result.maxInclusive = true;
                                            }
                                          }
                                          
                                          return result;
                                        };
                                        
                                        const parsed = parseRangeValue(rangeValue);
                                        const handleTypeChange = (newType: string) => {
                                          const v = (parsed as any).min || (parsed as any).max || "0";
                                          let newValue = "";
                                          if (newType === "min-inclusive") newValue = `min:${v}:inclusive`;
                                          else if (newType === "min-exclusive") newValue = `min:${v}:exclusive`;
                                          else if (newType === "max-inclusive") newValue = `max:${v}:inclusive`;
                                          else if (newType === "max-exclusive") newValue = `max:${v}:exclusive`;
                                          else if (newType === "range") newValue = `min:${v}:inclusive|max:${(parsed as any).max || "0"}:inclusive`;
                                          updatePropertyField(prop.id, { value: newValue });
                                        };

                                        const handleValueChange = (v1: string, v2?: string) => {
                                          const p = parsed as any;
                                          let newValue = "";
                                          const type = p.hasMin && p.hasMax ? "range" : p.hasMin ? (p.minInclusive ? "min-inclusive" : "min-exclusive") : (p.maxInclusive ? "max-inclusive" : "max-exclusive");
                                          
                                          if (type === "min-inclusive") newValue = `min:${v1}:inclusive`;
                                          else if (type === "min-exclusive") newValue = `min:${v1}:exclusive`;
                                          else if (type === "max-inclusive") newValue = `max:${v1}:inclusive`;
                                          else if (type === "max-exclusive") newValue = `max:${v1}:exclusive`;
                                          else if (type === "range") newValue = `min:${v1}:inclusive|max:${v2 ?? p.max}:inclusive`;
                                          updatePropertyField(prop.id, { value: newValue });
                                        };

                                        const p = parsed as any;
                                        const currentType = p.hasMin && p.hasMax ? "range" : p.hasMin ? (p.minInclusive ? "min-inclusive" : "min-exclusive") : (p.maxInclusive ? "max-inclusive" : "max-exclusive");

                                        return (
                                          <div className="flex flex-col gap-1">
                                            <select
                                              className="w-full rounded border border-slate-300 px-2 py-1 text-xs"
                                              value={currentType}
                                              onChange={(e) => handleTypeChange(e.target.value)}
                                            >
                                              <option value="min-inclusive">≥ (větší nebo rovno)</option>
                                              <option value="min-exclusive">&gt; (větší než)</option>
                                              <option value="max-inclusive">≤ (menší nebo rovno)</option>
                                              <option value="max-exclusive">&lt; (menší než)</option>
                                              <option value="range">Rozmezí (od-do)</option>
                                            </select>
                                            {currentType === "range" ? (
                                              <div className="flex items-center gap-1">
                                                <input
                                                  type="number"
                                                  className="w-full rounded border border-slate-300 px-1 py-1 text-sm"
                                                  value={p.min}
                                                  onChange={(e) => handleValueChange(e.target.value, p.max)}
                                                  placeholder="Min"
                                                />
                                                <span className="text-xs text-slate-400">-</span>
                                                <input
                                                  type="number"
                                                  className="w-full rounded border border-slate-300 px-1 py-1 text-sm"
                                                  value={p.max}
                                                  onChange={(e) => handleValueChange(p.min, e.target.value)}
                                                  placeholder="Max"
                                                />
                                              </div>
                                            ) : (
                                              <input
                                                type="number"
                                                className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                                                value={p.hasMin ? p.min : p.max}
                                                onChange={(e) => handleValueChange(e.target.value)}
                                                placeholder="Hodnota"
                                              />
                                            )}
                                          </div>
                                        );
                                      }
                                      
                                      // Pro FILLED (Žádné) - editovatelné pole s respektováním datového typu
                                      if (isDisabled) {
                                        const isNumeric = isIfcNumericLikeType(prop.dataType);
                                        
                                        if (isBool) {
                                          return (
                                            <select
                                              className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                                              value={prop.value ?? ""}
                                              onChange={(e) => updatePropertyField(prop.id, { value: e.target.value })}
                                            >
                                              <option value="">Bez požadavku</option>
                                              <option value="TRUE">TRUE</option>
                                              <option value="FALSE">FALSE</option>
                                            </select>
                                          );
                                        }
                                        
                                        if (isNumeric) {
                                          return (
                                            <input
                                              type="number"
                                              className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                                              value={prop.value ?? ""}
                                              onChange={(e) => updatePropertyField(prop.id, { value: e.target.value })}
                                              placeholder="Bez požadavku"
                                            />
                                          );
                                        }
                                        
                                        // Pro enum hodnoty z IFC - zobrazit select
                                        if (enumValues && enumValues.length > 0) {
                                          return (
                                            <select
                                              className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                                              value={prop.value ?? ""}
                                              onChange={(e) => updatePropertyField(prop.id, { value: e.target.value })}
                                            >
                                              <option value="">Bez požadavku</option>
                                              {enumValues.map((val) => (
                                                <option key={val} value={val}>
                                                  {val}
                                                </option>
                                              ))}
                                            </select>
                                          );
                                        }
                                        
                                        return (
                                          <input
                                            className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                                            value={prop.value ?? ""}
                                            onChange={(e) => updatePropertyField(prop.id, { value: e.target.value })}
                                            placeholder="Bez požadavku"
                                          />
                                        );
                                      }
                                      
                                      // Fallback - pokud máme předdefinované IFC hodnoty, použít select
                                      if (enumValues && enumValues.length > 0) {
                                        return (
                                          <select
                                            className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                                            value={prop.value ?? ""}
                                            onChange={(e) => updatePropertyField(prop.id, { value: e.target.value })}
                                          >
                                            <option value="">— vybrat hodnotu —</option>
                                            {enumValues.map((val) => (
                                              <option key={val} value={val}>
                                                {val}
                                              </option>
                                            ))}
                                          </select>
                                        );
                                      }
                                      return (
                                        <input
                                          className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                                          value={prop.value ?? ""}
                                          onChange={(e) => updatePropertyField(prop.id, { value: e.target.value })}
                                          placeholder="Hodnota"
                                        />
                                      );
                                    })()}
                                    {showCzTranslations && (prop.constraint !== "ENUM" || !prop.extensions?.[ENUM_CODELIST_ID_KEY]) && (
                                      <input
                                        className="mt-1 w-full rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-700 not-italic placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-400 focus:border-slate-400"
                                        placeholder={prop.constraint === "ENUM" ? "Výčet CZ (oddělte ;)" : "CZ"}
                                        value={prop.valueCz ?? ""}
                                        onChange={(e) => updatePropertyField(prop.id, { valueCz: e.target.value || undefined })}
                                      />
                                    )}
                                  </td>
                                  )}
                                  {!hiddenPropertyColumns.has(6) && (
                                    <td className="px-2 py-2">
                                      {(() => {
                                        const unit = prop.unit ?? "";
                                        const derived =
                                          unit.trim() !== "" && isPresetUnit(unit) ? unit.trim() : unit.trim() === "" ? "" : "__CUSTOM__";
                                        const mode = unitModeByPropId[prop.id] ?? derived;
                                        return (
                                          <div className="flex flex-col gap-1">
                                            <select
                                              className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                                              value={mode}
                                              onChange={(e) => {
                                                const v = e.target.value;
                                                if (v === "__CUSTOM__") {
                                                  setUnitModeByPropId((prev) => ({ ...prev, [prop.id]: "__CUSTOM__" }));
                                                  if (isPresetUnit(unit)) updatePropertyField(prop.id, { unit: "" });
                                                  return;
                                                }
                                                setUnitModeByPropId((prev) => ({ ...prev, [prop.id]: v }));
                                                updatePropertyField(prop.id, { unit: v });
                                              }}
                                            >
                                              <option value="__CUSTOM__">Vlastní</option>
                                              {UNIT_PRESETS.map((p) => (
                                                <option key={p.value} value={p.value}>
                                                  {p.label ?? (p.value || "—")}
                                                </option>
                                              ))}
                                            </select>
                                            {mode === "__CUSTOM__" && (
                                              <input
                                                className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                                                placeholder="Zadejte jednotku"
                                                value={unit}
                                                onChange={(e) => {
                                                  if (unitModeByPropId[prop.id] !== "__CUSTOM__") {
                                                    setUnitModeByPropId((prev) => ({ ...prev, [prop.id]: "__CUSTOM__" }));
                                                  }
                                                  updatePropertyField(prop.id, { unit: e.target.value });
                                                }}
                                              />
                                            )}
                                          </div>
                                        );
                                      })()}
                                    </td>
                                  )}
                                  {!hiddenPropertyColumns.has(7) && (
                                    <td className="px-2 py-2">
                                      <input type="text" className="w-full rounded border border-slate-300 px-2 py-1 text-sm" value={prop.uri ?? ""} onChange={(e) => updatePropertyField(prop.id, { uri: e.target.value })} placeholder="URI" />
                                    </td>
                                  )}
                                  {!hiddenPropertyColumns.has(8) && (
                                    <td className="px-2 py-2" colSpan={3}>
                                    <div className="flex items-center gap-2 rounded-lg border-2 border-slate-300 bg-slate-50/50 p-2">
                                      <input 
                                        className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-sm" 
                                        value={prop.popis ?? ""} 
                                        onChange={(e) => updatePropertyField(prop.id, { popis: e.target.value })}
                                        placeholder="Popis" 
                                      />
                                      <input 
                                        className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-sm" 
                                        value={prop.note ?? ""} 
                                        onChange={(e) => updatePropertyField(prop.id, { note: e.target.value })}
                                        placeholder="Poznámka" 
                                      />
                                      <input 
                                        className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-sm" 
                                        value={prop.priklady ?? ""} 
                                        onChange={(e) => updatePropertyField(prop.id, { priklady: e.target.value })}
                                        placeholder="Příklady" 
                                      />
                                      <button
                                        type="button"
                                        className="flex-shrink-0 flex items-center justify-center w-7 h-7 rounded border border-slate-300 bg-white text-slate-600 hover:bg-amber-50 hover:text-amber-700 hover:border-amber-300"
                                        title="Otevřít Popis, Poznámka, Příklady v dialogu"
                                        onClick={() => setPropertyRowEditDialog({ prop: { ...prop }, groupKey: group.key })}
                                      >
                                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                                          <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                                          <path d="m15 5 4 4" />
                                        </svg>
                                      </button>
                                    </div>
                                  </td>
                                  )}
                                  {!hiddenPropertyColumns.has(9) && (
                                    <td className="px-2 py-2">
                                    <PhaseSelector phases={phases} value={prop.phases} onChange={(ids) => updatePropertyField(prop.id, { phases: ids })} />
                                  </td>
                                  )}
                                  {!hiddenPropertyColumns.has(10) && (
                                    <td className="px-2 py-2">
                                    <UseCaseRowControl
                                      entries={project?.purposeOfUseEntries ?? []}
                                      useCaseMode={prop.useCaseMode}
                                      useCaseIds={prop.useCaseIds}
                                      onChange={(patch) => updatePropertyField(prop.id, patch)}
                                    />
                                  </td>
                                  )}
                                  {!hiddenPropertyColumns.has(11) && (
                                    <td className="px-2 py-2 text-center">
                                      <input
                                        type="checkbox"
                                        className="h-4 w-4 cursor-pointer rounded border-slate-300 text-green-600 focus:ring-green-500"
                                        checked={prop.isApplicability ?? false}
                                        onChange={(e) => updatePropertyField(prop.id, { isApplicability: e.target.checked })}
                                        title="Pokud je zaškrtnuto, požadavek bude v části Použitelnost (applicability)"
                                      />
                                    </td>
                                  )}
                                  {!hiddenPropertyColumns.has(12) && (
                                    <td className="px-2 py-2 text-right">
                                      {isIdsProjectedRequirement(prop)
                                        ? renderIdsEditAction(prop)
                                        : (
                                          <button className="text-xs text-red-600 hover:underline" onClick={() => removeRequirement("properties", prop.id)}>
                                            Odebrat
                                          </button>
                                        )}
                                    </td>
                                  )}
                                </tr>
                              ))
                              )}
                            </tbody>
                          </table>
                        )}
                      </div>
                      </fieldset>
                    )}
                  </div>
                );
                })}
              </div>
              )}

              {propertyRowEditDialog && (
                <PropertyRowEditDialog
                  prop={propertyRowEditDialog.prop}
                  onSave={(patch) => {
                    updatePropertyField(propertyRowEditDialog.prop.id, patch);
                    setPropertyRowEditDialog(null);
                  }}
                  onClose={() => setPropertyRowEditDialog(null)}
                />
              )}
              {duplicatePropertyGroupsDialogOpen && project && onDuplicatePropertyGroupsToObjects && (
                <DuplicatePropertyGroupsDialog
                  classification={project.classification}
                  classificationSystemEntries={project.classificationSystemEntries ?? []}
                  objects={project.objects}
                  currentObjectCode={object.code}
                  selectedGroupKeys={Array.from(selectedGroups)}
                  groupLabels={Object.fromEntries(
                    propertyGroups.map((g) => [
                      g.key,
                      customGroupNames[g.key] ?? g.properties[0]?.psetNameCz ?? g.psetName ?? g.key,
                    ]),
                  )}
                  onConfirm={(targetObjectCodes) => {
                    const groups = Array.from(selectedGroups)
                      .map((key) => {
                        const group = propertyGroups.find((pg) => pg.key === key);
                        return group ? { groupKey: key, properties: group.properties } : null;
                      })
                      .filter((x): x is { groupKey: string; properties: PropertyRequirement[] } => x !== null);
                    if (groups.length > 0 && targetObjectCodes.length > 0) {
                      onDuplicatePropertyGroupsToObjects(object.code, groups, targetObjectCodes);
                      setSelectedGroups(new Set());
                    }
                    setDuplicatePropertyGroupsDialogOpen(false);
                  }}
                  onClose={() => setDuplicatePropertyGroupsDialogOpen(false)}
                />
              )}
            </div>
          )}

          {enumSaveDialog && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
              <div className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl">
                <div className="mb-2 text-lg font-semibold text-slate-800">Uložit výčet do číselníků?</div>
                <div className="mb-3 text-sm text-slate-600">
                  Zadejte název číselníku. Po uložení se číselník vytvoří a {enumSaveDialog.type === "attribute" ? "tento atribut" : "tato vlastnost"} se na něj automaticky naváže.
                </div>
                <div className="space-y-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-600">Název číselníku</label>
                    <input
                      className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                      value={enumSaveDialog.name}
                      onChange={(e) => setEnumSaveDialog((p) => (p ? { ...p, name: e.target.value } : p))}
                    />
                  </div>
                  <div className="rounded border border-slate-200 bg-slate-50 p-2">
                    <div className="mb-1 text-[11px] font-semibold uppercase text-slate-500">Hodnoty</div>
                    <div className="flex flex-wrap gap-1">
                      {enumSaveDialog.values.slice(0, 40).map((v) => (
                        <span key={v} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-700">
                          {v}
                        </span>
                      ))}
                      {enumSaveDialog.values.length > 40 && (
                        <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] text-slate-700">
                          +{enumSaveDialog.values.length - 40}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="mt-4 flex justify-end gap-2">
                  <button
                    className="rounded border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50"
                    onClick={() => setEnumSaveDialog(null)}
                  >
                    Neukládat
                  </button>
                  <button
                    className="rounded bg-red-600 px-3 py-1 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-50"
                    onClick={() => {
                      onSaveEnumAsCodeList({
                        objectCode: object.code,
                        propertyId: enumSaveDialog.propertyId,
                        name: enumSaveDialog.name,
                        values: enumSaveDialog.values,
                        link: true,
                      });
                      setEnumSaveDialog(null);
                    }}
                    disabled={enumSaveDialog.values.length === 0}
                  >
                    Vytvořit a přiřadit
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Modal pro nápovědu k typům vztahů */}
          {showRelationHelpModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setShowRelationHelpModal(false)}>
              <div className="w-full max-w-2xl max-h-[80vh] overflow-auto rounded-lg bg-white p-5 shadow-xl m-4" onClick={(e) => e.stopPropagation()}>
                <div className="mb-4 flex items-center justify-between">
                  <div className="text-lg font-semibold text-slate-800">Nápověda k typům vztahů (PartOf)</div>
                  <button
                    className="rounded p-1 hover:bg-slate-100"
                    onClick={() => setShowRelationHelpModal(false)}
                    title="Zavřít"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5 text-slate-500">
                      <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                    </svg>
                  </button>
                </div>
                <div className="text-sm text-slate-700 leading-relaxed whitespace-pre-line">
                  {RELATION_TYPES_HELP_TEXT}
                </div>
                <div className="mt-4 flex justify-end">
                  <button
                    className="rounded bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500"
                    onClick={() => setShowRelationHelpModal(false)}
                  >
                    Zavřít
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeTab === "partOf" && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <DocLink 
                  href="https://github.com/buildingSMART/IDS/blob/development/Documentation/UserManual/partof-facet.md"
                  label="PartOf Facet"
                  type="ids"
                />
                <button className="rounded bg-red-600 px-3 py-1 text-xs font-semibold text-white hover:bg-red-500" onClick={addRelation}>
                  Přidat vztah
                </button>
                {effectiveRequirements.relations.length > 0 && (
                  <>
                    <div className="relative">
                      <button className="rounded border border-slate-300 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 flex items-center gap-1" onClick={() => setPartOfColumnMenuOpen((o) => !o)} title="Zobrazit nebo skrýt sloupce">
                        Sloupce
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                      </button>
                      {partOfColumnMenuOpen && (
                        <>
                          <div className="fixed inset-0 z-40" onClick={() => setPartOfColumnMenuOpen(false)} aria-hidden />
                          <div className="absolute left-0 top-full mt-1 z-50 min-w-[200px] rounded-md border border-slate-200 bg-white py-2 shadow-lg">
                            <div className="flex items-center justify-between gap-2 px-3 py-1">
                              <span className="text-[11px] font-semibold uppercase text-slate-500">Sloupce</span>
                              <div className="flex gap-1">
                                <button type="button" className="text-[10px] text-red-600 hover:underline" onClick={() => setHiddenPartOfColumns(new Set())}>Zobrazit vše</button>
                                <span className="text-slate-300">|</span>
                                <button type="button" className="text-[10px] text-slate-600 hover:underline" onClick={() => setHiddenPartOfColumns(new Set([0,1,2,3,4,5,6,7,8,9,10,11]))}>Skrýt vše</button>
                              </div>
                            </div>
                            {Object.entries(PARTOF_COLUMNS_HIDEABLE).map(([k, label]) => {
                              const idx = Number(k);
                              return (
                                <label key={idx} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
                                  <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-red-600" checked={hiddenPartOfColumns.has(idx)} onChange={() => togglePartOfColumn(idx)} />
                                  {label}
                                </label>
                              );
                            })}
                          </div>
                        </>
                      )}
                    </div>
                    <div className="h-4 w-px bg-slate-300" />
                    <button
                      className="rounded border border-slate-300 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                      onClick={selectAllRelations}
                    >
                      Označit všechny
                    </button>
                    {selectedRelations.size > 0 && onDuplicateRelationsToObjects && (
                      <button
                        className="rounded border border-red-300 bg-red-50 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
                        onClick={() => setDuplicateToObjectsDialogType("partOf")}
                      >
                        Duplikovat do…
                      </button>
                    )}
                    {selectedRelations.size > 0 && (
                      <button
                        className="rounded border border-red-300 bg-red-50 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
                        onClick={deleteSelectedRelations}
                      >
                        Smazat označené ({selectedRelations.size})
                      </button>
                    )}
                  </>
                )}
              </div>
              {effectiveRequirements.relations.length === 0 ? (
                <div className="rounded border border-dashed border-slate-300 p-3 text-sm text-slate-600">
                  Žádné vztahy. Přidejte vztah.
                </div>
              ) : (
                <>
              <div className="text-xs text-slate-500">Vztahy mezi IFC entitami (IfcRelAggregates, IfcRelNests, ...)</div>
              <div className="overflow-x-auto overflow-y-visible rounded border border-slate-200" style={{ maxWidth: "100%" }}>
                <table className="text-sm table-fixed" style={{ tableLayout: "fixed", minWidth: Math.max(400, [0,1,2,3,4,5,6,7,8,9,10,11].filter((i) => !hiddenPartOfColumns.has(i)).reduce((s, i) => s + (partOfTableColWidths[i] ?? DEFAULT_PARTOF_COL_WIDTHS[i]), 0)) }}>
                  <colgroup>
                    {[0,1,2,3,4,5,6,7,8,9,10,11].filter((i) => !hiddenPartOfColumns.has(i)).map((i) => (
                      <col key={i} style={{ width: partOfTableColWidths[i] ?? DEFAULT_PARTOF_COL_WIDTHS[i] }} />
                    ))}
                  </colgroup>
                  <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                    <tr>
                      {!hiddenPartOfColumns.has(0) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1" />
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "partOf", col: 0 }); resizingStartX.current = e.clientX; resizingStartW.current = partOfTableColWidths[0] ?? DEFAULT_PARTOF_COL_WIDTHS[0]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenPartOfColumns.has(1) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1">Výskyt</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "partOf", col: 1 }); resizingStartX.current = e.clientX; resizingStartW.current = partOfTableColWidths[1] ?? DEFAULT_PARTOF_COL_WIDTHS[1]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenPartOfColumns.has(2) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1">Součást entity</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "partOf", col: 2 }); resizingStartX.current = e.clientX; resizingStartW.current = partOfTableColWidths[2] ?? DEFAULT_PARTOF_COL_WIDTHS[2]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenPartOfColumns.has(3) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1">Vztah</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "partOf", col: 3 }); resizingStartX.current = e.clientX; resizingStartW.current = partOfTableColWidths[3] ?? DEFAULT_PARTOF_COL_WIDTHS[3]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenPartOfColumns.has(4) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1">URI</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "partOf", col: 4 }); resizingStartX.current = e.clientX; resizingStartW.current = partOfTableColWidths[4] ?? DEFAULT_PARTOF_COL_WIDTHS[4]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenPartOfColumns.has(5) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1">Popis</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "partOf", col: 5 }); resizingStartX.current = e.clientX; resizingStartW.current = partOfTableColWidths[5] ?? DEFAULT_PARTOF_COL_WIDTHS[5]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenPartOfColumns.has(6) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1">Poznámka</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "partOf", col: 6 }); resizingStartX.current = e.clientX; resizingStartW.current = partOfTableColWidths[6] ?? DEFAULT_PARTOF_COL_WIDTHS[6]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenPartOfColumns.has(7) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1">Příklady</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "partOf", col: 7 }); resizingStartX.current = e.clientX; resizingStartW.current = partOfTableColWidths[7] ?? DEFAULT_PARTOF_COL_WIDTHS[7]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenPartOfColumns.has(8) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1">Fáze</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "partOf", col: 8 }); resizingStartX.current = e.clientX; resizingStartW.current = partOfTableColWidths[8] ?? DEFAULT_PARTOF_COL_WIDTHS[8]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenPartOfColumns.has(9) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1">Účel užití</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "partOf", col: 9 }); resizingStartX.current = e.clientX; resizingStartW.current = partOfTableColWidths[9] ?? DEFAULT_PARTOF_COL_WIDTHS[9]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenPartOfColumns.has(10) && (
                        <th className="px-2 py-2 relative select-none">
                          <div className="flex items-center justify-center gap-1 pr-1">
                            <span>Použitelnost</span>
                            <button type="button" className="flex items-center justify-center w-5 h-5 rounded-full bg-slate-200 text-slate-600 hover:bg-red-100 hover:text-red-600 text-xs font-bold flex-shrink-0" title="Použitelnost indikuje, jestli se daný požadavek vnímá dle IDS jako identifikační údaj.">?</button>
                          </div>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "partOf", col: 10 }); resizingStartX.current = e.clientX; resizingStartW.current = partOfTableColWidths[10] ?? DEFAULT_PARTOF_COL_WIDTHS[10]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenPartOfColumns.has(11) && (
                        <th className="px-2 py-2 text-right relative select-none">
                          <span className="block pr-1">Akce</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "partOf", col: 11 }); resizingStartX.current = e.clientX; resizingStartW.current = partOfTableColWidths[11] ?? DEFAULT_PARTOF_COL_WIDTHS[11]; }} aria-hidden />
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {effectiveRequirements.relations.map((rel) => {
                      const isIdsProjected = isIdsProjectedRequirement(rel);
                      return (
                        <tr
                          key={rel.id}
                          className={`border-t border-slate-200 ${
                            isIdsProjected ? "pointer-events-none bg-violet-50/70" : ""
                          }`}
                          title={
                            isIdsProjected
                              ? `Odvozeno z IDS specifikace: ${getIdsProjectedSpecificationName(rel) ?? ""}`
                              : undefined
                          }
                        >
                          {!hiddenPartOfColumns.has(0) && (
                            <td className="px-2 py-2">
                              <input type="checkbox" className="h-4 w-4 cursor-pointer rounded border-slate-300 text-red-600 focus:ring-red-500" checked={selectedRelations.has(rel.id)} onChange={() => toggleRelationSelection(rel.id)} />
                            </td>
                          )}
                          {!hiddenPartOfColumns.has(1) && (
                            <td className="px-2 py-2">
                            <select 
                              className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                              value={rel.occurrence ?? "optional"} 
                              onChange={(e) => {
                                const newValue = e.target.value as "required" | "prohibited" | "optional";
                                if (selectedRelations.has(rel.id) && selectedRelations.size > 0) {
                                  updateSelectedRelations({ occurrence: newValue });
                                } else {
                                  updateRelationField(rel.id, { occurrence: newValue });
                                }
                              }}
                            >
                              <option value="required">Požadováno (required)</option>
                              <option value="prohibited">Zakázáno (prohibited)</option>
                              <option value="optional">Možné (optional)</option>
                            </select>
                            </td>
                          )}
                          {!hiddenPartOfColumns.has(2) && (
                            <td className="px-2 py-2">
                            <div className="flex flex-col gap-0.5">
                              <EntitySelect
                                schemaIndex={schema}
                                value={rel.entityType ?? ""}
                                onChange={(entity) => {
                                  updateRelationField(rel.id, {
                                    entityType: entity,
                                    targetType: entity,
                                  });
                                }}
                                placeholder="-- Vyberte entitu --"
                                className="w-full rounded border border-slate-300 px-2 py-1 text-sm min-w-0 max-w-none"
                              />
                              {showCzTranslations && (
                                <input
                                  className="w-full rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-700 not-italic placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-400 focus:border-slate-400"
                                  placeholder="CZ"
                                  value={rel.entityTypeCz ?? ""}
                                  onChange={(e) => updateRelationField(rel.id, { entityTypeCz: e.target.value || undefined })}
                                />
                              )}
                            </div>
                            </td>
                          )}
                          {!hiddenPartOfColumns.has(3) && (
                            <td className="px-2 py-2">
                            <div className="flex flex-col gap-0.5">
                              <div className="flex items-center gap-1">
                                <select
                                  className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                                  value={rel.relationType}
                                  onChange={(e) => updateRelationField(rel.id, { relationType: e.target.value as any })}
                                >
                                  {relationTypeOptions.map((opt) => (
                                    <option key={opt} value={opt}>
                                    {opt}
                                  </option>
                                ))}
                              </select>
                              <button
                                type="button"
                                className="flex items-center justify-center w-5 h-5 rounded-full bg-slate-200 text-slate-600 hover:bg-red-100 hover:text-red-600 text-xs font-bold flex-shrink-0"
                                onClick={() => setShowRelationHelpModal(true)}
                                title="Zobrazit nápovědu k typům vztahů"
                              >
                                ?
                              </button>
                            </div>
                            {showCzTranslations && (
                              <input
                                className="mt-0.5 w-full rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-700 not-italic placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-400 focus:border-slate-400"
                                placeholder="CZ"
                                value={rel.relationTypeCz ?? ""}
                                onChange={(e) => updateRelationField(rel.id, { relationTypeCz: e.target.value || undefined })}
                              />
                            )}
                            </div>
                            </td>
                          )}
                          {!hiddenPartOfColumns.has(4) && (
                            <td className="px-2 py-2">
                              <input type="text" className="w-full rounded border border-slate-300 px-2 py-1 text-sm" value={rel.uri ?? ""} onChange={(e) => updateRelationField(rel.id, { uri: e.target.value })} placeholder="URI" />
                            </td>
                          )}
                          {!hiddenPartOfColumns.has(5) && (
                            <td className="px-2 py-2">
                              <input className="w-full rounded border border-slate-300 px-2 py-1 text-sm" value={rel.popis ?? ""} onChange={(e) => updateRelationField(rel.id, { popis: e.target.value })} placeholder="Popis" />
                            </td>
                          )}
                          {!hiddenPartOfColumns.has(6) && (
                            <td className="px-2 py-2">
                              <input className="w-full rounded border border-slate-300 px-2 py-1 text-sm" value={rel.note ?? ""} onChange={(e) => updateRelationField(rel.id, { note: e.target.value })} placeholder="Poznámka k relaci" />
                            </td>
                          )}
                          {!hiddenPartOfColumns.has(7) && (
                            <td className="px-2 py-2">
                              <input className="w-full rounded border border-slate-300 px-2 py-1 text-sm" value={rel.priklady ?? ""} onChange={(e) => updateRelationField(rel.id, { priklady: e.target.value })} placeholder="Příklady" />
                            </td>
                          )}
                          {!hiddenPartOfColumns.has(8) && (
                            <td className="px-2 py-2">
                            <PhaseSelector phases={phases} value={rel.phases} onChange={(ids) => updateRelationField(rel.id, { phases: ids })} />
                            </td>
                          )}
                          {!hiddenPartOfColumns.has(9) && (
                            <td className="px-2 py-2">
                            <UseCaseMultiSelect
                              entries={project?.purposeOfUseEntries ?? []}
                              value={rel.useCaseIds ?? []}
                              onChange={(ids) => updateRelationField(rel.id, { useCaseMode: "custom", useCaseIds: ids })}
                            />
                            </td>
                          )}
                          {!hiddenPartOfColumns.has(10) && (
                            <td className="px-2 py-2 text-center">
                              <input type="checkbox" className="h-4 w-4 cursor-pointer rounded border-slate-300 text-green-600 focus:ring-green-500" checked={rel.isApplicability ?? false} onChange={(e) => updateRelationField(rel.id, { isApplicability: e.target.checked })} title="Pokud je zaškrtnuto, požadavek bude v části Použitelnost (applicability)" />
                            </td>
                          )}
                          {!hiddenPartOfColumns.has(11) && (
                            <td className="px-2 py-2 text-right">
                              {isIdsProjected
                                ? renderIdsEditAction(rel)
                                : (
                                  <button className="text-xs text-red-600 hover:underline" onClick={() => removeRequirement("relations", rel.id)}>
                                    Odebrat
                                  </button>
                                )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
                </>
              )}
            </div>
          )}

          {activeTab === "material" && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <DocLink 
                  href="https://github.com/buildingSMART/IDS/blob/development/Documentation/UserManual/material-facet.md"
                  label="Material Facet"
                  type="ids"
                />
                <button className="rounded bg-red-600 px-3 py-1 text-xs font-semibold text-white hover:bg-red-500" onClick={addMaterial}>
                  Přidat materiál
                </button>
                {effectiveRequirements.materials.length > 0 && (
                  <>
                    <div className="relative">
                      <button className="rounded border border-slate-300 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 flex items-center gap-1" onClick={() => setMaterialColumnMenuOpen((o) => !o)} title="Zobrazit nebo skrýt sloupce">
                        Sloupce
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                      </button>
                      {materialColumnMenuOpen && (
                        <>
                          <div className="fixed inset-0 z-40" onClick={() => setMaterialColumnMenuOpen(false)} aria-hidden />
                          <div className="absolute left-0 top-full mt-1 z-50 min-w-[200px] rounded-md border border-slate-200 bg-white py-2 shadow-lg">
                            <div className="flex items-center justify-between gap-2 px-3 py-1">
                              <span className="text-[11px] font-semibold uppercase text-slate-500">Sloupce</span>
                              <div className="flex gap-1">
                                <button type="button" className="text-[10px] text-red-600 hover:underline" onClick={() => setHiddenMaterialColumns(new Set())}>Zobrazit vše</button>
                                <span className="text-slate-300">|</span>
                                <button type="button" className="text-[10px] text-slate-600 hover:underline" onClick={() => setHiddenMaterialColumns(new Set([0,1,2,3,4,5,6,7,8,9,10,11]))}>Skrýt vše</button>
                              </div>
                            </div>
                            {Object.entries(MATERIAL_COLUMNS_HIDEABLE).map(([k, label]) => {
                              const idx = Number(k);
                              return (
                                <label key={idx} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
                                  <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-red-600" checked={hiddenMaterialColumns.has(idx)} onChange={() => toggleMaterialColumn(idx)} />
                                  {label}
                                </label>
                              );
                            })}
                          </div>
                        </>
                      )}
                    </div>
                    <div className="h-4 w-px bg-slate-300" />
                    <button
                      className="rounded border border-slate-300 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                      onClick={selectAllMaterials}
                    >
                      Označit všechny
                    </button>
                    {selectedMaterials.size > 0 && onDuplicateMaterialsToObjects && (
                      <button
                        className="rounded border border-red-300 bg-red-50 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
                        onClick={() => setDuplicateToObjectsDialogType("material")}
                      >
                        Duplikovat do…
                      </button>
                    )}
                    {selectedMaterials.size > 0 && (
                      <button
                        className="rounded border border-red-300 bg-red-50 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
                        onClick={deleteSelectedMaterials}
                      >
                        Smazat označené ({selectedMaterials.size})
                      </button>
                    )}
                  </>
                )}
              </div>
              {effectiveRequirements.materials.length === 0 ? (
                <div className="rounded border border-dashed border-slate-300 p-3 text-sm text-slate-600">
                  Žádné materiálové požadavky. Přidejte materiál.
                </div>
              ) : (
                <>
              <div className="text-xs text-slate-500">Materiálové požadavky (IfcMaterial, IfcMaterialLayerSet, ...)</div>
              <div className="overflow-x-auto overflow-y-visible rounded border border-slate-200" style={{ maxWidth: "100%" }}>
                <table className="text-sm table-fixed" style={{ tableLayout: "fixed", minWidth: Math.max(400, [0,1,2,3,4,5,6,7,8,9,10,11].filter((i) => !hiddenMaterialColumns.has(i)).reduce((s, i) => s + (materialTableColWidths[i] ?? DEFAULT_MATERIAL_COL_WIDTHS[i]), 0)) }}>
                  <colgroup>
                    {[0,1,2,3,4,5,6,7,8,9,10,11].filter((i) => !hiddenMaterialColumns.has(i)).map((i) => (
                      <col key={i} style={{ width: materialTableColWidths[i] ?? DEFAULT_MATERIAL_COL_WIDTHS[i] }} />
                    ))}
                  </colgroup>
                  <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                    <tr>
                      {!hiddenMaterialColumns.has(0) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1" />
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "material", col: 0 }); resizingStartX.current = e.clientX; resizingStartW.current = materialTableColWidths[0] ?? DEFAULT_MATERIAL_COL_WIDTHS[0]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenMaterialColumns.has(1) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1">Výskyt</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "material", col: 1 }); resizingStartX.current = e.clientX; resizingStartW.current = materialTableColWidths[1] ?? DEFAULT_MATERIAL_COL_WIDTHS[1]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenMaterialColumns.has(2) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1">Omezení</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "material", col: 2 }); resizingStartX.current = e.clientX; resizingStartW.current = materialTableColWidths[2] ?? DEFAULT_MATERIAL_COL_WIDTHS[2]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenMaterialColumns.has(3) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1">Hodnota</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "material", col: 3 }); resizingStartX.current = e.clientX; resizingStartW.current = materialTableColWidths[3] ?? DEFAULT_MATERIAL_COL_WIDTHS[3]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenMaterialColumns.has(4) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1">URI</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "material", col: 4 }); resizingStartX.current = e.clientX; resizingStartW.current = materialTableColWidths[4] ?? DEFAULT_MATERIAL_COL_WIDTHS[4]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenMaterialColumns.has(5) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1">Popis</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "material", col: 5 }); resizingStartX.current = e.clientX; resizingStartW.current = materialTableColWidths[5] ?? DEFAULT_MATERIAL_COL_WIDTHS[5]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenMaterialColumns.has(6) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1">Poznámka</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "material", col: 6 }); resizingStartX.current = e.clientX; resizingStartW.current = materialTableColWidths[6] ?? DEFAULT_MATERIAL_COL_WIDTHS[6]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenMaterialColumns.has(7) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1">Příklady</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "material", col: 7 }); resizingStartX.current = e.clientX; resizingStartW.current = materialTableColWidths[7] ?? DEFAULT_MATERIAL_COL_WIDTHS[7]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenMaterialColumns.has(8) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1">Fáze</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "material", col: 8 }); resizingStartX.current = e.clientX; resizingStartW.current = materialTableColWidths[8] ?? DEFAULT_MATERIAL_COL_WIDTHS[8]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenMaterialColumns.has(9) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1">Účel užití</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "material", col: 9 }); resizingStartX.current = e.clientX; resizingStartW.current = materialTableColWidths[9] ?? DEFAULT_MATERIAL_COL_WIDTHS[9]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenMaterialColumns.has(10) && (
                        <th className="px-2 py-2 text-center relative select-none">
                          <div className="flex items-center justify-center gap-1 pr-1">
                            <span>Použitelnost</span>
                            <button type="button" className="flex items-center justify-center w-5 h-5 rounded-full bg-slate-200 text-slate-600 hover:bg-red-100 hover:text-red-600 text-xs font-bold flex-shrink-0" title="Použitelnost indikuje, jestli se daný požadavek vnímá dle IDS jako identifikační údaj.">?</button>
                          </div>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "material", col: 10 }); resizingStartX.current = e.clientX; resizingStartW.current = materialTableColWidths[10] ?? DEFAULT_MATERIAL_COL_WIDTHS[10]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenMaterialColumns.has(11) && (
                        <th className="px-2 py-2 text-right relative select-none">
                          <span className="block pr-1">Akce</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "material", col: 11 }); resizingStartX.current = e.clientX; resizingStartW.current = materialTableColWidths[11] ?? DEFAULT_MATERIAL_COL_WIDTHS[11]; }} aria-hidden />
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {effectiveRequirements.materials.map((mat) => (
                      <tr
                        key={mat.id}
                        className={`border-t border-slate-200 ${
                          isIdsProjectedRequirement(mat)
                            ? "pointer-events-none bg-violet-50/70"
                            : ""
                        }`}
                        title={
                          isIdsProjectedRequirement(mat)
                            ? `Odvozeno z IDS specifikace: ${getIdsProjectedSpecificationName(mat) ?? ""}`
                            : undefined
                        }
                      >
                        {!hiddenMaterialColumns.has(0) && (
                          <td className="px-2 py-2">
                            <input type="checkbox" className="h-4 w-4 cursor-pointer rounded border-slate-300 text-red-600 focus:ring-red-500" checked={selectedMaterials.has(mat.id)} onChange={() => toggleMaterialSelection(mat.id)} />
                          </td>
                        )}
                        {!hiddenMaterialColumns.has(1) && (
                          <td className="px-2 py-2">
                          <select 
                            className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                            value={mat.occurrence ?? "optional"} 
                            onChange={(e) => {
                              const newValue = e.target.value as "required" | "prohibited" | "optional";
                              if (selectedMaterials.has(mat.id) && selectedMaterials.size > 0) {
                                updateSelectedMaterials({ occurrence: newValue });
                              } else {
                                updateMaterialField(mat.id, { occurrence: newValue });
                              }
                            }}
                          >
                            <option value="required">Požadováno (required)</option>
                            <option value="prohibited">Zakázáno (prohibited)</option>
                            <option value="optional">Možné (optional)</option>
                          </select>
                        </td>
                        )}
                        {!hiddenMaterialColumns.has(2) && (
                          <td className="px-2 py-2">
                            <select className="w-full rounded border border-slate-300 px-2 py-1 text-sm" value={mat.constraint ?? "FILLED"} onChange={(e) => updateMaterialField(mat.id, { constraint: e.target.value as any, value: "" })}>
                            {MATERIAL_CONSTRAINT_OPTIONS.map((opt) => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                        </td>
                        )}
                        {!hiddenMaterialColumns.has(3) && (
                          <td className="px-2 py-2">
                          {(() => {
                            const isDisabled = mat.constraint === "FILLED" || mat.constraint === undefined;
                            const isLength = mat.constraint === "LENGTH";
                            const isPattern = mat.constraint === "PATTERN";
                            const isEnum = mat.constraint === "ENUM";
                            const isRange = mat.constraint === "RANGE";
                            const linkedCodeListId = (mat.extensions?.[ENUM_CODELIST_ID_KEY] as string | undefined) ?? undefined;
                            const linkedCodeList = linkedCodeListId ? codeLists.find((c) => c.id === linkedCodeListId) : undefined;

                            // Pro FILLED (Žádné) - editovatelné pole s placeholderem "Bez požadavku"
                            if (isDisabled) {
                              return (
                                <input
                                  className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                                  value={mat.value ?? ""}
                                  onChange={(e) => updateMaterialField(mat.id, { value: e.target.value })}
                                  placeholder="Bez požadavku"
                                />
                              );
                            }

                            // Pro PATTERN - input s odkazem na regex101
                            if (isPattern) {
                              return (
                                <div className="flex items-center gap-1">
                                  <input
                                    className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                                    value={mat.value ?? ""}
                                    onChange={(e) => updateMaterialField(mat.id, { value: e.target.value })}
                                    placeholder='Regex pattern (např. ^DT[0-9]{2}$)'
                                  />
                                  <a
                                    href="https://regex101.com/"
                                    target="_blank"
                                    rel="noreferrer"
                                    className="flex items-center text-slate-500 hover:text-red-600"
                                    title="Otevřít regex tester (regex101)"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <svg aria-hidden xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
                                      <path d="M14 3h7v7h-2V6.41l-9.29 9.3-1.42-1.42 9.3-9.29H14V3ZM5 5h5v2H7v10h10v-3h2v5H5V5Z" />
                                    </svg>
                                  </a>
                                </div>
                              );
                            }

                            // Pro ENUM (výčet) – inline hodnoty nebo číselník + badges + nabídka uložení
                            if (isEnum) {
                              const values = linkedCodeList ? (linkedCodeList.values ?? []) : parseEnumValues(mat.value ?? "");
                              const displayValues = values.slice(0, 24);
                              const remaining = values.length - displayValues.length;

                              const detachFromCodeList = () => {
                                const nextExtensions = { ...(mat.extensions ?? {}) } as Record<string, unknown>;
                                delete (nextExtensions as any)[ENUM_CODELIST_ID_KEY];
                                updateMaterialField(mat.id, { extensions: nextExtensions });
                              };

                              const linkToCodeList = (id: string) => {
                                const list = codeLists.find((c) => c.id === id);
                                if (!list) return;
                                const nextExtensions = { ...(mat.extensions ?? {}) } as Record<string, unknown>;
                                nextExtensions[ENUM_CODELIST_ID_KEY] = list.id;
                                updateMaterialField(mat.id, { extensions: nextExtensions, value: formatEnumValues(list.values ?? []) });
                              };

                              return (
                                <div className="flex flex-col gap-1">
                                  <div className="flex items-center gap-1">
                                    <select
                                      className="rounded border border-slate-300 px-2 py-1 text-xs"
                                      value={linkedCodeListId ? `codelist:${linkedCodeListId}` : "inline"}
                                      onChange={(e) => {
                                        const v = e.target.value;
                                        if (v === "inline") {
                                          detachFromCodeList();
                                          return;
                                        }
                                        if (v.startsWith("codelist:")) {
                                          linkToCodeList(v.replace("codelist:", ""));
                                        }
                                      }}
                                    >
                                      <option value="inline">Vlastní</option>
                                      {codeLists.length > 0 && <option disabled>— Číselníky —</option>}
                                      {codeLists.map((cl) => (
                                        <option key={cl.id} value={`codelist:${cl.id}`}>
                                          {cl.name}
                                        </option>
                                      ))}
                                    </select>
                                    {linkedCodeListId && (
                                      <button
                                        className="rounded border border-slate-300 px-2 py-1 text-[11px] hover:bg-slate-50"
                                        onClick={detachFromCodeList}
                                        title="Odpojit od číselníku (ponechat hodnoty jako inline)"
                                      >
                                        Odpojit
                                      </button>
                                    )}
                                  </div>

                                  {!linkedCodeListId ? (
                                    <div className="flex items-center gap-1">
                                      <input
                                        className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                                        placeholder="Napiš hodnotu a stiskni Enter"
                                        value={enumDraftByMatId[mat.id] ?? ""}
                                        onChange={(e) =>
                                          setEnumDraftByMatId((prev) => ({ ...prev, [mat.id]: e.target.value }))
                                        }
                                        onKeyDown={(e) => {
                                          if (e.key !== "Enter") return;
                                          e.preventDefault();
                                          const raw = (enumDraftByMatId[mat.id] ?? "").trim();
                                          if (!raw) return;
                                          const nextValues = Array.from(new Set([...values, raw]));
                                          updateMaterialField(mat.id, { value: formatEnumValues(nextValues) });
                                          setEnumDraftByMatId((prev) => ({ ...prev, [mat.id]: "" }));
                                        }}
                                      />
                                      <button
                                        className={`flex items-center rounded border px-2 py-1 text-[11px] ${
                                          values.length === 0
                                            ? "border-slate-200 text-slate-400 cursor-not-allowed"
                                            : "border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 hover:border-emerald-400"
                                        }`}
                                        disabled={values.length === 0}
                                        title="Uložit jako číselník a přiřadit"
                                        onClick={() => {
                                          const suggestedName = (mat.category || "").trim() || "Výčet materiálu";
                                          setEnumSaveDialog({
                                            propertyId: mat.id,
                                            name: suggestedName,
                                            values,
                                            type: "property", // použijeme property type pro uložení
                                          });
                                        }}
                                      >
                                        <svg
                                          aria-hidden
                                          xmlns="http://www.w3.org/2000/svg"
                                          viewBox="0 0 24 24"
                                          fill="currentColor"
                                          className="h-4 w-4"
                                        >
                                          <path d="M6 2h11l3 3v17H4V4a2 2 0 0 1 2-2Zm12 8V6.5L16.5 5H6v5h12ZM6 20h12v-8H6v8Zm2-6h8v4H8v-4Z" />
                                        </svg>
                                      </button>
                                    </div>
                                  ) : (
                                    <div className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-600">
                                      Používá číselník: <span className="font-semibold text-slate-800">{linkedCodeList?.name ?? linkedCodeListId}</span>
                                    </div>
                                  )}

                                  <div className="flex flex-wrap gap-1">
                                    {displayValues.map((v) => (
                                      <span key={v} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-700" title={v}>
                                        <span>{v}</span>
                                        {!linkedCodeListId && (
                                          <button
                                            className="text-slate-400 hover:text-slate-700"
                                            title="Odebrat hodnotu"
                                            onClick={() => {
                                              const nextValues = values.filter((x) => x !== v);
                                              updateMaterialField(mat.id, { value: formatEnumValues(nextValues) });
                                            }}
                                          >
                                            ×
                                          </button>
                                        )}
                                      </span>
                                    ))}
                                    {remaining > 0 && (
                                      <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] text-slate-700">
                                        +{remaining}
                                      </span>
                                    )}
                                    {values.length === 0 && (
                                      <span className="text-[11px] text-slate-400">Žádné hodnoty výčtu.</span>
                                    )}
                                  </div>
                                </div>
                              );
                            }

                            // Pro LENGTH - speciální UI pro zadávání délky
                            if (isLength) {
                              const lengthValue = mat.value ?? "";
                              const parseLengthValue = (val: string) => {
                                if (!val) return { type: "exact", exact: "", min: "", max: "" };
                                if (val.startsWith("min:")) {
                                  return { type: "min", exact: "", min: val.replace("min:", ""), max: "" };
                                }
                                if (val.startsWith("max:")) {
                                  return { type: "max", exact: "", min: "", max: val.replace("max:", "") };
                                }
                                if (/^\d+$/.test(val)) {
                                  return { type: "exact", exact: val, min: "", max: "" };
                                }
                                return { type: "exact", exact: val, min: "", max: "" };
                              };
                              
                              const parsed = parseLengthValue(lengthValue);
                              const currentType = parsed.type;
                              
                              const getCurrentValue = () => {
                                if (currentType === "exact") return parsed.exact;
                                if (currentType === "min") return parsed.min;
                                if (currentType === "max") return parsed.max;
                                return "";
                              };
                              
                              const handleTypeChange = (newType: string) => {
                                const currentValue = getCurrentValue();
                                const valueToUse = currentValue || "1";
                                let newValue = "";
                                if (newType === "exact") {
                                  newValue = valueToUse;
                                } else if (newType === "min") {
                                  newValue = `min:${valueToUse}`;
                                } else if (newType === "max") {
                                  newValue = `max:${valueToUse}`;
                                }
                                updateMaterialField(mat.id, { value: newValue });
                              };
                              
                              const handleValueChange = (newValue: string) => {
                                const valueToUse = newValue || "1";
                                let valueToSave = "";
                                if (currentType === "exact") {
                                  valueToSave = valueToUse;
                                } else if (currentType === "min") {
                                  valueToSave = `min:${valueToUse}`;
                                } else if (currentType === "max") {
                                  valueToSave = `max:${valueToUse}`;
                                }
                                updateMaterialField(mat.id, { value: valueToSave });
                              };
                              
                              return (
                                <div className="flex flex-col gap-1">
                                  <select
                                    className="w-full rounded border border-slate-300 px-2 py-1 text-xs"
                                    value={currentType}
                                    onChange={(e) => handleTypeChange(e.target.value)}
                                  >
                                    <option value="exact">Přesná délka</option>
                                    <option value="min">Minimální délka</option>
                                    <option value="max">Maximální délka</option>
                                  </select>
                                  <input
                                    type="number"
                                    min="1"
                                    className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                                    value={getCurrentValue() || "1"}
                                    onChange={(e) => handleValueChange(e.target.value)}
                                    placeholder="Počet znaků"
                                  />
                                </div>
                              );
                            }

                            // Pro RANGE/Bounds - speciální UI pro zadávání ohraničení
                            if (isRange) {
                              const rangeValue = mat.value ?? "";
                              const parseRangeValue = (val: string) => {
                                if (!val) return { hasMin: false, min: "", minInclusive: true, hasMax: false, max: "", maxInclusive: true };
                                
                                const parts = val.split("|").map((p) => p.trim()).filter(Boolean);
                                let result = { hasMin: false, min: "", minInclusive: true, hasMax: false, max: "", maxInclusive: true };
                                
                                parts.forEach(part => {
                                  if (part.startsWith("min:")) {
                                    const minPart = part.replace("min:", "");
                                    const [minVal, inclusive] = minPart.split(":");
                                    result.hasMin = true;
                                    result.min = (minVal ?? "").trim();
                                    result.minInclusive = (inclusive ?? "").trim() !== "exclusive";
                                  } else if (part.startsWith("max:")) {
                                    const maxPart = part.replace("max:", "");
                                    const [maxVal, inclusive] = maxPart.split(":");
                                    result.hasMax = true;
                                    result.max = (maxVal ?? "").trim();
                                    result.maxInclusive = (inclusive ?? "").trim() !== "exclusive";
                                  }
                                });
                                
                                if (!result.hasMin && !result.hasMax && parts.length > 0) {
                                  if (parts.length === 1) {
                                    result.hasMin = true;
                                    result.min = parts[0];
                                    result.minInclusive = true;
                                  } else {
                                    result.hasMin = true;
                                    result.min = parts[0];
                                    result.hasMax = true;
                                    result.max = parts[1];
                                    result.minInclusive = true;
                                    result.maxInclusive = true;
                                  }
                                }
                                
                                return result;
                              };
                              
                              const parsed = parseRangeValue(rangeValue);
                              const handleTypeChange = (newType: string) => {
                                const v = (parsed as any).min || (parsed as any).max || "0";
                                let newValue = "";
                                if (newType === "min-inclusive") newValue = `min:${v}:inclusive`;
                                else if (newType === "min-exclusive") newValue = `min:${v}:exclusive`;
                                else if (newType === "max-inclusive") newValue = `max:${v}:inclusive`;
                                else if (newType === "max-exclusive") newValue = `max:${v}:exclusive`;
                                else if (newType === "range") newValue = `min:${v}:inclusive|max:${(parsed as any).max || "0"}:inclusive`;
                                updateMaterialField(mat.id, { value: newValue });
                              };

                              const handleValueChange = (v1: string, v2?: string) => {
                                const p = parsed as any;
                                let newValue = "";
                                const type = p.hasMin && p.hasMax ? "range" : p.hasMin ? (p.minInclusive ? "min-inclusive" : "min-exclusive") : (p.maxInclusive ? "max-inclusive" : "max-exclusive");
                                
                                if (type === "min-inclusive") newValue = `min:${v1}:inclusive`;
                                else if (type === "min-exclusive") newValue = `min:${v1}:exclusive`;
                                else if (type === "max-inclusive") newValue = `max:${v1}:inclusive`;
                                else if (type === "max-exclusive") newValue = `max:${v1}:exclusive`;
                                else if (type === "range") newValue = `min:${v1}:inclusive|max:${v2 ?? p.max}:inclusive`;
                                updateMaterialField(mat.id, { value: newValue });
                              };

                              const p = parsed as any;
                              const currentType = p.hasMin && p.hasMax ? "range" : p.hasMin ? (p.minInclusive ? "min-inclusive" : "min-exclusive") : (p.maxInclusive ? "max-inclusive" : "max-exclusive");

                              return (
                                <div className="flex flex-col gap-1">
                                  <select
                                    className="w-full rounded border border-slate-300 px-2 py-1 text-xs"
                                    value={currentType}
                                    onChange={(e) => handleTypeChange(e.target.value)}
                                  >
                                    <option value="min-inclusive">≥ (větší nebo rovno)</option>
                                    <option value="min-exclusive">&gt; (větší než)</option>
                                    <option value="max-inclusive">≤ (menší nebo rovno)</option>
                                    <option value="max-exclusive">&lt; (menší než)</option>
                                    <option value="range">Rozmezí (od-do)</option>
                                  </select>
                                  {currentType === "range" ? (
                                    <div className="flex items-center gap-1">
                                      <input
                                        type="number"
                                        className="w-full rounded border border-slate-300 px-1 py-1 text-sm"
                                        value={p.min}
                                        onChange={(e) => handleValueChange(e.target.value, p.max)}
                                        placeholder="Min"
                                      />
                                      <span className="text-xs text-slate-400">-</span>
                                      <input
                                        type="number"
                                        className="w-full rounded border border-slate-300 px-1 py-1 text-sm"
                                        value={p.max}
                                        onChange={(e) => handleValueChange(p.min, e.target.value)}
                                        placeholder="Max"
                                      />
                                    </div>
                                  ) : (
                                    <input
                                      type="number"
                                      className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                                      value={p.hasMin ? p.min : p.max}
                                      onChange={(e) => handleValueChange(e.target.value)}
                                      placeholder="Hodnota"
                                    />
                                  )}
                                </div>
                              );
                            }

                            // Fallback - prostý input
                            return (
                              <input
                                className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                                value={mat.value ?? ""}
                                onChange={(e) => updateMaterialField(mat.id, { value: e.target.value })}
                              />
                            );
                          })()}
                          {showCzTranslations && mat.category && (
                            <input
                              className="mt-1 w-full rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-700 not-italic placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-400 focus:border-slate-400"
                              placeholder="Kategorie CZ"
                              value={mat.categoryCz ?? ""}
                              onChange={(e) => updateMaterialField(mat.id, { categoryCz: e.target.value || undefined })}
                            />
                          )}
                          {showCzTranslations && (mat.constraint !== "ENUM" || !mat.extensions?.[ENUM_CODELIST_ID_KEY]) && (
                            <input
                              className="mt-1 w-full rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-700 not-italic placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-400 focus:border-slate-400"
                              placeholder={mat.constraint === "ENUM" ? "Výčet CZ (oddělte ;)" : "CZ"}
                              value={mat.valueCz ?? ""}
                              onChange={(e) => updateMaterialField(mat.id, { valueCz: e.target.value || undefined })}
                            />
                          )}
                        </td>
                        )}
                        {!hiddenMaterialColumns.has(4) && (
                          <td className="px-2 py-2">
                            <input type="text" className="w-full rounded border border-slate-300 px-2 py-1 text-sm" value={mat.uri ?? ""} onChange={(e) => updateMaterialField(mat.id, { uri: e.target.value })} placeholder="URI materiálu" />
                          </td>
                        )}
                        {!hiddenMaterialColumns.has(5) && (
                          <td className="px-2 py-2">
                            <input className="w-full rounded border border-slate-300 px-2 py-1 text-sm" value={mat.popis ?? ""} onChange={(e) => updateMaterialField(mat.id, { popis: e.target.value })} placeholder="Popis" />
                          </td>
                        )}
                        {!hiddenMaterialColumns.has(6) && (
                          <td className="px-2 py-2">
                            <input className="w-full rounded border border-slate-300 px-2 py-1 text-sm" value={mat.note ?? ""} onChange={(e) => updateMaterialField(mat.id, { note: e.target.value })} placeholder="Poznámka k materiálu" />
                          </td>
                        )}
                        {!hiddenMaterialColumns.has(7) && (
                          <td className="px-2 py-2">
                            <input className="w-full rounded border border-slate-300 px-2 py-1 text-sm" value={mat.priklady ?? ""} onChange={(e) => updateMaterialField(mat.id, { priklady: e.target.value })} placeholder="Příklady" />
                          </td>
                        )}
                        {!hiddenMaterialColumns.has(8) && (
                          <td className="px-2 py-2">
                            <PhaseSelector phases={phases} value={mat.phases} onChange={(ids) => updateMaterialField(mat.id, { phases: ids })} />
                          </td>
                        )}
                        {!hiddenMaterialColumns.has(9) && (
                          <td className="px-2 py-2">
                            <UseCaseMultiSelect
                              entries={project?.purposeOfUseEntries ?? []}
                              value={mat.useCaseIds ?? []}
                              onChange={(ids) => updateMaterialField(mat.id, { useCaseMode: "custom", useCaseIds: ids })}
                            />
                          </td>
                        )}
                        {!hiddenMaterialColumns.has(10) && (
                          <td className="px-2 py-2 text-center">
                            <input type="checkbox" className="h-4 w-4 cursor-pointer rounded border-slate-300 text-green-600 focus:ring-green-500" checked={mat.isApplicability ?? false} onChange={(e) => updateMaterialField(mat.id, { isApplicability: e.target.checked })} title="Pokud je zaškrtnuto, požadavek bude v části Použitelnost (applicability)" />
                          </td>
                        )}
                        {!hiddenMaterialColumns.has(11) && (
                          <td className="px-2 py-2 text-right">
                            {isIdsProjectedRequirement(mat)
                              ? renderIdsEditAction(mat)
                              : (
                                <button className="text-xs text-red-600 hover:underline" onClick={() => removeRequirement("materials", mat.id)}>
                                  Odebrat
                                </button>
                              )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
                </>
              )}
            </div>
          )}

          {activeTab === "classification" && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <DocLink 
                  href="https://github.com/buildingSMART/IDS/blob/development/Documentation/UserManual/classification-facet.md"
                  label="Classification Facet"
                  type="ids"
                />
                <button className="rounded bg-red-600 px-3 py-1 text-xs font-semibold text-white hover:bg-red-500" onClick={addClassification}>
                  Přidat klasifikaci
                </button>
                {classificationsWithoutIfc.length > 0 && (
                  <div className="relative">
                    <button className="rounded border border-slate-300 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 flex items-center gap-1" onClick={() => setClassificationColumnMenuOpen((o) => !o)} title="Zobrazit nebo skrýt sloupce">
                      Sloupce
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                    </button>
                    {classificationColumnMenuOpen && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setClassificationColumnMenuOpen(false)} aria-hidden />
                        <div className="absolute left-0 top-full mt-1 z-50 min-w-[200px] rounded-md border border-slate-200 bg-white py-2 shadow-lg">
                          <div className="flex items-center justify-between gap-2 px-3 py-1">
                            <span className="text-[11px] font-semibold uppercase text-slate-500">Sloupce</span>
                            <div className="flex gap-1">
                              <button type="button" className="text-[10px] text-red-600 hover:underline" onClick={() => setHiddenClassificationColumns(new Set())}>Zobrazit vše</button>
                              <span className="text-slate-300">|</span>
                              <button type="button" className="text-[10px] text-slate-600 hover:underline" onClick={() => setHiddenClassificationColumns(new Set([0,1,2,3,4,5,6,7,8,9,10,11,12]))}>Skrýt vše</button>
                            </div>
                          </div>
                          {Object.entries(CLASSIFICATION_COLUMNS_HIDEABLE).map(([k, label]) => {
                            const idx = Number(k);
                            return (
                              <label key={idx} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
                                <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-red-600" checked={hiddenClassificationColumns.has(idx)} onChange={() => toggleClassificationColumn(idx)} />
                                {label}
                              </label>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </div>
                )}
                {classificationsWithoutIfc.some((c) => !c.readOnly) && (
                  <>
                    <div className="h-4 w-px bg-slate-300" />
                    <button
                      className="rounded border border-slate-300 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                      onClick={selectAllClassifications}
                    >
                      Označit všechny
                    </button>
                    {selectedClassifications.size > 0 && onDuplicateClassificationsToObjects && (
                      <button
                        className="rounded border border-red-300 bg-red-50 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
                        onClick={() => setDuplicateToObjectsDialogType("classification")}
                      >
                        Duplikovat do…
                      </button>
                    )}
                    {selectedClassifications.size > 0 && (
                      <button
                        className="rounded border border-red-300 bg-red-50 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
                        onClick={deleteSelectedClassifications}
                      >
                        Smazat označené ({selectedClassifications.size})
                      </button>
                    )}
                  </>
                )}
              </div>
              {classificationsWithoutIfc.length === 0 ? (
                <div className="rounded border border-dashed border-slate-300 p-3 text-sm text-slate-600">
                  Žádné klasifikace. Přidejte klasifikaci.
                </div>
              ) : (
                <>
              <div className="overflow-x-auto overflow-y-visible rounded border border-slate-200" style={{ maxWidth: "100%" }}>
                <table className="text-sm table-fixed" style={{ tableLayout: "fixed", minWidth: Math.max(400, [0,1,2,3,4,5,6,7,8,9,10,11,12].filter((i) => !hiddenClassificationColumns.has(i)).reduce((s, i) => s + (classificationTableColWidths[i] ?? DEFAULT_CLASSIFICATION_COL_WIDTHS[i]), 0)) }}>
                  <colgroup>
                    {[0,1,2,3,4,5,6,7,8,9,10,11,12].filter((i) => !hiddenClassificationColumns.has(i)).map((i) => (
                      <col key={i} style={{ width: classificationTableColWidths[i] ?? DEFAULT_CLASSIFICATION_COL_WIDTHS[i] }} />
                    ))}
                  </colgroup>
                  <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                    <tr>
                      {!hiddenClassificationColumns.has(0) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1" />
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "classification", col: 0 }); resizingStartX.current = e.clientX; resizingStartW.current = classificationTableColWidths[0] ?? DEFAULT_CLASSIFICATION_COL_WIDTHS[0]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenClassificationColumns.has(1) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1">Výskyt</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "classification", col: 1 }); resizingStartX.current = e.clientX; resizingStartW.current = classificationTableColWidths[1] ?? DEFAULT_CLASSIFICATION_COL_WIDTHS[1]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenClassificationColumns.has(2) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1">Klasifikační systém</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "classification", col: 2 }); resizingStartX.current = e.clientX; resizingStartW.current = classificationTableColWidths[2] ?? DEFAULT_CLASSIFICATION_COL_WIDTHS[2]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenClassificationColumns.has(3) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1">Omezení</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "classification", col: 3 }); resizingStartX.current = e.clientX; resizingStartW.current = classificationTableColWidths[3] ?? DEFAULT_CLASSIFICATION_COL_WIDTHS[3]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenClassificationColumns.has(4) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1">Hodnota</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "classification", col: 4 }); resizingStartX.current = e.clientX; resizingStartW.current = classificationTableColWidths[4] ?? DEFAULT_CLASSIFICATION_COL_WIDTHS[4]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenClassificationColumns.has(5) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1">URI</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "classification", col: 5 }); resizingStartX.current = e.clientX; resizingStartW.current = classificationTableColWidths[5] ?? DEFAULT_CLASSIFICATION_COL_WIDTHS[5]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenClassificationColumns.has(6) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1">Popis</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "classification", col: 6 }); resizingStartX.current = e.clientX; resizingStartW.current = classificationTableColWidths[6] ?? DEFAULT_CLASSIFICATION_COL_WIDTHS[6]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenClassificationColumns.has(7) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1">Poznámka</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "classification", col: 7 }); resizingStartX.current = e.clientX; resizingStartW.current = classificationTableColWidths[7] ?? DEFAULT_CLASSIFICATION_COL_WIDTHS[7]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenClassificationColumns.has(8) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1">Příklady</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "classification", col: 8 }); resizingStartX.current = e.clientX; resizingStartW.current = classificationTableColWidths[8] ?? DEFAULT_CLASSIFICATION_COL_WIDTHS[8]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenClassificationColumns.has(9) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1">Fáze</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "classification", col: 9 }); resizingStartX.current = e.clientX; resizingStartW.current = classificationTableColWidths[9] ?? DEFAULT_CLASSIFICATION_COL_WIDTHS[9]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenClassificationColumns.has(10) && (
                        <th className="px-2 py-2 relative select-none">
                          <span className="block pr-1">Účel užití</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "classification", col: 10 }); resizingStartX.current = e.clientX; resizingStartW.current = classificationTableColWidths[10] ?? DEFAULT_CLASSIFICATION_COL_WIDTHS[10]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenClassificationColumns.has(11) && (
                        <th className="px-2 py-2 text-center relative select-none">
                          <div className="flex items-center justify-center gap-1 pr-1">
                            <span>Použitelnost</span>
                            <button type="button" className="flex items-center justify-center w-5 h-5 rounded-full bg-slate-200 text-slate-600 hover:bg-red-100 hover:text-red-600 text-xs font-bold flex-shrink-0" title="Použitelnost indikuje, jestli se daný požadavek vnímá dle IDS jako identifikační údaj.">?</button>
                          </div>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "classification", col: 11 }); resizingStartX.current = e.clientX; resizingStartW.current = classificationTableColWidths[11] ?? DEFAULT_CLASSIFICATION_COL_WIDTHS[11]; }} aria-hidden />
                        </th>
                      )}
                      {!hiddenClassificationColumns.has(12) && (
                        <th className="px-2 py-2 text-right relative select-none">
                          <span className="block pr-1">Akce</span>
                          <div className="absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize hover:bg-red-200 shrink-0" onMouseDown={(e) => { e.preventDefault(); setResizingContext({ table: "classification", col: 12 }); resizingStartX.current = e.clientX; resizingStartW.current = classificationTableColWidths[12] ?? DEFAULT_CLASSIFICATION_COL_WIDTHS[12]; }} aria-hidden />
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {classificationsWithoutIfc.map((cls) => (
                      <tr
                        key={cls.id}
                        className={`border-t border-slate-200 ${
                          isIdsProjectedRequirement(cls)
                            ? "pointer-events-none bg-violet-50/70"
                            : ""
                        }`}
                        title={
                          isIdsProjectedRequirement(cls)
                            ? `Odvozeno z IDS specifikace: ${getIdsProjectedSpecificationName(cls) ?? ""}`
                            : undefined
                        }
                      >
                        {!hiddenClassificationColumns.has(0) && (
                          <td className="px-2 py-2">
                            <input type="checkbox" className={`h-4 w-4 rounded border-slate-300 text-red-600 focus:ring-red-500 ${cls.readOnly ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`} checked={selectedClassifications.has(cls.id)} onChange={() => !cls.readOnly && toggleClassificationSelection(cls.id)} disabled={cls.readOnly} title={cls.readOnly ? (isIdsProjectedRequirement(cls) ? "Odvozeno z IDS - nelze upravit" : "Primární klasifikace - nelze vybrat") : ""} />
                          </td>
                        )}
                        {!hiddenClassificationColumns.has(1) && (
                          <td className="px-2 py-2">
                          {cls.readOnly ? (
                            <span className="text-xs font-medium text-slate-700">
                              {cls.occurrence === "prohibited"
                                ? "Zakázané"
                                : cls.occurrence === "optional"
                                  ? "Možné"
                                  : "Požadované"}
                            </span>
                          ) : (
                            <select
                              className="w-full min-w-[100px] rounded border border-slate-300 px-2 py-1 text-sm"
                              value={cls.occurrence ?? "required"}
                              onChange={(e) =>
                                updateRequirements((reqs) => {
                                  reqs.classifications = reqs.classifications.map((c) => (c.id === cls.id ? { ...c, occurrence: e.target.value as "required" | "prohibited" | "optional" } : c));
                                })
                              }
                            >
                              <option value="required">Požadované</option>
                              <option value="prohibited">Zakázané</option>
                              <option value="optional">Možné</option>
                            </select>
                          )}
                        </td>
                        )}
                        {!hiddenClassificationColumns.has(2) && (
                          <td className="px-2 py-2">
                          {isIdsProjectedRequirement(cls) && (
                            <div className="mb-1 rounded bg-violet-100 px-2 py-1 text-xs font-semibold text-violet-900">
                              {cls.system}
                            </div>
                          )}
                            <select
                              className={`w-full rounded border border-slate-300 px-2 py-1 text-sm ${cls.readOnly ? "bg-slate-100 text-slate-400 cursor-not-allowed" : ""}`}
                              value={cls.systemEntryId ?? ""}
                            onChange={(e) => {
                              const selectedEntryId = e.target.value;
                              const selectedEntry = classificationSystemEntriesForRequirements.find((s) => s.id === selectedEntryId);
                              updateRequirements((reqs) => {
                                reqs.classifications = reqs.classifications.map((c) =>
                                  c.id === cls.id
                                    ? {
                                        ...c,
                                        systemEntryId: selectedEntryId || undefined,
                                        system: selectedEntry?.name ?? c.system,
                                      }
                                    : c
                                );
                              });
                            }}
                            disabled={cls.readOnly}
                          >
                            <option value="">— Vyberte systém —</option>
                            {classificationSystemEntriesForRequirements.map((entry) => (
                              <option key={entry.id} value={entry.id}>
                                {entry.name}
                              </option>
                            ))}
                          </select>
                          {!cls.systemEntryId && cls.system && (
                            <input
                              className={`mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm ${cls.readOnly ? "bg-slate-100 text-slate-400 cursor-not-allowed" : ""}`}
                              value={cls.system}
                              onChange={(e) =>
                                updateRequirements((reqs) => {
                                  reqs.classifications = reqs.classifications.map((c) => (c.id === cls.id ? { ...c, system: e.target.value } : c));
                                })
                              }
                              disabled={cls.readOnly}
                              placeholder="Nebo zadejte název systému ručně"
                            />
                          )}
                          {showCzTranslations && (
                            <input
                              className="mt-1 w-full rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-700 not-italic placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-400 focus:border-slate-400"
                              placeholder="Systém CZ"
                              value={cls.systemCz ?? ""}
                              onChange={(e) =>
                                updateRequirements((reqs) => {
                                  reqs.classifications = reqs.classifications.map((c) => (c.id === cls.id ? { ...c, systemCz: e.target.value || undefined } : c));
                                })
                              }
                              disabled={cls.readOnly}
                            />
                          )}
                        </td>
                        )}
                        {!hiddenClassificationColumns.has(3) && (
                          <td className="px-2 py-2">
                            <select
                              className={`w-full rounded border border-slate-300 px-2 py-1 text-sm ${cls.readOnly ? "bg-slate-100 text-slate-400 cursor-not-allowed" : ""}`}
                              value={cls.constraint ?? "FILLED"}
                            onChange={(e) =>
                              updateRequirements((reqs) => {
                                reqs.classifications = reqs.classifications.map((c) => (c.id === cls.id ? { ...c, constraint: e.target.value as "FILLED" | "ENUM" | "PATTERN" } : c));
                              })
                            }
                            disabled={cls.readOnly}
                          >
                            <option value="FILLED">Jednoduchá hodnota</option>
                            <option value="ENUM">Výčet</option>
                            <option value="PATTERN">Vzor (regex)</option>
                          </select>
                        </td>
                        )}
                        {!hiddenClassificationColumns.has(4) && (
                          <td className="px-2 py-2">
                            <div className="flex flex-col gap-0.5">
                              <input
                                className={`w-full rounded border border-slate-300 px-2 py-1 text-sm ${cls.readOnly ? "bg-slate-100 text-slate-400 cursor-not-allowed" : ""}`}
                                value={cls.value ?? cls.identification ?? cls.code ?? ""}
                                onChange={(e) =>
                                  updateRequirements((reqs) => {
                                    reqs.classifications = reqs.classifications.map((c) => (c.id === cls.id ? { ...c, value: e.target.value, identification: e.target.value, code: e.target.value } : c));
                                  })
                                }
                                disabled={cls.readOnly}
                                placeholder={cls.constraint === "ENUM" ? "Hodnoty oddělené |" : cls.constraint === "PATTERN" ? "Regex vzor" : "Hodnota klasifikace"}
                              />
                              {showCzTranslations && cls.constraint !== "ENUM" && (
                                <input
                                  className="w-full rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-700 not-italic placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-slate-400 focus:border-slate-400"
                                  placeholder="CZ"
                                  value={cls.valueCz ?? ""}
                                  onChange={(e) =>
                                    updateRequirements((reqs) => {
                                      reqs.classifications = reqs.classifications.map((c) => (c.id === cls.id ? { ...c, valueCz: e.target.value || undefined } : c));
                                    })
                                  }
                                  disabled={cls.readOnly}
                                />
                              )}
                            </div>
                        </td>
                        )}
                        {!hiddenClassificationColumns.has(5) && (
                          <td className="px-2 py-2">
                            <input
                              className={`w-full rounded border border-slate-300 px-2 py-1 text-sm ${cls.readOnly ? "bg-slate-100 text-slate-400 cursor-not-allowed" : ""}`}
                              value={cls.uri ?? ""}
                            onChange={(e) =>
                              updateRequirements((reqs) => {
                                reqs.classifications = reqs.classifications.map((c) => (c.id === cls.id ? { ...c, uri: e.target.value || undefined } : c));
                              })
                            }
                            disabled={cls.readOnly}
                            placeholder="URI odkaz"
                          />
                        </td>
                        )}
                        {!hiddenClassificationColumns.has(6) && (
                          <td className="px-2 py-2">
                            <input
                              className={`w-full rounded border border-slate-300 px-2 py-1 text-sm ${cls.readOnly ? "bg-slate-100 text-slate-400 cursor-not-allowed" : ""}`}
                              value={cls.description ?? ""}
                            onChange={(e) =>
                              updateRequirements((reqs) => {
                                reqs.classifications = reqs.classifications.map((c) => (c.id === cls.id ? { ...c, description: e.target.value } : c));
                              })
                            }
                            disabled={cls.readOnly}
                            placeholder="Popis"
                          />
                        </td>
                        )}
                        {!hiddenClassificationColumns.has(7) && (
                          <td className="px-2 py-2">
                            <input
                              className={`w-full rounded border border-slate-300 px-2 py-1 text-sm ${cls.readOnly ? "bg-slate-100 text-slate-400 cursor-not-allowed" : ""}`}
                              value={cls.note ?? ""}
                            onChange={(e) =>
                              updateRequirements((reqs) => {
                                reqs.classifications = reqs.classifications.map((c) => (c.id === cls.id ? { ...c, note: e.target.value || undefined } : c));
                              })
                            }
                            disabled={cls.readOnly}
                            placeholder="Poznámka"
                          />
                        </td>
                        )}
                        {!hiddenClassificationColumns.has(8) && (
                          <td className="px-2 py-2">
                            <input
                              className={`w-full rounded border border-slate-300 px-2 py-1 text-sm ${cls.readOnly ? "bg-slate-100 text-slate-400 cursor-not-allowed" : ""}`}
                              value={cls.priklady ?? ""}
                            onChange={(e) =>
                              updateRequirements((reqs) => {
                                reqs.classifications = reqs.classifications.map((c) => (c.id === cls.id ? { ...c, priklady: e.target.value || undefined } : c));
                              })
                            }
                            disabled={cls.readOnly}
                            placeholder="Příklady"
                          />
                        </td>
                        )}
                        {!hiddenClassificationColumns.has(9) && (
                          <td className="px-2 py-2">
                            <PhaseSelector
                              phases={phases}
                              value={cls.phases}
                            onChange={(ids) =>
                              updateRequirements((reqs) => {
                                reqs.classifications = reqs.classifications.map((c) => (c.id === cls.id ? { ...c, phases: ids } : c));
                              })
                            }
                          />
                        </td>
                        )}
                        {!hiddenClassificationColumns.has(10) && (
                          <td className="px-2 py-2">
                            <UseCaseMultiSelect
                              entries={project?.purposeOfUseEntries ?? []}
                              value={cls.useCaseIds ?? []}
                              onChange={(ids) =>
                                updateRequirements((reqs) => {
                                  reqs.classifications = reqs.classifications.map((c) => (c.id === cls.id ? { ...c, useCaseMode: "custom" as const, useCaseIds: ids } : c));
                                })
                              }
                            />
                          </td>
                        )}
                        {!hiddenClassificationColumns.has(11) && (
                          <td className="px-2 py-2 text-center">
                            <input
                              type="checkbox"
                              className={`h-4 w-4 rounded border-slate-300 text-green-600 focus:ring-green-500 ${cls.readOnly ? "cursor-not-allowed" : "cursor-pointer"}`}
                              checked={isIdsProjectedRequirement(cls) ? (cls.isApplicability ?? false) : cls.readOnly ? true : (cls.isApplicability ?? false)}
                            onChange={(e) =>
                              updateRequirements((reqs) => {
                                reqs.classifications = reqs.classifications.map((c) => (c.id === cls.id ? { ...c, isApplicability: e.target.checked } : c));
                              })
                            }
                            disabled={cls.readOnly}
                            title={cls.readOnly ? (isIdsProjectedRequirement(cls) ? "Zachovaná část původní IDS specifikace" : "Primární klasifikace je vždy v části Použitelnost") : "Pokud je zaškrtnuto, klasifikace bude v části Použitelnost (applicability)"}
                          />
                        </td>
                        )}
                        {!hiddenClassificationColumns.has(12) && (
                          <td className="px-2 py-2 text-right">
                            {!cls.readOnly && (
                            <button className="text-xs text-red-600 hover:underline" onClick={() => removeRequirement("classifications", cls.id)}>
                              Odebrat
                            </button>
                          )}
                          {cls.readOnly && (
                            isIdsProjectedRequirement(cls)
                              ? renderIdsEditAction(cls)
                              : (
                                <span className="text-xs text-slate-400" title="Tato klasifikace je z primárního systému a nelze ji odebrat">
                                  Primární
                                </span>
                              )
                            )}
                          </td>
                        )}
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
                </>
              )}
            </div>
          )}

          {activeTab === "ids" && (() => {
            const validationErrors = validateIdsCompliance(object);
            const hasErrors = validationErrors.some((e) => e.type === "error");
            const hasWarnings = validationErrors.some((e) => e.type === "warning");
            // V náhledu IDS zobrazovat jen fáze zaškrtnuté u entity (ifcEntityPhases)
            const entityPhaseIds = object.ifcEntityPhases ?? object.entityPhases;
            const phasesForIdsPreview = entityPhaseIds?.length ? phases.filter((p) => entityPhaseIds.includes(p.id)) : phases;
            const effectivePhaseId = selectedPhaseId && phasesForIdsPreview.some((p) => p.id === selectedPhaseId) ? selectedPhaseId : null;
            
            return (
            <div className="space-y-3">
              {/* Řádek: Účely užití (náhled podle účelu) */}
              <div className="flex gap-1 flex-wrap items-center">
                <span className="text-xs text-slate-500 w-20 shrink-0">Účely užití:</span>
                <button
                  className={`px-3 py-1.5 text-xs font-medium rounded-t transition-colors ${
                    selectedUseCaseId === null
                      ? "bg-red-100 text-red-700 border-b-2 border-red-500"
                      : "text-slate-600 hover:bg-slate-100"
                  }`}
                  onClick={() => setSelectedUseCaseId(null)}
                >
                  Vše
                </button>
                {(project?.purposeOfUseEntries ?? []).map((entry) => (
                  <button
                    key={entry.id}
                    className={`px-3 py-1.5 text-xs font-medium rounded-t transition-colors ${
                      selectedUseCaseId === entry.id
                        ? "bg-red-100 text-red-700 border-b-2 border-red-500"
                        : "text-slate-600 hover:bg-slate-100"
                    }`}
                    onClick={() => setSelectedUseCaseId(entry.id)}
                    title={entry.description ?? entry.name}
                  >
                    {entry.name}
                  </button>
                ))}
              </div>
              {/* Řádek: Fáze + Export IDS (jako jeden řádek) */}
              <div className="flex justify-between items-center flex-wrap gap-2">
                <div className="flex gap-1 flex-wrap items-center">
                  {phases.length > 0 && (
                    <>
                      <span className="text-xs text-slate-500 w-12 shrink-0">Fáze:</span>
                      <button
                        className={`px-3 py-1.5 text-xs font-medium rounded-t transition-colors ${
                          effectivePhaseId === null
                            ? "bg-red-100 text-red-700 border-b-2 border-red-500"
                            : "text-slate-600 hover:bg-slate-100"
                        }`}
                        onClick={() => setSelectedPhaseId(null)}
                      >
                        Vše
                      </button>
                      {phasesForIdsPreview.map((phase) => (
                        <button
                          key={phase.id}
                          className={`px-3 py-1.5 text-xs font-medium rounded-t transition-colors ${
                            effectivePhaseId === phase.id
                              ? "bg-red-100 text-red-700 border-b-2 border-red-500"
                              : "text-slate-600 hover:bg-slate-100"
                          }`}
                          onClick={() => setSelectedPhaseId(phase.id)}
                          title={phase.name}
                        >
                          {phase.code}
                        </button>
                      ))}
                    </>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  {hasErrors && (
                    <span className="text-xs text-red-600 flex items-center gap-1">
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                        <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                      </svg>
                      {validationErrors.filter((e) => e.type === "error").length} chyb
                    </span>
                  )}
                  {!hasErrors && hasWarnings && (
                    <span className="text-xs text-amber-600 flex items-center gap-1">
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                        <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                      </svg>
                      {validationErrors.filter((e) => e.type === "warning").length} varování
                    </span>
                  )}
                  <span className="text-xs text-slate-500 bg-slate-100 px-2 py-1 rounded">IFC4X3_ADD2</span>
                  {!hasErrors && !hasWarnings && (
                    <span className="text-xs text-green-600 flex items-center gap-1">
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clipRule="evenodd" />
                      </svg>
                      Validní
                    </span>
                  )}
                  <button
                    className={`text-sm text-white px-3 py-1.5 rounded flex items-center gap-1.5 ${hasErrors ? "bg-slate-400 cursor-not-allowed" : "bg-red-600 hover:bg-red-700"}`}
                    onClick={() => hasErrors || setIsExportIdsDialogOpen(true)}
                    disabled={hasErrors}
                    title={hasErrors ? "Opravte chyby před exportem" : "Export IDS – výběr fáze, výskytu a metadata"}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                      <path d="M10.75 2.75a.75.75 0 00-1.5 0v8.614L6.295 8.235a.75.75 0 10-1.09 1.03l4.25 4.5a.75.75 0 001.09 0l4.25-4.5a.75.75 0 00-1.09-1.03l-2.955 3.129V2.75z" />
                      <path d="M3.5 12.75a.75.75 0 00-1.5 0v2.5A2.75 2.75 0 004.75 18h10.5A2.75 2.75 0 0018 15.25v-2.5a.75.75 0 00-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5z" />
                    </svg>
                    Export IDS
                  </button>
                </div>
              </div>
              
              {/* Druhý řádek: Výskyt */}
              <div className="flex gap-1 flex-wrap items-center">
                <span className="text-xs text-slate-500 w-12 shrink-0">Výskyt:</span>
                  <button
                    className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
                      occurrenceFilter === "all"
                        ? "bg-slate-700 text-white"
                        : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                    }`}
                    onClick={() => setOccurrenceFilter("all")}
                  >
                    Vše
                  </button>
                  <button
                    className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
                      occurrenceFilter === "required"
                        ? "bg-green-600 text-white"
                        : "bg-green-100 text-green-700 hover:bg-green-200"
                    }`}
                    onClick={() => setOccurrenceFilter("required")}
                  >
                    Požadované
                  </button>
                  <button
                    className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
                      occurrenceFilter === "prohibited"
                        ? "bg-red-600 text-white"
                        : "bg-red-100 text-red-700 hover:bg-red-200"
                    }`}
                    onClick={() => setOccurrenceFilter("prohibited")}
                  >
                    Zakázané
                  </button>
                  <button
                    className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
                      occurrenceFilter === "optional"
                        ? "bg-amber-600 text-white"
                        : "bg-amber-100 text-amber-700 hover:bg-amber-200"
                    }`}
                    onClick={() => setOccurrenceFilter("optional")}
                  >
                    Možné
                  </button>
              </div>
              
              {/* Třetí řádek: Náhled */}
              <div className="flex gap-2 flex-wrap items-center">
                <span className="text-xs text-slate-500 w-12 shrink-0">Náhled:</span>
                  <button
                    className={`px-4 py-2 text-sm font-medium transition-colors ${
                      idsSubTab === "readable"
                        ? "border-b-2 border-red-500 text-red-600"
                        : "text-slate-600 hover:text-slate-800"
                    }`}
                    onClick={() => setIdsSubTab("readable")}
                  >
                    Lidská řeč
                  </button>
                  <button
                    className={`px-4 py-2 text-sm font-medium transition-colors ${
                      idsSubTab === "schema"
                        ? "border-b-2 border-red-500 text-red-600"
                        : "text-slate-600 hover:text-slate-800"
                    }`}
                    onClick={() => setIdsSubTab("schema")}
                  >
                    Schéma IDS
                  </button>
                  <button
                    className={`px-4 py-2 text-sm font-medium transition-colors ${
                      idsSubTab === "metadata"
                        ? "border-b-2 border-red-500 text-red-600"
                        : "text-slate-600 hover:text-slate-800"
                    }`}
                    onClick={() => setIdsSubTab("metadata")}
                  >
                    Metadata specifikace
                  </button>
              </div>
              
              {/* Validation errors */}
              {validationErrors.length > 0 && (
                <div className="rounded border border-slate-200 bg-white p-3">
                  <div className="text-sm font-semibold text-slate-800 mb-2">Validace IDS</div>
                  <ul className="space-y-1">
                    {validationErrors.map((err, idx) => (
                      <li key={idx} className={`text-xs flex items-start gap-2 ${err.type === "error" ? "text-red-600" : "text-amber-600"}`}>
                        {err.type === "error" ? (
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 flex-shrink-0 mt-0.5">
                            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                          </svg>
                        ) : (
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 flex-shrink-0 mt-0.5">
                            <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                          </svg>
                        )}
                        <span>{err.message}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              
              {/* Human-readable view */}
              {idsSubTab === "readable" && (() => {
                const currentPhase = phases.find((p) => p.id === effectivePhaseId);
                const { applicability, requirements } = generateHumanReadable(object, phases, classificationSystemEntries, effectivePhaseId, occurrenceFilter, selectedUseCaseId ?? undefined);
                const hasContent = applicability.length > 0 || requirements.length > 0;
                
                const currentUseCase = selectedUseCaseId ? (project?.purposeOfUseEntries ?? []).find((e) => e.id === selectedUseCaseId) : null;
                return (
                  <div className="rounded border border-slate-200 bg-white p-4 text-sm text-slate-700">
                    {currentUseCase && (
                      <div className="text-xs text-red-600 font-semibold mb-2">
                        Účel užití: {currentUseCase.name}
                      </div>
                    )}
                    {currentPhase && (
                      <div className="text-xs text-red-600 font-semibold mb-3">
                        Fáze: {currentPhase.code} - {currentPhase.name}
                      </div>
                    )}
                    {!hasContent ? (
                      <div className="text-slate-500 italic">
                        {effectivePhaseId 
                          ? `Žádné požadavky pro fázi ${currentPhase?.code || ""}.`
                          : "Nejsou definovány žádné požadavky. Přidejte entity, vlastnosti, relace nebo další požadavky v ostatních kartách."
                        }
                      </div>
                    ) : (
                      <>
                        {/* Applicability section */}
                        {applicability.length > 0 && (
                          <div className="mb-4">
                            <div className="font-semibold text-slate-800 mb-2">
                              Model <span className="text-red-600">MUSÍ</span> obsahovat entity, které mají:
                            </div>
                            <ul className="list-disc pl-5 space-y-1">
                              {applicability.map((item, idx) => (
                                <li key={idx} dangerouslySetInnerHTML={{ __html: item.replace(/\*\*([^*]+)\*\*/g, '<strong class="text-slate-900">$1</strong>') }} />
                              ))}
                            </ul>
                          </div>
                        )}
                        
                        {/* Requirements section */}
                        {requirements.length > 0 && (
                          <div>
                            <div className="font-semibold text-slate-800 mb-2">
                              A splňovat následující požadavky:
                            </div>
                            <ul className="list-disc pl-5 space-y-1">
                              {requirements.map((item, idx) => (
                                <li 
                                  key={idx} 
                                  dangerouslySetInnerHTML={{ 
                                    __html: item
                                      .replace(/\*\*MUSÍ\*\*/g, '<strong class="text-red-600">MUSÍ</strong>')
                                      .replace(/\*\*NESMÍ\*\*/g, '<strong class="text-red-600">NESMÍ</strong>')
                                      .replace(/\*\*MŮŽE\*\*/g, '<strong class="text-amber-600">MŮŽE</strong>')
                                      .replace(/\*\*([^*]+)\*\*/g, '<strong class="text-slate-900">$1</strong>')
                                      .replace(/\*([^*]+)\*/g, '<em class="text-slate-500">$1</em>')
                                  }} 
                                />
                              ))}
                            </ul>
                          </div>
                        )}
                        
                        {/* IFC version badge */}
                        <div className="mt-4 text-right text-xs text-slate-400">
                          #{selectedIfcVersion}
                        </div>
                      </>
                    )}
                  </div>
                );
              })()}
              
              {/* XML Schema view */}
              {idsSubTab === "schema" && (() => {
                const currentPhase = phases.find((p) => p.id === effectivePhaseId);
                const phaseName = currentPhase ? `${currentPhase.code} - ${currentPhase.name}` : undefined;
                const effectiveUseCaseId = selectedUseCaseId ?? undefined;
                // For preview, apply occurrence filter; for export, use "all"
                const xml = generateIdsXml(object, selectedIfcVersion, effectivePhaseId, classificationSystemEntries, occurrenceFilter, phaseName, undefined, effectiveUseCaseId);
                const xmlForExport = generateIdsXml(object, selectedIfcVersion, effectivePhaseId, classificationSystemEntries, "all", phaseName, undefined, effectiveUseCaseId);
                const sanitize = (s: string) => (s || "").replace(/[^\p{L}\p{N}_\-]/gu, "_").replace(/_+/g, "_") || "export";
                const objectNameForFile = (object.code || object.description || "specification").replace(/::/g, ".");
                const fileName = currentPhase 
                  ? `${sanitize(objectNameForFile)}_${sanitize(currentPhase.code)}`
                  : sanitize(objectNameForFile);
                
                const currentUseCaseSchema = selectedUseCaseId ? (project?.purposeOfUseEntries ?? []).find((e) => e.id === selectedUseCaseId) : null;
                return (
                <div className="space-y-2">
                  {currentUseCaseSchema && (
                    <div className="text-xs text-red-600 font-semibold">
                      Účel užití: {currentUseCaseSchema.name}
                    </div>
                  )}
                  {currentPhase && (
                    <div className="text-xs text-red-600 font-semibold">
                      Fáze: {currentPhase.code} - {currentPhase.name}
                    </div>
                  )}
                  <div className="flex justify-between items-center">
                    <div className="text-xs text-slate-500">
                      IDS XML schéma dle buildingSMART IDS 1.0
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        className="text-xs text-red-600 hover:text-red-800 flex items-center gap-1"
                        onClick={() => {
                          navigator.clipboard.writeText(xml).then(() => {
                            // Could add a toast notification here
                          });
                        }}
                        title="Kopírovat do schránky"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                          <path d="M7 3.5A1.5 1.5 0 018.5 2h3.879a1.5 1.5 0 011.06.44l3.122 3.12a1.5 1.5 0 01.439 1.061V11.5a1.5 1.5 0 01-1.5 1.5H8.5A1.5 1.5 0 017 11.5V3.5z" />
                          <path d="M4.5 6A1.5 1.5 0 003 7.5v9A1.5 1.5 0 004.5 18h7a1.5 1.5 0 001.5-1.5v-1h-5A2.5 2.5 0 015.5 13V6h-1z" />
                        </svg>
                        Kopírovat
                      </button>
                      <button
                        className={`text-xs text-white px-2 py-1 rounded flex items-center gap-1 ${hasErrors ? "bg-slate-400 cursor-not-allowed" : "bg-red-600 hover:bg-red-700"}`}
                        onClick={() => {
                          if (hasErrors) return;
                          // Export always uses full XML (no occurrence filter)
                          const blob = new Blob([xmlForExport], { type: "application/xml" });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement("a");
                          a.href = url;
                          a.download = `${fileName}.ids`;
                          document.body.appendChild(a);
                          a.click();
                          document.body.removeChild(a);
                          URL.revokeObjectURL(url);
                        }}
                        disabled={hasErrors}
                        title={hasErrors ? "Opravte chyby před exportem" : "Stáhnout jako .ids soubor (vždy export všech požadavků)"}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                          <path d="M10.75 2.75a.75.75 0 00-1.5 0v8.614L6.295 8.235a.75.75 0 10-1.09 1.03l4.25 4.5a.75.75 0 001.09 0l4.25-4.5a.75.75 0 00-1.09-1.03l-2.955 3.129V2.75z" />
                          <path d="M3.5 12.75a.75.75 0 00-1.5 0v2.5A2.75 2.75 0 004.75 18h10.5A2.75 2.75 0 0018 15.25v-2.5a.75.75 0 00-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5z" />
                        </svg>
                        Export .ids
                      </button>
                    </div>
                  </div>
                  <pre className="rounded border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700 overflow-auto max-h-[500px] font-mono whitespace-pre">
                    {xml}
                  </pre>
                </div>
                );
              })()}
              
              {/* Metadata specifikace – pro aktuální kombinaci fáze a výskytu */}
              {idsSubTab === "metadata" && (() => {
                const metaKey = `${effectivePhaseId ?? "all"}|${occurrenceFilter}`;
                const meta = getIdsSpecMetadataForPhaseOccurrence(object, effectivePhaseId, occurrenceFilter) ?? {};
                const updateMeta = (patch: Partial<IdsSpecMetadata>) => {
                  const existing = object.idsSpecMetadata ?? {};
                  const keys = Object.keys(existing);
                  const isLegacy = keys.length > 0 && !keys.some((k) => k.includes("|"));
                  const baseMap: Record<string, IdsSpecMetadata> = isLegacy
                    ? { [metaKey]: existing as unknown as IdsSpecMetadata }
                    : { ...(existing as Record<string, IdsSpecMetadata>) };
                  baseMap[metaKey] = { ...baseMap[metaKey], ...patch };
                  onChange({
                    ...object,
                    idsSpecMetadata: baseMap,
                  });
                };
                const currentPhase = phases.find((p) => p.id === effectivePhaseId);
                const occurrenceLabel = occurrenceFilter === "all" ? "Vše" : occurrenceFilter === "required" ? "Požadované" : occurrenceFilter === "prohibited" ? "Zakázané" : "Možné";
                const objectNameForSpec = (object.code || object.description || "").replace(/::/g, ".");
                const sanitize = (s: string) => (s || "").replace(/[^\p{L}\p{N}_\-]/gu, "_").replace(/_+/g, "_") || "export";
                const derivedSpecName = [
                  sanitize(objectNameForSpec),
                  currentPhase?.code ? sanitize(currentPhase.code) : "",
                  occurrenceLabel,
                ].filter(Boolean).join("_");
                return (
                  <div className="rounded border border-slate-200 bg-white p-4 space-y-4">
                    <p className="text-xs text-slate-500">
                      Metadata pro <strong>{currentPhase ? `${currentPhase.code} - ${currentPhase.name}` : "Všechny fáze"}</strong> a výskyt <strong>{occurrenceLabel}</strong>.
                    </p>
                    <div className="grid gap-3 text-sm">
                      <div>
                        <label className="block text-xs font-semibold text-slate-600 mb-1">Název (name)</label>
                        <input
                          type="text"
                          value={(meta.name ?? "").trim() || derivedSpecName}
                          onChange={(e) => updateMeta({ name: (e.target.value.trim() || undefined) })}
                          className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
                          disabled={isLocked}
                        />
                        <span className="text-[10px] text-slate-400">Krátký název specifikované informace</span>
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-600 mb-1">IFC verze (ifcVersion)</label>
                        <input
                          type="text"
                          readOnly
                          value={selectedIfcVersion}
                          className="w-full rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm text-slate-600"
                        />
                        <span className="text-[10px] text-slate-400">Z nastavení projektu, nelze měnit</span>
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-600 mb-1">Identifikátor (identifier)</label>
                        <input
                          type="text"
                          value={meta.identifier ?? ""}
                          onChange={(e) => updateMeta({ identifier: e.target.value || undefined })}
                          placeholder="SP01, Fire-001, nebo UUID"
                          className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
                          disabled={isLocked}
                        />
                        <span className="text-[10px] text-slate-400">Unikátní v rámci IDS souboru</span>
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-600 mb-1">Popis (description)</label>
                        <textarea
                          value={meta.description ?? ""}
                          onChange={(e) => updateMeta({ description: e.target.value || undefined })}
                          placeholder="Proč je požadavek důležitý pro projekt, jaké workflow podporuje"
                          className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm min-h-[80px]"
                          rows={3}
                          disabled={isLocked}
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-600 mb-1">Instrukce (instructions)</label>
                        <textarea
                          value={meta.instructions ?? ""}
                          onChange={(e) => updateMeta({ instructions: e.target.value || undefined })}
                          placeholder="Kdo je odpovědný, jak dosáhnout požadavku, edge-cases"
                          className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm min-h-[80px]"
                          rows={3}
                          disabled={isLocked}
                        />
                      </div>
                    </div>
                  </div>
                );
              })()}
              
            </div>
            );
          })()}
        </div>
          );

          if (requirementsViewMode === "groups" && project) {
            return (
              <RequirementGroupsPanel
                project={project as Project}
                ifcEntity={object.ifcEntity}
                predefinedType={selectedPredefinedType}
                selectedFingerprint={selectedItemGroup?.fingerprint}
                onSelectGroup={(fp, kind, group) => {
                  setSelectedItemGroup(fp && kind ? { kind, fingerprint: fp } : null);
                  onFocusRequirementGroup?.(group ?? null);
                }}
                onAssignGroupToObjects={onAssignGroupToObjects}
                onMoveGroupToKind={onMoveGroupToKind}
                onEditIdsGroup={(group) => {
                  const specificationId = group.idsReference?.specificationId;
                  if (!specificationId) return;
                  const specification = project.idsSpecifications?.find(
                    (item) => item.id === specificationId,
                  );
                  if (!specification) return;
                  openIdsSpecificationEditor(
                    specification,
                    group.idsReference?.facetIds[0],
                  );
                }}
                onAssignIdsGroup={onAssignIdsGroup}
                onConvertProjectGroupToIds={onConvertProjectGroupToIds}
              >
                {selectedItemGroup && selectedItemGroupData?.origin === "project" && (
                  <>
                    <div className="px-4 py-1.5 text-xs text-slate-600 border-b border-slate-200 bg-amber-50/50">
                      Změny se aplikují na {selectedItemGroupData.objectCodes.length} objektů.
                    </div>
                    {editorBlock}
                  </>
                )}
              </RequirementGroupsPanel>
            );
          }

          return (
            <>
              <RequirementsTabs
                requirements={effectiveRequirements}
                onChangeRequirements={(nextReqs) => {
                  if (onChange) onChange({ ...object, requirements: nextReqs });
                }}
                activeTab={activeTab}
                onTabChange={setActiveTab}
              />
              {requirementsViewMode === "object" && idsProjectedRequirementCount > 0 && (
                <div className="border-b border-violet-200 bg-violet-50 px-4 py-2 text-xs text-violet-900">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    {entityIdsSpecifications.map((specification) => (
                      <button
                        type="button"
                        key={specification.id}
                        className="rounded border border-violet-300 bg-white px-2 py-1 text-[10px] font-semibold text-violet-800 hover:bg-violet-100"
                        onClick={() => {
                          openIdsSpecificationEditor(specification);
                        }}
                      >
                        Upravit IDS
                        {idsSpecificationOrdinalById.get(specification.id)
                          ? ` #${idsSpecificationOrdinalById.get(specification.id)}`
                          : ""}
                        : {specification.name || specification.identifier}
                      </button>
                    ))}
                  </div>
                  <span className="font-semibold">
                    IDS: {idsProjectedRequirementCount} odvozených facetů
                  </span>
                  {" · "}
                  Jsou promítnuté do běžných záložek podle vybrané entity, zachovávají
                  Použitelnost/Požadavky a zde jsou pouze pro čtení. Zdrojové IDS se tím neduplikuje.
                </div>
              )}
              {editorBlock}
            </>
          );
        })()}
      </div>
      </CollapsibleSection>
      )}

      {/* Dialog pro duplikaci požadavků (atributy, klasifikace, materiál, součásti) do jiných objektů – mimo karty, aby byl dostupný ze všech záložek */}
      {duplicateToObjectsDialogType && project && (() => {
        const configs = {
          attributes: {
            title: "Duplikovat atributy do objektů",
            description: "Vyberte objekty, do kterých se zkopírují vybrané atributy (vždy jako nezávislé kopie).",
            getSummary: () => `Počet: ${selectedAttributes.size} atributů`,
            getItems: () => effectiveRequirements.attributes.filter((a) => selectedAttributes.has(a.id)),
            onConfirm: onDuplicateAttributesToObjects,
            clearSelection: () => setSelectedAttributes(new Set()),
          },
          classification: {
            title: "Duplikovat klasifikace do objektů",
            description: "Vyberte objekty, do kterých se zkopírují vybrané klasifikace (vždy jako nezávislé kopie).",
            getSummary: () => `Počet: ${selectedClassifications.size} klasifikací`,
            getItems: () => effectiveRequirements.classifications.filter((c) => selectedClassifications.has(c.id)),
            onConfirm: onDuplicateClassificationsToObjects,
            clearSelection: () => setSelectedClassifications(new Set()),
          },
          material: {
            title: "Duplikovat materiálové požadavky do objektů",
            description: "Vyberte objekty, do kterých se zkopírují vybrané materiálové požadavky (vždy jako nezávislé kopie).",
            getSummary: () => `Počet: ${selectedMaterials.size} materiálů`,
            getItems: () => effectiveRequirements.materials.filter((m) => selectedMaterials.has(m.id)),
            onConfirm: onDuplicateMaterialsToObjects,
            clearSelection: () => setSelectedMaterials(new Set()),
          },
          partOf: {
            title: "Duplikovat součásti (vztahy) do objektů",
            description: "Vyberte objekty, do kterých se zkopírují vybrané vztahy součástí (vždy jako nezávislé kopie).",
            getSummary: () => `Počet: ${selectedRelations.size} vztahů`,
            getItems: () => effectiveRequirements.relations.filter((r) => selectedRelations.has(r.id)),
            onConfirm: onDuplicateRelationsToObjects,
            clearSelection: () => setSelectedRelations(new Set()),
          },
        };
        const config = configs[duplicateToObjectsDialogType];
        if (!config || !config.onConfirm) return null;
        const handler = config.onConfirm;
        return (
          <SelectObjectsForDuplicateDialog
            classification={project.classification}
            classificationSystemEntries={project.classificationSystemEntries ?? []}
            objects={project.objects}
            currentObjectCode={object.code}
            title={config.title}
            description={config.description}
            selectedSummary={config.getSummary()}
            getConflictsForTargets={() => []}
            onConfirm={(targetObjectCodes) => {
              const items = config.getItems();
              if (items.length > 0 && targetObjectCodes.length > 0) {
                (handler as (sourceObjectCode: string, items: unknown, targetObjectCodes: string[]) => void)(object.code, items, targetObjectCodes);
                config.clearSelection();
              }
              setDuplicateToObjectsDialogType(null);
            }}
            onClose={() => setDuplicateToObjectsDialogType(null)}
          />
        );
      })()}

      {/* Export IDS dialog – výběr fáze, výskytu a metadata */}
      {isExportIdsDialogOpen && activeTab === "ids" && (
        <IdsSingleExportDialog
          object={object}
          phases={phases}
          entityPhaseIds={object.ifcEntityPhases ?? object.entityPhases}
          classificationSystemEntries={classificationSystemEntries}
          project={project}
          selectedIfcVersion={selectedIfcVersion}
          generateIdsXml={generateIdsXml}
          onClose={() => setIsExportIdsDialogOpen(false)}
        />
      )}
    </div>
  );
};
