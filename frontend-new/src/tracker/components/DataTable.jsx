import React from 'react';

// Generic table.
// columns: [{ key, header, render?(row), width?, align?, className? }]
// selectable: shows a checkbox column driven by `selected` (Set of ids) + `onSelectionChange`.
export default function DataTable({
  columns,
  rows,
  rowKey = 'id',
  selectable = false,
  selected,
  onSelectionChange,
  onRowClick,
  emptyMessage = 'Nothing to show.',
  loading = false,
}) {
  const ids = rows.map((r) => r[rowKey]);
  const allChecked = selectable && ids.length > 0 && ids.every((id) => selected?.has(id));
  const someChecked = selectable && !allChecked && ids.some((id) => selected?.has(id));

  const toggleAll = () => {
    const next = new Set(selected);
    if (allChecked) ids.forEach((id) => next.delete(id));
    else ids.forEach((id) => next.add(id));
    onSelectionChange(next);
  };
  const toggleOne = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    onSelectionChange(next);
  };

  const colCount = columns.length + (selectable ? 1 : 0);

  return (
    <div className="trk-table-wrap">
      <table className="trk-table">
        <thead>
          <tr>
            {selectable && (
              <th className="trk-table__check">
                <input
                  type="checkbox"
                  checked={allChecked}
                  ref={(el) => { if (el) el.indeterminate = someChecked; }}
                  onChange={toggleAll}
                  aria-label="Select all rows"
                />
              </th>
            )}
            {columns.map((c) => (
              <th key={c.key} style={{ width: c.width, textAlign: c.align }} className={c.className}>{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr><td colSpan={colCount} className="trk-table__empty">Loading…</td></tr>
          )}
          {!loading && rows.length === 0 && (
            <tr><td colSpan={colCount} className="trk-table__empty">{emptyMessage}</td></tr>
          )}
          {!loading && rows.map((row) => {
            const id = row[rowKey];
            const isSel = selectable && selected?.has(id);
            return (
              <tr
                key={id}
                className={`${isSel ? 'is-selected' : ''} ${onRowClick ? 'is-clickable' : ''}`}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {selectable && (
                  <td className="trk-table__check" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={!!isSel} onChange={() => toggleOne(id)} aria-label="Select row" />
                  </td>
                )}
                {columns.map((c) => (
                  <td key={c.key} style={{ textAlign: c.align }} className={c.className}>
                    {c.render ? c.render(row) : row[c.key]}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
