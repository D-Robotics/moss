export const WorkbenchIcon = ({ name }: { name: 'menu' | 'panel' }) => (
  <span className="text-glyph" aria-hidden="true">
    {name === 'menu' ? '☰' : '▣'}
  </span>
);
