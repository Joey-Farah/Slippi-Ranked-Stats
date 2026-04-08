<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import * as echarts from "echarts";

  let {
    categories,
    values,
    label = "",
    color = "#2ecc71",
    horizontal = false,
    height,
    paired = false, // when true: show green win% + red loss% as stacked bars
  }: {
    categories: string[];
    values: number[];
    label?: string;
    color?: string;
    horizontal?: boolean;
    height?: number;
    paired?: boolean;
  } = $props();

  // Auto-size height based on item count for horizontal bars
  let autoHeight = $derived(height ?? (horizontal ? Math.max(180, categories.length * 28 + 40) : 240));

  let container: HTMLDivElement;
  let chart: echarts.ECharts | null = null;

  function buildOption() {
    // ECharts renders horizontal bars bottom-to-top, so reverse to make
    // the first item appear at the top of the chart.
    const cats = horizontal ? [...categories].reverse() : categories;
    const vals = horizontal ? [...values].reverse() : values;

    const axis = {
      type: "value" as const,
      axisLine: { lineStyle: { color: "#3a3a3a" } },
      axisLabel: { color: "#666", fontSize: 11, formatter: (v: number) => v.toFixed(0) + "%" },
      splitLine: { lineStyle: { color: "#2a2a2a" } },
      max: 100,
    };
    const cat = {
      type: "category" as const,
      data: cats,
      axisLine: { lineStyle: { color: "#3a3a3a" } },
      axisLabel: { color: "#aaa", fontSize: 11 },
    };

    const tooltip = {
      trigger: "axis" as const,
      backgroundColor: "#2b2b2b",
      borderColor: "#3a3a3a",
      textStyle: { color: "#e0e0e0" },
      formatter: (params: any) => {
        const win = params[0]?.value ?? 0;
        const loss = 100 - win;
        return `${params[0].name}<br/><span style="color:#2ecc71">Win: ${win.toFixed(1)}%</span>  <span style="color:#e74c3c">Loss: ${loss.toFixed(1)}%</span>`;
      },
    };

    if (paired) {
      return {
        backgroundColor: "transparent",
        textStyle: { color: "#888" },
        grid: horizontal
          ? { left: 140, right: 60, top: 10, bottom: 20 }
          : { left: 40, right: 20, top: 20, bottom: 60 },
        tooltip,
        xAxis: horizontal ? axis : { ...cat, axisLabel: { color: "#aaa", fontSize: 10, rotate: 30 } },
        yAxis: horizontal ? cat : axis,
        series: [
          {
            name: "Win",
            type: "bar",
            stack: "winloss",
            data: vals,
            itemStyle: { color: "#2ecc71" },
            label: {
              show: true,
              position: "inside",
              formatter: (p: any) => {
                const v = p.value as number;
                return v >= 15 ? `${v.toFixed(1)}%` : "";
              },
              color: "#fff",
              fontSize: 11,
              fontWeight: "bold",
            },
          },
          {
            name: "Loss",
            type: "bar",
            stack: "winloss",
            data: vals.map((v) => 100 - v),
            itemStyle: { color: "#e74c3c" },
            label: {
              show: true,
              position: "inside",
              formatter: (p: any) => {
                const v = p.value as number;
                return v >= 15 ? `${v.toFixed(1)}%` : "";
              },
              color: "#fff",
              fontSize: 11,
              fontWeight: "bold",
            },
          },
        ],
      };
    }

    // Single bar (non-paired) mode
    return {
      backgroundColor: "transparent",
      textStyle: { color: "#888" },
      grid: horizontal
        ? { left: 140, right: 60, top: 10, bottom: 20 }
        : { left: 40, right: 20, top: 20, bottom: 60 },
      tooltip: {
        trigger: "axis" as const,
        backgroundColor: "#2b2b2b",
        borderColor: "#3a3a3a",
        textStyle: { color: "#e0e0e0" },
        formatter: (params: any) => `${params[0].name}<br/>${params[0].value.toFixed(1)}%`,
      },
      xAxis: horizontal ? axis : { ...cat, axisLabel: { color: "#aaa", fontSize: 10, rotate: 30 } },
      yAxis: horizontal ? cat : axis,
      series: [
        {
          name: label,
          type: "bar",
          data: vals,
          itemStyle: {
            color: (params: any) => {
              const v = params.value as number;
              if (v >= 60) return "#2ecc71";
              if (v >= 40) return color;
              return "#e74c3c";
            },
            borderRadius: 3,
          },
          label: {
            show: true,
            position: horizontal ? "right" : "top",
            formatter: (p: any) => `${(p.value as number).toFixed(1)}%`,
            color: "#aaa",
            fontSize: 11,
          },
        },
      ],
    };
  }

  onMount(() => {
    chart = echarts.init(container, "dark");
    chart.setOption(buildOption());
    const ro = new ResizeObserver(() => chart?.resize());
    ro.observe(container);
    return () => ro.disconnect();
  });

  $effect(() => {
    chart?.setOption(buildOption(), { notMerge: true });
  });

  onDestroy(() => chart?.dispose());
</script>

<div bind:this={container} style="width:100%; height:{autoHeight}px"></div>
