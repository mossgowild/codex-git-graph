export const colors = ['var(--accent)', 'var(--success)', 'var(--warning)', 'var(--danger)',
  'color-mix(in srgb, var(--accent) 55%, var(--success))',
  'color-mix(in srgb, var(--accent) 55%, var(--danger))',
  'color-mix(in srgb, var(--success) 55%, var(--warning))'];

export function layout(commits) {
  const lanes = [];
  let sequence = 0, width = 1;
  const rows = commits.map(commit => {
    let column = lanes.findIndex(lane => lane?.hash === commit.hash);
    const incoming = column !== -1;
    if (column === -1) {
      column = lanes.findIndex(lane => lane == null);
      if (column === -1) column = lanes.length;
      lanes[column] = { hash: commit.hash, color: sequence++ % colors.length };
    }
    const color = lanes[column].color;
    const lines = lanes.flatMap((lane, index) => lane && index !== column
      ? [{ from: index, to: index, kind: 'through', color: lane.color }] : []);
    if (incoming) lines.push({ from: column, to: column, kind: 'incoming', color });
    lanes[column] = null;
    for (const [index, parent] of commit.parents.entries()) {
      let target = lanes.findIndex(lane => lane?.hash === parent);
      if (target === -1) {
        target = index === 0 ? column : lanes.findIndex(lane => lane == null);
        if (target === -1) target = lanes.length;
        lanes[target] = { hash: parent, color: index === 0 ? color : sequence++ % colors.length };
      }
      lines.push({ from: column, to: target, kind: 'parent', color: lanes[target].color });
    }
    width = Math.max(width, lanes.length, column + 1);
    while (lanes.length && lanes.at(-1) == null) lanes.pop();
    return { ...commit, column, color, lines };
  });
  return { rows, width, continuation: lanes.filter(Boolean).map(lane => lane.hash) };
}
