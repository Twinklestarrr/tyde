import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { ProjectBoardTrendMetric, ProjectBoardTrends } from '@tyde/shared';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export const boardMetricLabels: Record<ProjectBoardTrendMetric, string> = {
  QUANTITY: '作业数量',
  ACCURACY: '正确率',
  CPD: 'CPD',
};
export function boardNumber(value: number | null) {
  return value == null ? '—' : value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}
const colors = [
  '#1f9bb6',
  '#ed5875',
  '#008e6c',
  '#8b6bd9',
  '#ba7315',
  '#5279d9',
  '#ae477f',
  '#557c32',
  '#986953',
  '#47687a',
];

/** 旧版多人比较：十人以内共同绘线，超过十人使用日期矩阵；空值保留断点。 */
export function ProjectBoardTrendsView({ data }: { data: ProjectBoardTrends }) {
  const id = useId();
  const chartRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  const hasChart =
    data.series.length > 0 &&
    data.series.length <= 10 &&
    data.series.some((member) => member.values.some((value) => value != null));
  useLayoutEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const measure = () => {
      const next = chart.getBoundingClientRect().width;
      if (next > 0) setWidth(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(chart);
    return () => observer.disconnect();
  }, [hasChart]);
  if (!data.series.length || !data.dates.length)
    return <EmptyState title="当前范围暂无可展示的人员趋势。" />;
  const format = (value: number | null | undefined, unit?: string | null) =>
    value == null
      ? '—'
      : `${boardNumber(value)}${data.metric === 'ACCURACY' ? '%' : data.metric === 'QUANTITY' && unit ? ` ${unit}` : ''}`;
  const name = (member: ProjectBoardTrends['series'][number]) =>
    `${member.displayName}（用户ID：${member.userId}）`;
  if (data.series.length > 10)
    return (
      <div className="min-w-0 overflow-x-auto">
        <Table>
          <caption className="sr-only">{boardMetricLabels[data.metric]}逐日人员数据</caption>
          <TableHeader>
            <TableRow>
              <TableHead>人员</TableHead>
              {data.dates.map((date) => (
                <TableHead key={date}>{date}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.series.map((member) => (
              <TableRow key={member.memberId}>
                <TableCell className="whitespace-nowrap">{name(member)}</TableCell>
                {data.dates.map((date, index) => (
                  <TableCell key={date}>
                    {format(member.values[index], member.quantityUnit)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  if (!hasChart)
    return <EmptyState title="当前日期范围暂无可计算的数据。" description="缺少数据不等于零。" />;
  const maximum = Math.max(
    1,
    ...data.series.flatMap((member) =>
      member.values.filter((value): value is number => value != null),
    ),
  );
  const height = 260;
  const left = 56;
  const right = 18;
  const top = 38;
  const bottom = 32;
  const x = (index: number) =>
    data.dates.length === 1
      ? (left + width - right) / 2
      : left + (index / (data.dates.length - 1)) * (width - left - right);
  const y = (value: number) => height - bottom - (value / maximum) * (height - top - bottom);
  const units = [...new Set(data.series.map((member) => member.quantityUnit).filter(Boolean))];
  const unit =
    data.metric === 'ACCURACY' ? '%' : data.metric === 'QUANTITY' ? units.join(' / ') : '';
  return (
    <figure className="min-w-0 space-y-3">
      <figcaption id={`${id}-title`} className="flex flex-wrap gap-x-4 gap-y-2 text-xs">
        {data.series.map((member, index) => (
          <span key={member.memberId} className="inline-flex items-center gap-1.5 break-words">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: colors[index] }}
              aria-hidden
            />
            {name(member)}
          </span>
        ))}
      </figcaption>
      <div
        ref={chartRef}
        role="region"
        aria-label="趋势图表"
        tabIndex={0}
        className="min-w-0 rounded-md focus-visible:outline-2 focus-visible:outline-ring"
      >
        <svg
          viewBox={`0 0 ${width} ${height}`}
          height={height}
          role="img"
          aria-labelledby={`${id}-title ${id}-description`}
          className="block w-full text-muted-foreground"
        >
          <desc id={`${id}-description`}>
            {data.dates[0]}至{data.dates.at(-1)}的{boardMetricLabels[data.metric]}，断点表示无数据。
          </desc>
          <text x={left} y={14} fontSize="12" fill="currentColor">
            {boardMetricLabels[data.metric]}
            {unit ? `（${unit}）` : ''}
          </text>
          {[0, maximum / 2, maximum].map((value) => (
            <g key={value}>
              <line
                x1={left}
                x2={width - right}
                y1={y(value)}
                y2={y(value)}
                stroke="currentColor"
                opacity="0.16"
              />
              <text
                x={left - 8}
                y={y(value) + 4}
                textAnchor="end"
                fill="currentColor"
                fontSize="12"
              >
                {value >= 1000000
                  ? value.toExponential(1)
                  : value.toLocaleString('zh-CN', {
                      notation: 'compact',
                      maximumFractionDigits: 1,
                    })}
              </text>
            </g>
          ))}
          {data.series.map((member, seriesIndex) => {
            let connected = false;
            const path = data.dates
              .map((_, index) => {
                const value = member.values[index];
                if (value == null) {
                  connected = false;
                  return '';
                }
                const point = `${connected ? 'L' : 'M'}${x(index)},${y(value)}`;
                connected = true;
                return point;
              })
              .join(' ');
            return (
              <g key={member.memberId} style={{ color: colors[seriesIndex] }}>
                <path
                  d={path}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  vectorEffect="non-scaling-stroke"
                />
                {data.dates.map((date, index) => {
                  const value = member.values[index];
                  return value == null ? null : (
                    <g key={date}>
                      <circle cx={x(index)} cy={y(value)} r="3" fill="currentColor">
                        <title>
                          {name(member)} · {date} · {format(value, member.quantityUnit)}
                        </title>
                      </circle>
                      <text
                        x={x(index)}
                        y={y(value) - 8}
                        fontSize="10"
                        textAnchor="middle"
                        fill="currentColor"
                      >
                        {format(value)}
                      </text>
                    </g>
                  );
                })}
              </g>
            );
          })}
          <text x={left} y={height - 8} fill="currentColor" fontSize="12">
            {data.dates[0]}
          </text>
          {data.dates.length > 1 && (
            <text
              x={width - right}
              y={height - 8}
              textAnchor="end"
              fill="currentColor"
              fontSize="12"
            >
              {data.dates.at(-1)}
            </text>
          )}
        </svg>
      </div>
      {data.metric === 'ACCURACY' && (
        <p className="text-xs text-muted-foreground">
          断点表示当天无抽检数据；0%表示存在抽检且合格量为0。
        </p>
      )}
    </figure>
  );
}
