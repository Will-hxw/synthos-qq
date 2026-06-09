import type { EChartsType } from "echarts/core";

import { useEffect, useRef } from "react";
import { init, use } from "echarts/core";
import { LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

use([LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

interface MessageTrendChartProps {
    currentHourlyData: number[];
    previousHourlyData: number[];
    timestamps: number[];
    width?: number | string;
    height?: number | string;
}

const formatHour = (timestamp: number) => {
    const date = new Date(timestamp);

    return `${date.getHours()}:00`;
};

function buildOption(currentHourlyData: number[], previousHourlyData: number[], timestamps: number[]) {
    return {
        tooltip: { trigger: "axis" as const },
        legend: { show: false },
        xAxis: {
            type: "category" as const,
            data: timestamps.map(formatHour),
            axisLabel: { rotate: 45, fontSize: 10 }
        },
        yAxis: { type: "value" as const, axisLabel: { fontSize: 8 } },
        series: [
            {
                name: "前一天",
                data: previousHourlyData,
                type: "line" as const,
                smooth: true,
                lineStyle: { color: "#9CA3AF" },
                itemStyle: { color: "#9CA3AF" },
                areaStyle: { color: "rgba(156, 163, 175, 0.2)" }
            },
            {
                name: "当前24小时",
                data: currentHourlyData,
                type: "line" as const,
                smooth: true,
                areaStyle: {}
            }
        ],
        grid: { left: "10%", right: "10%", top: "10%", bottom: "20%" }
    };
}

/**
 * 自包含的消息走势图：自己持有 ECharts 生命周期。
 * - 挂载时 init，卸载时 dispose（修复实例/canvas 泄漏）
 * - 实例随 React keyed 节点绑定，排序重排时不再错位
 * - ResizeObserver 监听容器尺寸变化并 resize（修复无法自适应）
 */
export default function MessageTrendChart({ currentHourlyData, previousHourlyData, timestamps, width = "300px", height = "100px" }: MessageTrendChartProps) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const instanceRef = useRef<EChartsType | null>(null);

    // 挂载时创建实例并监听尺寸；卸载时销毁，避免泄漏
    useEffect(() => {
        const el = containerRef.current;

        if (!el) {
            return;
        }

        const chart = init(el);

        instanceRef.current = chart;

        const resizeObserver = new ResizeObserver(() => {
            chart.resize();
        });

        resizeObserver.observe(el);

        return () => {
            resizeObserver.disconnect();
            chart.dispose();
            instanceRef.current = null;
        };
    }, []);

    // 数据变化时仅更新配置，不重建实例
    useEffect(() => {
        instanceRef.current?.setOption(buildOption(currentHourlyData, previousHourlyData, timestamps));
    }, [currentHourlyData, previousHourlyData, timestamps]);

    return <div ref={containerRef} style={{ width, height }} />;
}
