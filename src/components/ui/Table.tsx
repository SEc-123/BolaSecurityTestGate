export interface Column<T> {
  key: keyof T;
  label: string;
  render?: (value: any, row: T) => React.ReactNode;
  width?: string;
}

interface TableProps<T extends { id: string }> {
  columns: Column<T>[];
  data: T[];
  onRowClick?: (row: T) => void;
  loading?: boolean;
}

export function Table<T extends { id: string }>({
  columns,
  data,
  onRowClick,
  loading = false,
}: TableProps<T>) {
  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center border border-slate-200 bg-white">
        <div className="animate-spin h-10 w-10 rounded-full border border-slate-200 border-t-slate-700"></div>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="border border-dashed border-slate-300 bg-white py-12 text-center">
        <p className="text-sm text-slate-500">No data available</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead className="border-b border-slate-200 bg-slate-50">
          <tr>
            {columns.map((column, columnIndex) => (
              <th
                key={`${String(column.key)}-${columnIndex}`}
                className={`px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-[0.08em] text-slate-500 ${
                  column.width || ''
                }`}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, idx) => (
            <tr
              key={row.id}
              className={`cursor-pointer border-b border-slate-100 transition-colors last:border-b-0 hover:bg-blue-50/40 ${
                idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/70'
              }`}
              onClick={() => onRowClick?.(row)}
            >
              {columns.map((column, columnIndex) => (
                <td key={`${String(column.key)}-${columnIndex}`} className="px-4 py-3 align-top text-sm text-slate-800">
                  {column.render ? column.render(row[column.key], row) : String(row[column.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
