import React from 'react';
import {
  BarChart3,
  LineChart as LineIcon,
  AreaChart as AreaIcon,
  PieChart as PieIcon,
  Radar as RadarIcon,
  AlignLeft,
  Layers,
} from 'lucide-react';

export type ChartKind = 'bar' | 'hbar' | 'line' | 'area' | 'radar' | 'pie' | 'stacked';

export const VIVID_PALETTE = [
  '#2563EB', // Cobalt Blue
  '#8B5CF6', // Vivid Violet
  '#10B981', // Emerald Green
  '#F59E0B', // Warm Amber
  '#F43F5E', // Vivid Rose
  '#06B6D4', // Bright Cyan
  '#EC4899', // Magenta Pink
  '#EA580C', // Vibrant Orange
  '#6366F1', // Indigo
  '#14B8A6', // Teal
];

const CHART_META: Record<ChartKind, { label: string; icon: React.ReactNode }> = {
  bar: { label: 'Sütun', icon: <BarChart3 className="h-3.5 w-3.5" /> },
  hbar: { label: 'Yatay', icon: <AlignLeft className="h-3.5 w-3.5" /> },
  stacked: { label: 'Yığılmış', icon: <Layers className="h-3.5 w-3.5" /> },
  line: { label: 'Çizgi', icon: <LineIcon className="h-3.5 w-3.5" /> },
  area: { label: 'Alan', icon: <AreaIcon className="h-3.5 w-3.5" /> },
  radar: { label: 'Radar', icon: <RadarIcon className="h-3.5 w-3.5" /> },
  pie: { label: 'Pasta', icon: <PieIcon className="h-3.5 w-3.5" /> },
};

interface ChartTypeSelectorProps {
  value: ChartKind;
  options: ChartKind[];
  onChange: (kind: ChartKind) => void;
}

export const ChartTypeSelector: React.FC<ChartTypeSelectorProps> = ({
  value,
  options,
  onChange,
}) => {
  return (
    <div
      className="no-print inline-flex flex-wrap items-center gap-0.5 rounded-lg border border-slate-200 bg-slate-100 p-0.5"
      role="group"
      aria-label="Grafik türü seçici"
    >
      {options.map((kind) => {
        const meta = CHART_META[kind];
        const active = value === kind;
        return (
          <button
            key={kind}
            type="button"
            onClick={() => onChange(kind)}
            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold transition-colors ${
              active
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {meta.icon}
            <span>{meta.label}</span>
          </button>
        );
      })}
    </div>
  );
};
