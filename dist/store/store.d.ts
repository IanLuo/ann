export interface JourneyEvent {
    at: string;
    type: string;
    note?: string;
    gate?: string | {
        old: string;
        new: string;
    };
    artifact?: {
        name: string;
        path: string;
        lockSha: string;
    };
    successor?: {
        name: string;
        path: string;
    };
    target?: string;
    feedback?: string;
    [key: string]: unknown;
}
/**
 * The tree store (S1) — reads/writes legs, nodes, events, artifacts per
 * journey-format-spec v8. Builds the in-memory tree; owns the single
 * appendEvent() write function (architecture LB-3); exposes derived views
 * (status / resolution / integrity) for shared readers.
 */
export declare class Store {
    readonly root: string;
    readonly legs: string;
    private nodes;
    constructor(root: string);
    private walk;
    private load;
    private parse;
    ids(): string[];
    events(id: string): JourneyEvent[];
    /**
     * Derived status (v8 §3/§12). Tasks: tail mapping. Legs: pure function of the
     * leg's tasks — all done → done; frontmost-ready child → its status; childless
     * → own lifecycle (L1 base step); all remaining failed → blocked (escalate).
     */
    status(id: string): string;
    private taskStatus;
    private legStatus;
    /**
     * Resolution (format §5): current(name) = the artifact-locked producer with that
     * name that is not superseded. Never by timestamp; the log is the only order.
     * Structured events preferred; legacy prose notes are parsed as a fallback.
     */
    current(name: string): {
        name: string;
        path: string;
        sha?: string;
        producer: string;
    } | undefined;
    private lockers;
    private supersededProducers;
    /**
     * THE single write path (LB-3): validate schema against the vocab registry,
     * gate-check the prospective log, append only when clean — fail-closed.
     */
    appendEvent(id: string, event: JourneyEvent): void;
    /** GATE-1/GATE-2 (F-AC15): tasks only — leg roots carry no events (v8). */
    gateProblems(id: string, evs?: JourneyEvent[]): string[];
    /** Integrity check: gate gaps + missing current-artifact files + orphan names. */
    check(): string[];
    /** Leg gate (v8 §12/§13): is every task of this leg's predecessor done? */
    legGateMet(legId: string): {
        met: boolean;
        blocker?: string;
    };
    /** v8 §12/§13: leg roots carry no events — the grandfathered set is historical. */
    legRootDisciplineProblems(): string[];
}
