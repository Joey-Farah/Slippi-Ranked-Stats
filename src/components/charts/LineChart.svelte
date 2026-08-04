<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import * as echarts from "echarts";

  interface Marker {
    x: string;
    y: number;
    name: string;
  }

  let {
    xData,
    yData,
    label = "",
    color = "#2ecc71",
    fill = false,
    markers = [] as Marker[],
    height = 240,
    yMin = undefined as number | undefined,
    yMax = undefined as number | undefined,
    y2Data = undefined as (number | null)[] | undefined,
    label2 = "",
    color2 = "#7c3aed",
    xAxisLabel = "",
    yAxisLabel = "",
  }: {
    xData: (string | number)[];
    yData: (number | null)[];
    label?: string;
    color?: string;
    fill?: boolean;
    markers?: Marker[];
    height?: number;
    yMin?: number;
    yMax?: number;
    y2Data?: (number | null)[];
    label2?: string;
    color2?: string;
    xAxisLabel?: string;
    yAxisLabel?: string;
  } = $props();

  let container: HTMLDivElement;
  let chart: echarts.ECharts | null = null;

  function buildOption() {
    return {
      backgroundColor: "transparent",
      textStyle: { color: "#888" },
      grid: { left: 50, right: 20, top: 20, bottom: xAxisLabel ? 56 : 40 },
      tooltip: {
        trigger: "axis",
        backgroundColor: "#2b2b2b",
        borderColor: "#3a3a3a",
        textStyle: { color: "#e0e0e0" },
        formatter: (params: any) => {
          const pts = Array.isArray(params) ? params : [params];
          if (!pts[0]) return "";
          const date = String(pts[0].axisValue).slice(0, 10);
          return pts
            .filter((p: any) => p.value != null)
            .reduce((s: string, p: any) => s + `${p.marker}${p.seriesName}: ${Number(p.value).toFixed(1)}<br/>`, `${date}<br/>`);
        },
      },
      xAxis: {
        type: "category",
        data: xData,
        axisLine: { lineStyle: { color: "#3a3a3a" } },
        axisLabel: { color: "#666", fontSize: 11, formatter: (v: string) => v.slice(0, 10) },
        splitLine: { show: false },
        name: xAxisLabel,
        nameLocation: "middle",
        nameGap: 28,
        nameTextStyle: { color: "#888", fontSize: 11 },
      },
      yAxis: {
        type: "value",
        min: yMin,
        max: yMax,
        axisLine: { lineStyle: { color: "#3a3a3a" } },
        axisLabel: { color: "#666", fontSize: 11, formatter: (v: number) => v.toFixed(1) },
        splitLine: { lineStyle: { color: "#2a2a2a" } },
        name: yAxisLabel,
        nameLocation: "middle",
        nameGap: 40,
        nameTextStyle: { color: "#888", fontSize: 11 },
      },
      series: [
        {
          name: label,
          type: "line",
          data: yData,
          smooth: true,
          lineStyle: { color, width: 2 },
          itemStyle: { color },
          areaStyle: fill ? { color: color + "22" } : undefined,
          showSymbol: false,
        },
        ...(y2Data
          ? [{
              name: label2,
              type: "line",
              data: y2Data,
              smooth: true,
              lineStyle: { color: color2, width: 2, type: "dashed" },
              itemStyle: { color: color2 },
              showSymbol: false,
            }]
          : []),
        ...(markers.length > 0
          ? [
              {
                name: "Season End",
                type: "scatter",
                data: markers.map((m) => ({
                  name: m.name,
                  value: [m.x, m.y],
                })),
                symbol: "diamond",
                symbolSize: 10,
                itemStyle: { color: "#f39c12" },
                tooltip: {
                  formatter: (params: any) =>
                    `${params.data.name}: ${params.data.value[1].toFixed(1)}`,
                },
              },
            ]
          : []),
      ],
    };
  }

  onMount(() => {
    chart = echarts.init(container, "dark");
    chart.setOption(buildOption());
    // Coalesce to one resize per frame. ResizeObserver fires continuously while a window is
    // being dragged, and echarts.resize() is a full re-layout and redraw — running it per
    // callback rather than per frame is what made dragging the window feel like it was
    // stuttering on any tab with charts on it.
    let frame = 0;
    const ro = new ResizeObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        chart?.resize();
      });
    });
    ro.observe(container);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      ro.disconnect();
    };
  });

  $effect(() => {
    chart?.setOption(buildOption(), { notMerge: true });
  });

  onDestroy(() => chart?.dispose());
</script>

<div bind:this={container} style="width:100%; height:{height}px"></div>
