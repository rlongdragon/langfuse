/**
 * LiveView - a Logfire-style live stream of observations.
 *
 * Composition (mirrors Logfire's live tab):
 *  - top: an activity histogram over the selected range, "now" at the right
 *  - list: one row per span, root spans collapsed by default with a
 *    child-count badge; expanding reveals descendants indented in place
 *  - duration column: a bar positioned on the TRACE's own time axis
 *    (left = start offset within the trace, width = share of trace duration),
 *    so parallelism and ordering read inside each request group
 *  - right: clicking a row opens a detail panel with the observation's real
 *    input/output rendered by the same IOPreview the trace page uses
 *
 * Data: polls `generations.all` every few seconds; the view "forgets" traces
 * older than the selected range, so the stream stays a stream instead of an
 * ever-growing table. Spans land when they END (ingestion is async batch), so
 * a short run appears as one burst a few seconds after it finishes.
 */

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import { api } from "@/src/utils/api";
import { useLangfuseV4WriteMode } from "@/src/features/organizations";
import { type FilterState } from "@langfuse/shared";
import { cn } from "@/src/utils/tailwind";
import { IOPreview } from "@/src/features/traces/components/IOPreview/IOPreview";
import { OutlierBarStrip } from "@/src/features/events/components/outlier-strip/OutlierBarStrip";
import {
  prepareOutlierSeries,
  type OutlierStripBin,
} from "@/src/features/events/components/outlier-strip/lib/binning";
import { useElementSize } from "@/src/hooks/useElementSize";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/src/components/ui/resizable";

/** Reuses ItemBadge's type→hue mapping, so a colour means what it already means. */
const TYPE_COLOR: Record<string, string> = {
  TRACE: "bg-dark-green",
  GENERATION: "bg-muted-magenta",
  EVENT: "bg-muted-green",
  SPAN: "bg-muted-blue",
  AGENT: "bg-purple-600",
  TOOL: "bg-orange-600",
  CHAIN: "bg-pink-600",
  RETRIEVER: "bg-teal-600",
  EMBEDDING: "bg-amber-600",
  GUARDRAIL: "bg-red-600",
};
const FALLBACK_COLOR = "bg-muted-gray";

/** Same hues as concrete CSS colors, for the outlined duration bars. */
const TYPE_COLOR_VALUE: Record<string, string> = {
  TRACE: "hsl(var(--dark-green))",
  GENERATION: "hsl(var(--muted-magenta))",
  EVENT: "hsl(var(--muted-green))",
  SPAN: "hsl(var(--muted-blue))",
  AGENT: "#9333ea",
  TOOL: "#ea580c",
  CHAIN: "#db2777",
  RETRIEVER: "#0d9488",
  EMBEDDING: "#d97706",
  GUARDRAIL: "#dc2626",
};
const FALLBACK_COLOR_VALUE = "hsl(var(--muted-foreground))";

/** Trace chips cycle through the same hues so a trace keeps its colour. */
const CHIP_STYLES = [
  "bg-light-green text-dark-green",
  "bg-light-blue text-dark-blue",
  "bg-light-violet text-dark-violet",
  "bg-light-teal text-dark-teal",
  "bg-light-yellow text-dark-yellow",
];
const chipStyle = (key: string) => {
  let h = 0;
  for (let i = 0; i < key.length; i++)
    h = (h * 31 + key.charCodeAt(i)) % 4_294_967_296;
  return CHIP_STYLES[h % CHIP_STYLES.length];
};

const POLL_MS = 3_000;
/** paginationZod caps limit at 100. */
const FETCH_LIMIT = 100;
const RANGE_OPTIONS = [
  { label: "5m", ms: 5 * 60 * 1000 },
  { label: "15m", ms: 15 * 60 * 1000 },
  { label: "1h", ms: 60 * 60 * 1000 },
] as const;
const HISTOGRAM_BUCKETS = 60;

type LiveSpan = {
  id: string;
  traceId: string;
  traceName: string | null;
  name: string | null;
  type: string;
  startMs: number;
  endMs: number | null;
  parentId: string | null;
  model: string | null;
  totalTokens: number | null;
  childCount: number;
  depth: number;
};

type TraceGroup = {
  traceId: string;
  traceName: string | null;
  startMs: number;
  endMs: number;
  spans: LiveSpan[]; // pre-order (parent before descendants)
};

const fmtDur = (ms: number) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
const pad2 = (n: number) => String(n).padStart(2, "0");
const wallClock = (ms: number) => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

export function LiveView({ projectId }: { projectId: string }) {
  const [live, setLive] = useState(true);
  const [rangeMs, setRangeMs] = useState<number>(RANGE_OPTIONS[0].ms);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<{
    id: string;
    traceId: string;
    startMs: number;
  } | null>(null);
  // 1s heartbeat, only consumed by running-duration labels.
  const [nowTick, setNowTick] = useState(() => Date.now());

  // Stable lower bound so the query key does not churn on every render.
  const [fromTimestamp] = useState(
    () => new Date(Date.now() - 24 * 60 * 60 * 1000),
  );
  const filter: FilterState = useMemo(
    () => [
      {
        column: "Start Time",
        type: "datetime" as const,
        operator: ">=" as const,
        value: fromTimestamp,
      },
    ],
    [fromTimestamp],
  );

  // In events_only mode ingestion writes only to the events table, which the
  // legacy generations list never reads.
  const readsEvents = useLangfuseV4WriteMode() === "events_only";
  const queryOpts = {
    refetchInterval: live ? POLL_MS : (false as const),
    refetchIntervalInBackground: false,
    trpc: { context: { skipBatch: true } },
  };
  const legacyQuery = api.generations.all.useQuery(
    {
      projectId,
      filter,
      searchQuery: null,
      searchType: ["id"],
      orderBy: { column: "startTime", order: "DESC" },
      page: 0,
      limit: FETCH_LIMIT,
    },
    { ...queryOpts, enabled: !readsEvents },
  );
  const eventsQuery = api.events.all.useQuery(
    {
      projectId,
      filter: [
        {
          column: "startTime",
          type: "datetime",
          operator: ">=",
          value: fromTimestamp,
        },
      ],
      searchQuery: null,
      searchType: ["id"],
      orderBy: { column: "startTime", order: "DESC" },
      page: 1,
      limit: FETCH_LIMIT,
    },
    { ...queryOpts, enabled: readsEvents },
  );
  const query = readsEvents ? eventsQuery : legacyQuery;

  /** Regrouped into traces, newest first, spans in pre-order for the tree. */
  const groups: TraceGroup[] = useMemo(() => {
    const rows =
      (readsEvents
        ? eventsQuery.data?.observations
        : legacyQuery.data?.generations) ?? [];
    const byTrace = new Map<
      string,
      { spans: Map<string, LiveSpan>; children: Map<string | null, string[]> }
    >();
    for (const o of rows) {
      const traceId = o.traceId ?? "unknown";
      let t = byTrace.get(traceId);
      if (!t) {
        t = { spans: new Map(), children: new Map() };
        byTrace.set(traceId, t);
      }
      const usage = (o as { usageDetails?: Record<string, number> })
        .usageDetails;
      t.spans.set(o.id, {
        id: o.id,
        traceId,
        traceName: o.traceName ?? null,
        name: o.name,
        type: o.type,
        startMs: o.startTime.getTime(),
        endMs: o.endTime ? o.endTime.getTime() : null,
        parentId: o.parentObservationId,
        model: o.model ?? null,
        totalTokens: usage?.total ?? null,
        childCount: 0,
        depth: 0,
      });
    }
    const list: TraceGroup[] = [];
    for (const [traceId, t] of byTrace) {
      // parent → ordered children (a parent missing from the fetch window
      // promotes its orphans to roots so nothing silently disappears)
      for (const s of t.spans.values()) {
        const parentKey =
          s.parentId && t.spans.has(s.parentId) ? s.parentId : null;
        const bucket = t.children.get(parentKey) ?? [];
        bucket.push(s.id);
        t.children.set(parentKey, bucket);
      }
      for (const bucket of t.children.values())
        bucket.sort(
          (a, b) => t.spans.get(a)!.startMs - t.spans.get(b)!.startMs,
        );
      const ordered: LiveSpan[] = [];
      const walk = (parentKey: string | null, depth: number): number => {
        let count = 0;
        for (const id of t.children.get(parentKey) ?? []) {
          const span = t.spans.get(id)!;
          span.depth = depth;
          ordered.push(span);
          const below = walk(id, depth + 1);
          span.childCount = below;
          count += 1 + below;
        }
        return count;
      };
      walk(null, 0);
      if (ordered.length === 0) continue;
      let startMs = Infinity;
      let endMs = 0;
      let traceName: string | null = null;
      for (const s of ordered) {
        startMs = Math.min(startMs, s.startMs);
        endMs = Math.max(endMs, s.endMs ?? s.startMs);
        if (!traceName && s.traceName) traceName = s.traceName;
      }
      // OTel exporters only ship a span once it ENDS, so while a session's
      // root span is still running its finished children arrive as orphans.
      // Cluster sibling roots of the same trace under one synthetic trace
      // row instead of spraying them across the stream as separate roots.
      if ((t.children.get(null)?.length ?? 0) > 1) {
        const synthId = `trace:${traceId}`;
        for (const s of ordered) {
          s.depth += 1;
          if (!s.parentId || !t.spans.has(s.parentId)) s.parentId = synthId;
        }
        ordered.unshift({
          id: synthId,
          traceId,
          traceName,
          name: traceName ?? ordered[0]!.name,
          type: "TRACE",
          startMs,
          endMs: ordered.some((s) => s.endMs === null) ? null : endMs,
          parentId: null,
          model: null,
          totalTokens: null,
          childCount: ordered.length,
          depth: 0,
        });
      }
      list.push({ traceId, traceName, startMs, endMs, spans: ordered });
    }
    list.sort((a, b) => b.startMs - a.startMs);
    return list;
  }, [readsEvents, eventsQuery.data, legacyQuery.data]);

  const latestDataMs = useMemo(
    () => groups.reduce((m, g) => Math.max(m, g.endMs), 0),
    [groups],
  );

  /**
   * Everything is windowed on the WALL clock, like Logfire: the histogram
   * slides continuously and quiet periods genuinely empty out. Pausing stops
   * the heartbeat, which freezes the window in place.
   */
  const windowEnd = nowTick;
  const windowStart = windowEnd - rangeMs;

  /** The stream forgets: only traces active inside the sliding window. */
  const visibleGroups = useMemo(
    () => groups.filter((g) => g.endMs >= windowStart),
    [groups, windowStart],
  );

  /**
   * Activity strip over [now - range, now], rendered by the SAME
   * OutlierBarStrip the traces table uses. Its server query bottoms out at
   * 1-minute buckets, so the Live view feeds it client-side bins from the
   * spans it already fetched and reuses only the visual pipeline
   * (densify + ticks via prepareOutlierSeries).
   */
  const [stripRef, stripSize] = useElementSize<HTMLDivElement>();
  const strip = useMemo(() => {
    const bucketMs = rangeMs / HISTOGRAM_BUCKETS;
    const counts = new Map<number, number>();
    for (const g of visibleGroups)
      for (const s of g.spans) {
        if (s.startMs < windowStart || s.startMs > windowEnd) continue;
        const bucket = Math.floor(s.startMs / bucketMs) * bucketMs;
        counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
      }
    const bins: OutlierStripBin[] = [...counts.entries()].map(
      ([bucketMsStart, count]) => ({
        bucketStart: new Date(bucketMsStart),
        count,
        values: { count_count: count },
      }),
    );
    return prepareOutlierSeries({
      bins,
      metric: "count",
      fromMs: windowStart,
      toMs: windowEnd,
      stepSeconds: bucketMs / 1000,
      widthPx: stripSize?.width ?? 0,
    });
  }, [visibleGroups, windowStart, windowEnd, rangeMs, stripSize?.width]);

  const rowCount = visibleGroups.reduce((n, g) => n + g.spans.length, 0);

  // 1s heartbeat drives the sliding window and running-duration labels while
  // live; pausing stops it and freezes the view. A timer is an external system.
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);

  const toggleSpan = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const setAll = (open: boolean) => {
    if (!open) {
      setExpanded(new Set());
      return;
    }
    const all = new Set<string>();
    for (const g of visibleGroups)
      for (const s of g.spans) if (s.childCount > 0) all.add(s.id);
    setExpanded(all);
  };

  const gridCols =
    "grid grid-cols-[64px_minmax(0,1fr)_150px_230px] items-center";

  return (
    <div className="bg-background flex h-full w-full flex-col overflow-hidden">
      {/* controls */}
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <button
          type="button"
          onClick={() => setLive((v) => !v)}
          className={cn(
            "flex items-center gap-2 rounded-full border px-3 py-0.5 text-xs",
            live
              ? "border-dark-green text-dark-green"
              : "text-muted-foreground",
          )}
        >
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              live ? "bg-dark-green animate-pulse" : "bg-muted-foreground",
            )}
          />
          {live ? "Live" : "Paused"}
        </button>
        <div className="flex overflow-hidden rounded-md border">
          {RANGE_OPTIONS.map((r) => (
            <button
              key={r.label}
              type="button"
              onClick={() => setRangeMs(r.ms)}
              className={cn(
                "px-2.5 py-0.5 text-xs",
                r.ms === rangeMs
                  ? "bg-secondary text-foreground font-bold"
                  : "text-muted-foreground",
              )}
            >
              Last {r.label}
            </button>
          ))}
        </div>
        <div className="flex overflow-hidden rounded-md border">
          <button
            type="button"
            onClick={() => setAll(true)}
            className="text-muted-foreground hover:text-foreground px-2.5 py-0.5 text-xs"
          >
            Expand all
          </button>
          <button
            type="button"
            onClick={() => setAll(false)}
            className="text-muted-foreground hover:text-foreground border-l px-2.5 py-0.5 text-xs"
          >
            Collapse all
          </button>
        </div>
        <div className="flex-1" />
        <span className="text-muted-foreground font-mono text-xs tabular-nums">
          {rowCount} spans · {visibleGroups.length} traces
          {query.isFetching ? " · syncing…" : ""}
        </span>
      </div>

      {/* activity strip — the traces table's OutlierBarStrip, client-fed */}
      <div className="border-b px-3 pt-2 pb-1">
        <div ref={stripRef} className="w-full">
          {stripSize?.width ? (
            <OutlierBarStrip
              dense={strip.dense}
              maxValue={strip.maxValue}
              stepMs={rangeMs / HISTOGRAM_BUCKETS}
              metric="count"
              widthPx={stripSize.width}
              ticks={strip.ticks}
              heightPx={40}
            />
          ) : (
            <div className="h-10" />
          )}
        </div>
        <div className="text-muted-foreground flex justify-between pt-0.5 font-mono text-[9.5px]">
          <span>{wallClock(windowStart)}</span>
          <span>{wallClock(windowStart + rangeMs / 2)}</span>
          <span className="text-dark-green">
            {wallClock(windowEnd)} {live ? "(now)" : "(paused)"}
          </span>
        </div>
      </div>

      {/* column header */}
      <div className={cn(gridCols, "bg-card h-7 border-b px-3")}>
        <div className="text-muted-foreground text-[10.5px] tracking-wide uppercase">
          Time
        </div>
        <div className="text-muted-foreground text-[10.5px] tracking-wide uppercase">
          Message
        </div>
        <div className="text-muted-foreground pl-2 text-[10.5px] tracking-wide uppercase">
          Scope
        </div>
        <div className="text-muted-foreground pl-2 text-[10.5px] tracking-wide uppercase">
          Duration
        </div>
      </div>

      {/* stream + detail panel */}
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel defaultSize="68%" minSize="30%" className="min-w-0">
          <div className="h-full min-w-0 overflow-y-auto">
            {visibleGroups.length === 0 ? (
              <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-1 text-sm">
                <span>
                  {query.isLoading
                    ? "Loading observations…"
                    : "No spans in the selected window. New spans appear seconds after ingestion."}
                </span>
                {!query.isLoading && latestDataMs > 0 ? (
                  <span className="font-mono text-xs">
                    Last activity: {wallClock(latestDataMs)}
                  </span>
                ) : null}
              </div>
            ) : null}
            {visibleGroups.map((g) => {
              const traceDur = Math.max(1, g.endMs - g.startMs);
              const hiddenStack: Array<{ depth: number }> = [];
              return (
                <div key={g.traceId} className="border-b last:border-b-0">
                  {g.spans.map((s) => {
                    // hide descendants of any collapsed ancestor
                    while (
                      hiddenStack.length &&
                      s.depth <= hiddenStack[hiddenStack.length - 1]!.depth
                    )
                      hiddenStack.pop();
                    if (hiddenStack.length) return null;
                    if (s.childCount > 0 && !expanded.has(s.id))
                      hiddenStack.push({ depth: s.depth });

                    const running = s.endMs === null;
                    const effEnd = running ? nowTick : s.endMs!;
                    const color = TYPE_COLOR[s.type] ?? FALLBACK_COLOR;
                    const colorValue =
                      TYPE_COLOR_VALUE[s.type] ?? FALLBACK_COLOR_VALUE;
                    const spanDur = Math.max(1, effEnd - s.startMs);
                    // Divider ticks at direct children's start offsets — the
                    // |-----|---|-| segmentation on an expanded parent's bar.
                    const childTicks =
                      s.childCount > 0 && expanded.has(s.id)
                        ? g.spans
                            .filter(
                              (c) =>
                                c.parentId === s.id && c.startMs > s.startMs,
                            )
                            .map((c) =>
                              Math.min(0.99, (c.startMs - s.startMs) / spanDur),
                            )
                        : [];
                    const isOpen = expanded.has(s.id);
                    const isSel = selected?.id === s.id;
                    const barLeft = ((s.startMs - g.startMs) / traceDur) * 100;
                    const barWidth = Math.max(
                      1.5,
                      ((Math.min(effEnd, g.endMs) - s.startMs) / traceDur) *
                        100,
                    );
                    const isTick = barWidth < 1.2;
                    const isSolidBar = !isTick && !isOpen && s.depth === 0;
                    return (
                      <div
                        key={s.id}
                        className={cn(
                          gridCols,
                          "hover:bg-muted cursor-pointer px-3 py-0.5",
                          isSel && "bg-muted",
                          running && "bg-dark-green/5",
                        )}
                        onClick={() => {
                          // Synthetic trace rows have no observation behind
                          // them; clicking toggles the group instead.
                          if (s.id.startsWith("trace:")) {
                            toggleSpan(s.id);
                            return;
                          }
                          setSelected(
                            isSel
                              ? null
                              : {
                                  id: s.id,
                                  traceId: g.traceId,
                                  startMs: s.startMs,
                                },
                          );
                        }}
                      >
                        <div className="text-muted-foreground font-mono text-[11px] tabular-nums">
                          {wallClock(s.startMs)}
                        </div>
                        <div className="flex min-w-0 items-center gap-1.5 pr-2">
                          {/* fixed-width chip slot on every row, so children
                            indent under the parent's name, not under the chip */}
                          {s.depth === 0 ? (
                            <span
                              className={cn(
                                "w-28 shrink-0 truncate rounded px-1.5 text-center font-mono text-[10px] font-bold",
                                chipStyle(g.traceName ?? g.traceId),
                              )}
                              title={g.traceName ?? g.traceId}
                            >
                              {g.traceName ?? g.traceId.slice(0, 12)}
                            </span>
                          ) : (
                            <span className="w-28 shrink-0" />
                          )}
                          {s.depth > 0 ? (
                            <span
                              className="shrink-0"
                              style={{ width: s.depth * 16 }}
                            />
                          ) : null}
                          {s.childCount > 0 ? (
                            <button
                              type="button"
                              aria-label={isOpen ? "Collapse" : "Expand"}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleSpan(s.id);
                              }}
                              className="text-muted-foreground hover:text-foreground flex shrink-0 items-center gap-0.5"
                            >
                              {isOpen ? (
                                <ChevronDown className="icon-sm" />
                              ) : (
                                <ChevronRight className="icon-sm" />
                              )}
                              <span className="rounded border px-1 font-mono text-[9.5px]">
                                {s.childCount}
                              </span>
                            </button>
                          ) : (
                            <span className="w-3 shrink-0" />
                          )}
                          <span
                            className={cn(
                              "h-2 w-2 shrink-0 rounded-[2px]",
                              color,
                            )}
                          />
                          <span
                            className="truncate text-xs"
                            title={s.name ?? s.id}
                          >
                            {s.name ?? s.id}
                          </span>
                          {s.totalTokens ? (
                            <span className="text-muted-foreground shrink-0 rounded border px-1 font-mono text-[9.5px]">
                              ∑ {s.totalTokens.toLocaleString()}
                            </span>
                          ) : null}
                        </div>
                        <div
                          className="text-foreground-tertiary truncate pl-2 font-mono text-[10.5px] lowercase"
                          title={`${s.type.toLowerCase()}${s.model ? ` · ${s.model}` : ""}`}
                        >
                          {s.type.toLowerCase()}
                          {s.model ? ` · ${s.model}` : ""}
                        </div>
                        <div className="flex items-center gap-2 pl-2">
                          <div className="relative h-3 min-w-0 flex-1">
                            {/* Logfire's bar logic follows the fold state: a
                              COLLAPSED root shows one solid bar summarizing
                              its subtree; every row inside an expanded group
                              (the expanded parent AND its descendants, leaves
                              included) switches to the interval style —
                              bracket end caps + a half-height rail + solid
                              segments over self time (a leaf's self time is
                              its whole span). Tiny spans become one tick. */}
                            {isTick ? (
                              <span
                                className="absolute top-1/2 h-[11px] w-[2px] -translate-y-1/2"
                                style={{
                                  left: `${barLeft}%`,
                                  backgroundColor: colorValue,
                                }}
                              />
                            ) : null}
                            {isSolidBar ? (
                              <span
                                className={cn(
                                  "absolute top-1/2 h-[8px] -translate-y-1/2 rounded-[2px]",
                                  running && "animate-pulse",
                                )}
                                style={{
                                  left: `${barLeft}%`,
                                  width: `${barWidth}%`,
                                  backgroundColor: colorValue,
                                }}
                              />
                            ) : null}
                            {!isTick && !isSolidBar ? (
                              <span
                                className={cn(
                                  "absolute top-0 h-full",
                                  running && "animate-pulse",
                                )}
                                style={{
                                  left: `${barLeft}%`,
                                  width: `${barWidth}%`,
                                }}
                              >
                                {/* continuous mid-thickness bar */}
                                <span
                                  className="absolute top-1/2 h-[6px] w-full -translate-y-1/2 rounded-[1px] opacity-90"
                                  style={{ backgroundColor: colorValue }}
                                />
                                {/* end caps */}
                                <span
                                  className="absolute top-1/2 left-0 h-[12px] w-[2px] -translate-y-1/2"
                                  style={{ backgroundColor: colorValue }}
                                />
                                {!running ? (
                                  <span
                                    className="absolute top-1/2 right-0 h-[12px] w-[2px] -translate-y-1/2"
                                    style={{ backgroundColor: colorValue }}
                                  />
                                ) : null}
                                {/* dividers where direct children start */}
                                {childTicks.map((p, i) => (
                                  <span
                                    key={i}
                                    className="absolute top-1/2 h-[12px] w-[2px] -translate-y-1/2"
                                    style={{
                                      left: `${p * 100}%`,
                                      backgroundColor: colorValue,
                                    }}
                                  />
                                ))}
                              </span>
                            ) : null}
                          </div>
                          <span
                            className={cn(
                              "w-14 shrink-0 text-right font-mono text-[11px] tabular-nums",
                              running && "text-dark-green",
                            )}
                          >
                            {fmtDur(effEnd - s.startMs)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </ResizablePanel>

        {selected ? (
          <>
            <ResizableHandle className="bg-border w-px" />
            <ResizablePanel
              defaultSize="32%"
              minSize="18%"
              className="flex min-w-0"
            >
              <DetailPanel
                key={selected.id}
                projectId={projectId}
                observationId={selected.id}
                traceId={selected.traceId}
                startMs={selected.startMs}
                onClose={() => setSelected(null)}
              />
            </ResizablePanel>
          </>
        ) : null}
      </ResizablePanelGroup>
    </div>
  );
}

/** Right-hand detail: the observation's real input/output, like the trace page. */
function DetailPanel({
  projectId,
  observationId,
  traceId,
  startMs,
  onClose,
}: {
  projectId: string;
  observationId: string;
  traceId: string;
  startMs: number;
  onClose: () => void;
}) {
  const [startTime] = useState(() => new Date(startMs));
  const obs = api.observations.byId.useQuery(
    { observationId, traceId, projectId, startTime },
    { staleTime: 5 * 60 * 1000 },
  );
  const o = obs.data;

  return (
    <div className="flex h-full w-full min-w-0 flex-col overflow-hidden">
      <div className="bg-card flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              "h-2 w-2 shrink-0 rounded-[2px]",
              o ? (TYPE_COLOR[o.type] ?? FALLBACK_COLOR) : FALLBACK_COLOR,
            )}
          />
          <span
            className="truncate text-xs font-bold"
            title={o?.name ?? observationId}
          >
            {o?.name ?? observationId}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close detail"
          className="text-muted-foreground hover:text-foreground shrink-0 rounded p-0.5"
        >
          <X className="icon-base" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {o ? (
          <>
            <dl className="mb-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-0.5 text-xs">
              <dt className="text-muted-foreground font-mono text-[10.5px]">
                type
              </dt>
              <dd>{o.type.toLowerCase()}</dd>
              {o.model ? (
                <>
                  <dt className="text-muted-foreground font-mono text-[10.5px]">
                    model
                  </dt>
                  <dd>{o.model}</dd>
                </>
              ) : null}
              {o.latency != null ? (
                <>
                  <dt className="text-muted-foreground font-mono text-[10.5px]">
                    latency
                  </dt>
                  <dd className="tabular-nums">{o.latency.toFixed(2)}s</dd>
                </>
              ) : null}
            </dl>
            <IOPreview
              projectId={projectId}
              traceId={traceId}
              input={o.input ?? undefined}
              output={o.output ?? undefined}
              metadata={o.metadata ?? undefined}
              observationName={o.name ?? undefined}
            />
          </>
        ) : (
          <p className="text-muted-foreground text-xs">
            {obs.isError ? "Could not load this observation." : "Loading…"}
          </p>
        )}
      </div>
    </div>
  );
}
