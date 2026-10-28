import { describe, expect, it } from 'vitest';
import { footprintBytes, processIdentity } from './perf/terminal-native-capture.mjs';

// Exact fields transcribed from retained no-xterm native baseline21418:
// /tmp/tx232-minimal-regions-20261024/control/baseline-collected.footprint.json.
// This validates schema/units, NOT permission, attribution or native capture.
const captured = () => ({ unit: 'byte', 'bytes per unit': 1, errors: [], warnings: [],
  processes: [{ pid: 21418, name: 'jsc', footprint: 7471632 }] });

describe('native endpoint evidence parsing', () => {
  it('accepts captured exact bytes for only the requested PID', () => {
    expect(footprintBytes(captured(), 21418)).toBe(7471632);
    expect(() => footprintBytes(captured(), 21419)).toThrow('target');
  });
  it('does not treat scaled, warned, missing or multi-process data as exact evidence', () => {
    for (const bad of [null, { ...captured(), unit: 'KB' }, { ...captured(), 'bytes per unit': 1024 },
      { ...captured(), warnings: ['incomplete'] }, { ...captured(), errors: ['permission'] },
      { ...captured(), processes: [...captured().processes, ...captured().processes] }]) {
      expect(() => footprintBytes(bad, 21418)).toThrow();
    }
  });
  it('rejects invalid byte scalars', () => {
    for (const footprint of [-1, 1.5, '7471632', null, true, Number.MAX_SAFE_INTEGER + 1]) {
      const value = captured(); value.processes[0].footprint = footprint;
      expect(() => footprintBytes(value, 21418)).toThrow();
    }
  });
  it('retains start time and full command, refusing missing or ambiguous PID rows', () => {
    const row = ' 21418 21411 21418 Sat Oct 24 22:55:01 2026 /path with spaces/jsc';
    expect(processIdentity(row, 21418)).toEqual({ pid: 21418, ppid: 21411, pgid: 21418,
      started: 'Sat Oct 24 22:55:01 2026', command: '/path with spaces/jsc' });
    for (const bad of ['', row + '\n' + row, '21418 21411 21418 truncated']) {
      expect(() => processIdentity(bad, 21418)).toThrow();
    }
    expect(() => processIdentity(row, 21419)).toThrow();
  });
});
