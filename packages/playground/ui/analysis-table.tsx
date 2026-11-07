import { useMemo, useState } from "react";
import type { AnalysisDataset } from "../src/analysis-contract";
import { Bar, Button, FieldLabel, Input, Select, View } from "./components";
import { Modal } from "./modal";
import { ResultGrid, ValueInspector } from "./results";
import { ToolbarActions } from "./toolbar-actions";
import type { Value } from "./types";

export function AnalysisTable({ dataset, rows }: { dataset: AnalysisDataset; rows: AnalysisDataset["rows"] }) {
  const [search, setSearch] = useState(""),
    [sort, setSort] = useState<number | null>(null),
    [descending, setDescending] = useState(false),
    [hidden, setHidden] = useState<number[]>([]),
    [columns, setColumns] = useState(false),
    [inspect, setInspect] = useState<Value | undefined>();
  const visible = dataset.columns.map((_, i) => i).filter((i) => !hidden.includes(i));
  const data = useMemo(
    () => ({
      columns: dataset.columns.filter((_, i) => !hidden.includes(i)),
      rows: rows.map((row) => row.filter((_, i) => !hidden.includes(i)).map((v) => v as Value)),
      truncated: !dataset.complete,
    }),
    [dataset, rows, hidden],
  );
  return (
    <View className="analysis-table">
      <Bar className="analysis-table-toolbar">
        <Input
          aria-label="Search analysis rows"
          placeholder="Search captured rows"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <ToolbarActions label="Analysis table actions" collapseBelow={520}>
          <Select
            aria-label="Sort analysis rows"
            value={sort ?? ""}
            onChange={(e) => setSort(e.target.value === "" ? null : Number(e.target.value))}
          >
            <option value="">Source order</option>
            {visible.map((i) => (
              <option key={i} value={i}>
                {dataset.columns[i]}
              </option>
            ))}
          </Select>
          <Button disabled={sort === null} onClick={() => setDescending((v) => !v)}>
            {descending ? "Descending" : "Ascending"}
          </Button>
          <Button onClick={() => setColumns(true)}>Columns</Button>
        </ToolbarActions>
      </Bar>
      <ResultGrid
        data={data}
        filter={search}
        sort={sort === null || !visible.includes(sort) ? null : { column: visible.indexOf(sort), descending }}
        onInspect={setInspect}
      />
      {inspect !== undefined ? <ValueInspector value={inspect} onClose={() => setInspect(undefined)} /> : null}
      {columns ? (
        <Modal className="analysis-columns" label="Visible analysis columns" onClose={() => setColumns(false)}>
          <h3>Visible columns</h3>
          {dataset.columns.map((name, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: captured columns have immutable ordinal identities and may share names.
            <FieldLabel key={i}>
              <Input
                type="checkbox"
                checked={!hidden.includes(i)}
                disabled={visible.length === 1 && visible.includes(i)}
                onChange={(e) =>
                  setHidden((current) => (e.target.checked ? current.filter((value) => value !== i) : [...current, i]))
                }
              />
              {name}
            </FieldLabel>
          ))}
          <Button onClick={() => setColumns(false)}>Done</Button>
        </Modal>
      ) : null}
    </View>
  );
}
