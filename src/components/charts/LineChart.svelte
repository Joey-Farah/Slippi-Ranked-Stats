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
    zoom = false,
    onzoom = undefined as ((zoomed: boolean) => void) | undefined,
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
    /** Allow dragging across the plot to zoom into that range. No visible chrome: the parent
     *  shows its own reset control, driven by onzoom, and calls resetZoom(). */
    zoom?: boolean;
    /** Called whenever the view becomes zoomed or returns to the full range. */
    onzoom?: (zoomed: boolean) => void;
  } = $props();

  let container: HTMLDivElement;
  let chart: echarts.ECharts | null = null;

  // Selected window, as percentages. Deliberately PLAIN variables, not $state: buildOption reads
  // them, so making them reactive would have every zoom drag retrigger the $effect below and
  // re-render the chart mid-gesture. They exist so the window survives the notMerge setOption
  // that fires whenever the data changes — otherwise picking a range and then touching any
  // filter would silently snap the view back to the full history.
  let zoomStart = 0;
  let zoomEnd = 100;

  /** True once a sub-range has been selected. */
  function isZoomed() {
    return zoom && (zoomStart > 0 || zoomEnd < 100);
  }

  /** Y bounds for the current view.
   *
   *  Unzoomed, the caller's yMin/yMax apply. Zoomed, they are released (null = auto) so the
   *  axis fits the points actually on screen: the caller pads by `max(50, range*0.15)`, which
   *  is sized for the whole history, and keeping it while zoomed renders a 20-point span as a
   *  flat line in a 100-point window — the zoom looks like it did nothing. `scale: true` keeps
   *  the axis off zero, which ratings need either way. */
  function yBounds() {
    return isZoomed() ? { min: null, max: null } : { min: yMin, max: yMax };
  }

  /** Leave the rectangle-zoom cursor permanently active, so dragging always selects a range
   *  instead of requiring a toolbox button to be toggled on first. */
  function armSelect() {
    if (!zoom) return;
    chart?.dispatchAction({ type: "takeGlobalCursor", key: "dataZoomSelect", dataZoomSelectActive: true } as any);
  }

  /** Back to the full range. Called by the parent's reset control. */
  export function resetZoom() {
    zoomStart = 0;
    zoomEnd = 100;
    chart?.dispatchAction({ type: "dataZoom", start: 0, end: 100 });
    onzoom?.(false);
    armSelect();
  }

  function buildOption() {
    return {
      backgroundColor: "transparent",
      textStyle: { color: "#888" },
      grid: { left: 50, right: 20, top: 20, bottom: (xAxisLabel ? 56 : 40) + (zoom ? 42 : 0) },
      // Drag across the plot to zoom into that span. This is the toolbox's rectangle-zoom
      // behaviour with the toolbox itself hidden and the cursor mode left permanently on
      // (see takeGlobalCursor below) — so there is no slider, no icons, nothing on screen
      // until the user actually drags.
      // ⚠ The toolbox must be SHOWN for its dataZoom feature to register the drag handler that
      // takeGlobalCursor then arms — with `show: false` ECharts skips rendering it entirely and
      // dragging does nothing at all. So it is rendered, but with zero-sized icons and no
      // titles, which leaves nothing visible on the chart.
      toolbox: zoom
        ? {
            show: true,
            itemSize: 0,
            showTitle: false,
            right: 0,
            top: 0,
            feature: { dataZoom: { yAxisIndex: "none", title: { zoom: "", back: "" } } },
          }
        : undefined,
      dataZoom: zoom
        ? [
            // The x-range the toolbox zoom drives. Every `inside` interaction is off: panning
            // and wheel-zoom would both fight the drag-to-select gesture, and wheel-zoom in a
            // scrolling tab traps the page.
            {
              type: "inside", start: zoomStart, end: zoomEnd,
              zoomOnMouseWheel: false, moveOnMouseWheel: false, moveOnMouseMove: false,
            },
          ]
        : undefined,
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
        min: yBounds().min,
        max: yBounds().max,
        scale: true,
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
    // Remember the window the user picked so the next data-driven re-render keeps it.
    armSelect();
    chart.on("datazoom", () => {
      const dz: any = (chart?.getOption() as any)?.dataZoom?.[0];
      if (dz && typeof dz.start === "number" && typeof dz.end === "number") {
        zoomStart = dz.start;
        zoomEnd = dz.end;
      }
      // Re-fit the y axis to what is now on screen. A targeted merge, not a full rebuild:
      // notMerge here would tear down the chart mid-gesture.
      chart?.setOption({ yAxis: yBounds() });
      onzoom?.(isZoomed());
      // A completed drag drops the cursor back to normal; re-arm so the next drag also works.
      armSelect();
    });
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
    armSelect();   // notMerge drops the cursor mode along with everything else
  });

  onDestroy(() => chart?.dispose());
</script>

<div bind:this={container} style="width:100%; height:{height}px"></div>
