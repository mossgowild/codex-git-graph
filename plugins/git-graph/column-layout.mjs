import { z } from 'zod';

export const columns = [
  { id: 'graph', label: '关系图', min: 20, initial: 20 },
  { id: 'message', label: '提交', min: 100, initial: 180 },
  { id: 'author', label: '作者', min: 56, initial: 100 },
  { id: 'date', label: '日期', min: 48, initial: 60 },
  { id: 'hash', label: 'SHA', min: 56, initial: 64 },
];
export const maxColumnWidth = 2400;
export const widthsSchema = z.strictObject(Object.fromEntries(columns.map(column =>
  [column.id, z.number().int().min(column.min).max(maxColumnWidth).optional()])));
